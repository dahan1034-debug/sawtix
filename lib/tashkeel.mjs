// طبقة التشكيل الهجينة:
// النموذج المحلي (text2tashkeel) يعطي حركات الكلمات الفصحى، وقاموس اللهجة
// يصحّح العامية التي يخطئ فيها النموذج (وش، ليش، الحين...). النتيجة تُنظَّف من
// الحركات المستحيلة، وتُحذف حركات الإعراب في آخر الجملة حتى لا تُقرأ بلهجة نشرة.

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GULF_PHRASES, SPELLING_FIXES, lookupTashkeel, bareWord } from './lexicon.mjs'
import { friendlyPythonError, runPython } from './python.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PY_SCRIPT = path.join(__dirname, '..', 'py', 'tashkeel.py')
const CACHE_FILE = path.join(__dirname, '..', '.tmp', 'tashkeel-cache.json')
const CACHE_LIMIT = 4000

const HARAKAT = /[\u064B-\u0652\u0670\u0653-\u0655]/
const HARAKAT_G = /[\u064B-\u0652\u0670\u0653-\u0655]/g
const TANWEEN = /[\u064B-\u064D]/

let cache = null
let cacheDirty = false
let writing = null

async function loadCache() {
  if (cache) return cache
  cache = {}
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8')
    cache = JSON.parse(raw)
  } catch {
    cache = {}
  }
  return cache
}

async function persistCache() {
  if (!cacheDirty || !cache) return
  cacheDirty = false
  const entries = Object.entries(cache)
  if (entries.length > CACHE_LIMIT) {
    cache = Object.fromEntries(entries.slice(entries.length - CACHE_LIMIT))
  }
  writing = writing ?? fs
    .mkdir(path.dirname(CACHE_FILE), { recursive: true })
    .then(() => fs.writeFile(CACHE_FILE, JSON.stringify(cache), 'utf8'))
    .catch(() => {})
    .finally(() => {
      writing = null
    })
  return writing
}

export function stripTashkeel(text) {
  return String(text ?? '').replace(HARAKAT_G, '')
}

export function hasTashkeel(text) {
  return HARAKAT.test(String(text ?? ''))
}

/** ينظّف التشكيل من الحركات المكرّرة أو الخاطئة التي قد تُربك المحرك. */
export function sanitizeTashkeel(text) {
  // توحيد ترتيب الشدّة قبل حركتها (بعض النماذج تُخرجها معكوسة)
  let out = String(text ?? '').replace(/([\u064B-\u0650])\u0651/g, '\u0651$1')
  const isMark = (char) => /[\u064B-\u0652\u0670]/.test(char)
  let cleaned = ''
  let previous = ''
  for (const char of out) {
    if (!isMark(char)) {
      cleaned += char
      previous = char
      continue
    }
    if (isMark(previous)) {
      // بعد الشدّة حركة واحدة مسموحة، وبعد الحركة لا شيء إلا شدّة
      if (previous === '\u0651') {
        cleaned += char
        previous = char
      }
      continue
    }
    if (char === '\u0651' && previous === '\u0651') continue
    cleaned += char
    previous = char
  }
  out = cleaned
  // لا تنوين على التاء المربوطة
  out = out.replace(/\u0629([\u064B-\u064D])/g, '\u0629')
  // لا حركة قصيرة على الألف (التنوين يبقى لأنه يحمل معنى)
  out = out.replace(/\u0627([\u064E-\u0650\u0652])/g, '\u0627')
  return out
}

/** يحذف حركة الإعراب في آخر الكلمة حتى لا تُقرأ الجملة بلهجة نشرة. */
export function dropCaseEnding(token) {
  return String(token ?? '').replace(/([\u0621-\u064A])[\u064B-\u0650]$/u, '$1')
}

const PUNCT_CLASS = '\\s،؛؟!.,:«»()\\[\\]…"\'’“”—-'

function tokenParts(token) {
  const match = new RegExp(`^([${PUNCT_CLASS}]*)([\\u0621-\\u064A\\u064B-\\u0652\\u0670]*)([${PUNCT_CLASS}]*)$`, 'u').exec(String(token))
  if (!match) return { before: '', core: String(token), after: '' }
  return { before: match[1], core: match[2], after: match[3] }
}

/** يطبّق قاموس التشكيل السعودي على النص (عبارات ثم كلمات). */
export function applyGulfLexicon(text) {
  let out = String(text ?? '')

  for (const [phrase, spoken] of Object.entries(GULF_PHRASES)) {
    const pattern = new RegExp(`(^|[^\\u0600-\\u06FF])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\u0600-\\u06FF])`, 'g')
    out = out.replace(pattern, (_match, prefix) => `${prefix}${spoken}`)
  }

  out = out.split(/(\s+)/).map((token) => {
    if (!/[\u0600-\u06FF]/.test(token)) return token
    const { before, core, after } = tokenParts(token)
    const plain = stripTashkeel(core)
    const spoken = lookupTashkeel(plain)
    return spoken ? `${before}${spoken}${after}` : token
  }).join('')

  return out
}

/** قاموس المستخدم: كلمة كما تُكتب → كما تُنطق. */
export function applyCustomDictionary(text, dictionary = []) {
  let out = String(text ?? '')
  const entries = [...dictionary]
    .filter((entry) => entry && entry.orig && entry.phon)
    .sort((a, b) => String(b.orig).length - String(a.orig).length)
  for (const entry of entries) {
    const pattern = new RegExp(`(^|[^\\u0600-\\u06FF])${String(entry.orig).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\u0600-\\u06FF])`, 'g')
    out = out.replace(pattern, (_match, prefix) => `${prefix}${entry.phon}`)
  }
  return out
}

/** يطبّق تصحيحات إملائية مسبقاً (نسخة محلية لتجنّب دورة استيراد). */
export function applySpellingFixes(text) {
  let out = String(text ?? '')
  for (const [wrong, right] of Object.entries(SPELLING_FIXES)) {
    const pattern = new RegExp(`(^|[^\\u0600-\\u06FF])${wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\u0600-\\u06FF])`, 'g')
    out = out.replace(pattern, (_match, prefix) => `${prefix}${right}`)
  }
  return out
}

/**
 * يشكّل قائمة نصوص دفعة واحدة عبر النموذج المحلي، مع كاش دائم.
 * @param {string[]} texts
 * @returns {Promise<(string|null)[]>}
 */
export async function diacritizeBatch(texts) {
  const list = texts.map((text) => String(text ?? ''))
  const store = await loadCache()
  const missing = []
  const seen = new Set()
  for (const text of list) {
    if (!/[\u0600-\u06FF]/.test(text)) continue
    const key = crypto.createHash('sha1').update(text).digest('hex').slice(0, 24)
    if (!store[key] && !seen.has(key)) {
      seen.add(key)
      missing.push({ key, text })
    }
  }

  if (missing.length) {
    const tmpFile = path.join(os.tmpdir(), `tashkeel-${crypto.randomBytes(6).toString('hex')}.json`)
    try {
      await fs.writeFile(tmpFile, JSON.stringify(missing.map((item) => item.text)), 'utf8')
      const run = await runPython([PY_SCRIPT, tmpFile], { maxBuffer: 16 * 1024 * 1024, timeout: 240_000 })
      if (!run.ok && !run.stdout.trim()) {
        // التشكيل ميزة تحسين لا حاجز: نفشل بهدوء ونكمل بقاموس اللهجة
        throw new Error(friendlyPythonError({ stderr: run.stderr, message: run.error?.message }, 'tashkeel'))
      }
      const line = String(run.stdout).trim().split('\n').filter(Boolean).pop()
      const parsed = JSON.parse(line)
      if (parsed.engine !== 'none') {
        missing.forEach((item, index) => {
          const value = parsed.results?.[index]
          if (typeof value === 'string' && value) store[item.key] = value
        })
        cacheDirty = true
        await persistCache()
      }
    } catch {
      return list.map(() => null)
    } finally {
      await fs.unlink(tmpFile).catch(() => {})
    }
  }

  return list.map((text) => {
    if (!/[\u0600-\u06FF]/.test(text)) return text
    const key = crypto.createHash('sha1').update(text).digest('hex').slice(0, 24)
    return store[key] ?? null
  })
}

const PUNCT = /[،؛:,.!؟?"'«»()\[\]…—-]+/g

/**
 * يدمج تشكيل النموذج مع قاموس اللهجة كلمة بكلمة.
 * لو اختلف عدد الكلمات (النموذج يصلح الهمزات أحياناً) نُرجع النص الأصلي
 * ونكتفي بتشكيل القاموس، حتى لا تنزاح الحركات عن كلماتها.
 */
/** يحدد كلمات العبارات المعروفة بموضعها في الجملة قبل التشكيل. */
export function phraseOverrides(text) {
  const tokens = String(text ?? '').split(/\s+/)
  const bare = tokens.map((token) => stripTashkeel(token).replace(/[^\u0600-\u06FF]/g, ''))
  const overrides = new Map()
  for (const [phrase, spoken] of Object.entries(GULF_PHRASES)) {
    const words = phrase.split(/\s+/).map((word) => stripTashkeel(word).replace(/[^\u0600-\u06FF]/g, ''))
    for (let start = 0; start <= bare.length - words.length; start += 1) {
      let matched = true
      for (let offset = 0; offset < words.length; offset += 1) {
        if (bare[start + offset] !== words[offset]) {
          matched = false
          break
        }
      }
      if (!matched) continue
      spoken.split(/\s+/).forEach((word, offset) => overrides.set(start + offset, word))
    }
  }
  return overrides
}

export function mergeDiacritics(original, modelText, overrides = new Map()) {
  if (!modelText) return original
  const originalTokens = original.split(/(\s+)/)
  const modelTokens = modelText.split(/(\s+)/).filter((token) => token.trim())

  const originalWords = originalTokens.filter((token) => token.trim())
  if (originalWords.length !== modelTokens.length) return original

  let cursor = 0
  return originalTokens.map((token) => {
    if (!token.trim()) return token
    const modelToken = modelTokens[cursor]
    const override = overrides.get(cursor)
    cursor += 1
    if (override) return token.replace(/[\u0600-\u06FF\u064B-\u0652]+/u, override)
    const { before, core, after } = tokenParts(modelToken)
    const plain = stripTashkeel(core)
    const lexicon = lookupTashkeel(plain)
    if (lexicon) return `${before}${lexicon}${after}`
    if (!/[\u0600-\u06FF]/.test(core)) return token
    return `${before}${sanitizeTashkeel(core)}${after}`
  }).join('')
}

/** يحذف حركة الإعراب في نهاية كل كلمة (صيغة الوقف) حتى لا تُقرأ بلهجة نشرة. */
export function pausalEnding(text) {
  return String(text ?? '')
    .split(/(\s+)/)
    .map((token) => {
      if (!/[\u0600-\u06FF]/.test(token)) return token
      const { before, core, after } = tokenParts(token)
      // لا نحذف حركة بعد شدّة (إِنَّ) حتى لا تنكسر الكلمة
      const endsWithMark = /[\u064B-\u0650]$/u.test(core)
      const afterShadda = core[core.length - 2] === '\u0651'
      const fixed = endsWithMark && !afterShadda ? core.slice(0, -1) : core
      return `${before}${fixed}${after}`
    })
    .join('')
}

/**
 * يبني النص المنطوق النهائي: تصحيحات → قاموس المستخدم → تشكيل هجين.
 * @param {string[]} texts
 * @param {{diacritics?: 'smart'|'light'|'off', dictionary?: object[]}} options
 */
export async function buildSpokenTexts(texts, options = {}) {
  const mode = options.diacritics ?? 'smart'
  const dictionary = Array.isArray(options.dictionary) ? options.dictionary : []
  // التصحيحات الإملائية فقط هنا؛ كلمات القاموس تُمرَّر كـ«تجاوز» حتى لا يعيد النموذج تشكيلها
  const prepared = texts.map((text) => applySpellingFixes(text))

  if (mode === 'off' || mode === 'light') {
    return prepared.map((text) => applyCustomDictionary(applyGulfLexicon(text), dictionary))
  }

  const model = await diacritizeBatch(prepared)
  return prepared.map((text, index) => {
    if (!/[\u0600-\u06FF]/.test(text)) return text
    const overrides = phraseOverrides(text)
    const tokens = text.split(/\s+/)
    for (const entry of dictionary) {
      const orig = stripTashkeel(entry.orig).replace(/[^\u0600-\u06FF]/g, '')
      if (!orig) continue
      tokens.forEach((token, tokenIndex) => {
        const bare = stripTashkeel(token).replace(/[^\u0600-\u06FF]/g, '')
        if (bare && bare === orig) overrides.set(tokenIndex, entry.phon)
      })
    }
    const merged = applyGulfLexicon(mergeDiacritics(text, model[index], overrides))
    return pausalEnding(merged)
  })
}

/** نسبة الحروف المشكّلة — مؤشر ثقة للواجهة. */
export function diacriticCoverage(text) {
  const letters = (String(text ?? '').match(/[\u0621-\u064A]/g) ?? []).length
  const marks = (String(text ?? '').match(/[\u064B-\u0652]/g) ?? []).length
  if (!letters) return 0
  return Math.min(100, Math.round((marks / letters) * 100))
}

export { bareWord }
