// خط التوليد الكامل:
// تطبيع → مراجعة → خطة إلقاء (جمل/جُمل فرعية) → تشكيل هجين → فصل اللغات
// → توليد كل وحدة بصوتها → قياس → مطابقة المدة عند الطلب → تركيب على خط زمني
// → MP3 نهائي مع تسوية مستوى + SRT + ملف لكل مقطع.

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'
import { synthBatch, assertVoicesUsable } from './tts.mjs'
import { CancelledError, isCancelledError } from './cancellation.mjs'
import {
  applyDeltaToTail,
  finalizeDelta,
  fitPauses,
  timingError,
  totalGapMs,
  totalPauseMs,
} from './timing.mjs'
import { analyzeText, planDelivery } from './intent.mjs'
import {
  normalizeText,
  splitLanguageRuns,
  formatSrtTime,
  countWords,
  estimateSeconds,
} from './normalize.mjs'
import { buildSpokenTexts, diacriticCoverage } from './tashkeel.mjs'
import { reviewText } from './qa.mjs'
import { directText } from './director.mjs'
import { ALL_VOICES, resolveVoice, DEFAULT_VOICE, DEFAULT_ENGLISH_VOICE } from './voices.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

// أقصى تسريع يقبله المحرك (إصلاح ٤.٣: كان 75% فيفشل في مطابقة الجمل القصيرة)
const MAX_RATE = 100

// كاش الصوت المُولَّد: نفس (النص + الصوت + السرعة + الطبقة + المستوى) = نفس الملف
// بدون إعادة توليد من الشبكة. (نقص ٥.١)
export const CACHE_DIR = path.join(__dirname, '..', 'out', '_cache', 'audio')

// صمت الأطراف: كل وحدة من المحرك السحابي تعود بذيل صمت طويل (حتى ~١٫٥ ثانية)
// ورأس صمت قصير. تركه كما هو يجعل «مطابقة المدة» تتحقق بحشو صمت بدل إيقاع كلام،
// ويضخّم مدة كل مقطع بعدد وحداته. نقصّه بعد التوليد مع هامش صغير آمن.
export const SILENCE_THRESHOLD_DB = -45
const LEAD_SILENCE_MS = 20
const TAIL_SILENCE_MS = 60

/**
 * يقصّ الصمت من بداية/نهاية ملف صوتي في مكانه (بهامش صغير يمنع قطع الحروف).
 * @param {string} file
 * @returns {Promise<boolean>} هل تغيّر الملف؟
 */
export async function trimEdgeSilence(file) {
  const tmp = `${file}.trim.mp3`
  const chain = [
    `silenceremove=start_periods=1:start_threshold=${SILENCE_THRESHOLD_DB}dB:start_duration=0.02`,
    'areverse',
    `silenceremove=start_periods=1:start_threshold=${SILENCE_THRESHOLD_DB}dB:start_duration=0.02`,
    'areverse',
    `adelay=${LEAD_SILENCE_MS}:all=1`,
    `apad=pad_dur=${(TAIL_SILENCE_MS / 1000).toFixed(3)}`,
  ].join(',')
  try {
    await new Promise((resolve, reject) => {
      execFile(
        ffmpegPath,
        ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-af', chain, '-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '48000', '-ac', '1', tmp],
        { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 },
        (error, _stdout, errOut) => (error ? reject(new Error(errOut?.trim() || error.message)) : resolve()),
      )
    })
    const stat = await fs.stat(tmp)
    if (stat.size <= 700) throw new Error('ملف الصوت بعد القص أصغر من المتوقع')
    await fs.rename(tmp, file)
    return true
  } catch {
    await fs.unlink(tmp).catch(() => {})
    return false
  }
}
/** مفتاح الكاش لوحدة نطق. */
export function audioCacheKey(job) {
  return crypto
    .createHash('sha1')
    .update([job.voice, job.rate, job.pitch, job.volume, job.text].join('|'))
    .digest('hex')
    .slice(0, 32)
}

/**
 * يولّد الوحدات مع إعادة استخدام المكاش منها.
 * @param {{id:string,text:string,voice:string,rate:number,pitch:number,volume:number,out:string}[]} jobs
 * @param {string} cacheDir
 * @param {number} concurrency
 */
export async function synthWithCache(jobs, cacheDir = CACHE_DIR, concurrency = 4, hooks = {}) {
  if (!jobs.length) return []
  await fs.mkdir(cacheDir, { recursive: true }).catch(() => {})
  const results = new Array(jobs.length)
  const pending = []
  let done = 0
  const total = jobs.length
  const report = () => {
    done += 1
    hooks.onUnit?.(done, total)
  }
  if (hooks.isCancelled?.()) throw new CancelledError()

  await Promise.all(jobs.map(async (job, index) => {
    const file = path.join(cacheDir, `${audioCacheKey(job)}.mp3`)
    try {
      const stat = await fs.stat(file)
      if (stat.size > 700) {
        await fs.mkdir(path.dirname(job.out), { recursive: true })
        await fs.copyFile(file, job.out)
        await trimEdgeSilence(job.out)
        results[index] = { id: job.id, ok: true, bytes: stat.size, cached: true }
        report()
        return
      }
    } catch { /* غير مكاش */ }
    pending.push({ job, index, file })
  }))

  if (pending.length) {
    if (hooks.isCancelled?.()) throw new CancelledError()
    const fresh = await synthBatch(pending.map((item) => item.job), concurrency)
    const byId = new Map(fresh.map((result) => [result.id, result]))
    await Promise.all(pending.map(async ({ job, index, file }) => {
      const result = byId.get(job.id) ?? { id: job.id, ok: false, error: 'لا نتيجة لهذا المقطع' }
      // نقصّ الصمت قبل القياس وقبل حفظ الكاش، فتكون المدد كلها لكلام حقيقي.
      if (result.ok) await trimEdgeSilence(job.out)
      results[index] = result
      if (result.ok) await fs.copyFile(job.out, file).catch(() => {})
      report()
    }))
  }

  return results
}

/** يحذف ملفات كاش الصوت الأقدم من عدد أيام (تنظيف دوري). */
export async function pruneAudioCache(days = Number(process.env.CACHE_TTL_DAYS) || 14) {
  const limit = Date.now() - days * 24 * 3600 * 1000
  let removed = 0
  try {
    const files = await fs.readdir(CACHE_DIR)
    await Promise.all(files.map(async (name) => {
      const file = path.join(CACHE_DIR, name)
      try {
        const stat = await fs.stat(file)
        if (stat.mtimeMs < limit) {
          await fs.unlink(file)
          removed += 1
        }
      } catch { /* تجاهل */ }
    }))
  } catch { /* لا كاش بعد */ }
  return removed
}

/** قياس مدة ملف صوتي عبر ffmpeg (بدون ffprobe). */
export async function probeDuration(file) {
  const stderr = await new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', '-i', file], { maxBuffer: 8 * 1024 * 1024 }, (_error, _stdout, errOut) => resolve(errOut ?? ''))
  })
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  if (!match) throw new Error(`تعذّر قياس مدة الملف: ${path.basename(file)}`)
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/**
 * يركّب المقاطع على خط زمني مطلق ثم يطبّق تسوية مستوى صوت.
 * durationMs: طول الملف النهائي المطلوب. ضروري لأن وقفة نهاية المقطع ليست ملفاً
 * صوتياً؛ بدون حشوها تخرج المدد المعلنة و SRT أطول من الصوت الفعلي.
 */
async function mixTimeline(tracks, outFile, { loudness = true, gapMs = 0, durationMs = null } = {}) {
  if (!tracks.length) throw new Error('لا يوجد صوت للتركيب')
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  const filters = []
  tracks.forEach((track, index) => {
    args.push('-i', track.file)
    filters.push(`[${index}:a]adelay=${Math.max(0, Math.round(track.startMs ?? index * gapMs))}:all=1[s${index}]`)
  })
  const joined = tracks.map((_, index) => `[s${index}]`).join('')
  const chain = `${joined}amix=inputs=${tracks.length}:duration=longest:normalize=0`
  const polished = loudness ? `${chain},loudnorm=I=-16:TP=-1.5:LRA=11` : chain
  filters.push(durationMs ? `${polished},apad[mix]` : `${polished}[mix]`)
  if (durationMs) args.push('-t', (durationMs / 1000).toFixed(3))
  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[mix]',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-ac',
    '1',
    outFile,
  )
  await new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 16 * 1024 * 1024, timeout: 300_000 }, (error, _stdout, errOut) => {
      if (error) return reject(new Error(errOut?.trim() || error.message))
      resolve()
    })
  })
}

function buildSrt(placed) {
  return placed
    .map((item, index) => `${index + 1}\n${formatSrtTime(item.startSec)} --> ${formatSrtTime(item.endSec)}\n${item.text}\n`)
    .join('\n')
}

/** يجهّز وحدة نطق: نص مطبّع + خطة + تشكيل + أصوات. */
async function prepareUtterances(project) {
  const settings = project.settings ?? {}
  const segments = []
  const runTexts = []
  const dictionary = Array.isArray(project.dictionary) ? project.dictionary : []
  // مدير الاستوديو: يفهم النص أولاً ويوجّه الصوت والنمط والإبراز والنطق
  const projectText = project.segments.map((segment) => String(segment.text ?? '')).join('\n')
  const direction = settings.director === 'off'
    ? null
    : directText(projectText, {
        segments: project.segments,
        voice: project.voice,
        style: settings.style,
        dictionary,
      })

  project.segments.forEach((segment, segmentIndex) => {
    const directed = direction?.segments?.[segmentIndex]
    const normalized = normalizeText(segment.text)
    const language = splitLanguageRuns(normalized)[0]?.lang ?? 'ar'
    const analysis = analyzeText(normalized)
    const segmentStyle = segment.style
      || (settings.style && settings.style !== 'auto' ? settings.style : directed?.style)
    const segmentIntensity = segment.intensity === undefined || segment.intensity === null
      ? directed?.intensity
      : segment.intensity
    const parts = planDelivery(normalized, {
      intent: segment.intent,
      intensity: segmentIntensity,
      settings,
      style: segmentStyle,
      isFirst: segmentIndex === 0,
      emphasis: directed?.emphasis,
    })
    const requestedVoice = segment.voice || project.voice
    const segmentVoice = requestedVoice && requestedVoice !== 'auto' ? requestedVoice : directed?.voice

    const preparedParts = parts.map((part) => {
      const runs = splitLanguageRuns(part.text)
        .filter((run) => /[\u0600-\u06FFa-zA-Z0-9]/.test(run.text))
        .map((run, runIndex) => {
        const voice = resolveVoice({
          voice: segmentVoice || DEFAULT_VOICE,
          englishVoice: segment.englishVoice || project.englishVoice || DEFAULT_ENGLISH_VOICE,
          language: run.lang,
        })
        const id = `${segmentIndex}:${part.index}:${runIndex}`
        runTexts.push({ id, text: run.text })
        return { ...run, voice, id, file: '', duration: 0, spoken: run.text }
      })
      return { ...part, partIndex: part.index, runs }
    }).filter((part) => part.runs.length)

    segments.push({
      index: segmentIndex,
      id: segment.id ?? `seg-${segmentIndex}`,
      source: segment,
      text: normalized,
      displayText: String(segment.text).replace(/\s+/g, ' ').trim(),
      language,
      analysis,
      parts: preparedParts,
      rateOverride: 0,
      target: Number(segment.target) > 0 ? Number(segment.target) : null,
      explicitStart: segment.start !== null && segment.start !== undefined && segment.start !== '' ? Number(segment.start) : null,
      duration: 0,
    })
  })

  const spoken = await buildSpokenTexts(runTexts.map((item) => item.text), {
    diacritics: settings.diacritics === 'off' || settings.diacritics === 'light' ? settings.diacritics : 'smart',
    dictionary,
  })
  const spokenById = new Map(runTexts.map((item, index) => [item.id, spoken[index] ?? item.text]))
  for (const segment of segments) {
    for (const part of segment.parts) {
      for (const run of part.runs) run.spoken = spokenById.get(run.id) ?? run.text
    }
  }

  return { segments, direction }
}

/** ملخص موجز لإخراج المدير يُعاد للواجهة والسجل (بلا كائنات ضخمة). */
function directionSummary(direction) {
  if (!direction) return null
  return {
    genre: direction.contentType,
    genreLabel: direction.label,
    tone: direction.tone,
    audience: direction.audience.label,
    confidence: direction.confidence,
    voice: direction.voice,
    suggestedVoice: direction.suggestedVoice,
    style: direction.style,
    intensity: direction.intensity,
    summary: direction.summary,
    notes: direction.notes,
    pronunciation: {
      score: direction.pronunciation.score,
      grade: direction.pronunciation.grade,
      verdict: direction.pronunciation.verdict,
      summary: direction.pronunciation.summary,
      items: direction.pronunciation.items.slice(0, 10),
      auto: direction.pronunciation.auto.slice(0, 12),
    },
    segments: direction.segments.map((item) => ({
      index: item.index,
      role: item.role,
      intent: item.intent,
      emphasis: item.emphasis,
      note: item.note,
    })),
  }
}

function partDuration(part, gapMs = 90) {
  const speech = part.runs.reduce((sum, run) => sum + run.duration, 0)
  return speech + Math.max(0, part.runs.length - 1) * gapMs
}

function segmentDuration(segment, gapMs = 90) {
  return segment.parts.reduce((sum, part) => sum + partDuration(part, gapMs), 0)
}

function buildJobs(segments, dir, round = 1) {
  const jobs = []
  for (const segment of segments) {
    for (const part of segment.parts) {
      for (const run of part.runs) {
        jobs.push({
          id: run.id,
          text: run.spoken,
          voice: run.voice,
          rate: clamp(Math.round(part.rate + segment.rateOverride), -30, MAX_RATE),
          pitch: part.pitch,
          volume: part.volume,
          out: path.join(dir, `r${round}_${run.id.replace(/:/g, '-')}.mp3`),
        })
      }
    }
  }
  return jobs
}

/** يتحقق أن كل الأصوات المستخدمة موجودة عند المزوّد (رسالة عربية واضحة). */
async function verifyProjectVoices(segments, project) {
  const ids = [
    project.voice,
    project.englishVoice,
    ...segments.flatMap((segment) => segment.parts.flatMap((part) => part.runs.map((run) => run.voice))),
  ].filter((id) => id && id !== 'auto')
  const labels = Object.fromEntries(ALL_VOICES.map((voice) => [voice.id, voice.label]))
  await assertVoicesUsable(ids, labels)
}

/**
 * توليد مشروع كامل.
 * @param {{voice:string, englishVoice?:string, settings:object, segments:object[], dictionary?:object[]}} project
 * @param {string} outRoot
 */
export async function renderVoiceover(project, outRoot, options = {}) {
  const jobId = options.jobId ?? `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
  const dir = path.join(outRoot, jobId)
  const segDir = path.join(dir, 'segments')
  await fs.mkdir(segDir, { recursive: true })

  // ---- تقارير التقدّم والإلغاء (اختيارية: تعمل بلا طابور أيضاً)
  const report = (stage, label, percent, extra = {}) => options.onProgress?.({ stage, label, percent, ...extra })
  const checkCancelled = () => {
    if (options.isCancelled?.()) throw new CancelledError()
  }
  let unitsDone = 0

  const settings = project.settings ?? {}
  const timingMode = settings.timingMode === 'exact' ? 'exact' : 'natural'
  const gapMs = Math.round((Number(settings.defaultGap) || 0) * 1000)

  report('prepare', 'تطبيع النص والتشكيل', 3)
  const { segments, direction } = await prepareUtterances(project)
  checkCancelled()

  if (!segments.length) throw new Error('أضف مقطعاً واحداً على الأقل')
  const empty = segments.find((segment) => !segment.parts.length)
  if (empty) throw new Error(`المقطع #${empty.index + 1} صار فارغاً بعد التنظيف`)

  await verifyProjectVoices(segments, project)
  checkCancelled()

  // ---- الجولة الأولى: نطق طبيعي
  const jobs = buildJobs(segments, dir, 1)
  report('synth', 'توليد وحدات النطق', 6, { doneUnits: 0, totalUnits: jobs.length })
  const results = await synthWithCache(jobs, CACHE_DIR, 4, {
    isCancelled: options.isCancelled,
    onUnit: (done, total) => {
      unitsDone = done
      report('synth', 'توليد وحدات النطق', 6 + (done / Math.max(1, total)) * 58, {
        doneUnits: done,
        totalUnits: total,
      })
    },
  })
  checkCancelled()
  const byId = new Map(results.map((result) => [result.id, result]))
  const failed = jobs.filter((job) => !byId.get(job.id)?.ok)
  if (failed.length) {
    const detail = failed.slice(0, 3).map((job) => `${job.id}: ${byId.get(job.id)?.error ?? 'خطأ'}`).join(' | ')
    throw new Error(`تعذّر توليد ${failed.length} وحدة صوتية — ${detail}`)
  }

  await Promise.all(jobs.map(async (job) => {
    const run = findRun(segments, job.id)
    run.file = job.out
    run.duration = await probeDuration(job.out)
  }))

  report('timing', timingMode === 'exact' ? 'ضبط المدة بالثانية' : 'حساب الخط الزمني', 68)
  checkCancelled()

  // ---- مطابقة المدة لكل مقطع عند وضع «مطابق بالثانية»
  // الترتيب الصحيح: (١) اضغط الوقفات إن كانت وحدها تأكل الميزانية،
  // (٢) عدّل سرعة الكلام، (٣) أكمل النقص أو اقصص الفائض من صمت النهاية،
  // وبعد ذلك فقط يُعلَن أن المدة لم تُصب. (إصلاح ٤.٣ في تقرير النواقص)
  if (timingMode === 'exact') {
    const targeted = segments.filter((segment) => segment.target).length
    let timed = 0
    for (const segment of segments) {
      if (!segment.target) continue
      report('timing', 'ضبط المدة بالثانية', 68 + (timed / Math.max(1, targeted)) * 6, {
        doneUnits: timed,
        totalUnits: targeted,
      })
      timed += 1
      const targetMs = segment.target * 1000
      const baseRate = segment.parts[0]?.rate ?? 0
      const speechMs = () => segment.parts.reduce(
        (sum, part) => sum + part.runs.reduce((total, run) => total + run.duration * 1000, 0), 0,
      )
      const snapshot = () => segment.parts.flatMap((part) => part.runs.map((run) => ({ run, file: run.file, duration: run.duration })))
      const errorNow = (speech = speechMs()) => timingError({ parts: segment.parts, speechMs: speech, targetMs })

      // (١) الوقفات أولاً
      const fitted = fitPauses({ parts: segment.parts, speechMs: speechMs(), targetMs })
      if (fitted.scale < 1) {
        segment.parts = fitted.parts
        segment.pausesScaled = Math.round(fitted.scale * 100)
      }

      let best = { rateOverride: 0, speech: speechMs(), error: errorNow() }

      checkCancelled()
      for (let round = 2; round <= 4 && best.error > 0.02; round += 1) {
        const fixedMs = totalPauseMs(segment.parts) + totalGapMs(segment.parts)
        const availableMs = targetMs - fixedMs
        if (availableMs < 250) break // الوقفات المضغوطة وحدها تستهلك المدة المستهدفة
        const currentTotalRate = 1 + (baseRate + best.rateOverride) / 100
        const desiredTotalRate = currentTotalRate * (best.speech / availableMs)
        const candidate = clamp(Math.round((desiredTotalRate - 1) * 100 - baseRate), -30, MAX_RATE)
        if (candidate === best.rateOverride) break

        const previous = snapshot()
        segment.rateOverride = candidate
        const roundJobs = buildJobs([segment], dir, round)
        const roundResults = await synthWithCache(roundJobs, CACHE_DIR, 3)
        if (roundResults.some((result) => !result.ok)) {
          segment.rateOverride = best.rateOverride
          await Promise.all(roundJobs.map((job) => fs.unlink(job.out).catch(() => {})))
          break
        }
        const durations = await Promise.all(roundJobs.map((job) => probeDuration(job.out)))
        roundJobs.forEach((job, index) => {
          const run = findRun([segment], job.id)
          run.file = job.out
          run.duration = durations[index]
        })

        const speech = speechMs()
        const error = errorNow(speech)
        if (error < best.error - 0.01) {
          best = { rateOverride: candidate, speech, error }
          await Promise.all(previous.map((item) => (item.file === findRun([segment], item.run.id)?.file ? null : fs.unlink(item.file).catch(() => {}))))
        } else {
          // التجربة أسوأ: نرجع الملفات السابقة ونثبّت أفضل سرعة
          await Promise.all(roundJobs.map((job) => fs.unlink(job.out).catch(() => {})))
          previous.forEach((item) => {
            item.run.file = item.file
            item.run.duration = item.duration
          })
          segment.rateOverride = best.rateOverride
          break
        }
      }

      segment.rateOverride = best.rateOverride
      segment.rateUsed = best.rateOverride + baseRate

      // (٣) تكميل النقص أو قصّ الفائض من صمت النهاية بدل إعلان الفشل
      const delta = finalizeDelta({ parts: segment.parts, speechMs: speechMs(), targetMs })
      if (delta.padMs || delta.trimMs) {
        const pauseBefore = totalPauseMs(segment.parts)
        segment.parts = applyDeltaToTail(segment.parts, delta)
        // نُبلّغ بالمقدار المُطبَّق فعلاً، لا بالمطلوب: القصّ لا يمكن أن يتجاوز صمت النهاية المتاح.
        const pauseAfter = totalPauseMs(segment.parts)
        segment.timingPaddedMs = Math.max(0, pauseAfter - pauseBefore)
        segment.timingTrimmedMs = Math.max(0, pauseBefore - pauseAfter)
      }
      segment.targetMissed = errorNow() > 0.05
      if (segment.targetMissed) segment.timingError = Math.round(errorNow() * 1000) / 10
    }
  }

  report('timing', timingMode === 'exact' ? 'تم ضبط المدة' : 'تم حساب الخط الزمني', 74)
  checkCancelled()

  // ---- التركيب على خط زمني
  let cursorMs = 0
  const placedParts = []
  const placedSegments = []
  for (const segment of segments) {
    const durationMs = Math.round(segmentDuration(segment) * 1000)
    const useExplicit = segment.explicitStart !== null && Number.isFinite(segment.explicitStart) && segment.explicitStart >= 0
    const startMs = useExplicit ? Math.round(clamp(segment.explicitStart, 0, 3600) * 1000) : Math.round(cursorMs)
    let inner = startMs

    for (const part of segment.parts) {
      inner += part.pauseBefore
      const speechStart = inner
      for (const run of part.runs) {
        const runMs = Math.round(run.duration * 1000)
        placedParts.push({
          segmentIndex: segment.index,
          runId: run.id,
          text: run.spoken,
          displayText: part.text,
          file: run.file,
          startMs: inner,
          durationMs: runMs,
        })
        inner += runMs + 90
      }
      inner -= 90
      inner += part.pauseAfter
      part.startMs = speechStart
      part.endMs = inner
    }

    const endMs = inner
    placedSegments.push({
      index: segment.index,
      id: segment.id,
      text: segment.displayText,
      // النص المنطوق فعلياً (بعد التشكيل وقاموس النطق) لا نص الخطة
      spoken: segment.parts.flatMap((part) => part.runs.map((run) => run.spoken)).join(' '),
      intent: segment.analysis.intent,
      intentLabel: segment.analysis.label,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      explicit: useExplicit,
      target: segment.target,
      targetMissed: Boolean(segment.target && Math.abs((endMs - startMs) / 1000 / segment.target - 1) > 0.05),
      timingErrorPercent: segment.target ? Math.round(Math.abs((endMs - startMs) / 1000 / segment.target - 1) * 1000) / 10 : 0,
      pausesScaled: segment.pausesScaled ?? 100,
      paddedMs: segment.timingPaddedMs ?? 0,
      trimmedMs: segment.timingTrimmedMs ?? 0,
      rateUsed: Math.round((segment.rateUsed ?? segment.parts[0]?.rate ?? 0)),
      language: segment.language,
      review: reviewText(segment.displayText),
      parts: segment.parts.map((part) => ({
        text: part.text,
        role: part.role,
        intent: part.intent,
        note: part.note,
        rate: part.rate + segment.rateOverride,
        startSec: Math.round(part.startMs) / 1000,
        endSec: Math.round(part.endMs) / 1000,
        pauseBefore: part.pauseBefore,
        pauseAfter: part.pauseAfter,
      })),
    })
    cursorMs = Math.max(cursorMs, endMs) + gapMs
  }

  // ---- MP3 لكل مقطع (بلا تسوية مستوى، حتى تبقى المستويات متسقة مع الملف الكامل)
  report('segments', 'تركيب المقاطع', 75, { doneUnits: 0, totalUnits: placedSegments.length })
  let mixedSegments = 0
  await Promise.all(placedSegments.map(async (segment) => {
    const tracks = placedParts
      .filter((part) => part.segmentIndex === segment.index)
      .map((part) => ({ file: part.file, startMs: Math.round(part.startMs - segment.startMs) }))
    const name = `${String(segment.index + 1).padStart(2, '0')}_${segment.intent}.mp3`
    const target = path.join(segDir, name)
    await mixTimeline(tracks, target, { loudness: false, durationMs: segment.durationMs })
    segment.fileName = name
    segment.url = `/files/${jobId}/segments/${encodeURIComponent(name)}`
    mixedSegments += 1
    report('segments', 'تركيب المقاطع', 75 + (mixedSegments / Math.max(1, placedSegments.length)) * 17, {
      doneUnits: mixedSegments,
      totalUnits: placedSegments.length,
    })
  }))
  checkCancelled()

  report('final', 'التركيب النهائي وتسوية المستوى', 94)
  const fullPath = path.join(dir, 'voiceover.mp3')
  const timelineEndMs = Math.max(0, ...placedSegments.map((segment) => segment.endMs))
  await mixTimeline(placedParts, fullPath, { loudness: true, durationMs: timelineEndMs })
  const totalDuration = await probeDuration(fullPath)

  const srtPath = path.join(dir, 'subtitles.srt')
  await fs.writeFile(srtPath, buildSrt(placedSegments.map((segment) => ({
    text: segment.text,
    startSec: segment.startMs / 1000,
    endSec: segment.endMs / 1000,
  }))), 'utf8')

  await Promise.all(placedParts.map((part) => fs.unlink(part.file).catch(() => {})))
  report('done', 'تم التوليد', 100, { doneUnits: placedSegments.length, totalUnits: placedSegments.length })

  return {
    jobId,
    voice: project.voice,
    englishVoice: project.englishVoice,
    direction: directionSummary(direction),
    timingMode,
    durationSec: Math.round(totalDuration * 100) / 100,
    url: `/files/${jobId}/voiceover.mp3`,
    srtUrl: `/files/${jobId}/subtitles.srt`,
    stats: {
      segments: placedSegments.length,
      unitsCached: results.filter((result) => result.cached).length,
      words: placedSegments.reduce((sum, segment) => sum + countWords(segment.text), 0),
      characters: placedSegments.reduce((sum, segment) => sum + segment.text.length, 0),
      utterances: placedParts.length,
    },
    segments: placedSegments.map((segment) => ({
      index: segment.index,
      id: segment.id,
      text: segment.text,
      spoken: segment.spoken,
      intent: segment.intent,
      intentLabel: segment.intentLabel,
      language: segment.language,
      startSec: Math.round(segment.startMs) / 1000,
      endSec: Math.round(segment.endMs) / 1000,
      durationSec: Math.round(segment.durationMs) / 1000,
      explicit: segment.explicit,
      target: segment.target,
      targetMissed: segment.targetMissed,
      timingErrorPercent: segment.timingErrorPercent,
      pausesScaled: segment.pausesScaled,
      paddedMs: segment.paddedMs,
      trimmedMs: segment.trimmedMs,
      rateUsed: segment.rateUsed,
      url: segment.url,
      fileName: segment.fileName,
      parts: segment.parts,
    })),
  }
}

function findRun(segments, id) {
  const [segmentIndex, partIndex, runIndex] = id.split(':').map(Number)
  const segment = segments.find((item) => item.index === segmentIndex)
  const part = segment?.parts.find((item) => item.partIndex === partIndex)
  return part?.runs[runIndex]
}

/** تحليل مشروع كامل بلا توليد: مراجعة + خطة إلقاء + تقدير مدة. */
export async function analyzeProject(project) {
  const settings = project.settings ?? {}
  const dictionary = Array.isArray(project.dictionary) ? project.dictionary : []
  const segments = []
  const allParts = []
  const allTexts = []
  const projectText = project.segments.map((segment) => String(segment.text ?? '')).join('\n')
  const direction = settings.director === 'off'
    ? null
    : directText(projectText, {
        segments: project.segments,
        voice: project.voice,
        style: settings.style,
        dictionary,
      })

  project.segments.forEach((segment, index) => {
    const normalized = normalizeText(segment.text)
    const directed = direction?.segments?.[index]
    const parts = planDelivery(normalized, {
      intent: segment.intent,
      intensity: segment.intensity ?? directed?.intensity,
      settings,
      style: segment.style || (settings.style && settings.style !== 'auto' ? settings.style : directed?.style),
      isFirst: index === 0,
      emphasis: directed?.emphasis,
    })
    segments.push({
      id: segment.id,
      text: normalized,
      review: reviewText(segment.text, { dictionary, diacritics: settings.diacritics }),
      analysis: analyzeText(normalized),
      parts,
      estimated: parts.reduce((sum, part) => sum + part.estimated + (part.pauseBefore + part.pauseAfter) / 1000, 0),
    })
    allParts.push(...parts.map((part) => part.text))
    allTexts.push(normalized)
  })

  const spoken = await buildSpokenTexts(allTexts, {
    diacritics: settings.diacritics === 'off' || settings.diacritics === 'light' ? settings.diacritics : 'smart',
    dictionary,
  })

  return {
    segments: segments.map((segment, index) => ({
      ...segment,
      spoken: spoken[index],
      coverage: diacriticCoverage(spoken[index] ?? ''),
      estimated: Math.round(segment.estimated * 10) / 10,
      estimatedNatural: estimateSeconds(segment.text),
    })),
    totalEstimated: Math.round(segments.reduce((sum, segment) => sum + segment.estimated, 0) * 10) / 10,
    parts: allParts.length,
    direction: directionSummary(direction),
  }
}

/** معاينة وحدة واحدة بنفس خط الإنتاج (لسماع نبرة قبل التوليد الكامل). */
export async function previewUtterance({ text, voice, englishVoice, settings, dictionary }, outDir) {
  const jobId = `p_${crypto.createHash('sha1').update(JSON.stringify({ text, voice, englishVoice, settings, dictionary })).digest('hex').slice(0, 16)}`
  const dir = path.join(outDir, jobId)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'preview.mp3')

  const normalized = normalizeText(text)
  const direction = settings?.director === 'off'
    ? null
    : directText(text, {
        segments: [{ text }],
        voice,
        style: settings?.style,
        intensity: settings?.intensity,
        dictionary,
      })
  const directed = direction?.segments?.[0]
  const chosenVoice = voice && voice !== 'auto' ? voice : direction?.voice?.id || DEFAULT_VOICE
  const parts = planDelivery(normalized, {
    intent: settings?.intent,
    intensity: settings?.intensity ?? directed?.intensity,
    settings,
    style: settings?.style && settings.style !== 'auto' ? settings.style : directed?.style,
    emphasis: directed?.emphasis,
  })
  if (!parts.length) throw new Error('لا يوجد نص قابل للنطق')

  const runs = []
  for (const [partIndex, part] of parts.entries()) {
    const filteredRuns = splitLanguageRuns(part.text).filter((run) => /[\u0600-\u06FFa-zA-Z0-9]/.test(run.text))
    if (!filteredRuns.length) continue
    for (const [runIndex, run] of filteredRuns.entries()) {
      runs.push({
        id: `${partIndex}:${runIndex}`,
        text: run.text,
        lang: run.lang,
        voice: resolveVoice({
          voice: chosenVoice,
          englishVoice: englishVoice || DEFAULT_ENGLISH_VOICE,
          language: run.lang,
        }),
        rate: clamp(Math.round(part.rate + (settings?.rate ?? 0)), -30, MAX_RATE),
        pitch: part.pitch,
        volume: part.volume,
      })
    }
  }

  await assertVoicesUsable(
    [chosenVoice, englishVoice || DEFAULT_ENGLISH_VOICE, ...runs.map((run) => run.voice)].filter((id) => id && id !== 'auto'),
    Object.fromEntries(ALL_VOICES.map((item) => [item.id, item.label])),
  )

  const spoken = await buildSpokenTexts(runs.map((run) => run.text), {
    diacritics: settings?.diacritics,
    dictionary,
  })

  const jobs = runs.map((run, index) => ({
    id: run.id,
    text: spoken[index] ?? run.text,
    voice: run.voice,
    rate: run.rate,
    pitch: run.pitch,
    volume: run.volume,
    out: path.join(dir, `run-${index}.mp3`),
  }))
  const results = await synthWithCache(jobs, CACHE_DIR, 3)
  if (results.some((result) => !result.ok)) {
    throw new Error(results.find((result) => !result.ok)?.error ?? 'فشل التوليد')
  }
  const tracks = await Promise.all(jobs.map(async (job, index) => ({
    file: job.out,
    startMs: index * 0,
    duration: await probeDuration(job.out),
  })))
  let cursor = 0
  for (const track of tracks) {
    track.startMs = Math.round(cursor)
    cursor += track.duration * 1000 + 90
  }
  await mixTimeline(tracks, file, { loudness: true })
  await Promise.all(jobs.map((job) => fs.unlink(job.out).catch(() => {})))
  const duration = await probeDuration(file)

  return {
    file,
    duration: Math.round(duration * 100) / 100,
    voice: chosenVoice,
    spoken: spoken.join(' '),
    plan: parts,
    coverage: diacriticCoverage(spoken.join(' ')),
    direction: directionSummary(direction),
  }
}
