// اختبارات طبقة الإنتاج: التطبيع الواعي باللغة، حسابات المطابقة الزمنية،
// الكاش، وترجمة أخطاء المحرك. كلها بلا شبكة وبلا ffmpeg.

import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeText, detectLanguage } from '../lib/normalize.mjs'
import {
  applyDeltaToTail,
  finalizeDelta,
  fitPauses,
  timingError,
  totalGapMs,
  totalPauseMs,
} from '../lib/timing.mjs'
import { audioCacheKey, synthWithCache } from '../lib/render.mjs'
import { humanizeSynthError } from '../lib/tts.mjs'
import { friendlyPythonError, PYTHON_BIN } from '../lib/python.mjs'

const ARABIC = /[\u0600-\u06FF]/

/* ------------------- التطبيع الواعي باللغة (٤.١ / ٤.٢) ------------------- */

test('الجملة الإنجليزية الخالصة لا يمسّها قاموس التعريب', () => {
  const out = normalizeText('I like this story and our brand trend')
  assert.equal(out, 'I like this story and our brand trend')
  assert.doesNotMatch(out, ARABIC)
})

test('الهاشتاق والرابط والحساب في نص إنجليزي تُقرأ بكلمات إنجليزية', () => {
  const out = normalizeText('Follow us #marketing at https://example.com today')
  assert.doesNotMatch(out, ARABIC)
  assert.match(out, /hashtag marketing/)
  assert.match(out, /link/)
})

test('المصطلح الإنجليزي داخل جملة عربية يبقى مُعرَّباً للنطق', () => {
  const out = normalizeText('استخدم Canva في التصميم')
  assert.match(out, /كانفا/)
  assert.doesNotMatch(out, /Canva/)
})

test('الهاشتاق داخل جملة عربية يُقرأ «هاشتاق»', () => {
  const out = normalizeText('تابعني #تسويق على حسابي')
  assert.match(out, /هاشتاق تسويق/)
})

test('النص المختلط: كل جملة تُطبَّع بلغتها', () => {
  const out = normalizeText('Our story starts in 1999. هلا بك، اليوم نتكلم عن الذكاء.')
  assert.match(out, /Our story starts in one thousand nine hundred ninety-nine/)
  assert.match(out, /هلا بك/)
  assert.doesNotMatch(out, /ستوري/)
})

test('الأرقام العربية تبقى كلمات عربية والفصحى يُصحَّح إملائياً', () => {
  const out = normalizeText('عندنا 3 مشاكل و 50% من الحلول')
  assert.match(out, /ثلاثة مشاكل/)
  assert.match(out, /خمسين بالمئة/)
})

test('detectLanguage يميّز الإنجليزية عن العربية', () => {
  assert.equal(detectLanguage('This is a full English sentence'), 'en')
  assert.equal(detectLanguage('هذه جملة عربية كاملة بلا لاتيني'), 'ar')
})

/* ---------------------- مطابقة المدة (إصلاح ٤.٣) ---------------------- */

const part = (pauseBefore, pauseAfter, runs = 1) => ({
  pauseBefore,
  pauseAfter,
  runs: Array.from({ length: runs }, () => ({ duration: 0 })),
})

test('الوقفات تُضغط إذا تجاوزت ميزانية المدة المستهدفة', () => {
  const parts = [part(180, 276)]
  const { scale, parts: fitted } = fitPauses({ parts, speechMs: 2800, targetMs: 3000 })
  assert.ok(scale < 1, 'يجب أن تُضغط الوقفات')
  assert.equal(totalPauseMs(fitted), 200)
  assert.ok(totalPauseMs(fitted) <= 3000 - 2800)
})

test('الوقفات لا تُلمس إذا كانت الميزانية تسمح', () => {
  const parts = [part(180, 276)]
  const { scale, parts: fitted } = fitPauses({ parts, speechMs: 1500, targetMs: 3000 })
  assert.equal(scale, 1)
  assert.equal(totalPauseMs(fitted), 456)
})

test('الفارق المتبقي يُكمَل أو يُقصّ من صمت النهاية', () => {
  const pads = finalizeDelta({ parts: [part(100, 100)], speechMs: 2600, targetMs: 3000 })
  assert.equal(pads.padMs, 200)
  assert.equal(pads.trimMs, 0)

  const trims = finalizeDelta({ parts: [part(100, 400)], speechMs: 2700, targetMs: 3000 })
  assert.equal(trims.trimMs, 200)

  const within = finalizeDelta({ parts: [part(100, 100)], speechMs: 2750, targetMs: 3000 })
  assert.equal(within.padMs, 0)
  assert.equal(within.trimMs, 0)
})

test('applyDeltaToTail يعدّل آخر جزء فقط ولا يخرجه سالباً', () => {
  const parts = [part(100, 100), part(100, 120)]
  const padded = applyDeltaToTail(parts, { padMs: 250 })
  assert.equal(padded[1].pauseAfter, 370)
  assert.equal(padded[0].pauseAfter, 100)

  const trimmed = applyDeltaToTail(parts, { trimMs: 999 })
  assert.equal(trimmed[1].pauseAfter, 0)
})

test('timingError يحسب نسبة الانحراف', () => {
  const parts = [part(0, 0)]
  assert.equal(Math.round(timingError({ parts, speechMs: 3000, targetMs: 3000 }) * 100), 0)
  assert.equal(Number(timingError({ parts, speechMs: 3300, targetMs: 3000 }).toFixed(2)), 0.1)
})

test('totalGapMs يحسب الفواصل بين الوحدات فقط', () => {
  assert.equal(totalGapMs([part(0, 0, 1), part(0, 0, 3)]), 180)
})

/* --------------------------- الكاش والأخطاء --------------------------- */

test('مفتاح الكاش ثابت ويتغير بتغير الصوت أو السرعة', () => {
  const base = { voice: 'ar-SA-HamedNeural', rate: 0, pitch: 0, volume: 0, text: 'هلا' }
  assert.equal(audioCacheKey(base), audioCacheKey({ ...base }))
  assert.notEqual(audioCacheKey(base), audioCacheKey({ ...base, voice: 'ar-SA-ZariyahNeural' }))
  assert.notEqual(audioCacheKey(base), audioCacheKey({ ...base, rate: 5 }))
})

test('synthWithCache يعيد استخدام الملف المكاش بدل الشبكة', async () => {
  const { promises: fs } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sawti-cache-'))
  const cacheDir = path.join(dir, 'cache')
  const job = { id: '0:0:0', text: 'نص تجريبي', voice: 'ar-SA-HamedNeural', rate: 0, pitch: 0, volume: 0, out: path.join(dir, 'a.mp3') }

  await fs.mkdir(cacheDir, { recursive: true })
  await fs.writeFile(path.join(cacheDir, `${audioCacheKey(job)}.mp3`), Buffer.alloc(2048))

  const [result] = await synthWithCache([job], cacheDir)
  assert.equal(result.ok, true)
  assert.equal(result.cached, true)
  const copied = await fs.stat(job.out)
  assert.equal(copied.size, 2048)

  await fs.rm(dir, { recursive: true, force: true })
})

test('أخطاء المحرك تُترجم إلى رسائل عربية مفهومة', () => {
  assert.match(humanizeSynthError('NoAudioReceived'), /لم يرجع صوتاً/)
  assert.match(humanizeSynthError('429 Too Many Requests'), /حد الطلبات/)
  assert.match(humanizeSynthError('getaddrinfo ENOTFOUND'), /الاتصال/)
  assert.match(humanizeSynthError('some weird failure'), /some weird failure/)
})

test('نقص حزم بايثون يُشرح برسالة قابلة للتنفيذ', () => {
  assert.match(friendlyPythonError({ stderr: "ModuleNotFoundError: No module named 'edge_tts'" }, 'tts'), /edge-tts/)
  assert.match(friendlyPythonError({ stderr: 'ENOENT' }), /PYTHON_BIN/)
  assert.match(friendlyPythonError({ stderr: "No module named 'onnxruntime'" }), /onnxruntime/)
  assert.ok(PYTHON_BIN.length > 0)
})
