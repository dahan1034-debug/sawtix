import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeText,
  arabicNumberToWords,
  englishNumberToWords,
  splitSentences,
  splitLanguageRuns,
  estimateSeconds,
  detectLanguage,
  formatSrtTime,
} from '../lib/normalize.mjs'
import { lookupTashkeel, GULF_TASHKEEL, MSA_TO_GULF } from '../lib/lexicon.mjs'
import {
  applyGulfLexicon,
  buildSpokenTexts,
  sanitizeTashkeel,
  pausalEnding,
  stripTashkeel,
  phraseOverrides,
  diacriticCoverage,
} from '../lib/tashkeel.mjs'
import { analyzeText, planDelivery, resolveProsody, INTENTS, STYLES } from '../lib/intent.mjs'
import { reviewText, dialectizeText } from '../lib/qa.mjs'
import { resolveVoice, DEFAULT_VOICE, DEFAULT_ENGLISH_VOICE } from '../lib/voices.mjs'

/* ------------------------------ الأرقام ------------------------------ */

test('الأرقام العربية تُنطق كلمات سعودية سليمة', () => {
  assert.equal(arabicNumberToWords(0), 'صفر')
  assert.equal(arabicNumberToWords(7), 'سبعة')
  assert.equal(arabicNumberToWords(12), 'اثنا عشر')
  assert.equal(arabicNumberToWords(21), 'واحد وعشرين')
  assert.equal(arabicNumberToWords(100), 'مية')
  assert.equal(arabicNumberToWords(1500), 'ألف وخمس مية')
  assert.equal(arabicNumberToWords(2000), 'ألفين')
  assert.equal(arabicNumberToWords(3000), 'ثلاثة آلاف')
  assert.equal(arabicNumberToWords(1_250_000), 'مليون وميتين وخمسين ألف')
  assert.equal(arabicNumberToWords(2_000_000_000), 'مليارين')
})

test('الأرقام الإنجليزية تُنطق كلمات', () => {
  assert.equal(englishNumberToWords(0), 'zero')
  assert.equal(englishNumberToWords(42), 'forty-two')
  assert.equal(englishNumberToWords(2026), 'two thousand twenty-six')
})

test('التطبيع يحوّل النسب والعملات والأرقام العربية-الهندية', () => {
  const out = normalizeText('عندنا ٣ مشاكل و 50% من الحلول تكلف 1500 ريال')
  assert.match(out, /ثلاثة مشاكل/)
  assert.match(out, /خمسين بالمئة/)
  assert.match(out, /ألف وخمس مية ريال/)
  assert.doesNotMatch(out, /[٠-٩]/)
})

test('الوقت لا يتكرر فيه لفظ «الساعة»', () => {
  const out = normalizeText('قابلني الساعة 3:30')
  assert.equal((out.match(/الساعة/g) ?? []).length, 1)
  assert.match(out, /ثلاثة ونص/)
})

test('التاريخ يُنطق بالشهر العربي', () => {
  const out = normalizeText('موعدنا 25/11/2026')
  assert.match(out, /خمسة وعشرين نوفمبر/)
  assert.match(out, /ألفين وستة وعشرين/)
})

test('الاختصارات الشائعة تُنطق عربي', () => {
  const out = normalizeText('حمّل ملف PDF وشاهد الريلز على انستقرام')
  assert.match(out, /بي دي إف/)
  assert.match(out, /إنستقرام/)
})

test('تصحيح الإملاء الشائع', () => {
  assert.match(normalizeText('لاكن انشاء الله هاذا الشي'), /لكن/)
  assert.match(normalizeText('لاكن انشاء الله هاذا الشي'), /إن شاء الله/)
})

test('العملات الإنجليزية', () => {
  assert.match(normalizeText('It costs $25', 'en'), /twenty-five dollars/)
})

/* ------------------------------ الجمل ------------------------------ */

test('تقسيم الجمل يحافظ على علامة السؤال ولا يقطع «...»', () => {
  const parts = splitSentences('وش رايك نسوي كذا؟ بصراحة الفكرة حلوة! لكن... محتاجين وقت.')
  assert.equal(parts.length, 3)
  assert.ok(parts[0].endsWith('؟'))
  assert.ok(parts[2].startsWith('لكن...'))
})

test('تقسيم الجمل الطويلة عند الفواصل', () => {
  const long = `${'هذه جملة طويلة جداً '.repeat(6)}، ${'وهذه تكملة أخرى '.repeat(6)}`
  const parts = splitSentences(long)
  assert.ok(parts.length >= 2)
  assert.ok(parts.every((part) => part.length <= 160))
})

test('فصل العربية عن الإنجليزية داخل الجملة', () => {
  const runs = splitLanguageRuns('جرّب تطبيق Canva اليوم')
  assert.deepEqual(runs.map((run) => run.lang), ['ar', 'en', 'ar'])
  assert.equal(runs[1].text, 'Canva')
})

test('كشف اللغة', () => {
  assert.equal(detectLanguage('وش رايك اليوم'), 'ar')
  assert.equal(detectLanguage('This is English only'), 'en')
  assert.equal(detectLanguage('جرب Canva اليوم'), 'mixed')
})

test('تقدير المدة معقول', () => {
  const short = estimateSeconds('وش رايك؟')
  const long = estimateSeconds('وش رايك نجرب الفكرة اليوم ونشوف النتيجة بعد أسبوع كامل من التجربة')
  assert.ok(short > 0.4 && short < 2)
  assert.ok(long > short * 3)
})

test('تنسيق SRT', () => {
  assert.equal(formatSrtTime(0), '00:00:00,000')
  assert.equal(formatSrtTime(61.5), '00:01:01,500')
})

/* ------------------------------ القاموس ------------------------------ */

test('تشكيل الكلمات السعودية الأساسية', () => {
  assert.equal(lookupTashkeel('وش'), 'وَش')
  assert.equal(lookupTashkeel('ليش'), 'لِيش')
  assert.equal(lookupTashkeel('الحين'), 'الحِين')
  assert.equal(lookupTashkeel('عشان'), 'عَشان')
  assert.equal(lookupTashkeel('نجرب'), 'نِجَرِّب')
  assert.equal(lookupTashkeel('يوقفون'), 'يِوقِفُون')
})

test('لا يخلط بين أبداً (الزمن) وأبدأ (الفعل)', () => {
  assert.equal(lookupTashkeel('أبداً'), 'أَبَدًا')
  assert.equal(lookupTashkeel('أبدأ'), 'أَبْدَأ')
})

test('البحث يتعامل مع «ال» وحروف العطف', () => {
  assert.equal(lookupTashkeel('زقزقة'), null)
  assert.match(lookupTashkeel('وراح') ?? '', /رَاح/)
  assert.match(lookupTashkeel('الحين') ?? '', /الحِين/)
  assert.match(lookupTashkeel('وشو') ?? '', /وَشُو/)
})

test('القاموس يغطي حداً أدنى معقولاً من المفردات', () => {
  assert.ok(Object.keys(GULF_TASHKEEL).length >= 150)
  assert.ok(Object.keys(MSA_TO_GULF).length >= 40)
})

test('تطبيق قاموس العبارات', () => {
  const out = applyGulfLexicon('وش رايك نروح الحين')
  assert.match(out, /وَش رَايِك/)
  assert.match(out, /الحِين/)
})

test('تحديد مواضع عبارات القاموس قبل التشكيل', () => {
  const overrides = phraseOverrides('وش رايك اليوم')
  assert.equal(overrides.get(0), 'وَش')
  assert.equal(overrides.get(1), 'رَايِك')
})

test('تنظيف التشكيل من الحركات المكررة والتنوين على التاء', () => {
  assert.equal(stripTashkeel('كِتَابٌ'), 'كتاب')
  const base = sanitizeTashkeel('مُحَمَّدٌ')
  assert.equal(sanitizeTashkeel('مُحَمَّدٌٌ'), base)
  assert.equal(sanitizeTashkeel(base), base)
  assert.equal(sanitizeTashkeel('تَجْرِبَةٌ'), 'تَجْرِبَة')
  assert.equal(sanitizeTashkeel('كِتَابَاً'), 'كِتَابَاً')
})

test('حذف حركة الإعراب في آخر الكلمة فقط', () => {
  assert.equal(pausalEnding('الفَرْقُ.'), 'الفَرْق.')
  assert.equal(pausalEnding('إِنَّ'), 'إِنَّ')
  assert.equal(pausalEnding('ثَانِيَتَيْنِ'), 'ثَانِيَتَيْن')
})

test('بناء النص المنطوق بوضع القاموس فقط بلا نموذج', async () => {
  const [out] = await buildSpokenTexts(['وش رايك نجرب الحين'], { diacritics: 'light' })
  assert.match(out, /وَش رَايِك/)
  assert.match(out, /الحِين/)
  assert.ok(diacriticCoverage(out) > 30)
})

test('قاموس المستخدم يُطبّق قبل التشكيل', async () => {
  const [out] = await buildSpokenTexts(['حمّل Canva'], {
    diacritics: 'light',
    dictionary: [{ orig: 'Canva', phon: 'كَانْفَا' }],
  })
  assert.match(out, /كَانْفَا/)
})

/* ------------------------------ الإلقاء ------------------------------ */

test('كشف السؤال من علامة الاستفهام ومن بداية الجملة', () => {
  assert.equal(analyzeText('تتوقع ليش الناس يوقفون؟').intent, 'question')
  assert.equal(analyzeText('وش رايك في الفكرة').intent, 'question')
})

test('كشف التعجب والتحذير والدعوة', () => {
  assert.equal(analyzeText('واو! هذا رهيب!').intent, 'exclaim')
  assert.equal(analyzeText('انتبه لا تسوي هالغلط').intent, 'warn')
  assert.equal(analyzeText('جرّبها اليوم وقل لي وش صار').intent, 'cta')
})

test('كل النبرات معرّفة ولها قيم نطق صحيحة', () => {
  for (const intent of INTENTS) {
    const prosody = resolveProsody({ intent: intent.id, intensity: 3 })
    assert.ok(prosody.rate >= -30 && prosody.rate <= 60, intent.id)
    assert.ok(prosody.pitch >= -30 && prosody.pitch <= 40, intent.id)
    assert.ok(prosody.pauseAfter >= 0)
  }
  for (const style of STYLES) {
    assert.ok(Number.isFinite(resolveProsody({ style: style.id }).rate))
  }
})

test('خطة الإلقاء تقسّم الجملة الطويلة وتضع وقفات', () => {
  const plan = planDelivery('تتوقع ليش أغلب الناس يوقفون عند أول ثانيتين؟ السبب مو الكاميرا، الموضوع كله في البداية.', { isFirst: true })
  assert.ok(plan.length >= 2)
  assert.equal(plan[0].role, 'hook')
  assert.ok(plan[0].pauseBefore <= 180)
  assert.ok(plan.every((part) => part.pauseAfter >= 90))
})

test('الجملة الأولى تأخذ نبرة افتتاحية', () => {
  const plan = planDelivery('وش صار بعدها', { isFirst: true })
  assert.equal(plan[0].role, 'hook')
})

/* ------------------------------ المراجعة ------------------------------ */

test('المراجعة تكشف الأخطاء الإملائية والفصحى', () => {
  const review = reviewText('لاكن انشاء الله هاذا الشي صعب، هل تعلم أن الأمر الآن مختلف؟')
  const types = review.issues.map((issue) => issue.type)
  assert.ok(types.includes('spelling'))
  assert.ok(types.includes('dialect'))
  assert.ok(review.score < 100)
})

test('النص السعودي الجيد يحصل على درجة عالية', () => {
  const review = reviewText('وش رايك نجرب الحين؟ بصراحة الفكرة حلوة وما تحتاج وقت.')
  assert.ok(review.score >= 85, `score=${review.score}`)
  assert.ok(review.stats.dialectRatio > 0)
})

test('تحويل الفصحى إلى سعودي يحفظ المعنى ويغيّر المفردات', () => {
  const { text, changes } = dialectizeText('أريد أن أستطيع، ولكن هذا الأمر الآن صعب')
  assert.ok(changes.length >= 3)
  assert.match(text, /أبي/)
  assert.match(text, /الحين/)
  assert.match(text, /بس/)
})

test('المراجعة ترصد النص الفصيح الطويل', () => {
  const review = reviewText('إن هذا الأمر يعد من الأمور المهمة التي ينبغي على الإنسان أن يعرفها جيداً قبل البدء')
  assert.ok(review.issues.some((issue) => issue.type === 'dialect-low'))
})

/* ------------------------------ الأصوات ------------------------------ */

test('اختيار الصوت حسب اللغة', () => {
  assert.equal(resolveVoice({ language: 'ar', voice: 'ar-KW-FahedNeural' }), 'ar-KW-FahedNeural')
  assert.equal(resolveVoice({ language: 'en', englishVoice: 'en-GB-SoniaNeural' }), 'en-GB-SoniaNeural')
  assert.equal(resolveVoice({ language: 'en' }), DEFAULT_ENGLISH_VOICE)
  assert.equal(resolveVoice({ language: 'ar' }), DEFAULT_VOICE)
})
