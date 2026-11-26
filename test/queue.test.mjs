// اختبارات الطابور: التزامن، التقدّم، الترتيب، الإلغاء، والأخطاء.
// كلها بدوال تنفيذ وهمية — بلا شبكة ولا ffmpeg.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createQueue, JOB_STATES } from '../lib/queue.mjs'
import { CancelledError } from '../lib/cancellation.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('المهمة تكتمل وتُخزَّن نتيجتها وتصل للتقدّم 100', async () => {
  const queue = createQueue({ concurrency: 1 })
  const { id } = queue.enqueue({
    runner: async (_job, api) => {
      api.report({ stage: 'synth', label: 'توليد', percent: 40 })
      await sleep(5)
      api.report({ stage: 'final', label: 'تركيب', percent: 90 })
      return { url: '/files/x/voiceover.mp3' }
    },
  })

  await queue.whenIdle()
  const job = queue.get(id)
  assert.equal(job.state, JOB_STATES.DONE)
  assert.equal(job.progress.percent, 100)
  assert.equal(job.result.url, '/files/x/voiceover.mp3')
  assert.ok(job.startedAt && job.finishedAt)
})

test('التزامن محدود: لا تتجاوز المهام المتوازية الحد', async () => {
  const queue = createQueue({ concurrency: 2 })
  let active = 0
  let maxActive = 0
  const runner = async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await sleep(20)
    active -= 1
  }
  for (let i = 0; i < 6; i += 1) queue.enqueue({ runner })
  await queue.whenIdle()
  assert.equal(maxActive, 2)
  assert.equal(queue.list().filter((job) => job.state === JOB_STATES.DONE).length, 6)
})

test('المهام تُنفَّذ بترتيب الإضافة (FIFO) وموضع الانتظار صحيح', async () => {
  const queue = createQueue({ concurrency: 1 })
  const order = []
  const first = queue.enqueue({ runner: async () => { await sleep(15); order.push(1) } })
  const second = queue.enqueue({ runner: async () => { order.push(2) } })
  const third = queue.enqueue({ runner: async () => { order.push(3) } })

  await sleep(6) // ندع الأولى تبدأ فعلياً
  assert.equal(queue.get(first.id).state, JOB_STATES.RUNNING)
  assert.equal(queue.get(second.id).queuePosition, 1)
  assert.equal(queue.get(third.id).queuePosition, 2)

  await queue.whenIdle()
  assert.deepEqual(order, [1, 2, 3])
  assert.equal(queue.get(first.id).state, JOB_STATES.DONE)
})

test('إلغاء مهمة في الانتظار لا يشغّلها إطلاقاً', async () => {
  const queue = createQueue({ concurrency: 1 })
  let secondRan = false
  queue.enqueue({ runner: async () => { await sleep(30) } })
  const second = queue.enqueue({ runner: async () => { secondRan = true } })

  const cancelled = queue.cancel(second.id)
  assert.equal(cancelled.state, JOB_STATES.CANCELLED)

  await queue.whenIdle()
  assert.equal(secondRan, false)
  assert.equal(queue.get(second.id).state, JOB_STATES.CANCELLED)
})

test('إلغاء مهمة قيد التشغيل يوقفها عند أول نقطة تحقّق', async () => {
  const queue = createQueue({ concurrency: 1 })
  let reachedEnd = false
  const { id } = queue.enqueue({
    runner: async (_job, api) => {
      for (let step = 0; step < 20; step += 1) {
        if (api.isCancelled()) throw new CancelledError()
        await sleep(5)
        api.report({ stage: 'synth', percent: step * 4 })
      }
      reachedEnd = true
    },
  })

  await sleep(25)
  queue.cancel(id)
  await queue.whenIdle()

  const job = queue.get(id)
  assert.equal(job.state, JOB_STATES.CANCELLED)
  assert.equal(job.error, null, 'الإلغاء ليس خطأ')
  assert.equal(reachedEnd, false)
})

test('فشل المهمة يُسجَّل برسالة واضحة وحالة error', async () => {
  const queue = createQueue({ concurrency: 1 })
  const { id } = queue.enqueue({ runner: async () => { throw new Error('محرك الصوت غير مثبّت') } })
  await queue.whenIdle()
  const job = queue.get(id)
  assert.equal(job.state, JOB_STATES.ERROR)
  assert.equal(job.error, 'محرك الصوت غير مثبّت')
})

test('المشتركون يستلمون التحديثات ويُغلقون بنظافة', async () => {
  const queue = createQueue({ concurrency: 1 })
  const { id } = queue.enqueue({
    runner: async (_job, api) => {
      api.report({ percent: 50 })
      await sleep(10)
    },
  })

  const seen = []
  const unsubscribe = queue.subscribe(id, (snapshot) => seen.push(snapshot.progress.percent))
  await queue.whenIdle()
  unsubscribe()

  assert.ok(seen.includes(50))
  assert.equal(seen[seen.length - 1], 100)
})

test('السجل يُكتب على القرص ويُحمَّل بعد إعادة التشغيل', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sawti-queue-'))
  const first = createQueue({ concurrency: 1, outRoot: dir })
  const { id } = first.enqueue({
    payload: { note: 'ignored' },
    runner: async () => ({ url: '/files/abc/voiceover.mp3' }),
  })
  await first.whenIdle()

  const saved = JSON.parse(await fs.readFile(path.join(dir, id, 'job.json'), 'utf8'))
  assert.equal(saved.state, JOB_STATES.DONE)
  assert.equal(saved.result.url, '/files/abc/voiceover.mp3')

  const restarted = createQueue({ concurrency: 1, outRoot: dir })
  await restarted.loadHistory()
  assert.equal(restarted.get(id).state, JOB_STATES.DONE)

  await fs.rm(dir, { recursive: true, force: true })
})

test('إحصاءات الطابور تعكس المنتظر والمنفَّذ', async () => {
  const queue = createQueue({ concurrency: 1 })
  queue.enqueue({ runner: async () => { await sleep(20) } })
  queue.enqueue({ runner: async () => { await sleep(5) } })
  await sleep(5)
  const stats = queue.stats
  assert.equal(stats.concurrency, 1)
  assert.ok(stats.running + stats.queued <= stats.total)
  await queue.whenIdle()
  assert.equal(queue.stats.running, 0)
  assert.equal(queue.stats.queued, 0)
})
