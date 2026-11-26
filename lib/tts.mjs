// جسر Node → محرك الصوت (بايثون / edge-tts).
// كل تفاصيل التشغيل والأخطاء تُترجم هنا، حتى لا تصل الواجهة رسالة Traceback خام.

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PYTHON_BIN, friendlyPythonError, runPython } from './python.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PY_SCRIPT = path.join(__dirname, '..', 'py', 'tts.py')

const DEFAULT_CONCURRENCY = Math.max(1, Number(process.env.TTS_CONCURRENCY) || 4)

/** آخر سطر JSON من stdout (بايثون قد يطبع تحذيرات قبله). */
function lastJsonLine(stdout) {
  const line = String(stdout).trim().split('\n').filter(Boolean).pop()
  if (!line) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/**
 * يشتغل مهام التوليد في عملية بايثون واحدة (أسرع، ومحدود التزامن).
 * @param {{id:string,text:string,voice:string,rate:number,pitch:number,volume:number,out:string}[]} jobs
 * @param {number} concurrency
 * @returns {Promise<{id:string,ok:boolean,error?:string,bytes?:number}[]>}
 */
export async function synthBatch(jobs, concurrency = DEFAULT_CONCURRENCY) {
  if (!jobs.length) return []
  const tmpFile = path.join(os.tmpdir(), `sawti-${crypto.randomBytes(6).toString('hex')}.json`)
  await fs.writeFile(tmpFile, JSON.stringify(jobs), 'utf8')

  try {
    const run = await runPython([PY_SCRIPT, tmpFile, String(concurrency)], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: Number(process.env.TTS_TIMEOUT_MS) || 240_000,
    })

    if (!run.ok && !run.stdout.trim()) {
      // فشل تشغيل كامل (بايثون ناقص أو edge-tts غير مثبّت أو مهلة)
      throw new Error(friendlyPythonError({ stderr: run.stderr, message: run.error?.message }, 'tts'))
    }

    const parsed = lastJsonLine(run.stdout)
    if (!parsed?.results) {
      throw new Error(friendlyPythonError({ stderr: run.stderr, message: 'لم يرجع محرك الصوت نتيجة صالحة' }, 'tts'))
    }

    const byId = new Map(parsed.results.map((item) => [item.id, item]))
    return jobs.map((job) => {
      const found = byId.get(job.id) ?? { id: job.id, ok: false, error: 'لا نتيجة لهذا المقطع' }
      return found.ok ? found : { ...found, error: humanizeSynthError(found.error) }
    })
  } finally {
    await fs.unlink(tmpFile).catch(() => {})
  }
}

/** يترجم أخطاء التوليد المتوقعة (حجب، شبكة، صوت غير متاح) إلى رسالة مفهومة. */
export function humanizeSynthError(raw) {
  const text = String(raw ?? '')
  if (/NoAudioReceived|No audio was received/i.test(text)) {
    return 'المحرك لم يرجع صوتاً لهذا النص (نص غير منطوق أو صوت غير مدعوم لهذه اللغة).'
  }
  if (/401|403|Unauthorized|Forbidden/i.test(text)) {
    return 'رفض مزوّد الصوت الطلب (403/401) — قد تكون الخدمة محجوبة من هذه الشبكة.'
  }
  if (/429|Too Many Requests|rate limit/i.test(text)) {
    return 'تجاوزنا حد الطلبات عند مزوّد الصوت (429). انتظر قليلاً ثم أعد المحاولة.'
  }
  if (/Invalid voice|not a valid voice|Voice .* not found/i.test(text)) {
    return `الصوت المطلوب غير متاح عند المزوّد — اختر صوتاً آخر من القائمة. (${text.trim().slice(0, 120)})`
  }
  if (/getaddrinfo|ENOTFOUND|ECONNREFUSED|Timeout|timed out/i.test(text)) {
    return 'تعذّر الاتصال بمزوّد الصوت — تحقّق من اتصال الإنترنت.'
  }
  return text.trim() || 'خطأ غير معروف في التوليد'
}

let voiceCache = null

/**
 * يجلب معرّفات الأصوات المتاحة فعلاً من المزوّد (للتحقق من الكتالوج).
 * @returns {Promise<Set<string>|null>} null إذا تعذّر الجلب (لا نعطّل التوليد بسببها)
 */
export async function availableVoiceIds({ force = false } = {}) {
  if (voiceCache && !force) return voiceCache
  // ملاحظة: واجهة CLI في edge-tts 7 تطبع جدولاً نصياً لا JSON، فنستدعي الـ API مباشرة.
  const script = [
    'import asyncio, json, edge_tts',
    'voices = asyncio.run(edge_tts.list_voices())',
    'print(json.dumps([v["ShortName"] for v in voices]))',
  ].join('\n')
  const run = await runPython(['-c', script], { timeout: 30_000 })
  if (!run.ok) return null
  const text = run.stdout.trim()
  let ids = []
  try {
    const parsed = JSON.parse(text.split('\n').filter(Boolean).pop())
    ids = (Array.isArray(parsed) ? parsed : []).map((voice) => voice?.ShortName ?? voice?.Name).filter(Boolean)
  } catch {
    ids = [...text.matchAll(/"ShortName"\s*:\s*"([^"]+)"/g)].map((match) => match[1])
  }
  if (!ids.length) return null
  voiceCache = new Set(ids)
  return voiceCache
}

/** يتحقق أن الصوت موجود عند المزوّد، ويعيد رسالة عربية عند الفشل. */
export async function assertVoicesUsable(voiceIds, labels = {}) {
  const available = await availableVoiceIds()
  if (!available) return // لا نعطّل العمل إن تعذّر الجلب
  const missing = [...new Set(voiceIds)].filter((id) => id && !available.has(id))
  if (!missing.length) return
  const names = missing.map((id) => labels[id] ?? id).join('، ')
  throw new Error(`الصوت المحدد غير متاح حالياً عند المزوّد: ${names}. اختر صوتاً من القائمة المتاحة.`)
}

export const __test__ = { lastJsonLine, DEFAULT_CONCURRENCY, PYTHON_BIN }
