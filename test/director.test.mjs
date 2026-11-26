// مدير الاستوديو: فهم نوع المحتوى والجمهور، اختيار الصوت/النمط، خطة النطق،
// والإبراز — وكلها بلا شبكة وبلا ffmpeg (تحليل نصي فقط).

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  analyzeContent,
  buildPronunciationPlan,
  directText,
  extractEmphasis,
  CONTENT_TYPES,
} from '../lib/director.mjs'
import { planDelivery } from '../lib/intent.mjs'
import { analyzeProject } from '../lib/render.mjs'
import { VOICES } from '../lib/voices.mjs'

const VOICE_IDS = new Set(VOICES.map((voice) => voice.id))

/* --------------------------- فهم نوع المحتوى --------------------------- */

test('يميّز نوع المحتوى من النص وحده', () => {
  const cases = [
    ['خصم ٣٠٪ لفترة محدودة! اطلب الآن واحصل على توصيل مجاني.', 'ad'],
    ['أولاً افتح التطبيق، ثانياً اختر القالب، وأخيراً اضغط تصدير.', 'tutorial'],
    ['عاجل: أعلنت وزارة التجارة اليوم عن قرار جديد يخص المتاجر.', 'news'],
    ['قبل سنوات كنت أشتغل في مقهى، ويوم من الأيام جاءني شخص غريب.', 'story'],
    ['ههههه مقلب اليوم كان أقوى شي، ما توقعت ردة فعله!', 'comedy'],
    ['لا تستسلم، حلمك يستاهل، استمر وابدأ اليوم.', 'motivation'],
    ['جربت الجهاز أسبوع، وهذه تجربتي: مميزات وعيوب وهل يستاهل الشراء.', 'review'],
  ]
  for (const [text, expected] of cases) {
    const profile = analyzeContent(text)
    assert.equal(profile.contentType, expected, `${text} → ${profile.contentType}`)
    assert.ok(profile.confidence >= 35 && profile.confidence <= 96)
  }
  assert.ok(CONTENT_TYPES.length >= 8)
})

test('يستخرج الجمهور والصوت المناسبين', () => {
  const women = analyzeContent('دليل مكياج للبنات: خطوات بسيطة كل يوم.')
  assert.equal(women.audience.id, 'women')
  assert.equal(women.voice.id, 'ar-SA-ZariyahNeural')

  const pros = analyzeContent('شركات التسويق تحتاج خطة واضحة لقياس أرباح الحملة.')
  assert.equal(pros.audience.id, 'professionals')
  assert.ok(VOICE_IDS.has(pros.voice.id))
})

test('اختيار المستخدم الصريح يتقدّم على اقتراح المدير', () => {
  const direction = directText('وش رايك نجرب الفكرة الحين؟', {
    voice: 'ar-KW-NouraNeural',
    style: 'documentary',
    intensity: 5,
  })
  assert.equal(direction.voice.id, 'ar-KW-NouraNeural')
  assert.equal(direction.style.id, 'documentary')
  assert.equal(direction.intensity, 5)
  assert.match(direction.voice.why, /المستخدم/)
})

/* ------------------------------ خطة النطق ------------------------------ */

test('الاختصارات المعروفة تُنطق عربياً وتُوثَّق في الخطة', () => {
  const plan = buildPronunciationPlan('استخدم ChatGPT مع KPI لقياس الحملة.')
  const spoken = Object.fromEntries(plan.auto.map((item) => [item.orig, item.spoken]))
  assert.equal(spoken.ChatGPT, 'شات جي بي تي')
  assert.equal(spoken.KPI, 'كِي بِي آي')
  assert.equal(plan.items.filter((item) => item.type === 'foreign').length, 0)
  assert.ok(plan.score >= 90)
})

test('الكلمة الأجنبية المجهولة تُكشف ولا يُدّعى نطقها', () => {
  const plan = buildPronunciationPlan('صمّم الشعار على Figma اليوم.')
  const foreign = plan.items.find((item) => item.type === 'foreign')
  assert.equal(foreign.sample, 'Figma')
  assert.ok(plan.suggestions.some((item) => item.orig === 'Figma'))
  assert.ok(plan.score < 100)
})

test('الكلمات الملتبسة تُكشف حتى مع حرف العطف', () => {
  const plan = buildPronunciationPlan('وسلّم عليه، ثم كتب الرسالة.')
  const ambiguous = plan.items.filter((item) => item.type === 'ambiguous').map((item) => item.sample)
  assert.ok(ambiguous.includes('سلم'))
  assert.ok(ambiguous.includes('كتب'))
})

test('الخطأ الإملائي يُصحَّح ويُوثَّق كتعديل تلقائي', () => {
  const plan = buildPronunciationPlan('انشاء الله نبدأ الحين.')
  const spelling = plan.items.find((item) => item.type === 'spelling')
  assert.equal(spelling.suggestion, 'إن شاء الله')
  assert.equal(spelling.auto, true)
})

test('النص السعودي النظيف يحصل على جاهزية نطق كاملة', () => {
  const plan = buildPronunciationPlan('وش رايك نجرب الحين؟')
  assert.equal(plan.score, 100)
  assert.equal(plan.verdict, 'جاهز للتوليد')
  assert.equal(plan.items.length, 0)
})

/* ------------------------------ الأداء والإبراز ------------------------------ */

test('يستخرج كلمات الإبراز من المعنى لا من الترقيم', () => {
  const emphasis = extractEmphasis('السر مو في الكاميرا، الفرق كله في البداية.')
  assert.ok(emphasis.includes('السر'))
  assert.ok(emphasis.includes('فرق') || emphasis.includes('الفرق'))
  assert.ok(!emphasis.includes('اليوم'))
})

test('الإبراز يضيف تمهّلاً وطبقة أعلى للجملة التي تحمله', () => {
  const base = planDelivery('السر مو في الكاميرا', { intensity: 3 })
  const accented = planDelivery('السر مو في الكاميرا', { intensity: 3, emphasis: ['السر'] })
  assert.equal(accented[0].rate, base[0].rate - 4)
  assert.equal(accented[0].pitch, base[0].pitch + 4)
  assert.match(accented[0].note, /إبراز/)
  assert.deepEqual(accented[0].emphasis, ['السر'])
  // جملة أخرى لا تتأثر
  const other = planDelivery('نبدأ بالصوت الهادئ', { intensity: 3, emphasis: ['السر'] })
  assert.equal(other[0].rate, planDelivery('نبدأ بالصوت الهادئ', { intensity: 3 })[0].rate)
})

/* --------------------------- التكامل مع خط الإنتاج --------------------------- */

test('التحليل الكامل يعيد موجز المدير، ويُوقَف بـ director=off', async () => {
  const project = {
    voice: 'auto',
    englishVoice: 'en-US-AvaMultilingualNeural',
    settings: { diacritics: 'light', style: 'auto', timingMode: 'natural', defaultGap: 0.2, director: 'on' },
    segments: [{ id: 's1', text: 'خصم لفترة محدودة! اطلب الآن.', intent: 'auto', intensity: null }],
    dictionary: [],
  }
  const on = await analyzeProject(project)
  assert.equal(on.direction.genre, 'ad')
  assert.equal(on.direction.voice.id, 'ar-SA-HamedNeural')
  assert.equal(on.direction.style.id, 'energetic')
  assert.ok(on.direction.pronunciation.score > 0)
  assert.ok(on.segments[0].parts.some((part) => part.note.includes('إبراز')), 'كلمة «الآن» تُبرَز')

  const off = await analyzeProject({
    ...project,
    settings: { ...project.settings, director: 'off' },
  })
  assert.equal(off.direction, null)
  assert.ok(off.segments[0].parts.length > 0)
})
