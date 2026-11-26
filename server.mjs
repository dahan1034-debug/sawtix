// واجهة الاستوديو البرمجية: تحليل، مراجعة، تشكيل، معاينة، وتوليد كامل.

// يجب أن يسبق أي وحدة تقرأ process.env (مثل PYTHON_BIN) — انظر lib/env.mjs.
import './lib/env.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import ffmpegPath from 'ffmpeg-static'
import { diagnose } from './lib/python.mjs'
import { analyzeProject, previewUtterance, pruneAudioCache, renderVoiceover } from './lib/render.mjs'
import { createQueue } from './lib/queue.mjs'
import { reviewText, dialectizeText } from './lib/qa.mjs'
import { buildSpokenTexts, diacriticCoverage } from './lib/tashkeel.mjs'
import { INTENTS, STYLES, analyzeText, planDelivery } from './lib/intent.mjs'
import { directText } from './lib/director.mjs'
import { VOICES, ENGLISH_VOICES, DEFAULT_VOICE, DEFAULT_ENGLISH_VOICE } from './lib/voices.mjs'
import { normalizeText, splitSentences } from './lib/normalize.mjs'
import { GULF_TASHKEEL, MSA_TO_GULF, PRONUNCIATION } from './lib/lexicon.mjs'
import { createBasicAuth } from './lib/auth.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, 'out')
const PORT = Number(process.env.PORT) || 3000

await fs.mkdir(path.join(OUT_DIR, '_cache'), { recursive: true })

// ---- طابور التوليد: مهمة واحدة تُدار عبر الطابور، والتزامن قابل للضبط ----
const queue = createQueue({
  outRoot: OUT_DIR,
  concurrency: Number(process.env.QUEUE_CONCURRENCY) || 2,
  runner: async (job, api) => renderVoiceover(job.payload.project, OUT_DIR, {
    jobId: job.id,
    isCancelled: api.isCancelled,
    onProgress: (progress) => api.report(progress),
  }),
})
queue.loadHistory().catch(() => {})

const app = express()
// حماية الوصول للنسخة المنشورة: تُفعّل فقط عند ضبط APP_PASSWORD.
const auth = createBasicAuth({
  user: process.env.APP_USER || 'admin',
  password: process.env.APP_PASSWORD || '',
  openPaths: ['/api/health'],
})
app.use(auth.middleware)
app.use(express.json({ limit: '2mb' }))
app.use(express.static(path.join(__dirname, 'public')))
app.use('/files', express.static(OUT_DIR, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }))

const num = (value, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function sanitizeSettings(raw = {}) {
  return {
    rate: Math.min(30, Math.max(-30, num(raw.rate, 0))),
    pitch: Math.min(25, Math.max(-25, num(raw.pitch, 0))),
    volume: Math.min(20, Math.max(-20, num(raw.volume, 0))),
    style: typeof raw.style === 'string' ? raw.style : 'natural',
    diacritics: ['smart', 'light', 'off'].includes(raw.diacritics) ? raw.diacritics : 'smart',
    timingMode: raw.timingMode === 'exact' ? 'exact' : 'natural',
    defaultGap: Math.min(5, Math.max(0, num(raw.defaultGap, 0.2))),
    // مدير الاستوديو يعمل افتراضياً؛ يمكن إيقافه صراحةً
    director: raw.director === 'off' || raw.director === false ? 'off' : 'on',
  }
}

function sanitizeSegments(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((segment) => typeof segment?.text === 'string' && segment.text.trim())
    .slice(0, 60)
    .map((segment, index) => ({
      id: String(segment.id ?? `seg-${index}`),
      text: String(segment.text).slice(0, 4000),
      intent: typeof segment.intent === 'string' ? segment.intent : 'auto',
      style: typeof segment.style === 'string' ? segment.style : undefined,
      intensity: segment.intensity === null || segment.intensity === undefined || segment.intensity === '' || segment.intensity === 'auto'
        ? null
        : Math.min(5, Math.max(1, Math.round(num(segment.intensity, 3)))),
      voice: typeof segment.voice === 'string' ? segment.voice : undefined,
      englishVoice: typeof segment.englishVoice === 'string' ? segment.englishVoice : undefined,
      start: segment.start === null || segment.start === undefined || segment.start === '' ? null : Math.max(0, num(segment.start, 0)),
      target: segment.target === null || segment.target === undefined || segment.target === '' ? null : Math.max(0, num(segment.target, 0)),
    }))
}

function sanitizeDictionary(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((entry) => entry && typeof entry.orig === 'string' && typeof entry.phon === 'string' && entry.orig.trim())
    .slice(0, 400)
    .map((entry) => ({ orig: entry.orig.slice(0, 80), phon: entry.phon.slice(0, 120) }))
}

// ---- فحص البيئة (بايثون / محرك الصوت / المشكّل / ffmpeg) بكاش قصير ----
let envCache = null
let envCheckedAt = 0
const ENV_TTL_MS = 60_000

async function envInfo(force = false) {
  if (!force && envCache && Date.now() - envCheckedAt < ENV_TTL_MS) return envCache
  envCache = await diagnose({ ffmpegPath })
  envCheckedAt = Date.now()
  return envCache
}

// ---- تنظيف دوري للملفات القديمة (نقص ٥.٣): لا ينمو القرص بلا حد ----
const RETENTION_DAYS = Number(process.env.OUT_RETENTION_DAYS) || 7

async function pruneOldRenders(days = RETENTION_DAYS) {
  const limit = Date.now() - days * 24 * 3600 * 1000
  let removed = 0
  for (const group of ['', '_preview']) {
    const base = path.join(OUT_DIR, group)
    let entries = []
    try {
      entries = await fs.readdir(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '_cache') continue
      const target = path.join(base, entry.name)
      try {
        const stat = await fs.stat(target)
        if (stat.mtimeMs < limit) {
          await fs.rm(target, { recursive: true, force: true })
          removed += 1
        }
      } catch { /* تجاهل */ }
    }
  }
  const cached = await pruneAudioCache().catch(() => 0)
  if (removed || cached) console.log(`[cleanup] حُذف ${removed} مجلد توليد و${cached} ملف كاش قديم`)
  return removed
}

app.get('/api/config', async (_req, res) => {
  const engines = await envInfo()
  res.json({
    voices: VOICES,
    englishVoices: ENGLISH_VOICES,
    defaultVoice: DEFAULT_VOICE,
    defaultEnglishVoice: DEFAULT_ENGLISH_VOICE,
    intents: INTENTS,
    styles: STYLES,
    tashkeelAvailable: engines.tashkeel,
    engines,
    lexicalStats: {
      gulfWords: Object.keys(GULF_TASHKEEL).length,
      dialectMappings: Object.keys(MSA_TO_GULF).length,
      pronunciations: Object.keys(PRONUNCIATION).length,
    },
  })
})

// صحة النظام: لا نعلن «سليم» إن كان محرك الصوت ناقصاً (إصلاح ٣.٤)
app.get('/api/health', async (_req, res) => {
  const engines = await envInfo(true)
  res.status(engines.ok ? 200 : 503).json({
    ok: engines.ok,
    engines,
    problems: engines.messages,
  })
})

app.get('/api/voices', (_req, res) => res.json({ voices: VOICES, englishVoices: ENGLISH_VOICES }))

// تشكيل ونطق نص كما سيُرسل للمحرك
app.post('/api/spoken', async (req, res) => {
  try {
    const text = String(req.body?.text ?? '')
    if (!text.trim()) return res.status(400).json({ error: 'اكتب نصاً أولاً' })
    const settings = sanitizeSettings(req.body?.settings)
    const [spoken] = await buildSpokenTexts([normalizeText(text)], {
      diacritics: settings.diacritics,
      dictionary: sanitizeDictionary(req.body?.dictionary),
    })
    res.json({
      normalized: normalizeText(text),
      spoken,
      coverage: diacriticCoverage(spoken),
      sentences: splitSentences(spoken),
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/review', (req, res) => {
  const text = String(req.body?.text ?? '')
  if (!text.trim()) return res.status(400).json({ error: 'اكتب نصاً أولاً' })
  res.json(reviewText(text, { dictionary: sanitizeDictionary(req.body?.dictionary) }))
})

app.post('/api/dialectize', (req, res) => {
  const text = String(req.body?.text ?? '')
  if (!text.trim()) return res.status(400).json({ error: 'اكتب نصاً أولاً' })
  const result = dialectizeText(text)
  res.json({ ...result, review: reviewText(result.text) })
})

// تحليل المشروع كاملاً: خطة إلقاء + مراجعة + تقدير المدة + النص المشكّل
app.post('/api/analyze', async (req, res) => {
  try {
    const body = req.body ?? {}
    const segments = sanitizeSegments(body.segments)
    if (!segments.length) return res.status(400).json({ error: 'أضف مقطعاً واحداً على الأقل' })
    const settings = sanitizeSettings(body.settings)
    const project = {
      voice: body.voice || DEFAULT_VOICE,
      englishVoice: body.englishVoice || DEFAULT_ENGLISH_VOICE,
      settings,
      segments,
      dictionary: sanitizeDictionary(body.dictionary),
    }
    const result = await analyzeProject(project)
    const engines = await envInfo()
    res.json({
      ...result,
      tashkeelAvailable: engines.tashkeel,
      engines,
    })
  } catch (error) {
    console.error('[analyze]', error)
    res.status(500).json({ error: error.message })
  }
})

// تحليل مقطع واحد (للمحرر أثناء الكتابة)
app.post('/api/analyze-segment', (req, res) => {
  const text = String(req.body?.text ?? '')
  if (!text.trim()) return res.status(400).json({ error: 'اكتب نصاً أولاً' })
  const settings = sanitizeSettings(req.body?.settings)
  const normalized = normalizeText(text)
  const parts = planDelivery(normalized, {
    intent: req.body?.intent,
    intensity: req.body?.intensity,
    settings,
    style: req.body?.style ?? settings.style,
  })
  res.json({
    normalized,
    analysis: analyzeText(normalized),
    parts,
    review: reviewText(text),
    estimated: Math.round(parts.reduce((sum, part) => sum + part.estimated + (part.pauseBefore + part.pauseAfter) / 1000, 0) * 10) / 10,
  })
})

// موجز مدير الاستوديو لنص خام: نوع المحتوى، الصوت والنمط المقترح، خطة النطق والأداء
app.post('/api/director', (req, res) => {
  const body = req.body ?? {}
  const text = String(body.text ?? '')
  if (!text.trim()) return res.status(400).json({ error: 'اكتب نصاً أولاً' })
  const settings = sanitizeSettings(body.settings)
  const segments = sanitizeSegments(body.segments)
  const dictionary = sanitizeDictionary(body.dictionary)
  try {
    const direction = directText(text, {
      segments: segments.length ? segments : undefined,
      voice: body.voice || settings.voice,
      style: body.style ?? settings.style,
      intensity: body.intensity,
      dictionary,
    })
    res.json({ direction, review: reviewText(text, { dictionary }) })
  } catch (error) {
    console.error('[director]', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/preview', async (req, res) => {
  try {
    const body = req.body ?? {}
    const text = String(body.text ?? '')
    if (!text.trim()) return res.status(400).json({ error: 'اكتب نصاً أولاً' })
    const settings = sanitizeSettings(body.settings)
    const result = await previewUtterance(
      {
        text,
        voice: body.voice || DEFAULT_VOICE,
        englishVoice: body.englishVoice || DEFAULT_ENGLISH_VOICE,
        settings: { ...settings, intent: body.intent, intensity: body.intensity },
        dictionary: sanitizeDictionary(body.dictionary),
      },
      path.join(OUT_DIR, '_preview'),
    )
    res.setHeader('Content-Type', 'application/json')
    res.json({
      url: `/files/_preview/${path.basename(path.dirname(result.file))}/preview.mp3?t=${crypto.randomBytes(3).toString('hex')}`,
      duration: result.duration,
      voice: result.voice,
      spoken: result.spoken,
      plan: result.plan,
      coverage: result.coverage,
      direction: result.direction,
    })
  } catch (error) {
    console.error('[preview]', error)
    res.status(500).json({ error: error.message })
  }
})

// مسار متزامن (للتوافق مع الأدوات القديمة وcurl). الواجهة تستخدم /api/jobs.
app.post('/api/render', async (req, res) => {
  try {
    const body = req.body ?? {}
    const segments = sanitizeSegments(body.segments)
    if (!segments.length) return res.status(400).json({ error: 'أضف مقطعاً واحداً على الأقل فيه نص' })
    const project = {
      voice: body.voice || DEFAULT_VOICE,
      englishVoice: body.englishVoice || DEFAULT_ENGLISH_VOICE,
      settings: sanitizeSettings(body.settings),
      segments,
      dictionary: sanitizeDictionary(body.dictionary),
    }
    const result = await renderVoiceover(project, OUT_DIR)
    res.json(result)
  } catch (error) {
    console.error('[render]', error)
    res.status(500).json({ error: error.message })
  }
})

// ===================== طابور المهام (غير متزامن) =====================
// إنشاء مهمة توليد: يعيد فوراً بـ jobId، والتوليد يكمل في الخلفية.
app.post('/api/jobs', (req, res) => {
  const body = req.body ?? {}
  const segments = sanitizeSegments(body.segments)
  if (!segments.length) return res.status(400).json({ error: 'أضف مقطعاً واحداً على الأقل فيه نص' })

  const project = {
    voice: body.voice || DEFAULT_VOICE,
    englishVoice: body.englishVoice || DEFAULT_ENGLISH_VOICE,
    settings: sanitizeSettings(body.settings),
    segments,
    dictionary: sanitizeDictionary(body.dictionary),
  }

  const job = queue.enqueue({
    type: 'render',
    label: `${segments.length} مقطع`,
    payload: { project },
  })
  res.status(202).json({ ...job, queue: queue.stats })
})

// حالة مهمة واحدة
app.get('/api/jobs/:id', (req, res) => {
  const job = queue.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'مهمة غير موجودة' })
  res.json(job)
})

// سجل المهام (الأحدث أولاً)
app.get('/api/jobs', (_req, res) => res.json({ jobs: queue.list(30), queue: queue.stats }))

// إلغاء مهمة (في الانتظار: فوراً — قيد التشغيل: عند أول نقطة تحقّق)
app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = queue.cancel(req.params.id)
  if (!job) return res.status(404).json({ error: 'مهمة غير موجودة' })
  res.json(job)
})

// بثّ التقدّم المباشر (SSE) — بديل حقيقي عن شريط التقدّم الوهمي
app.get('/api/jobs/:id/events', (req, res) => {
  const job = queue.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'مهمة غير موجودة' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  let heartbeat = null
  let unsubscribe = null
  const close = () => {
    if (heartbeat) clearInterval(heartbeat)
    unsubscribe?.()
    if (!res.writableEnded) res.end()
  }

  const send = (snapshot) => {
    if (res.writableEnded) return
    res.write(`event: progress\ndata: ${JSON.stringify(snapshot)}\n\n`)
    if (['done', 'error', 'cancelled'].includes(snapshot.state)) {
      res.write('event: end\ndata: {}\n\n')
      close()
    }
  }

  unsubscribe = queue.subscribe(job.id, send)
  // لو كانت المهمة منتهية أصلاً، أغلقنا البث بعد اللقطة الأولى بدل تركه معلّقاً.
  if (res.writableEnded) return
  heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, 15_000)
  req.on('close', close)
})

app.use('/api', (_req, res) => res.status(404).json({ error: 'مسار غير معروف' }))

app.use((error, _req, res, _next) => {
  console.error('[unhandled]', error)
  if (res.headersSent) return
  res.status(500).json({ error: error?.message || 'خطأ داخلي' })
})

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`SAWTIX — FINIX Voice Studio يعمل على http://0.0.0.0:${PORT}`)
  console.log(auth.enabled ? '🔒 الوصول محمي باسم مستخدم وكلمة مرور (APP_PASSWORD)' : '🔓 الوصول مفتوح — اضبط APP_PASSWORD قبل النشر العام')
  const engines = await envInfo(true)
  if (!engines.ok) {
    console.warn('⚠️  بيئة ناقصة — لن يعمل التوليد على أكمل وجه:')
    for (const message of engines.messages) console.warn('   •', message)
  }
  // تنظيف قديم عند الإقلاع ثم كل ٦ ساعات
  pruneOldRenders().catch(() => {})
  setInterval(() => pruneOldRenders().catch(() => {}), 6 * 3600 * 1000).unref()
})
