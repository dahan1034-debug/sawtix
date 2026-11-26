// حماية الوصول للنسخة المنشورة: تعطّل محلياً، وتحمي كل شيء عند ضبط كلمة المرور.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createBasicAuth } from '../lib/auth.mjs'

function mockResponse() {
  const response = { statusCode: 200, headers: {}, body: undefined }
  response.status = (code) => {
    response.statusCode = code
    return response
  }
  response.setHeader = (name, value) => {
    response.headers[String(name).toLowerCase()] = value
    return response
  }
  response.type = () => response
  response.send = (body) => {
    response.body = body
    return response
  }
  return response
}

const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
const request = (authorization, path = '/') => ({ path, headers: authorization ? { authorization } : {} })

test('الحماية معطلة عندما لا توجد كلمة مرور', () => {
  const auth = createBasicAuth({ password: '' })
  assert.equal(auth.enabled, false)
  let called = false
  auth.middleware(request(), mockResponse(), () => {
    called = true
  })
  assert.equal(called, true)
})

test('المسار الصحي يبقى مفتوحاً لفحص المنصّة', () => {
  const auth = createBasicAuth({ password: 's3cret', openPaths: ['/api/health'] })
  let called = false
  auth.middleware(request(null, '/api/health'), mockResponse(), () => {
    called = true
  })
  assert.equal(called, true)
})

test('بدون بيانات دخول: 401 مع ترويسة Basic', () => {
  const auth = createBasicAuth({ password: 's3cret' })
  const response = mockResponse()
  let called = false
  auth.middleware(request(null), response, () => {
    called = true
  })
  assert.equal(called, false)
  assert.equal(response.statusCode, 401)
  assert.match(response.headers['www-authenticate'], /^Basic realm="SAWTIX"/)
})

test('كلمة مرور خاطئة أو مستخدم خاطئ: 401', () => {
  const auth = createBasicAuth({ user: 'admin', password: 's3cret' })
  for (const header of [basic('admin', 'wrong'), basic('root', 's3cret'), 'Basic ???', 'Bearer token']) {
    const response = mockResponse()
    let called = false
    auth.middleware(request(header), response, () => {
      called = true
    })
    assert.equal(called, false, header)
    assert.equal(response.statusCode, 401, header)
  }
})

test('بيانات صحيحة: يمر الطلب (وكلمة المرور قد تحوي نقطتين)', () => {
  const auth = createBasicAuth({ user: 'admin', password: 'a:b:c' })
  for (const header of [basic('admin', 'a:b:c')]) {
    const response = mockResponse()
    let called = false
    auth.middleware(request(header), response, () => {
      called = true
    })
    assert.equal(called, true)
    assert.equal(response.statusCode, 200)
  }
})
