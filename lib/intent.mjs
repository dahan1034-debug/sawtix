// محرك الإلقاء: يفهم نوع الجملة (سؤال، تعجب، تشويق، إطراء، تحذير، دعوة...)،
// ويحوّله إلى خطة أداء قابلة للتنفيذ على المحرك: سرعة، طبقة، مستوى، صمت قبل/بعد،
// وتقسيم الجملة إلى جُمل فرعية حتى تُؤدى كل فكرة بنبرتها بدل تلاوة واحدة مسطّحة.

import { splitSentences, estimateSeconds, countWords } from './normalize.mjs'

export const INTENTS = [
  {
    id: 'hook',
    label: 'افتتاحية / خطف انتباه',
    hint: 'أول ثانيتين: سرعة أعلى قليلاً وطبقة مرتفعة، ثم تمهّل',
    prosody: { rate: 7, pitch: 7, volume: 3, pauseBefore: 120, pauseAfter: 300 },
  },
  {
    id: 'question',
    label: 'سؤال',
    hint: 'نبرة صاعدة في النهاية، مع وقفة قصيرة قبل السؤال',
    prosody: { rate: 1, pitch: 9, volume: 1, pauseBefore: 160, pauseAfter: 240 },
  },
  {
    id: 'exclaim',
    label: 'تعجب / انبهار',
    hint: 'طاقة عالية وطبقة أعلى وصوت أقوى',
    prosody: { rate: 9, pitch: 13, volume: 6, pauseBefore: 100, pauseAfter: 360 },
  },
  {
    id: 'answer',
    label: 'إجابة / تأكيد',
    hint: 'ثبات ووضوح: سرعة أقل ونبرة مستقرة',
    prosody: { rate: -3, pitch: -1, volume: 2, pauseBefore: 140, pauseAfter: 220 },
  },
  {
    id: 'emphasize',
    label: 'تأكيد / إطراء',
    hint: 'تمهّل ونبرة أوضح لإبراز الجملة',
    prosody: { rate: -6, pitch: 4, volume: 6, pauseBefore: 180, pauseAfter: 280 },
  },
  {
    id: 'warn',
    label: 'تحذير / تنبيه',
    hint: 'أبطأ وأخفض قليلاً مع صمت أطول قبل الجملة',
    prosody: { rate: -8, pitch: -4, volume: 3, pauseBefore: 220, pauseAfter: 330 },
  },
  {
    id: 'cta',
    label: 'دعوة لاتخاذ إجراء',
    hint: 'طاقة إيجابية وحثّ مباشر',
    prosody: { rate: 5, pitch: 5, volume: 4, pauseBefore: 160, pauseAfter: 320 },
  },
  {
    id: 'reveal',
    label: 'كشف / مفاجأة',
    hint: 'صمت قبل الكشف ثم تسريع خفيف ونبرة أعلى',
    prosody: { rate: 2, pitch: 8, volume: 4, pauseBefore: 260, pauseAfter: 340 },
  },
  {
    id: 'contrast',
    label: 'مقارنة / استدراك',
    hint: 'تغيير واضح في الإيقاع بين الشقين',
    prosody: { rate: 0, pitch: 2, volume: 2, pauseBefore: 150, pauseAfter: 240 },
  },
  {
    id: 'empathy',
    label: 'تعاطف / مواساة',
    hint: 'أبطأ وأدفأ مع صمت لطيف',
    prosody: { rate: -7, pitch: -3, volume: -1, pauseBefore: 180, pauseAfter: 300 },
  },
  {
    id: 'story',
    label: 'سرد عادي',
    hint: 'إيقاع طبيعي متوازن',
    prosody: { rate: 0, pitch: 0, volume: 0, pauseBefore: 120, pauseAfter: 200 },
  },
]

export const STYLES = [
  { id: 'natural', label: 'طبيعي (سعودي يومي)', note: 'كما تتكلم في مقطع جوال', rate: 0, pitch: 0, volume: 0 },
  { id: 'energetic', label: 'حماسي (ريلز)', note: 'طاقة أعلى وإيقاع أسرع', rate: 6, pitch: 4, volume: 3 },
  { id: 'calm', label: 'هادئ / تعليمي', note: 'تمهّل ووضوح', rate: -5, pitch: -2, volume: 0 },
  { id: 'documentary', label: 'وثائقي', note: 'رصانة وثبات', rate: -6, pitch: -3, volume: 1 },
  { id: 'comedy', label: 'كوميدي', note: 'تقلّب في النبرة والوقفات', rate: 3, pitch: 5, volume: 2 },
  { id: 'news', label: 'إخباري', note: 'إيقاع نشرة سريعة', rate: 4, pitch: 1, volume: 2 },
]

const BY_ID = new Map(INTENTS.map((intent) => [intent.id, intent]))
const STYLE_BY_ID = new Map(STYLES.map((style) => [style.id, style]))

const KEYWORDS = {
  question: [
    'هل', 'وش', 'ويش', 'ايش', 'إيش', 'وشو', 'كيف', 'ليش', 'لماذا', 'متى', 'وين', 'منو', 'مين',
    'كم', 'اي', 'أي', 'صح', 'ولا', 'طيب', 'وش رايك', 'تعرف', 'تدري', 'لاحظت', 'تتوقع', 'شلون',
    'ليش ما', 'وش اللي', 'تظن', 'برأيك', 'في رأيك',
  ],
  exclaim: [
    'واو', 'ياسلام', 'يا سلام', 'ماشاءالله', 'ما شاء الله', 'عجيب', 'خيال', 'رهيب',
    'جنون', 'مستحيل', 'ما توقعت', 'ما تصدق', 'أقسم', 'والله', 'يا كثر', 'وش هالحلاوة',
    'لا يفوّت', 'ما تتفوت', 'صراحة رهيب',
  ],
  answer: ['نعم', 'إيه', 'ايه', 'أكيد', 'اكيد', 'صح', 'بالضبط', 'بالفعل', 'تمام', 'أبدا', 'النتيجة', 'السبب'],
  emphasize: [
    'بجد', 'صراحة', 'حقيقة', 'يعني', 'بالتحديد', 'خصوصا', 'خصوصاً', 'أهم', 'اهم', 'الأفضل', 'افضل',
    'أقوى', 'اقوى', 'مرة', 'جداً', 'جدا', 'كلش', 'أبداً', 'ابدا', 'مطلقاً', 'بصراحة', 'فعلاً',
  ],
  warn: [
    'احذر', 'انتبه', 'انتبهوا', 'لا تسوي', 'لا تنسى', 'لا تصور', 'لا تصورون', 'ركز', 'ركّز', 'استعجل',
    'خطأ', 'غلط', 'خطر', 'مشكلة', 'تحذير', 'إياك', 'اياك', 'انتبهي',
  ],
  cta: [
    'جرب', 'جرّب', 'احفظ', 'تابع', 'اضغط', 'شارك', 'لا تفوتك', 'خذها', 'خذ', 'اشترك', 'علق',
    'قل لي', 'قولوا', 'سوها', 'سويها', 'ابدأ', 'ابدا', 'روح', 'دش', 'تعال', 'علّق', 'احفظها',
  ],
  hook: ['تعال', 'شوف', 'اسمع', 'تصدق', 'تخيل', 'وقفة', 'خلني', 'خلك', 'اليوم', 'أول شي', 'اول شي', 'خلنا'],
  reveal: ['السر', 'المفاجأة', 'الحقيقة', 'النتيجة', 'خلاص', 'وهنا', 'اللي صار', 'تخيل', 'اكتشفت'],
  contrast: ['لكن', 'بس', 'عكس', 'بالعكس', 'المشكلة', 'الحل', 'قبل', 'بعد', 'أغلب', 'الفرق'],
  empathy: ['أعرف', 'أفهم', 'طبيعي', 'لا تزعل', 'معك حق', 'الله يعينك', 'تعبان', 'مضغوط', 'متعب'],
}

const WEAK_SINGLE = new Set(
  ['لا', 'صح', 'تمام', 'كم', 'اي', 'أي', 'من', 'طيب', 'يعني', 'مرة', 'غير', 'اليوم', 'خلني', 'خلك', 'تعرف', 'تدري', 'قبل', 'بعد', 'بس', 'لكن'].map(bareKey),
)

function bareKey(word) {
  return String(word)
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
    .replace(/[\u060C\u061B\u061F\u066A-\u066D«»…]/g, ' ')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\u0600-\u06FFa-zA-Z0-9]/g, '')
    .toLowerCase()
}

function barePhrase(phrase) {
  return String(phrase).split(/\s+/).map(bareKey).filter(Boolean).join(' ')
}

const KEYWORD_INDEX = Object.entries(KEYWORDS).flatMap(([intent, list]) =>
  list.map((keyword) => {
    const normalized = barePhrase(keyword)
    return { intent, keyword: normalized, parts: normalized.split(' ').length }
  }),
)

/** تحليل الجملة: النية + الشدة + أبعاد العاطفة. */
export function analyzeText(text) {
  const raw = String(text ?? '')
  const words = raw.split(/\s+/).map(bareKey).filter(Boolean)
  const scores = Object.fromEntries(Object.keys(KEYWORDS).map((key) => [key, { score: 0, matched: [] }]))

  for (const word of words) {
    for (const entry of KEYWORD_INDEX) {
      if (entry.parts !== 1) continue
      const weight = WEAK_SINGLE.has(entry.keyword) ? 0.32 : 1
      if (word === entry.keyword) {
        scores[entry.intent].score += weight
        scores[entry.intent].matched.push(word)
      } else if (entry.keyword.length >= 3 && word.startsWith(entry.keyword) && word.length - entry.keyword.length <= 3) {
        scores[entry.intent].score += weight * 0.55
        scores[entry.intent].matched.push(word)
      }
    }
  }

  for (let index = 0; index < words.length - 1; index += 1) {
    const pair = `${words[index]} ${words[index + 1]}`
    for (const entry of KEYWORD_INDEX) {
      if (entry.parts > 1 && pair === entry.keyword) {
        scores[entry.intent].score += 1.5
        scores[entry.intent].matched.push(pair)
      }
    }
  }

  if (/[؟?]/.test(raw)) {
    scores.question.score += 2.2
    scores.question.matched.push('؟')
  }
  if (/!/.test(raw)) {
    scores.exclaim.score += 1.5
    scores.exclaim.matched.push('!')
  }
  if (/\.\.\.|…/.test(raw)) {
    scores.reveal.score += 1.1
    scores.reveal.matched.push('…')
  }
  if (/^(?:وش|ليش|كيف|هل|متى|وين|كم)\b/u.test(raw.trim())) {
    scores.question.score += 1.4
    scores.question.matched.push('بداية سؤال')
  }

  let best = { id: 'story', score: 0, matched: [] }
  for (const [intent, value] of Object.entries(scores)) {
    if (value.score > best.score) best = { id: intent, score: value.score, matched: value.matched }
  }
  if (best.score < 1) best = { id: 'story', score: 0, matched: [] }

  const exclamations = (raw.match(/!/g) ?? []).length
  const questions = (raw.match(/[؟?]/g) ?? []).length
  const energy = clamp(Math.round(35 + best.score * 9 + exclamations * 8), 10, 100)
  const tension = clamp(Math.round(20 + (best.id === 'warn' ? 45 : 0) + (raw.includes('...') ? 18 : 0)), 5, 100)
  const warmth = clamp(Math.round(45 + (best.id === 'empathy' || best.id === 'cta' ? 30 : 0) + (raw.includes('الله') ? 10 : 0)), 10, 100)

  return {
    intent: best.id,
    label: BY_ID.get(best.id)?.label ?? 'سرد عادي',
    score: Math.round(best.score * 10) / 10,
    matched: [...new Set(best.matched)].slice(0, 6),
    intensity: clamp(Math.round(2.4 + Math.min(2.4, best.score * 0.5)), 1, 5),
    words: countWords(raw),
    questions,
    isQuestion: /[؟?]\s*$/.test(raw.trim()) || questions > 0,
    emotion: { energy, warmth, tension },
    suggestion: words.length > 24 ? 'جملة طويلة — تُقسَّم تلقائياً عند الفواصل حتى لا يتلاحق النفس' : '',
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** يحوّل النية + الشدة + النمط + الإعدادات العامة إلى قيم نطق نهائية. */
export function resolveProsody({ intent = 'story', intensity = 3, settings = {}, analysis = null, style = 'natural' }) {
  const base = (BY_ID.get(intent) ?? BY_ID.get('story')).prosody
  const styleValues = STYLE_BY_ID.get(style) ?? STYLE_BY_ID.get('natural')
  const factor = [0.45, 0.72, 1, 1.28, 1.55][clamp(Math.round(intensity), 1, 5) - 1]

  const rate = clamp(Math.round((settings.rate ?? 0) + styleValues.rate + base.rate * factor), -30, 60)
  // طبقة الصوت تُخفَّض بنسبة ٠٫٦ لأن إزاحة الهرتز الكبيرة تُخرج الصوت عن طبيعيته
  const pitch = clamp(Math.round(((settings.pitch ?? 0) + styleValues.pitch + base.pitch * factor) * 0.6), -22, 26)
  const volume = clamp(Math.round((settings.volume ?? 0) + styleValues.volume + base.volume * factor), -20, 25)

  let pauseBefore = Math.round(base.pauseBefore * (0.7 + 0.15 * intensity))
  let pauseAfter = Math.round(base.pauseAfter * (0.7 + 0.15 * intensity))
  if (analysis?.words > 22) {
    pauseBefore += 50
    pauseAfter += 70
  }

  return {
    rate,
    pitch,
    volume,
    pauseBefore,
    pauseAfter,
    intentLabel: BY_ID.get(intent)?.label ?? 'سرد عادي',
    styleLabel: styleValues.label,
  }
}

const CONNECTORS = /(?:^|\s)(لكن|بس|لأن|عشان|السر|الحقيقة|المشكلة|الحل|النتيجة|خلاص|بصراحة|وهنا|مع ذلك|بالعكس)(?=\s)/u

/** يقسّم الجملة الطويلة عند روابط المعنى حتى تأخذ كل فكرة نبرتها. */
function clauseSplit(sentence) {
  if (sentence.length <= 70) return [sentence]
  const parts = sentence.split(/(?<=[،؛])\s+|\s+(?=(?:لكن|بس|لأن|عشان|السر|الحقيقة|المشكلة|الحل|النتيجة|خلاص|بصراحة|وهنا|بالعكس)\s)/u)
  const output = []
  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue
    if (trimmed.length > 110) {
      const sub = trimmed.split(/\s+(?=و\s)/u)
      output.push(...sub.map((item) => item.trim()).filter(Boolean))
    } else {
      output.push(trimmed)
    }
  }
  return output.length ? output : [sentence]
}

function pauseForPunctuation(text) {
  const tail = String(text).trim().slice(-3)
  if (/[؟?]/.test(tail)) return 300
  if (/!/.test(tail)) return 320
  if (/\.\.\./.test(tail)) return 420
  if (/[،؛]/.test(tail)) return 130
  if (/\./.test(tail)) return 250
  return 180
}

/**
 * يبني خطة الأداء الكاملة لمقطع: جمل، نبرة كل جملة، صمت قبل/بعد، ودورها في البناء.
 * @param {string} text
 * @param {{intent?: string, intensity?: number, settings?: object, style?: string, isFirst?: boolean}} options
 */
export function planDelivery(text, options = {}) {
  const sentences = splitSentences(text)
  const parts = []
  let cursor = 0
  // كلمات يحملها مدير الاستوديو من تحليل المعنى: تُبرَز بتمهّل وطبقة أعلى
  const emphasis = new Set(
    (Array.isArray(options.emphasis) ? options.emphasis : []).map(bareKey).filter(Boolean),
  )

  for (const sentence of sentences) {
    const analysis = analyzeText(sentence)
    const intent = options.intent && options.intent !== 'auto' ? options.intent : analysis.intent
    const role = options.isFirst && cursor === 0
      ? 'hook'
      : /[؟?]\s*$/.test(sentence)
        ? 'question'
        : intent === 'cta'
          ? 'cta'
          : intent === 'reveal'
            ? 'reveal'
            : 'body'

    const effectiveIntent = role === 'hook' && intent === 'story' ? 'hook' : intent
    const prosody = resolveProsody({
      intent: effectiveIntent,
      intensity: options.intensity ?? analysis.intensity,
      settings: options.settings ?? {},
      analysis,
      style: options.style ?? 'natural',
    })

    const clauses = clauseSplit(sentence)
    clauses.forEach((clause, clauseIndex) => {
      const isLast = clauseIndex === clauses.length - 1
      const clauseAnalysis = analyzeText(clause)
      const clauseIntent = options.intent && options.intent !== 'auto' ? options.intent : clauseAnalysis.intent
      const clauseProsody = clauseIndex === 0
        ? prosody
        : resolveProsody({
            intent: clauseIntent,
            intensity: options.intensity ?? clauseAnalysis.intensity,
            settings: options.settings ?? {},
            analysis: clauseAnalysis,
            style: options.style ?? 'natural',
          })

      const pauseBefore = clauseIndex === 0
        ? (cursor === 0 ? Math.min(prosody.pauseBefore, 180) : Math.round(prosody.pauseBefore * 0.5))
        : 90
      const pauseAfter = isLast ? prosody.pauseAfter : pauseForPunctuation(clause)

      const clauseStems = clause.split(/\s+/).map((word) => bareKey(word).replace(/^ال/, ''))
      const emphasisHits = [...emphasis].filter((word) => clauseStems.includes(bareKey(word).replace(/^ال/, '')))
      // الإبراز لا يغيّر النية، بل يضيف تمهّلاً وطبقة أعلى على الجملة التي تحمل الكلمة المفتاحية
      const performed = emphasisHits.length
        ? {
            ...clauseProsody,
            rate: clamp(clauseProsody.rate - 4, -30, 60),
            pitch: clamp(clauseProsody.pitch + 4, -30, 40),
            volume: clamp(clauseProsody.volume + 2, -20, 25),
          }
        : clauseProsody

      parts.push({
        index: parts.length,
        text: clause,
        intent: clauseIntent,
        intentLabel: BY_ID.get(clauseIntent)?.label ?? 'سرد عادي',
        role: clauseIndex === 0 ? role : 'body',
        rate: performed.rate,
        pitch: performed.pitch,
        volume: performed.volume,
        pauseBefore,
        pauseAfter,
        emphasis: emphasisHits,
        estimated: estimateSeconds(clause),
        note: `${emphasisHits.length ? `إبراز «${emphasisHits[0]}» • ` : ''}${describeDelivery({ intent: clauseIntent, role, rate: performed.rate, pitch: performed.pitch })}`,
      })
    })
    cursor += 1
  }

  return parts
}

/** جملة قصيرة تشرح للمستخدم كيف ستُؤدى الجملة. */
function describeDelivery({ intent, role, rate, pitch }) {
  const direction = rate >= 5 ? 'أسرع' : rate <= -5 ? 'أبطأ' : 'طبيعي'
  const tone = pitch >= 6 ? 'نبرة مرتفعة' : pitch <= -4 ? 'نبرة منخفضة' : 'نبرة ثابتة'
  const map = {
    hook: 'بداية خاطفة',
    question: 'سؤال بنبرة صاعدة في النهاية',
    cta: 'دعوة مباشرة',
    reveal: 'كشف بعد وقفة',
    body: 'سرد',
  }
  return `${map[role] ?? map.body} • ${direction} • ${tone}`
}

/** يقترح نبرة لكل جملة دفعة واحدة (للواجهة). */
export function planProject(segments, settings = {}) {
  return segments.map((segment, index) => ({
    id: segment.id,
    parts: planDelivery(segment.text, {
      intent: segment.intent,
      intensity: segment.intensity,
      style: settings.style ?? segment.style,
      settings,
      isFirst: index === 0,
    }),
  }))
}
