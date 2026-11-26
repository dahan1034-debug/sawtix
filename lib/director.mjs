// مدير الاستوديو: يقرأ النص كوحدة معنى قبل أي توليد، ثم يخرج «موجز إخراج» كامل:
//   • نوع المحتوى (إعلان، شرح، خبر، قصة، كوميديا، تحفيز، وثائقي، مراجعة...)
//   • الجمهور المستهدف ودرجة الرسمية والطاقة والحميمية والإلحاح
//   • الصوت والنمط والشدة ونوع التعليق المقترح، مع سبب واضح لكل اختيار
//   • خطة نطق: اختصارات وأرقام وأخطاء إملائية وكلمات ملتبسة تحتاج ضبطاً
//   • خطة أداء لكل جملة: دورها (افتتاحية/جسم/خاتمة) والكلمات التي تُبرَز
// القيم كلها قابلة للتجاوز يدوياً: أي اختيار صريح من المستخدم يتقدّم على اقتراح
// المدير. المدير يفهم أولاً، ثم يوجّه التنفيذ — لا يغيّر نص المستخدم.

import { DIALECT_MARKERS, PRONUNCIATION, SPELLING_FIXES } from './lexicon.mjs'
import { countWords, detectLanguage, splitSentences } from './normalize.mjs'
import { analyzeText } from './intent.mjs'
import { VOICES, DEFAULT_VOICE } from './voices.mjs'

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const VOICE_BY_ID = new Map(VOICES.map((voice) => [voice.id, voice]))
const STYLE_LABELS = {
  natural: 'طبيعي (سعودي يومي)',
  energetic: 'حماسي (ريلز)',
  calm: 'هادئ / تعليمي',
  documentary: 'وثائقي',
  comedy: 'كوميدي',
  news: 'إخباري',
}

/** أنواع المحتوى: كلمات مفتاحية + نمط أداء + ترتيب أصوات مقترح + موجز إخراجي. */
export const CONTENT_TYPES = [
  {
    id: 'ad',
    label: 'إعلاني / ترويجي',
    tone: 'حيوي ومقنع',
    style: 'energetic',
    intensity: 4,
    voices: ['ar-SA-HamedNeural', 'ar-AE-HamdanNeural', 'ar-SA-ZariyahNeural'],
    keywords: [
      'خصم', 'تخفيض', 'عرض', 'لفترة محدودة', 'مجاناً', 'مجانا', 'كود', 'براند', 'منتج',
      'حملة', 'إعلان', 'اعلان', 'توصيل', 'اطلب', 'احجز', 'باقة', 'ضمان', 'اشتر', 'اشتري',
      'الآن فقط', 'فرصة', 'لا تفوّت', 'لا تفوت', 'جديدنا', 'متوفر',
    ],
    direction: 'ابدأ بفائدة واحدة تخص الجمهور أو بسؤال يخصه، اذكر العرض بوضوح، واختم بدعوة مباشرة قصيرة.',
  },
  {
    id: 'tutorial',
    label: 'شرح / تعليمي',
    tone: 'واضح ومطمئن',
    style: 'calm',
    intensity: 2,
    voices: ['ar-SA-ZariyahNeural', 'ar-SA-HamedNeural', 'ar-AE-FatimaNeural'],
    keywords: [
      'خطوة', 'خطوات', 'أولاً', 'اولا', 'ثانياً', 'ثانيا', 'ثالثاً', 'ثالثا', 'أخيراً', 'اخيرا',
      'طريقة', 'كيف', 'شرح', 'اشرح', 'تعلم', 'دليل', 'نصيحة', 'أسهل', 'اسهل', 'ابدأ', 'افتح',
      'اختر', 'اضغط', 'قوالب', 'إعداد', 'اعداد', 'درس', 'تطبيق عملي',
    ],
    direction: 'قسّم الشرح إلى خطوات مرقّمة، تمهّل عند كل خطوة، وضع وقفة قصيرة قبل تعليمات التنفيذ.',
  },
  {
    id: 'story',
    label: 'قصة / سرد',
    tone: 'دافئ وسردي',
    style: 'natural',
    intensity: 3,
    voices: ['ar-KW-FahedNeural', 'ar-KW-NouraNeural', 'ar-SY-LaithNeural'],
    keywords: [
      'قصة', 'قصتي', 'كان', 'كانت', 'قبل سنوات', 'يوم من الأيام', 'حدث', 'رحلة', 'رحلتي',
      'بدايتي', 'اكتشفت', 'شخص', 'صديق', 'تذكر', 'أتذكر', 'حكاية', 'مرّت', 'مرت',
    ],
    direction: 'ابنِ الحدث بتفاصيل حسّية، وخفّف السرعة عند لحظة التحوّل، وضع صمتاً قصيراً قبل النتيجة.',
  },
  {
    id: 'news',
    label: 'إخباري / تقرير',
    tone: 'رصين وواثق',
    style: 'news',
    intensity: 3,
    voices: ['ar-SA-HamedNeural', 'ar-AE-HamdanNeural', 'ar-SA-ZariyahNeural'],
    keywords: [
      'عاجل', 'أعلنت', 'اعلنت', 'أعلن', 'اعلن', 'نشرة', 'مصادر', 'تقرير', 'وزارة', 'هيئة',
      'ارتفاع', 'انخفاض', 'مؤتمر', 'بيان', 'أرقام', 'احصائيات', 'إحصائية',
    ],
    direction: 'ابدأ بالخبر الأهم في جملة واحدة، ثم التفاصيل بالأهم فالأقل، وحافظ على نبرة ثابتة بلا مبالغة.',
  },
  {
    id: 'comedy',
    label: 'كوميدي / ترفيهي',
    tone: 'خفيف ومتقلّب',
    style: 'comedy',
    intensity: 4,
    voices: ['ar-KW-FahedNeural', 'ar-KW-NouraNeural', 'ar-BH-AliNeural'],
    keywords: [
      'هههه', 'ههه', 'أضحك', 'اضحك', 'نكتة', 'كوميديا', 'مقلب', 'مزح', 'ضحك', 'تحدي',
      'سوالف', 'موقف', 'صارت لي', 'ما توقعت', 'مستحيل',
    ],
    direction: 'ابنِ التوقّع ثم اكسره، وضع وقفة قصيرة قبل المفاجأة، ولا تشرح النكتة بعدها.',
  },
  {
    id: 'motivation',
    label: 'تحفيزي / إلهامي',
    tone: 'مشحون بالإلهام',
    style: 'energetic',
    intensity: 4,
    voices: ['ar-AE-HamdanNeural', 'ar-SA-HamedNeural', 'ar-SA-ZariyahNeural'],
    keywords: [
      'لا تستسلم', 'حلم', 'حلمك', 'نجاح', 'طموح', 'تحدي', 'تقدر', 'استمر', 'إنجاز', 'انجاز',
      'هدف', 'فشل', 'ابدأ اليوم', 'غير حياتك', 'تستاهل', 'قوة', 'إرادة', 'ارادة',
    ],
    direction: 'ابدأ من الألم أو السؤال، ثم ارفع الطاقة تدريجياً، واختم بجملة قصيرة حاسمة.',
  },
  {
    id: 'documentary',
    label: 'وثائقي / معرفي',
    tone: 'هادئ ورصين',
    style: 'documentary',
    intensity: 2,
    voices: ['ar-OM-AbdullahNeural', 'ar-AE-HamdanNeural', 'ar-OM-AyshaNeural'],
    keywords: [
      'تاريخ', 'حضارة', 'وثائقي', 'فيلم', 'قصة حقيقية', 'قديماً', 'قديما', 'الحقيقة', 'اكتشاف',
      'اكتشف', 'العلماء', 'عالم', 'دراسة', 'عام', 'قرن', 'حضارات', 'أسرار', 'اسرار',
    ],
    direction: 'قدّم المعلومة بترتيب زمني أو سببي، وتمهّل عند الأرقام والأسماء، وضع صمتاً بعد المعلومة المهمة.',
  },
  {
    id: 'review',
    label: 'مراجعة / تقييم',
    tone: 'صادق وعملي',
    style: 'natural',
    intensity: 3,
    voices: ['ar-SA-HamedNeural', 'ar-SA-ZariyahNeural', 'ar-KW-NouraNeural'],
    keywords: [
      'جربت', 'جرّبت', 'تجربتي', 'رأيي', 'رايي', 'مميزات', 'ميزات', 'عيوب', 'تقييم', 'أفضل',
      'افضل', 'أسوأ', 'اسوأ', 'مقارنة', 'يستاهل', 'هل يستاهل', 'تجربة استخدام', 'بعد أسبوع',
      'بعد شهر', 'الخلاصة',
    ],
    direction: 'اذكر الحكم مبكراً، ثم المميزات والعيوب بأمثلة، واختم بخلاصة عملية لمن يناسبه المنتج.',
  },
  {
    id: 'social',
    label: 'محتوى اجتماعي عام',
    tone: 'قريب وطبيعي',
    style: 'natural',
    intensity: 3,
    voices: ['ar-SA-HamedNeural', 'ar-SA-ZariyahNeural', 'ar-KW-FahedNeural'],
    keywords: ['ريلز', 'ستوري', 'فولو', 'متابعين', 'ترند', 'فيديو', 'مقطع', 'حساب', 'منشور', 'سؤال'],
    direction: 'ابدأ بجملة قريبة من الجمهور، قدّم فكرة واحدة لكل مقطع، واختم بسؤال أو دعوة خفيفة.',
  },
]

/** الجمهور: يغيّر درجة الرسمية واختيار الصوت، لا يغيّر المعنى. */
export const AUDIENCES = [
  {
    id: 'kids',
    label: 'أطفال / عائلات',
    keywords: ['للأطفال', 'للاعبين', 'طفل', 'أطفال', 'اطفال', 'صغار', 'لعبة', 'مدرسة', 'مدرسه', 'أولاد', 'اولاد'],
    voices: ['ar-QA-AmalNeural', 'ar-AE-FatimaNeural', 'ar-OM-AyshaNeural'],
  },
  {
    id: 'women',
    label: 'جمهور نسائي',
    keywords: ['للنساء', 'للبنات', 'نسائي', 'مكياج', 'عناية', 'طبخ', 'أزياء', 'ازياء', 'ديكور', 'وصفات'],
    voices: ['ar-SA-ZariyahNeural', 'ar-AE-FatimaNeural', 'ar-KW-NouraNeural'],
  },
  {
    id: 'professionals',
    label: 'مهنيون / أعمال',
    keywords: ['شركات', 'شركة', 'بزنس', 'ريادة', 'رياده', 'موظف', 'موظفين', 'استثمار', 'أرباح', 'ارباح', 'تسويق', 'مشروع', 'عملاء'],
    voices: ['ar-AE-HamdanNeural', 'ar-SA-HamedNeural', 'ar-SA-ZariyahNeural'],
  },
  {
    id: 'youth',
    label: 'شباب / جيل رقمي',
    keywords: ['شباب', 'جيل', 'طلاب', 'جامعة', 'جامعات', 'ريلز', 'ترند', 'تيك توك', 'سناب'],
    voices: ['ar-SA-HamedNeural', 'ar-KW-FahedNeural', 'ar-KW-NouraNeural'],
  },
]

/** كلمات تحمل المعنى الأساسي فتستحق إبرازاً في النبرة. */
const EMPHASIS_WORDS = [
  'أهم', 'اهم', 'السر', 'أبداً', 'ابدا', 'مستحيل', 'مجاناً', 'مجانا', 'لازم', 'ممنوع',
  'خطأ', 'خطا', 'أفضل', 'افضل', 'أقوى', 'اقوى', 'الوحيد', 'الحقيقة', 'حقيقي', 'فرق',
  'كثير', 'جداً', 'جدا', 'بصراحة', 'فعلاً', 'فعلا', 'خلاص', 'الآن', 'الان', 'الحين',
  'لا', 'بدون',
]

/** كلمات تحتاج حركة صحيحة لأن الحركة تغيّر المعنى كلياً. */
export const AMBIGUOUS_WORDS = [
  { word: 'سلم', options: ['سَلَّمَ (حيّاك)', 'سِلْم (صلح)', 'سَلَم (تصغير)'], note: 'الحركة تغيّر الفعل إلى اسم' },
  { word: 'علم', options: ['عَلِمَ (عرف)', 'عَلَم (راية)', 'عِلْم (معرفة)'], note: 'ثلاثة معانٍ مختلفة بنفس الرسم' },
  { word: 'كتب', options: ['كَتَبَ (خطّ)', 'كُتُب (مؤلفات)'], note: 'فعل أو جمع كتاب' },
  { word: 'ملك', options: ['مَلَك (حاكم/ملك)', 'مُلْك (ملكية)', 'مَلَّك (جعله يملك)'], note: 'يختلف المعنى بالحركة' },
  { word: 'جدد', options: ['جَدَّد (أعاد)', 'جُدُد (جمع جديد)'], note: 'فعل أو صفة' },
  { word: 'حلم', options: ['حَلَم (رأى في المنام)', 'حِلْم (أمنية)'], note: 'فعل أو اسم' },
  { word: 'نزل', options: ['نَزَل (هبط)', 'نُزُل (مكان إقامة)'], note: 'فعل أو اسم' },
  { word: 'عدد', options: ['عَدَد (رقم)', 'عَدَّد (أحصى)'], note: 'اسم أو فعل' },
]


function normalizeForMatch(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** مطابقة عبارة كاملة بحدود عربية/لاتينية، لا مطابقة داخل كلمة. */
function matchesPhrase(text, phrase) {
  const target = normalizeForMatch(phrase)
  if (!target) return false
  return new RegExp(`(^|[^\\u0621-\\u064Aa-z])${escapeRegex(target)}($|[^\\u0621-\\u064Aa-z])`, 'u').test(text)
}

function scoreKeywords(text, keywords) {
  const matched = []
  let score = 0
  for (const keyword of keywords) {
    if (!matchesPhrase(text, keyword)) continue
    score += 1 + 0.35 * (normalizeForMatch(keyword).split(' ').length - 1)
    matched.push(keyword)
  }
  return { score, matched }
}

function pickFirstExisting(ids) {
  return ids.find((id) => VOICE_BY_ID.has(id)) ?? DEFAULT_VOICE
}

function voiceInfo(id, why) {
  const voice = VOICE_BY_ID.get(id) ?? VOICE_BY_ID.get(DEFAULT_VOICE)
  return {
    id: voice.id,
    label: voice.label,
    short: voice.short,
    gender: voice.gender,
    accent: voice.accent,
    why,
  }
}

function styleInfo(id, why) {
  const resolved = STYLE_LABELS[id] ? id : 'natural'
  return { id: resolved, label: STYLE_LABELS[resolved], why }
}

/**
 * يحلّل نوع المحتوى والجمهور والنبرة من النص وحده.
 * @param {string} text
 * @param {{segments?: object[]}} options
 */
export function analyzeContent(text, options = {}) {
  const raw = String(text ?? '')
  const segments = Array.isArray(options.segments) && options.segments.length
    ? options.segments
    : splitSentences(raw).map((sentence) => ({ text: sentence }))
  const joined = segments.map((segment) => String(segment?.text ?? '')).join(' ')
  const matchable = normalizeForMatch(joined)
  const sentences = splitSentences(joined)
  const words = joined.split(/\s+/).filter((word) => /[\u0600-\u06FFa-zA-Z0-9]/.test(word))
  const arabicWords = words.filter((word) => /[\u0600-\u06FF]/.test(word))
  const latinWords = words.filter((word) => /^[A-Za-z]/.test(word))
  const questions = (joined.match(/[؟?]/g) ?? []).length
  const exclamations = (joined.match(/!/g) ?? []).length
  const avgSentenceWords = sentences.length ? Math.round((countWords(joined) / sentences.length) * 10) / 10 : 0

  const dialectHits = arabicWords.filter((word) => DIALECT_MARKERS.has(normalizeForMatch(word)))
  const dialectRatio = arabicWords.length ? Math.round((dialectHits.length / arabicWords.length) * 100) : 0
  const formality = clamp(Math.round(100 - dialectRatio * 1.5), 5, 95)

  const urgencySignals = ['الآن', 'الان', 'اليوم', 'عاجل', 'آخر', 'اخر', 'ينتهي', 'محدود', 'بسرعة', 'بسرعه', 'فوراً', 'فورا', 'قبل']
  const urgencyHits = urgencySignals.filter((keyword) => matchesPhrase(matchable, keyword))
  const warmthSignals = ['أنا', 'انا', 'نحن', 'معك', 'معاك', 'ساعد', 'شكراً', 'شكرا', 'الله', 'أهلاً', 'هلا', 'حبيب', 'صديق']
  const warmthHits = warmthSignals.filter((keyword) => matchesPhrase(matchable, keyword))

  const scores = new Map()
  for (const genre of CONTENT_TYPES) {
    scores.set(genre.id, scoreKeywords(matchable, genre.keywords))
  }

  const first = sentences[0] ?? ''
  const structure = {
    hook: /[؟?]|!/.test(first) || /^(?:تعال|شوف|اسمع|تخيل|تصدق|هل|وش|ليش|كيف|لا تفوت)/u.test(first),
    cta: /(اشترك|تابع|اضغط|احجز|اطلب|جرّب|جرب|شارك|علّق|علّق|حمّل|حمل|احفظ|قل لي)/u.test(matchable),
    steps: /(أولاً|اولا|ثانياً|ثانيا|ثالثاً|ثالثا|الخطوة|خطوة|أخيراً|اخيرا)/u.test(matchable),
    story: /(قبل سنوات|يوم من الأيام|يوم من الايام|قصتي|رحلتي|كان لي)/u.test(matchable),
  }
  if (structure.steps) scores.get('tutorial').score += 0.8
  if (structure.cta && /\b(?:خصم|عرض|منتج|براند|كود|باقة)\b/u.test(matchable)) scores.get('ad').score += 0.8
  if (structure.story) scores.get('story').score += 0.8

  let best = { id: 'social', score: 0, matched: [] }
  let second = { id: 'social', score: 0 }
  for (const [id, value] of scores.entries()) {
    if (value.score > best.score) {
      second = best
      best = { id, score: value.score, matched: value.matched }
    } else if (value.score > second.score) {
      second = { id, score: value.score }
    }
  }
  // لا دليل كافٍ (كلمة عامة واحدة مثل «ريلز» أو «اليوم»): لا نُعلن نوعاً بثقة زائفة.
  if (best.score < 1.6) {
    if (structure.story) best = { id: 'story', score: best.score, matched: best.matched }
    else if (avgSentenceWords >= 14) best = { id: 'story', score: best.score, matched: best.matched }
    else best = { id: 'social', score: best.score, matched: best.matched }
  }
  const genre = CONTENT_TYPES.find((item) => item.id === best.id) ?? CONTENT_TYPES.at(-1)
  const confidence = clamp(Math.round(45 + best.score * 10 + (best.score - second.score) * 12), 35, 96)

  let audience = { id: 'general', label: 'جمهور عام', confidence: 40, matched: [] }
  let audienceScore = 0
  for (const candidate of AUDIENCES) {
    const result = scoreKeywords(matchable, candidate.keywords)
    if (result.score > audienceScore) {
      audienceScore = result.score
      audience = { ...candidate, confidence: clamp(45 + result.score * 12, 45, 92), matched: result.matched }
    }
  }

  // الصوت: الجمهور أولاً إن كان محدداً، ثم نوع المحتوى، ثم الافتراضي.
  const voiceCandidates = audience.id !== 'general'
    ? [...audience.voices, ...genre.voices]
    : genre.voices
  const voiceId = pickFirstExisting(voiceCandidates)
  const voiceReason = audience.id !== 'general'
    ? `مناسب لجمهور «${audience.label}» ثم لنوع «${genre.label}»`
    : `الأنسب لنوع «${genre.label}» حسب طبقة الصوت وإيقاعه`
  const voice = voiceInfo(voiceId, voiceReason)

  const energy = clamp(
    Math.round(38 + exclamations * 7 + (avgSentenceWords > 0 && avgSentenceWords <= 9 ? 8 : 0) + urgencyHits.length * 6 + (questions ? 4 : 0)),
    10,
    100,
  )
  const warmth = clamp(45 + warmthHits.length * 7 + (audience.id === 'women' || audience.id === 'kids' ? 10 : 0), 10, 100)
  const tension = clamp(20 + (genre.id === 'news' ? 20 : 0) + (genre.id === 'documentary' ? 15 : 0) + (urgencyHits.length ? 18 : 0), 5, 100)
  const intensity = clamp(genre.intensity + (energy >= 68 ? 1 : 0) + (energy <= 28 ? -1 : 0), 1, 5)
  const style = styleInfo(genre.style, `نمط «${STYLE_LABELS[genre.style]}» يخدم نوع «${genre.label}»`)

  return {
    contentType: genre.id,
    label: genre.label,
    confidence,
    signals: best.matched.slice(0, 6),
    tone: genre.tone,
    direction: genre.direction,
    audience,
    energy,
    warmth,
    tension,
    formality,
    urgency: urgencyHits.length ? 'مرتفع' : 'عادي',
    stats: {
      words: countWords(joined),
      sentences: sentences.length,
      questions,
      exclamations,
      avgSentenceWords,
      dialectRatio,
      latinWords: latinWords.length,
      segments: segments.length,
    },
    structure,
    intensity,
    style,
    voice,
    suggestedVoice: voice,
    summary: `${genre.label} • ${genre.tone} • ${voice.label} • ${STYLE_LABELS[style.id]} • شدة ${intensity}/5`,
    notes: [
      genre.direction,
      `الجمهور المقترح: ${audience.label} (ثقة ${audience.confidence}٪)، الرسمية ${formality}٪، الطاقة ${energy}٪.`,
      `الصوت المقترح: ${voice.label} — ${voice.why}.`,
      structure.hook ? 'الافتتاحية فيها خطّاف واضح؛ يُخفَّف الشرح في أول ثانيتين.' : 'لا يوجد خطّاف صريح؛ يُستحسن سؤال أو جملة قصيرة في البداية.',
    ],
  }
}

/** يستخرج الكلمات التي تحمل المعنى الأساسي في النص. */
export function extractEmphasis(text, limit = 6) {
  const tokens = String(text ?? '').split(/\s+/).map((word) => normalizeForMatch(word.replace(/[^\u0600-\u06FFa-zA-Z0-9]/g, '')))
  const found = []
  for (const candidate of EMPHASIS_WORDS) {
    const key = normalizeForMatch(candidate)
    const variants = new Set([key, `ال${key}`, `و${key}`, `وال${key}`])
    if (tokens.some((token) => variants.has(token)) && !found.some((item) => normalizeForMatch(item) === key)) {
      found.push(candidate)
    }
    if (found.length >= limit) break
  }
  return found
}

/**
 * خطة النطق: ما سيُصحَّح تلقائياً، وما يحتاج قراراً بشرياً.
 * لا يدّعي المدير معرفة نطق اسم لا يعرفه؛ بل يكشفه ويقترح إضافته للقاموس.
 */
export function buildPronunciationPlan(text, options = {}) {
  const raw = String(text ?? '')
  const language = detectLanguage(raw)
  // الجملة الإنجليزية الخالصة تُنطق بصوت إنجليزي: ليست «خطر نطق» داخل العربية.
  // نفحص فقط الجمل التي فيها عربية (عربية خالصة أو مختلطة).
  const arabicRaw = splitSentences(raw)
    .filter((sentence) => detectLanguage(sentence) !== 'en')
    .join(' ')
  const arabic = Boolean(arabicRaw.trim())
  const dictionary = Array.isArray(options.dictionary) ? options.dictionary : []
  const customOrig = new Set(dictionary.map((entry) => normalizeForMatch(entry?.orig)))
  const items = []
  const auto = []
  const suggestions = []

  // ١) أخطاء إملائية تُصحَّح تلقائياً قبل النطق.
  for (const [wrong, right] of Object.entries(SPELLING_FIXES)) {
    if (wrong === right) continue
    if (!matchesPhrase(normalizeForMatch(arabicRaw), wrong)) continue
    items.push({
      type: 'spelling',
      severity: 'medium',
      sample: wrong,
      message: `«${wrong}» تُكتب «${right}» — تُصحَّح تلقائياً قبل النطق`,
      suggestion: right,
      auto: true,
    })
  }

  // ٢) اختصارات ومصطلحات معروفة: تُنطق عربياً كما في القاموس.
  const latinTokens = [...new Set((arabicRaw.match(/[A-Za-z][A-Za-z0-9'’.-]*/g) ?? []))]
  const known = {}
  for (const token of latinTokens) {
    const key = token.replace(/[.']/g, '')
    const exact = PRONUNCIATION[token] ?? PRONUNCIATION[key]
    if (exact) {
      auto.push({ orig: token, spoken: exact, source: 'lexicon' })
      known[token] = exact
    }
  }

  // ٣) كلمات لاتينية غير معروفة داخل نص عربي: خطر لكنة أو نطق حرفي.
  if (arabic) {
    for (const token of latinTokens) {
      if (known[token] || customOrig.has(normalizeForMatch(token))) continue
      if (token.length < 2) continue
      items.push({
        type: 'foreign',
        severity: 'medium',
        sample: token,
        message: `«${token}» غير موجودة في قاموس النطق — قد تُقرأ بلكنة إنجليزية أو حرفاً حرفاً`,
        suggestion: `أضفها إلى قاموس النطق (مثال: ${token} → النطق العربي المقصود)`,
      })
      suggestions.push({ orig: token, phon: '' })
    }

    // ٤) كلمات ملتبسة تحتاج حركة صحيحة (مع حروف العطف و«ال»).
    const tokens = arabicRaw.split(/\s+/).map((word) => normalizeForMatch(word.replace(/[^\u0600-\u06FF]/g, '')))
    for (const entry of AMBIGUOUS_WORDS) {
      const key = normalizeForMatch(entry.word)
      const variants = new Set([key, `و${key}`, `ف${key}`, `ال${key}`, `وال${key}`, `بال${key}`, `لل${key}`])
      if (!tokens.some((token) => variants.has(token))) continue
      if (customOrig.has(normalizeForMatch(entry.word))) continue
      items.push({
        type: 'ambiguous',
        severity: 'medium',
        sample: entry.word,
        message: `«${entry.word}»: ${entry.note} — ${entry.options.join(' / ')}`,
        suggestion: `أضف الشكل المقصود إلى قاموس النطق (${entry.options[0]})`,
      })
    }
  }

  // ٥) الأرقام والتواريخ والعملات: تُحوَّل آلياً؛ نُبلّغ بها لا نُحذّر منها.
  const numbers = raw.match(/\d[\d.,:/%-]*/g) ?? []
  if (numbers.length) {
    items.push({
      type: 'number',
      severity: 'low',
      sample: numbers.slice(0, 3).join('، '),
      message: 'الأرقام والعملات والتواريخ تُحوَّل إلى كلمات منطوقة تلقائياً',
      suggestion: 'راجع الصيغة إن كان الرقم خاصاً (رقم جوال، كود، سنة)',
      auto: true,
    })
  }

  if (/[#@]|https?:\/\//.test(raw)) {
    items.push({
      type: 'symbol',
      severity: 'low',
      sample: (raw.match(/[#@]\S+|https?:\/\/\S+/g) ?? [])[0],
      message: 'الهاشتاق والحساب والرابط تُنطق كلمات (هاشتاق/حساب/رابط)',
      suggestion: 'احذفها إن لم تردها في الصوت',
      auto: true,
    })
  }

  const penalty = items.reduce((sum, item) => {
    if (item.type === 'foreign') return sum + 7
    if (item.type === 'ambiguous') return sum + 4
    if (item.type === 'spelling') return sum + 1
    return sum
  }, 0)
  const score = clamp(100 - penalty, 0, 100)
  const grade = score >= 90 ? 'ممتاز' : score >= 75 ? 'جيد' : score >= 60 ? 'يحتاج ضبطاً' : 'ضعيف'
  const verdict = score >= 75 ? 'جاهز للتوليد' : 'راجع النطق قبل التوليد'
  const top = items.filter((item) => !item.auto).slice(0, 3).map((item) => item.sample).filter(Boolean)

  return {
    score,
    grade,
    verdict,
    language,
    items: items.sort((a, b) => (b.severity === 'medium' ? 1 : 0) - (a.severity === 'medium' ? 1 : 0)),
    auto,
    suggestions,
    summary: top.length
      ? `${items.filter((item) => !item.auto).length} ملاحظة تحتاج قراراً — أبرزها: ${top.join('، ')}`
      : `النطق جاهز: ${auto.length} مصطلح سيُنطق من القاموس، والباقي يغطيه التشكيل التلقائي.`,
  }
}

const ROLE_NOTES = {
  hook: 'خطّاف: ابدأ سريعاً ونبرة أعلى قليلاً، ولا تشرح في أول ثانية.',
  body: 'جسم: إيقاع ثابت مع وقفة عند كل فكرة، وإبراز الكلمات المفتاحية.',
  close: 'خاتمة: جملة قصيرة وواضحة، وتمهّل قبلها ليثبت المعنى.',
}

/**
 * يوجّه مشروعاً كاملاً: نوع، جمهور، صوت، نمط، شدة، نطق، وخطة لكل جملة.
 * الاختيار الصريح من المستخدم (voice/style/intensity/intent) يتقدّم دائماً.
 */
export function directText(text, options = {}) {
  const raw = String(text ?? '')
  const segments = Array.isArray(options.segments) && options.segments.length
    ? options.segments
    : splitSentences(raw).map((sentence) => ({ text: sentence }))
  const projectText = segments.map((segment) => String(segment?.text ?? '')).join('\n') || raw
  const profile = analyzeContent(projectText, { segments })

  const requestedVoice = options.voice && options.voice !== 'auto' ? options.voice : null
  const voice = requestedVoice && VOICE_BY_ID.has(requestedVoice)
    ? voiceInfo(requestedVoice, 'اختيار المستخدم — المدير يحترمه ولا يستبدله')
    : profile.voice
  const requestedStyle = options.style && options.style !== 'auto' ? options.style : null
  const style = requestedStyle && STYLE_LABELS[requestedStyle]
    ? styleInfo(requestedStyle, 'اختيار المستخدم — المدير يحترمه ولا يستبدله')
    : profile.style
  const intensity = Number(options.intensity) >= 1 && Number(options.intensity) <= 5
    ? Math.round(Number(options.intensity))
    : profile.intensity

  const directions = segments.map((segment, index) => {
    const segmentText = String(segment?.text ?? '')
    const analysis = analyzeText(segmentText)
    const role = index === 0 ? 'hook' : index === segments.length - 1 && segments.length > 1 ? 'close' : 'body'
    const explicitIntent = segment?.intent && segment.intent !== 'auto' ? segment.intent : null
    const explicitVoice = segment?.voice && segment.voice !== 'auto' && VOICE_BY_ID.has(segment.voice) ? segment.voice : null
    return {
      index,
      role,
      intent: explicitIntent ?? analysis.intent,
      intensity: Number(segment?.intensity) >= 1 ? Math.round(Number(segment.intensity)) : intensity,
      style: segment?.style || style.id,
      voice: explicitVoice ?? voice.id,
      emphasis: extractEmphasis(segmentText),
      note: `${ROLE_NOTES[role]} • ${style.label}`,
    }
  })

  const pronunciation = buildPronunciationPlan(projectText, { dictionary: options.dictionary })
  const voiceLine = voice.why.includes('المستخدم')
    ? `الصوت: ${voice.label} (اختيارك).`
    : `الصوت المقترح: ${voice.label} — ${voice.why}.`

  return {
    ...profile,
    voice,
    style,
    intensity,
    pronunciation,
    segments: directions,
    summary: `${profile.label} • ${profile.tone} • ${voice.label} • ${style.label} • شدة ${intensity}/5`,
    notes: [
      profile.direction,
      `الجمهور المقترح: ${profile.audience.label} • الرسمية ${profile.formality}٪ • الطاقة ${profile.energy}٪ • الإلحاح ${profile.urgency}.`,
      voiceLine,
      ...profile.notes.slice(3),
      pronunciation.summary,
    ],
    suggestedVoice: profile.voice,
  }
}

export const __test__ = { normalizeForMatch, EMPHASIS_WORDS }
