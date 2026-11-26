// حماية وصول اختيارية (HTTP Basic) للنسخة المنشورة على الإنترنت.
// محلياً تبقى معطّلة ما لم يُضبط APP_PASSWORD. عند التفعيل تُحمى كل المسارات
// بما فيها الملفات الثابتة، ويبقى /api/health مفتوحاً لفحص المنصّة.

import crypto from 'node:crypto'

const digest = (value) => crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest()

/**
 * @param {{user?: string, password?: string, realm?: string, openPaths?: string[]}} options
 * @returns {{enabled: boolean, middleware: (req: any, res: any, next: Function) => void}}
 */
export function createBasicAuth({ user = 'admin', password = '', realm = 'SAWTIX', openPaths = [] } = {}) {
  const open = new Set(openPaths)
  if (!password) {
    return { enabled: false, middleware: (_req, _res, next) => next() }
  }

  const expectedUser = digest(user)
  const expectedPass = digest(password)

  const middleware = (req, res, next) => {
    if (open.has(req.path)) return next()

    const header = String(req.headers?.authorization ?? '')
    const [scheme, encoded] = header.split(/\s+/)
    if (scheme === 'Basic' && encoded) {
      let decoded = ''
      try {
        decoded = Buffer.from(encoded, 'base64').toString('utf8')
      } catch {
        decoded = ''
      }
      const separator = decoded.indexOf(':')
      if (separator >= 0) {
        const userOk = crypto.timingSafeEqual(digest(decoded.slice(0, separator)), expectedUser)
        const passOk = crypto.timingSafeEqual(digest(decoded.slice(separator + 1)), expectedPass)
        if (userOk && passOk) return next()
      }
    }

    res.setHeader('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`)
    res.status(401).type('text/plain; charset=utf-8').send('مطلوب تسجيل الدخول')
  }

  return { enabled: true, middleware }
}
