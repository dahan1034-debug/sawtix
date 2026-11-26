// طابور مهام التوليد:
// - يمنع تعليق الطلب الواحد لثوانٍ طويلة، ويسمح بمتابعة التقدّم والاستئناف والإلغاء.
// - محدود التزامن حتى لا نُغرق مزوّد الصوت بالطلبات.
// - يحفظ نتيجة كل مهمة في out/<jobId>/job.json ليبقى السجل بعد إعادة التشغيل.

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { CancelledError, isCancelledError } from './cancellation.mjs'

export const JOB_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
})

const FINAL_STATES = new Set([JOB_STATES.DONE, JOB_STATES.ERROR, JOB_STATES.CANCELLED])
const MAX_JOBS_IN_MEMORY = Number(process.env.QUEUE_MAX_JOBS) || 80

/** يصور حالة مهمة للعميل (بلا دوال ولا حمولات ثقيلة). */
export function jobSnapshot(job) {
  return {
    id: job.id,
    type: job.type,
    state: job.state,
    label: job.label,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    queuePosition: job.queuePosition ?? null,
    progress: { ...job.progress },
    error: job.error ?? null,
    result: job.state === JOB_STATES.DONE ? job.result : null,
    cancelRequested: Boolean(job.cancelRequested),
  }
}

/**
 * ينشئ طابور مهام.
 * @param {{
 *   concurrency?: number,
 *   outRoot?: string,
 *   runner?: (job: object, api: {report: Function, isCancelled: Function}) => Promise<any>,
 * }} options
 */
export function createQueue({ concurrency = Number(process.env.QUEUE_CONCURRENCY) || 2, outRoot = null, runner = null } = {}) {
  /** @type {Map<string, object>} */
  const jobs = new Map()
  const emitters = new Map()
  let running = 0
  let idleWaiters = []

  const emit = (job) => {
    const emitter = emitters.get(job.id)
    if (emitter) emitter.emit('update', jobSnapshot(job))
  }

  const settleWaiters = () => {
    if (running === 0 && [...jobs.values()].every((job) => FINAL_STATES.has(job.state))) {
      const waiters = idleWaiters
      idleWaiters = []
      waiters.forEach((resolve) => resolve())
    }
  }

  function trimMemory() {
    if (jobs.size <= MAX_JOBS_IN_MEMORY) return
    const finished = [...jobs.values()]
      .filter((job) => FINAL_STATES.has(job.state))
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
    while (jobs.size > MAX_JOBS_IN_MEMORY && finished.length) {
      const oldest = finished.shift()
      jobs.delete(oldest.id)
      emitters.delete(oldest.id)
    }
  }

  function refreshPositions() {
    let position = 0
    for (const job of jobs.values()) {
      if (job.state === JOB_STATES.QUEUED) {
        position += 1
        job.queuePosition = position
      } else {
        job.queuePosition = null
      }
    }
  }

  async function persist(job) {
    if (!outRoot) return
    const dir = path.join(outRoot, job.id)
    try {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify(jobSnapshot(job), null, 2), 'utf8')
    } catch { /* السجل ميزة إضافية لا تُفشل المهمة */ }
  }

  async function pump() {
    refreshPositions()
    if (running >= concurrency) return
    const next = [...jobs.values()].find((job) => job.state === JOB_STATES.QUEUED)
    if (!next) {
      settleWaiters()
      return
    }

    running += 1
    next.state = JOB_STATES.RUNNING
    next.startedAt = Date.now()
    next.queuePosition = null
    emit(next)

    const api = {
      report: (patch) => {
        next.progress = { ...next.progress, ...patch }
        if (next.progress.percent !== undefined) {
          next.progress.percent = Math.max(0, Math.min(100, Math.round(next.progress.percent)))
        }
        emit(next)
      },
      isCancelled: () => Boolean(next.cancelRequested),
    }

    try {
      const result = await (runner ?? next.runner)(next, api)
      if (next.cancelRequested) throw new CancelledError()
      next.result = result
      next.state = JOB_STATES.DONE
      next.progress = { ...next.progress, percent: 100, stage: 'done', label: 'تم التوليد' }
    } catch (error) {
      if (isCancelledError(error) || next.cancelRequested) {
        next.state = JOB_STATES.CANCELLED
        next.error = null
        next.progress = { ...next.progress, stage: 'cancelled', label: 'أُلغيت المهمة' }
      } else {
        next.state = JOB_STATES.ERROR
        next.error = error?.message || 'خطأ غير متوقع'
        next.progress = { ...next.progress, stage: 'error', label: 'فشل التوليد' }
      }
    } finally {
      running -= 1
      next.finishedAt = Date.now()
      await persist(next)
      emit(next)
      trimMemory()
      // نكمل الطابور في الدورة التالية حتى لا نتعمّق في الاستدعاء
      setImmediate(() => { pump().catch(() => {}) })
    }
  }

  return {
    concurrency,

    /**
     * يضيف مهمة للطابور.
     * @param {{type?: string, label?: string, payload?: object, runner?: Function}} input
     */
    enqueue(input = {}) {
      // نتحقق قبل الإضافة حتى لا تبقى مهمة بلا دالة تنفيذ عالقة في الذاكرة.
      if (!runner && !input.runner) throw new Error('الطابور يحتاج دالة تنفيذ (runner)')
      const job = {
        id: input.id ?? `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
        type: input.type ?? 'render',
        label: input.label ?? 'توليد تعليق صوتي',
        payload: input.payload ?? null,
        runner: input.runner ?? null,
        state: JOB_STATES.QUEUED,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        queuePosition: null,
        cancelRequested: false,
        progress: { stage: 'queued', label: 'في الانتظار', percent: 0, doneUnits: 0, totalUnits: 0 },
        result: null,
        error: null,
      }
      jobs.set(job.id, job)
      emitters.set(job.id, new EventEmitter())
      refreshPositions()
      emit(job)
      setImmediate(() => { pump().catch(() => {}) })
      return jobSnapshot(job)
    },

    get(id) {
      const job = jobs.get(id)
      return job ? jobSnapshot(job) : null
    },

    list(limit = 20) {
      return [...jobs.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map(jobSnapshot)
    },

    /** يطلب إلغاء مهمة (في الانتظار تُلغى فوراً، وقيد التشغيل تُوقَف عند أول نقطة تحقّق). */
    cancel(id) {
      const job = jobs.get(id)
      if (!job) return null
      if (FINAL_STATES.has(job.state)) return jobSnapshot(job)
      job.cancelRequested = true
      if (job.state === JOB_STATES.QUEUED) {
        job.state = JOB_STATES.CANCELLED
        job.finishedAt = Date.now()
        job.progress = { ...job.progress, stage: 'cancelled', label: 'أُلغيت قبل البدء' }
        persist(job).catch(() => {})
        emit(job)
      } else {
        job.progress = { ...job.progress, label: 'جارٍ الإلغاء…' }
        emit(job)
      }
      refreshPositions()
      return jobSnapshot(job)
    },

    /** يشترك في تحديثات مهمة. يعيد دالة إلغاء الاشتراك. */
    subscribe(id, listener) {
      let emitter = emitters.get(id)
      if (!emitter) {
        emitter = new EventEmitter()
        emitters.set(id, emitter)
      }
      emitter.on('update', listener)
      const job = jobs.get(id)
      if (job) listener(jobSnapshot(job))
      return () => emitter.off('update', listener)
    },

    /** ينتظر انتهاء كل المهام (للاختبارات والإيقاف الآمن). */
    whenIdle() {
      if (running === 0 && [...jobs.values()].every((job) => FINAL_STATES.has(job.state))) return Promise.resolve()
      return new Promise((resolve) => idleWaiters.push(resolve))
    },

    /** يحمّل سجل مهام سابقة من القرص (بعد إعادة تشغيل الخادم). */
    async loadHistory(limit = 30) {
      if (!outRoot) return []
      let entries = []
      try {
        entries = await fs.readdir(outRoot, { withFileTypes: true })
      } catch {
        return []
      }
      const loaded = []
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue
        try {
          const raw = await fs.readFile(path.join(outRoot, entry.name, 'job.json'), 'utf8')
          const snapshot = JSON.parse(raw)
          if (!snapshot?.id || !FINAL_STATES.has(snapshot.state)) continue
          if (jobs.has(snapshot.id)) continue
          jobs.set(snapshot.id, {
            ...snapshot,
            payload: null,
            runner: null,
            progress: snapshot.progress ?? { stage: snapshot.state, label: '', percent: 100 },
          })
          loaded.push(snapshot)
        } catch { /* مهمة قديمة بلا سجل */ }
      }
      return loaded.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
    },

    get stats() {
      return {
        concurrency,
        running,
        queued: [...jobs.values()].filter((job) => job.state === JOB_STATES.QUEUED).length,
        total: jobs.size,
      }
    },
  }
}
