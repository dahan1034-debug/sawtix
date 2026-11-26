// تطبيع النص قبل النطق: أرقام، عملات، تواريخ، أوقات، نسب، رموز، إيموجي،
// اختصارات، وتقسيم الجمل إلى وحدات أداء. الهدف: لا يقرأ المحرك رقماً بالغلط
// ولا ينطق رمزاً بالإنجليزي داخل جملة عربية.

import { PRONUNCIATION, SPELLING_FIXES, bareWord } from './lexicon.mjs'

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹'

const AR_ONES = ['صفر', 'واحد', 'اثنين', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة']
const AR_TEENS = ['أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر']
const AR_TENS = ['', '', 'عشرين', 'ثلاثين', 'أربعين', 'خمسين', 'ستين', 'سبعين', 'ثمانين', 'تسعين']
const AR_HUNDREDS = ['', 'مية', 'ميتين', 'ثلاث مية', 'أربع مية', 'خمس مية', 'ست مية', 'سبع مية', 'ثمان مية', 'تسع مية']
const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر']

/** أرقام عربية-هندية وفارسية إلى لاتينية. */
export function toWesternDigits(text) {
  return String(text ?? '')
    .replace(/[٠-٩]/g, (digit) => String(AR_DIGITS.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(FA_DIGITS.indexOf(digit)))
}

/** ٣٠٠٠ → ثلاثة آلاف (بصياغة قريبة من المنطوق السعودي). */
export function arabicNumberToWords(value) {
  let n = Math.trunc(Math.abs(Number(value) || 0))
  if (n === 0) return 'صفر'
  const parts = []

  const under100 = (num) => {
    if (num <= 10) return AR_ONES[num]
    if (num < 20) return AR_TEENS[num - 11]
    const tens = Math.floor(num / 10)
    const ones = num % 10
    return ones ? `${AR_ONES[ones]} و${AR_TENS[tens]}` : AR_TENS[tens]
  }

  const under1000 = (num) => {
    const hundred = Math.floor(num / 100)
    const rest = num % 100
    const head = AR_HUNDREDS[hundred]
    if (!rest) return head
    if (!head) return under100(rest)
    return `${head} و${under100(rest)}`
  }

  const scales = [
    { value: 1_000_000_000, one: 'مليار', two: 'مليارين', few: 'مليارات' },
    { value: 1_000_000, one: 'مليون', two: 'مليونين', few: 'ملايين' },
    { value: 1_000, one: 'ألف', two: 'ألفين', few: 'آلاف' },
  ]

  for (const scale of scales) {
    const count = Math.floor(n / scale.value)
    if (!count) continue
    n -= count * scale.value
    if (count === 1) parts.push(scale.one)
    else if (count === 2) parts.push(scale.two)
    else if (count <= 10) parts.push(`${under100(count)} ${scale.few}`)
    else parts.push(`${under1000(count)} ${scale.one}`)
  }

  if (n) parts.push(under1000(n))
  return parts.join(' و')
}

/** أرقام إنجليزية منطوقة (للنصوص الإنجليزية). */
export function englishNumberToWords(value) {
  const n = Math.trunc(Math.abs(Number(value) || 0))
  if (n === 0) return 'zero'
  const parts = []
  const groups = [
    [1_000_000_000, 'billion'],
    [1_000_000, 'million'],
    [1_000, 'thousand'],
  ]
  let rest = n
  const under1000 = (num) => {
    const out = []
    const hundred = Math.floor(num / 100)
    if (hundred) out.push(`${EN_ONES[hundred]} hundred`)
    const tail = num % 100
    if (tail) {
      if (tail < 20) out.push(EN_ONES[tail])
      else out.push(`${EN_TENS[Math.floor(tail / 10)]}${tail % 10 ? `-${EN_ONES[tail % 10]}` : ''}`)
    }
    return out.join(' ')
  }
  for (const [size, label] of groups) {
    const count = Math.floor(rest / size)
    if (!count) continue
    rest -= count * size
    parts.push(`${under1000(count)} ${label}`)
  }
  if (rest) parts.push(under1000(rest))
  return parts.join(' ')
}

const CURRENCY = [
  { pattern: /(?:ريال|ر\.?س|SAR)/i, word: 'ريال', plural: 'ريالات', english: 'riyals' },
  { pattern: /(?:درهم|AED)/i, word: 'درهم', plural: 'دراهم', english: 'dirhams' },
  { pattern: /(?:\$|دولار|USD)/i, word: 'دولار', plural: 'دولارات', english: 'dollars' },
  { pattern: /(?:يورو|€|EUR)/i, word: 'يورو', plural: 'يورو', english: 'euros' },
]

/** يختار صيغة الجمع العربية المناسبة (٣-١٠ جمع، غيرها مفرد). */
function arabicUnit(count, singular, plural) {
  const n = Math.abs(Number(count) || 0)
  if (plural && n >= 3 && n <= 10) return plural
  return singular
}

/** الأرقام والوحدات داخل نص عربي. */
function normalizeArabicNumbers(text) {
  let out = text

  // العملة قبل الرقم وبعده: 50 ريال / ريال 50
  out = out.replace(/(\d+(?:\.\d+)?)\s*(ريال|ر\.?س|درهم|دولار|يورو)/gi, (match, digits, unit) => {
    const found = CURRENCY.find((item) => item.pattern.test(unit))
    if (!found) return match
    const value = Number(digits)
    const words = arabicNumberToWords(value)
    return `${words} ${arabicUnit(value, found.word, found.plural)}`
  })

  // النسبة المئوية
  out = out.replace(/(\d+(?:\.\d+)?)\s*%/g, (_match, digits) => `${arabicNumberToWords(Number(digits))} بالمئة`)

  // الوقت 3:30 / 15:45 (نتجاهل «الساعة» المكتوبة قبل الرقم حتى لا تتكرر)
  out = out.replace(/(?:الساعة\s*)?(\d{1,2}):(\d{2})\b/g, (_match, hour, minute) => {
    const h = Number(hour)
    const m = Number(minute)
    if (h > 23 || m > 59) return `${arabicNumberToWords(h)} و${arabicNumberToWords(m)}`
    let tail
    if (m === 0) tail = 'بالضبط'
    else if (m === 15) tail = 'وربع'
    else if (m === 30) tail = 'ونص'
    else if (m === 45) tail = 'إلا ربع'
    else tail = `و${arabicNumberToWords(m)} دقيقة`
    return `الساعة ${arabicNumberToWords(h)}${tail.startsWith('و') || tail === 'إلا ربع' ? ' ' : ' '}${tail}`
  })

  // التاريخ 25/11/2026
  out = out.replace(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g, (_match, day, month, year) => {
    const d = Number(day)
    const mo = Number(month)
    if (mo < 1 || mo > 12) return _match
    return `${arabicNumberToWords(d)} ${MONTHS_AR[mo - 1]} ${arabicNumberToWords(year)}`
  })

  // السنة
  out = out.replace(/\b(1[89]\d{2}|20\d{2}|21\d{2})\b/g, (match, digits) => `${arabicNumberToWords(Number(digits))}`)

  // الأرقام الكبيرة (هاتف/آي دي) تُقرأ رقماً رقماً
  out = out.replace(/\b\d{6,}\b/g, (digits) => digits.split('').map((digit) => AR_ONES[Number(digit)]).join(' '))

  // الفاصلة العشرية
  out = out.replace(/(\d+)\.(\d+)/g, (_match, whole, fraction) => `${arabicNumberToWords(Number(whole))} فاصلة ${arabicNumberToWords(Number(fraction))}`)

  // النطاقات 10-20
  out = out.replace(/\b(\d+)\s*[-–]\s*(\d+)\b/g, (_match, from, to) => `من ${arabicNumberToWords(Number(from))} إلى ${arabicNumberToWords(Number(to))}`)

  // بقية الأرقام
  out = out.replace(/\d+/g, (digits) => arabicNumberToWords(Number(digits)))
  return out
}

/** الأرقام والوحدات داخل نص إنجليزي. */
function normalizeEnglishNumbers(text) {
  let out = text
  out = out.replace(/\$\s?(\d+(?:\.\d+)?)(?:\s?(?:k|K))?/g, (_match, digits) => `${englishNumberToWords(Number(digits))} dollars`)
  out = out.replace(/(\d+(?:\.\d+)?)\s*%/g, (_match, digits) => `${englishNumberToWords(Number(digits))} percent`)
  out = out.replace(/\b(\d{1,2}):(\d{2})\b/g, (_match, hour, minute) => `${englishNumberToWords(Number(hour))} ${englishNumberToWords(Number(minute))}`)
  out = out.replace(/\b(\d+)\s*[-–]\s*(\d+)\b/g, (_match, from, to) => `${englishNumberToWords(Number(from))} to ${englishNumberToWords(Number(to))}`)
  out = out.replace(/(\d+)\.(\d+)/g, (_match, whole, fraction) => `${englishNumberToWords(Number(whole))} point ${String(fraction).split('').map((d) => EN_ONES[Number(d)]).join(' ')}`)
  out = out.replace(/\b\d{6,}\b/g, (digits) => digits.split('').map((digit) => EN_ONES[Number(digit)]).join(' '))
  out = out.replace(/\d+/g, (digits) => englishNumberToWords(Number(digits)))
  return out
}

const EMOJI_PAUSE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu

/** إزالة الإيموجي مع تحويله إلى وقفة مفهومة. */
export function stripEmojis(text) {
  return String(text ?? '').replace(EMOJI_PAUSE, ' ')
}

/** توحيد علامات الترقيم العربية والإنجليزية وضبط المسافات. */
export function normalizePunctuation(text) {
  return String(text ?? '')
    .replace(/\u0640+/g, '') // تطويل
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .replace(/[“”„]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/…/g, '...')
    .replace(/[，、]/g, '،')
    .replace(/؛/g, '؛')
    .replace(/\s*([،؛؟!])\s*/g, '$1 ')
    .replace(/\.{3,}/g, '... ')
    .replace(/\s*\.\s*/g, '. ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** إزالة العلامات غير المنطوقة (نجوم، شرطات ماركداون، هاشتاق). */
function stripMarkup(text) {
  return String(text ?? '')
    .replace(/#([\u0600-\u06FF\w_]+)/g, (_match, tag) => `هاشتاق ${tag}`)
    .replace(/@([\w.]+)/g, (_match, handle) => `حساب ${handle}`)
    .replace(/https?:\/\/\S+/g, 'رابط')
    .replace(/[*_`~>|]/g, ' ')
}

/**
 * نفس الفكرة لكن بكلمات إنجليزية: لا يجوز أن يُقرأ نص إنجليزي بـ«هاشتاق/رابط».
 * (٤.٢ في تقرير النواقص)
 */
function stripMarkupEnglish(text) {
  return String(text ?? '')
    .replace(/#([\w_]+)/g, (_match, tag) => ` hashtag ${tag} `)
    .replace(/@([\w.]+)/g, (_match, handle) => ` at ${handle} `)
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[*_`~>|]/g, ' ')
}

/** يوسّع الاختصارات الإنجليزية والأرقام الرمزية. */
function expandAbbreviations(text) {
  let out = text
  for (const [source, target] of Object.entries(PRONUNCIATION)) {
    const pattern = new RegExp(`(^|[^\\w\\u0600-\\u06FF])${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\w\\u0600-\\u06FF])`, 'gi')
    out = out.replace(pattern, (_match, prefix) => `${prefix}${target}`)
  }
  out = out.replace(/&/g, ' و ')
  out = out.replace(/\+/g, ' زائد ')
  out = out.replace(/=/g, ' يساوي ')
  out = out.replace(/×/g, ' ضرب ')
  out = out.replace(/÷/g, ' قسمة ')
  return out
}

/** تصحيح أخطاء إملائية شائعة تؤثر على النطق. */
export function fixSpelling(text) {
  let out = String(text ?? '')
  for (const [wrong, right] of Object.entries(SPELLING_FIXES)) {
    const pattern = new RegExp(`(^|[^\\u0600-\\u06FF])${wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\u0600-\\u06FF])`, 'g')
    out = out.replace(pattern, (_match, prefix) => `${prefix}${right}`)
  }
  return out
}

/** يحدد لغة النص: ar / en / mixed. */
export function detectLanguage(text) {
  const value = String(text ?? '')
  const arabic = (value.match(/[\u0600-\u06FF]/g) ?? []).length
  const latin = (value.match(/[A-Za-z]/g) ?? []).length
  if (!arabic && !latin) return 'ar'
  if (arabic > latin * 4) return 'ar'
  if (latin > arabic * 4) return 'en'
  return 'mixed'
}

/** تطبيع جملة عربية (وقاموس التعريب مسموح). */
function normalizeArabicSentence(text) {
  let out = stripMarkup(text)
  out = fixSpelling(out)
  out = expandAbbreviations(out)
  out = normalizePunctuation(out)
  out = normalizeArabicNumbers(out)
  return out
}

/** تطبيع جملة إنجليزية: بلا قاموس تعريب وبلا أرقام عربية. */
function normalizeEnglishSentence(text) {
  let out = stripMarkupEnglish(text)
  out = normalizePunctuation(out)
  out = normalizeEnglishNumbers(out)
  return out
}

/** ينهي المسافات وعلامات الترقيم. */
function finalizeSpacing(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([،؛؟!.,])/g, '$1')
    .replace(/([،؛؟!.,])(?=\S)/g, '$1 ')
    .trim()
}

/**
 * تطبيع كامل جاهز للنطق (بلا تشكيل).
 *
 * مهم: التطبيع لغوي — كل جملة تُطبَّع بلغتها. الجملة الإنجليزية لا يمسّها
 * قاموس تعريب المصطلحات (PRONUNCIATION) ولا تحويل الهاشتاق/الرابط إلى عربي،
 * وإلا خرج النص الإنجليزي مشوّهاً («I like this story» ← «I لَايْك this سْتُوْرِي»).
 * (إصلاح ٤.١ و٤.٢ في تقرير النواقص)
 *
 * @param {string} input
 * @param {'ar'|'en'|'mixed'|null} language
 */
export function normalizeText(input, language = null) {
  const lang = language ?? detectLanguage(input)
  let text = stripEmojis(toWesternDigits(input))

  if (lang === 'en') {
    text = normalizeEnglishSentence(text)
  } else {
    text = splitSentences(text)
      .map((sentence) => (detectLanguage(sentence) === 'en'
        ? normalizeEnglishSentence(sentence)
        : normalizeArabicSentence(sentence)))
      .join(' ')
  }

  return finalizeSpacing(text)
}

/** تقسيم النص إلى جمل/وحدات أداء عند الترقيم ونهايات الأسطر. */
export function splitSentences(text) {
  const lines = String(text ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  const sentences = []
  for (const line of lines) {
    // «...» ليست نهاية جملة، نستبدلها بحرف واحد قبل التقسيم ثم نرجعها
    const guarded = line.replace(/\.{2,}/g, '…')
    const matches = guarded.match(/[^.!؟?]+[.!؟?]+|[^.!؟?]+$/g) ?? []
    for (const piece of matches) {
      const trimmed = piece.replace(/…/g, '...').trim()
      if (!trimmed) continue
      // جمل طويلة جداً تُقسَّم عند الفاصلة أو الروابط حتى يتنفس المتحدث
      if (trimmed.length > 140) {
        const chunks = trimmed.split(/(?<=[،؛])\s+/)
        let buffer = ''
        for (const chunk of chunks) {
          if ((buffer + ' ' + chunk).trim().length > 140) {
            if (buffer) sentences.push(buffer.trim())
            buffer = chunk
          } else {
            buffer = `${buffer} ${chunk}`.trim()
          }
        }
        if (buffer) sentences.push(buffer.trim())
      } else {
        sentences.push(trimmed)
      }
    }
  }
  return sentences
}

/** يفصل المقاطع العربية عن الإنجليزية داخل الجملة الواحدة. */
export function splitLanguageRuns(text) {
  const runs = []
  let buffer = ''
  let current = null
  const push = () => {
    if (!buffer.trim()) return
    runs.push({ lang: current, text: buffer.trim() })
    buffer = ''
  }
  for (const char of String(text ?? '')) {
    const isArabic = /[\u0600-\u06FF]/.test(char)
    const isLatin = /[A-Za-z]/.test(char)
    const kind = isLatin ? 'en' : 'ar'
    if (!isArabic && !isLatin) {
      if (current) buffer += char
      else buffer += char
      continue
    }
    if (current && kind !== current) push()
    current = kind
    buffer += char
  }
  push()
  return runs.length ? runs : [{ lang: 'ar', text: String(text ?? '') }]
}

/** تقدير مدة النطق بالثواني (للعرض قبل التوليد). */
export function estimateSeconds(text, language = 'ar') {
  const clean = String(text ?? '').replace(/[\u064B-\u065F\u0670]/g, '')
  if (!clean.trim()) return 0
  const words = clean.split(/\s+/).filter(Boolean).length
  if (language === 'en') return Math.max(0.5, Math.round((words / 2.6) * 10) / 10)
  const chars = clean.replace(/\s+/g, '').length
  const byWords = words / 2.8
  const byChars = chars / 13.5
  // الجمل القصيرة تُنطق أبطأ نسبياً
  const penalty = words <= 3 ? 0.18 : 0
  return Math.max(0.5, Math.round(((byWords + byChars) / 2 + penalty) * 10) / 10)
}

export function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(safe / 60)
  const rest = (safe % 60).toFixed(2).padStart(5, '0')
  return `${String(minutes).padStart(2, '0')}:${rest}`
}

export function formatSrtTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0)
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = Math.floor(safe % 60)
  const millis = Math.round((safe - Math.floor(safe)) * 1000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

/** عدد الكلمات بلا علامات. */
export function countWords(text) {
  return String(text ?? '').split(/\s+/).filter((word) => /[\u0600-\u06FFa-zA-Z0-9]/.test(word)).length
}

/** هل الكلمة لاتينية؟ */
export function isLatinToken(token) {
  return /^[A-Za-z][A-Za-z0-9'’._-]*$/.test(bareWord(token)) || /^[A-Za-z]/.test(String(token))
}
