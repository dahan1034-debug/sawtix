// حسابات مطابقة المدة («مطابق بالثانية») كدوال نقية قابلة للاختبار:
// الفصل هنا يسمح باختبار منطق التوقيت بلا شبكة ولا ffmpeg.

/** الفاصل الصامت بين وحدات النطق داخل المقطع (ms) — مطابق لما في render. */
export const RUN_GAP_MS = 90

/** مجموع الوقفات المعلنة (قبل/بعد) في أجزاء المقطع. */
export function totalPauseMs(parts) {
  return parts.reduce((sum, part) => sum + (Number(part.pauseBefore) || 0) + (Number(part.pauseAfter) || 0), 0)
}

/** الفواصل الصامتة بين الوحدات داخل الجزء. */
export function totalGapMs(parts) {
  return parts.reduce((sum, part) => sum + Math.max(0, (part.runs?.length ?? 0) - 1) * RUN_GAP_MS, 0)
}

/**
 * يضغط الوقفات إذا كانت وحدها تستهلك ميزانية المدة المستهدفة.
 * @param {{parts: object[], speechMs: number, targetMs: number}} input
 * @returns {{parts: object[], scale: number, pauseMs: number}}
 */
export function fitPauses({ parts, speechMs, targetMs }) {
  const pauseMs = totalPauseMs(parts)
  const gapMs = totalGapMs(parts)
  const budget = targetMs - speechMs - gapMs
  if (budget >= pauseMs || pauseMs <= 0) {
    return { parts, scale: 1, pauseMs }
  }
  const scale = Math.max(0, Math.min(1, budget / pauseMs))
  const fitted = parts.map((part) => ({
    ...part,
    pauseBefore: Math.round((Number(part.pauseBefore) || 0) * scale),
    pauseAfter: Math.round((Number(part.pauseAfter) || 0) * scale),
  }))
  return { parts: fitted, scale, pauseMs: totalPauseMs(fitted) }
}

/**
 * بعد ضبط السرعة: كم يتبقى لتكميل المدة أو لقصّها من صمت النهاية؟
 * @param {{parts: object[], speechMs: number, targetMs: number, toleranceMs?: number}} input
 * @returns {{deltaMs: number, padMs: number, trimMs: number}}
 */
export function finalizeDelta({ parts, speechMs, targetMs, toleranceMs = 80 }) {
  const total = speechMs + totalPauseMs(parts) + totalGapMs(parts)
  const delta = Math.round(targetMs - total)
  if (Math.abs(delta) <= toleranceMs) return { deltaMs: delta, padMs: 0, trimMs: 0 }
  return delta > 0
    ? { deltaMs: delta, padMs: delta, trimMs: 0 }
    : { deltaMs: delta, padMs: 0, trimMs: -delta }
}

/**
 * يوزّع التكميل/القصّ على صمت آخر جزء (أقل أثراً على الكلام).
 * @returns {object[]} أجزاء جديدة
 */
export function applyDeltaToTail(parts, { padMs = 0, trimMs = 0 }) {
  if (!parts.length) return parts
  const copy = parts.map((part) => ({ ...part }))
  const last = copy[copy.length - 1]
  if (padMs > 0) {
    last.pauseAfter = (Number(last.pauseAfter) || 0) + padMs
  } else if (trimMs > 0) {
    last.pauseAfter = Math.max(0, (Number(last.pauseAfter) || 0) - trimMs)
  }
  return copy
}

/** نسبة الخطأ عن المدة المستهدفة (0.05 = 5%). */
export function timingError({ parts, speechMs, targetMs }) {
  if (!targetMs) return 0
  const total = speechMs + totalPauseMs(parts) + totalGapMs(parts)
  return Math.abs(total / targetMs - 1)
}
