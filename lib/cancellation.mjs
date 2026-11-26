// خطأ إلغاء موحّد: يُرفع داخل خط الإنتاج عندما يطلب المستخدم إيقاف المهمة،
// حتى تُميَّز حالته في الطابور عن الأخطاء الحقيقية.

export class CancelledError extends Error {
  constructor(message = 'أُلغيت المهمة بطلب من المستخدم') {
    super(message)
    this.name = 'CancelledError'
    this.cancelled = true
  }
}

export function isCancelledError(error) {
  return Boolean(error?.cancelled) || error?.name === 'CancelledError'
}

/**
 * يعيد دالة تُرفع CancelledError عند الإلغاء، أو دالة لا تفعل شيئاً.
 * @param {(() => boolean)|undefined} check
 */
export function cancellable(check) {
  return () => {
    if (typeof check === 'function' && check()) throw new CancelledError()
  }
}
