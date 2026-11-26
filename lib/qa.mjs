// مراجعة النص قبل التوليد: يكشف الفصحى داخل نص سعودي، الكلمات الأجنبية غير
// المعرّبة، الأرقام والرموز، الجمل الطويلة، الأخطاء الإملائية، وتكرار الكلمات.
// الهدف أن يرى المستخدم مشكلة النطق قبل أن يسمعها.

import { DIALECT_MARKERS, KNOWN_LATIN, MSA_TO_GULF, PRONUNCIATION, bareWord } from './lexicon.mjs'
import { countWords, detectLanguage, splitSentences } from './normalize.mjs'

const SEVERITY_PENALTY = { high: 12, medium: 6, low: 2 }

const MSA_HINTS = [
  { phrase: 'هل تعلم', suggest: 'تدري' },
  { phrase: 'هل تعرف', suggest: 'تعرف' },
  { phrase: 'في الحقيقة', suggest: 'بصراحة' },
  { phrase: 'بالإضافة إلى', suggest: 'وكمان' },
  { phrase: 'على الرغم من', suggest: 'مع إن' },
  { phrase: 'من الممكن', suggest: 'يمكن' },
  { phrase: 'يجب أن', suggest: 'لازم' },
  { phrase: 'الآن', suggest: 'الحين' },
  { phrase: 'أيضاً', suggest: 'كمان' },
  { phrase: 'كثيراً', suggest: 'مرة' },
  { phrase: 'جداً', suggest: 'مرة' },
  { phrase: 'حسناً', suggest: 'طيب' },
  { phrase: 'شكراً', suggest: 'مشكور' },
  { phrase: 'أريد', suggest: 'أبي' },
  { phrase: 'نريد', suggest: 'نبغى' },
  { phrase: 'تريد', suggest: 'تبي' },
  { phrase: 'يريد', suggest: 'يبي' },
  { phrase: 'أستطيع', suggest: 'أقدر' },
  { phrase: 'ليس', suggest: 'مو' },
  { phrase: 'ليست', suggest: 'مو' },
  { phrase: 'هناك', suggest: 'فيه' },
  { phrase: 'هذه', suggest: 'هذي' },
  { phrase: 'هؤلاء', suggest: 'هذولا' },
  { phrase: 'الذين', suggest: 'اللي' },
  { phrase: 'التي', suggest: 'اللي' },
  { phrase: 'الذي', suggest: 'اللي' },
]

const COMMON_MISTAKES = [
  { pattern: /انشاء الله|انشالله/g, fix: 'إن شاء الله', note: 'تُكتب «إن شاء الله»' },
  { pattern: /لاكن/g, fix: 'لكن', note: 'الصواب «لكن»' },
  { pattern: /هاذا/g, fix: 'هذا', note: 'الصواب «هذا»' },
  { pattern: /هاذي/g, fix: 'هذي', note: 'الصواب «هذي»' },
  { pattern: /الذى/g, fix: 'الذي', note: 'الصواب «الذي»' },
  { pattern: /\bالى\b/g, fix: 'إلى', note: 'الصواب «إلى»' },
  { pattern: /\bانا\b/g, fix: 'أنا', note: 'الأفضل «أنا» بالهمزة' },
  { pattern: /\bانت\b/g, fix: 'أنت', note: 'الأفضل «أنت» بالهمزة' },
]

/** يحوّل الفصحى إلى سعودي بأمان (بدائل كلمة بكلمة فقط). */
export function dialectizeText(text) {
  let out = String(text ?? '')
  const changes = []
  const entries = Object.entries(MSA_TO_GULF).sort((a, b) => b[0].length - a[0].length)
  for (const [source, target] of entries) {
    const pattern = new RegExp(`(^|[^\\u0600-\\u06FF])${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\u0600-\\u06FF])`, 'g')
    out = out.replace(pattern, (match, prefix) => {
      changes.push({ from: source, to: target })
      return `${prefix}${target}`
    })
  }
  return { text: out, changes }
}

/**
 * مراجعة شاملة للنص.
 * @param {string} text
 * @param {{dictionary?: {orig:string,phon:string}[], diacritics?: string}} options
 */
export function reviewText(text, options = {}) {
  const raw = String(text ?? '').trim()
  const issues = []
  const language = detectLanguage(raw)
  const words = raw.split(/\s+/).filter(Boolean)
  const cleanWords = words.map((word) => bareWord(word.replace(/[^\u0600-\u06FFa-zA-Z0-9]/g, '')))
  const arabicWords = cleanWords.filter((word) => /[\u0600-\u06FF]/.test(word))
  const dialectHits = arabicWords.filter((word) => DIALECT_MARKERS.has(word) || DIALECT_MARKERS.has(word.replace(/^ال/, '')))
  const dialectRatio = arabicWords.length ? Math.round((dialectHits.length / arabicWords.length) * 100) : 0

  for (const mistake of COMMON_MISTAKES) {
    const matches = raw.match(mistake.pattern)
    if (matches?.length) {
      issues.push({
        type: 'spelling',
        severity: 'high',
        sample: matches[0],
        message: mistake.note,
        suggestion: mistake.fix,
      })
    }
  }

  for (const hint of MSA_HINTS) {
    const pattern = new RegExp(`(^|[^\\u0600-\\u06FF])${hint.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\u0600-\\u06FF])`, 'g')
    if (pattern.test(raw)) {
      issues.push({
        type: 'dialect',
        severity: 'medium',
        sample: hint.phrase,
        message: `«${hint.phrase}» فصحى وتكسر اللهجة — البديل السعودي أوضح`,
        suggestion: hint.suggest,
      })
    }
  }

  const latinTokens = [...new Set(words.map((word) => word.replace(/[^\w'’.-]/g, '')).filter((word) => /^[A-Za-z]/.test(word)))]
  for (const token of latinTokens) {
    const key = token.toLowerCase().replace(/[.']/g, '')
    if (KNOWN_LATIN.has(key) || PRONUNCIATION[token]) continue
    issues.push({
      type: 'latin',
      severity: 'low',
      sample: token,
      message: 'كلمة إنجليزية داخل نص عربي — قد تُنطق بلكنة مختلفة عن بقية الجملة',
      suggestion: `أضفها في قاموس النطق (مثال: ${token} → ${token})`,
    })
  }

  if (/\d/.test(raw)) {
    issues.push({
      type: 'number',
      severity: 'low',
      sample: (raw.match(/\d[\d.,:/%-]*/g) ?? [])[0],
      message: 'الأرقام تُحوَّل آلياً إلى كلمات منطوقة — راجع الصيغة إن كانت رقماً خاصاً',
      suggestion: 'اكتب الرقم كاملاً أو ضعه في قاموس النطق',
    })
  }

  if (/[#@]/.test(raw)) {
    issues.push({
      type: 'symbol',
      severity: 'low',
      sample: (raw.match(/[#@]\S+/g) ?? [])[0],
      message: 'الهاشتاق والإشارات تُنطق «هاشتاق/حساب» — احذفها إن لم تردها في الصوت',
      suggestion: 'احذف الرمز أو اكتبه كلمة',
    })
  }

  const sentences = splitSentences(raw)
  for (const sentence of sentences) {
    if (sentence.length > 160) {
      issues.push({
        type: 'long-sentence',
        severity: 'medium',
        sample: `${sentence.slice(0, 40)}…`,
        message: `جملة طويلة (${sentence.length} حرفاً) — تُقسَّم آلياً لكن الأفضل تقسيمها يدوياً`,
        suggestion: 'اقسمها عند الفاصلة أو «بس/لكن/عشان»',
      })
    }
    if (!/[.!؟?،؛]$/.test(sentence) && sentence.length > 30) {
      issues.push({
        type: 'punctuation',
        severity: 'low',
        sample: sentence.slice(0, 30),
        message: 'جملة بلا علامة ترقيم ختامية — علامة السؤال تحديداً تغيّر النبرة',
        suggestion: 'أضف «؟» للسؤال و«.» للخبر',
      })
    }
  }

  const repeated = []
  for (let index = 1; index < cleanWords.length; index += 1) {
    if (cleanWords[index] && cleanWords[index] === cleanWords[index - 1] && cleanWords[index].length > 2) {
      repeated.push(cleanWords[index])
    }
  }
  if (repeated.length) {
    issues.push({
      type: 'repeat',
      severity: 'low',
      sample: repeated.slice(0, 3).join('، '),
      message: 'تكرار متتالٍ لنفس الكلمة — قد يُقرأ مرتين',
      suggestion: 'احذف التكرار',
    })
  }

  if (language === 'ar' && arabicWords.length >= 6 && dialectRatio < 12) {
    issues.push({
      type: 'dialect-low',
      severity: 'medium',
      sample: `${dialectRatio}%`,
      message: 'النص عربي فصيح أكثر من اللازم — سيُقرأ بلهجة نشرة لا بلهجة سعودية يومية',
      suggestion: 'استخدم زر «حوّل للهجة» ثم راجع البدائل',
    })
  }

  if (language === 'mixed') {
    issues.push({
      type: 'mixed',
      severity: 'low',
      sample: 'عربي + إنجليزي',
      message: 'النص مختلط وسيُولَّد بصوتين — تأكد أن الانتقال طبيعي',
      suggestion: 'اكتب المصطلح الإنجليزي كامل الجملة أو عرّبه',
    })
  }

  const uniqueIssues = []
  const seen = new Set()
  for (const issue of issues) {
    const key = `${issue.type}:${issue.sample}`
    if (seen.has(key)) continue
    seen.add(key)
    uniqueIssues.push(issue)
  }

  const penalty = uniqueIssues.reduce((sum, issue) => sum + (SEVERITY_PENALTY[issue.severity] ?? 2), 0)
  const score = Math.max(0, Math.min(100, 100 - penalty))
  const grade = score >= 90 ? 'ممتاز' : score >= 75 ? 'جيد' : score >= 55 ? 'يحتاج مراجعة' : 'ضعيف'

  return {
    score,
    grade,
    language,
    stats: {
      words: countWords(raw),
      sentences: sentences.length,
      arabicWords: arabicWords.length,
      dialectWords: dialectHits.length,
      dialectRatio,
      latinWords: latinTokens.length,
      hasNumbers: /\d/.test(raw),
    },
    issues: uniqueIssues.sort((a, b) => (SEVERITY_PENALTY[b.severity] ?? 0) - (SEVERITY_PENALTY[a.severity] ?? 0)),
    dialectSuggestions: [...new Set(issues.filter((issue) => issue.type === 'dialect').map((issue) => issue.suggestion))],
  }
}
