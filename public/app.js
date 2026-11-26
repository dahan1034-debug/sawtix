/* FINIX Voice Studio — واجهة الاستوديو (JavaScript خالص، بلا خطوة بناء) */

const STORAGE_KEY = 'finix_voice_studio_v3';

const SAMPLE_SCRIPT = [
  'تتوقع ليش أغلب الناس يوقفون عند أول ثانيتين من الريلز؟',
  'السبب مو جودة الكاميرا أبداً!',
  'السر الحقيقي... إن البداية ما فيها فضول واضح.',
  'جرّب تطبق الفكرة اليوم وراح تلاحظ الفرق بنفسك.',
].join('\n');

const PRESETS = {
  hook: [
    'توقف! لا تسحب على هذا المقطع...',
    'أغلب الناس يغلطون في أول ثلاث ثواني، والنتيجة مشاهدة تروح هدر.',
    'السر بسيط: ابدأ بسؤال يخص جمهورك، وخلّ أول جملة قصيرة وواضحة.',
    'جرّبها في مقطعك القادم وقل لي وش صار!',
  ].join('\n'),
  tutorial: [
    'اليوم نرتب التعليق الصوتي للريلز بثلاث خطوات بسيطة.',
    'أولاً، ثبّت صوتاً واحداً لكل مقاطعك حتى يعرفك الجمهور فوراً.',
    'ثانياً، اضبط توقيت كل جملة بالثانية وحدد نبرتها.',
    'وأخيراً، صدّر الملف MP3 وابدأ المونتاج مباشرة.',
  ].join('\n'),
};

const state = {
  voice: 'auto',
  englishVoice: 'en-US-AvaMultilingualNeural',
  style: 'auto',
  director: 'on',
  diacritics: 'smart',
  rate: 0,
  pitch: 0,
  volume: 0,
  timingMode: 'natural',
  gap: 0.2,
  script: '',
  segments: [],
  dictionary: [],
};

let config = null;
let analysis = null;
let analyzeTimer = null;
let analyzeToken = 0;
let rendering = false;

const $ = (id) => document.getElementById(id);

/* ------------------------------- أدوات ------------------------------- */

function toast(message, kind = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.className = 'toast';
  }, kind === 'error' ? 9000 : 5000);
}

function escape(value) {
  return String(value ?? '');
}

function create(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function uid() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* التخزين قد يكون مقيداً */
  }
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    Object.assign(state, parsed);
    if (!Array.isArray(state.segments)) state.segments = [];
    if (!Array.isArray(state.dictionary)) state.dictionary = [];
  } catch {
    /* تجاهل */
  }
}

function formatSeconds(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds % 60).toFixed(1).padStart(4, '0');
  return minutes ? `${minutes}:${rest}` : `${rest} ث`;
}

function settingsPayload(extra = {}) {
  return {
    rate: Number(state.rate) || 0,
    pitch: Number(state.pitch) || 0,
    volume: Number(state.volume) || 0,
    style: state.style,
    diacritics: state.diacritics,
    timingMode: state.timingMode,
    defaultGap: Number(state.gap) || 0,
    director: state.director === 'off' ? 'off' : 'on',
    ...extra,
  };
}

/* --------------------------- تقسيم السكريبت --------------------------- */

function splitScript(text) {
  const lines = String(text ?? '').split(/\n+/);
  const sentences = [];
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    const guarded = trimmedLine.replace(/\.{2,}/g, '…');
    const matches = guarded.match(/[^.!؟?]+[.!؟?]+|[^.!؟?]+$/g) ?? [];
    for (const piece of matches) {
      const sentence = piece.replace(/…/g, '...').trim();
      if (sentence) sentences.push(sentence);
    }
  }
  return sentences;
}

function syncSegmentsFromScript() {
  const sentences = splitScript(state.script);
  const previous = state.segments;
  state.segments = sentences.map((text, index) => {
    const old = previous[index];
    return {
      id: old?.id ?? uid(),
      text,
      intent: old?.intent ?? 'auto',
      intensity: old?.intensity ?? null,
      target: old?.target ?? null,
      start: old?.start ?? null,
      style: old?.style ?? '',
      voice: old?.voice ?? '',
    };
  });
}

function scriptFromSegments() {
  return state.segments.map((segment) => segment.text.trim()).filter(Boolean).join('\n');
}

/* ------------------------------ الإعدادات ------------------------------ */

function fillSelect(select, items, valueKey, labelKey, formatter) {
  select.replaceChildren();
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item[valueKey];
    option.textContent = formatter ? formatter(item) : item[labelKey];
    select.append(option);
  }
}

function populateConfig() {
  fillSelect($('voice'), config.voices, 'id', 'label', (voice) => `${voice.short} — ${voice.label}`);
  fillSelect($('englishVoice'), config.englishVoices, 'id', 'label', (voice) => voice.label);
  fillSelect($('style'), config.styles, 'id', 'label');
  $('voice').prepend(new Option('تلقائي — يختاره مدير الاستوديو', 'auto'));
  $('style').prepend(new Option('تلقائي — حسب نوع النص', 'auto'));
  if (![...$('voice').options].some((option) => option.value === state.voice)) state.voice = 'auto';
  if (![...$('style').options].some((option) => option.value === state.style)) state.style = 'auto';
  $('directorToggle').checked = state.director !== 'off';

  $('voice').value = state.voice;
  $('englishVoice').value = state.englishVoice;
  $('style').value = state.style;
  $('diacritics').value = state.diacritics;
  $('rate').value = state.rate;
  $('pitch').value = state.pitch;
  $('volume').value = state.volume;
  $('gap').value = state.gap;

  $('lexiconChip').textContent = `قاموس: ${config.lexicalStats.gulfWords} كلمة سعودية + ${config.lexicalStats.pronunciations} نطق أجنبي`;

  // لا نترك المستخدم ينتظر توليداً سيفشل حتماً: نتحقق من المحركات أولاً
  const engines = config.engines;
  if (engines && !engines.ok) {
    const blocker = !engines.tts || !engines.ffmpeg || !engines.python;
    if (blocker) {
      $('renderBtn').disabled = true;
      $('renderTop').disabled = true;
      $('renderStatus').className = 'status-note err';
      $('renderStatus').textContent = engines.messages?.[0] ?? 'البيئة غير مكتملة — راجع npm run doctor';
      toast(engines.messages?.[0] ?? 'محرك الصوت غير جاهز', 'error');
    } else if (engines.messages?.length) {
      toast(engines.messages[0], 'warn');
    }
  }
  if (!config.tashkeelAvailable) {
    const smart = $('diacritics').querySelector('option[value="smart"]');
    if (smart) smart.disabled = true;
    state.diacritics = 'light';
    $('diacritics').value = 'light';
    toast('نموذج التشكيل غير مثبّت — يعمل وضع «قاموس اللهجة فقط». لتثبيته: pip install text2tashkeel', 'warn');
  }
  updateMeta();
}

function updateMeta() {
  const autoVoiceId = state.voice === 'auto' ? analysis?.direction?.voice?.id : null
  const voice = config?.voices.find((item) => item.id === (autoVoiceId || $('voice').value));
  $('voiceChipLabel').textContent = state.voice === 'auto'
    ? `AUTO${voice ? ` • ${voice.short}` : ''}`
    : voice?.short ?? 'FINIX-SA-01';
  $('voiceNote').textContent = state.voice === 'auto'
    ? `يختاره مدير الاستوديو حسب نوع النص${voice ? ` — ${voice.label}` : ''}`
    : voice?.note || voice?.bestFor || '';
  const autoStyleId = state.style === 'auto' ? analysis?.direction?.style?.id : null
  const style = config?.styles.find((item) => item.id === (autoStyleId || state.style));
  $('styleNote').textContent = state.style === 'auto'
    ? `تلقائي حسب نوع النص${style ? ` — ${style.label}` : ''}`
    : style?.note ?? '';
  $('rateVal').textContent = `${Math.round(state.rate)}%`;
  $('pitchVal').textContent = `${Math.round(state.pitch)}Hz`;
  $('volumeVal').textContent = `${Math.round(state.volume)}%`;
  $('durationLabel').textContent = formatSeconds(analysis?.totalEstimated ?? estimateLocal());
  $('segmentsChip').textContent = `${state.segments.length} مقاطع`;
  $('dictCount').textContent = `${state.dictionary.length} كلمة`;
}

function estimateLocal() {
  return state.segments.reduce((sum, segment) => {
    const words = segment.text.trim().split(/\s+/).filter(Boolean).length;
    return sum + Math.max(0.6, words / 2.6);
  }, 0);
}

/* ------------------------------ المقاطع ------------------------------ */

function renderSegments() {
  const container = $('segments');
  container.replaceChildren();
  state.segments.forEach((segment, index) => {
    container.append(buildSegmentCard(segment, index));
  });
  renderTimeline();
  updateMeta();
}

function buildSegmentCard(segment, index) {
  const card = create('div', 'segment');
  card.dataset.id = segment.id;

  const head = create('div', 'segment-head');
  const badge = create('span', 'segment-badge');
  badge.append(create('span', 'dot', String(index + 1)), create('span', '', `المقطع ${index + 1}`));
  const meta = create('span', 'chip');
  meta.dataset.role = 'segment-meta';
  meta.textContent = '—';
  head.append(badge, meta);

  const textarea = create('textarea');
  textarea.value = segment.text;
  textarea.rows = 2;
  textarea.setAttribute('aria-label', `نص المقطع ${index + 1}`);
  textarea.addEventListener('input', () => {
    segment.text = textarea.value;
    state.script = scriptFromSegments();
    $('scriptInput').value = state.script;
    save();
    scheduleAnalyze();
    renderTimeline();
  });

  const grid = create('div', 'segment-grid');

  const intentField = field('النبرة');
  const intentSelect = document.createElement('select');
  intentSelect.append(new Option('تلقائي (من المعنى)', 'auto'));
  for (const intent of config?.intents ?? []) intentSelect.append(new Option(intent.label, intent.id));
  intentSelect.value = segment.intent;
  intentSelect.addEventListener('change', () => {
    segment.intent = intentSelect.value;
    save();
    scheduleAnalyze();
  });
  intentField.append(intentSelect);

  const styleField = field('نمط خاص');
  const styleSelect = document.createElement('select');
  styleSelect.append(new Option('حسب العام', ''));
  for (const style of config?.styles ?? []) styleSelect.append(new Option(style.label, style.id));
  styleSelect.value = segment.style || '';
  styleSelect.addEventListener('change', () => {
    segment.style = styleSelect.value;
    save();
    scheduleAnalyze();
  });
  styleField.append(styleSelect);

  const intensityField = field('شدة الأداء');
  const intensity = document.createElement('input');
  intensity.type = 'number';
  intensity.min = '1';
  intensity.max = '5';
  intensity.step = '1';
  intensity.placeholder = 'تلقائي';
  intensity.value = segment.intensity ?? '';
  intensity.addEventListener('change', () => {
    const raw = intensity.value.trim();
    segment.intensity = raw === '' ? null : Math.min(5, Math.max(1, Number(raw) || 3));
    intensity.value = segment.intensity ?? '';
    save();
    scheduleAnalyze();
  });
  intensityField.append(intensity);

  const targetField = field('مدة مستهدفة (ث)');
  const target = document.createElement('input');
  target.type = 'number';
  target.min = '0';
  target.step = '0.1';
  target.placeholder = 'تلقائي';
  target.value = segment.target ?? '';
  target.addEventListener('change', () => {
    segment.target = target.value === '' ? null : Math.max(0, Number(target.value) || 0);
    save();
    scheduleAnalyze();
  });
  targetField.append(target);

  grid.append(intentField, styleField, intensityField, targetField);

  const actions = create('div', 'segment-actions');
  const previewBtn = create('button', 'btn btn-secondary btn-sm', 'معاينة');
  previewBtn.type = 'button';
  previewBtn.addEventListener('click', () => previewSegment(segment.id, card));
  const planBtn = create('button', 'btn btn-secondary btn-sm', 'خطة الإلقاء');
  planBtn.type = 'button';
  const plan = create('div', 'plan');
  planBtn.addEventListener('click', () => plan.classList.toggle('open'));
  const deleteBtn = create('button', 'btn btn-danger-soft btn-sm', 'حذف');
  deleteBtn.type = 'button';
  deleteBtn.addEventListener('click', () => {
    if (state.segments.length <= 1) {
      state.segments = [];
      state.script = '';
      $('scriptInput').value = '';
      syncWorkspace();
      renderSegments();
      analysis = null;
      renderReview(null);
      return;
    }
    state.segments = state.segments.filter((item) => item.id !== segment.id);
    state.script = scriptFromSegments();
    $('scriptInput').value = state.script;
    save();
    renderSegments();
    scheduleAnalyze();
  });
  actions.append(previewBtn, planBtn, deleteBtn);

  const spoken = create('div', 'spoken-box');
  spoken.hidden = true;
  spoken.dataset.role = 'spoken';

  card.append(head, textarea, grid, actions);
  const planHolder = create('div');
  planHolder.dataset.role = 'plan';
  planHolder.append(plan);
  card.append(planHolder, spoken);
  return card;
}

function field(label) {
  const wrapper = create('label', 'field');
  wrapper.append(create('span', '', label));
  return wrapper;
}

function renderTimeline() {
  const timeline = $('timeline');
  timeline.replaceChildren();
  const total = analysis?.segments?.length
    ? analysis.segments.reduce((sum, segment) => sum + (segment.estimated || 1), 0)
    : state.segments.length;
  state.segments.forEach((segment, index) => {
    const info = analysis?.segments?.[index];
    const weight = info?.estimated || 1.5;
    const clip = create('div', 'timeline-clip', String(index + 1));
    clip.style.flex = `${Math.max(0.6, weight)} 1 0`;
    clip.dataset.intent = info?.analysis?.intent ?? 'story';
    clip.title = `${segment.text.slice(0, 60)} — ${formatSeconds(weight)}`;
    timeline.append(clip);
  });
  const totalSeconds = analysis?.totalEstimated ?? estimateLocal();
  $('timelineTotal').textContent = `الإجمالي المقدر: ${totalSeconds.toFixed(1)} ث • ${state.segments.length} مقاطع`;
  $('durationLabel').textContent = formatSeconds(totalSeconds);
  void total;
}

/* ------------------------------ التحليل ------------------------------ */

function scheduleAnalyze() {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(() => runAnalyze(), 900);
}

async function runAnalyze(force = false) {
  if (!state.segments.length) {
    analysis = null;
    renderReview(null);
    renderDirector(null);
    renderTimeline();
    updateMeta();
    return;
  }
  const token = ++analyzeToken;
  $('analyzeStatus').textContent = 'جارٍ التحليل والتشكيل…';
  $('analyzeStatus').className = 'status-note';
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voice: state.voice,
        englishVoice: state.englishVoice,
        settings: settingsPayload(),
        segments: state.segments,
        dictionary: state.dictionary,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'فشل التحليل');
    if (token !== analyzeToken) return;
    analysis = data;
    applyAnalysisToSegments();
    renderReview(buildReview());
    renderDirector(data.direction);
    renderTimeline();
    updateMeta();
    $('analyzeStatus').textContent = `آخر تحليل: ${new Date().toLocaleTimeString('ar-SA')} • ${data.parts} وحدة نطق • ${data.totalEstimated} ث`;
    $('analyzeStatus').className = 'status-note ok';
    if (force) toast('تم التحليل والمراجعة.');
  } catch (error) {
    if (token !== analyzeToken) return;
    $('analyzeStatus').textContent = `تعذّر التحليل: ${error.message}`;
    $('analyzeStatus').className = 'status-note err';
  }
}

function applyAnalysisToSegments() {
  if (!analysis?.segments) return;
  analysis.segments.forEach((info, index) => {
    const segment = state.segments[index];
    const card = document.querySelector(`.segment[data-id="${segment?.id}"]`);
    if (!segment || !card) return;
    const meta = card.querySelector('[data-role="segment-meta"]');
    if (meta) {
      meta.textContent = `${info.estimated} ث • ${info.analysis.label} • ${info.coverage}% مشكّل`;
    }
    const planHolder = card.querySelector('[data-role="plan"]');
    const plan = planHolder?.querySelector('.plan');
    if (plan) {
      plan.replaceChildren();
      for (const part of info.parts) {
        const row = create('div', 'plan-row');
        row.append(
          create('span', 'plan-text', part.text),
          create('span', 'plan-meta', `${part.note} • سرعة ${part.rate > 0 ? '+' : ''}${part.rate}% • وقفة ${Math.round(part.pauseBefore)}ms`),
        );
        plan.append(row);
      }
      if (!info.parts.length) plan.append(create('p', 'empty', 'لا توجد وحدات نطق.'));
    }
    const spoken = card.querySelector('[data-role="spoken"]');
    if (spoken && info.spoken) {
      spoken.hidden = false;
      spoken.replaceChildren();
      spoken.append(create('b', '', 'النطق الفعلي: '), document.createTextNode(info.spoken));
    }
  });
  $('segmentsChip').textContent = `${analysis.segments.length} مقاطع • ${analysis.parts} وحدة`;
}

function buildReview() {
  if (!analysis?.segments?.length) return null;
  const reviews = analysis.segments.map((segment) => segment.review).filter(Boolean);
  if (!reviews.length) return null;
  const score = Math.round(reviews.reduce((sum, review) => sum + review.score, 0) / reviews.length);
  const issues = [];
  analysis.segments.forEach((segment, index) => {
    for (const issue of segment.review?.issues ?? []) {
      issues.push({ ...issue, segmentIndex: index });
    }
  });
  const stats = {
    words: analysis.segments.reduce((sum, segment) => sum + (segment.review?.stats.words ?? 0), 0),
    dialectRatio: Math.round(
      analysis.segments.reduce((sum, segment) => sum + (segment.review?.stats.dialectRatio ?? 0), 0) / analysis.segments.length,
    ),
    coverage: Math.round(analysis.segments.reduce((sum, segment) => sum + (segment.coverage ?? 0), 0) / analysis.segments.length),
  };
  const grade = score >= 90 ? 'ممتاز' : score >= 75 ? 'جيد' : score >= 55 ? 'يحتاج مراجعة' : 'ضعيف';
  return { score, grade, issues, stats, language: reviews.find((review) => review.language)?.language ?? 'ar' };
}

function renderReview(review) {
  const ring = $('scoreRing');
  const badge = $('reviewBadge');
  const list = $('issuesList');
  const statsBox = $('scoreStats');
  list.replaceChildren();
  statsBox.replaceChildren();

  if (!review) {
    ring.style.setProperty('--value', 0);
    $('scoreValue').textContent = '—';
    $('scoreGrade').textContent = 'لم تُجرَ المراجعة';
    badge.textContent = 'بانتظار النص';
    badge.className = 'chip';
    list.append(create('p', 'empty', 'اكتب نصاً ليبدأ الفحص: اللهجة، الإملاء، الأرقام، الأسماء الأجنبية، وطول الجمل.'));
    return;
  }

  ring.style.setProperty('--value', review.score);
  ring.style.setProperty('--ring-color', review.score >= 85 ? 'var(--green)' : review.score >= 65 ? 'var(--amber)' : 'var(--red)');
  $('scoreValue').textContent = String(review.score);
  $('scoreGrade').textContent = review.grade;
  $('scoreChip').firstElementChild.nextElementSibling.textContent = `${review.score} / 100`;
  badge.textContent = `${review.issues.length} ملاحظة`;
  badge.className = `chip ${review.issues.length ? 'chip-warn' : 'chip-green'}`;

  statsBox.append(
    chip(`${review.stats.dialectRatio}% لهجة`),
    chip(`${review.stats.words} كلمة`),
    chip(`${review.stats.coverage}% مشكّل`),
    chip(review.language === 'en' ? 'إنجليزي' : review.language === 'mixed' ? 'مختلط' : 'عربي'),
  );

  if (!review.issues.length) {
    list.append(create('p', 'empty', 'ما لقيت مشاكل مؤثرة على النطق. تقدر تولّد مباشرة.'));
    return;
  }

  for (const issue of review.issues) {
    const node = create('div', `issue ${issue.severity}`);
    node.append(create('span', 'issue-dot'));
    const body = create('div', 'issue-body');
    body.append(
      create('div', 'issue-title', `${ARIABLE[issue.type] ?? 'ملاحظة'}${issue.segmentIndex !== undefined ? ` • المقطع ${issue.segmentIndex + 1}` : ''}`),
      create('div', 'issue-sample', `${issue.message}${issue.sample ? ` — «${issue.sample}»` : ''}`),
    );
    if (issue.suggestion) body.append(create('div', 'issue-suggest', `المقترح: ${issue.suggestion}`));
    node.append(body);
    if (['spelling', 'dialect'].includes(issue.type) && issue.sample && issue.suggestion) {
      const apply = create('button', 'btn btn-secondary btn-sm apply-suggestion', 'طبّق');
      apply.type = 'button';
      apply.addEventListener('click', () => applySuggestion(issue));
      node.append(apply);
    }
    list.append(node);
  }
}

/* --------------------------- مدير الاستوديو --------------------------- */

const PRON_TYPE_LABELS = {
  spelling: 'إملاء',
  foreign: 'كلمة أجنبية',
  ambiguous: 'كلمة ملتبسة',
  number: 'أرقام',
  symbol: 'رموز',
};

function renderDirector(direction) {
  const chip = $('directorChip');
  const brief = $('directorBrief');
  const facts = $('directorFacts');
  const notes = $('directorNotes');
  facts.replaceChildren();
  notes.replaceChildren();

  if (!direction) {
    chip.textContent = state.director === 'off' ? 'موقوف' : 'بانتظار النص';
    chip.className = 'chip';
    brief.replaceChildren(create(
      'p',
      'empty',
      state.director === 'off'
        ? 'مدير الاستوديو موقوف — التوليد يستخدم اختياراتك اليدوية فقط.'
        : 'اكتب نصاً ليقترح المدير الصوت والنمط وخطة النطق والأداء.',
    ));
    return;
  }

  chip.textContent = `${direction.genreLabel} • ثقة ${direction.confidence}٪`;
  chip.className = 'chip chip-blue';
  brief.replaceChildren(
    create('p', 'director-summary', direction.summary),
    create('p', 'director-direction', direction.notes?.[0] ?? ''),
  );

  facts.append(
    directorFact('نوع المحتوى', direction.genreLabel, direction.tone),
    directorFact('الصوت المقترح', direction.voice?.label ?? '—', direction.voice?.why ?? ''),
    directorFact('النمط والشدة', `${direction.style?.label ?? '—'} • ${direction.intensity}/5`, `الجمهور: ${direction.audience}`),
    directorFact('جاهزية النطق', `${direction.pronunciation?.score ?? '—'}/100 • ${direction.pronunciation?.grade ?? ''}`, direction.pronunciation?.verdict ?? ''),
  );

  const auto = direction.pronunciation?.auto ?? [];
  if (auto.length) {
    notes.append(create(
      'div',
      'director-note',
      `سيُنطق من القاموس: ${auto.slice(0, 6).map((item) => `${item.orig} → ${item.spoken}`).join(' • ')}`,
    ));
  }
  for (const item of (direction.pronunciation?.items ?? []).slice(0, 5)) {
    const node = create('div', `issue ${item.severity}`);
    node.append(create('span', 'issue-dot'));
    const body = create('div', 'issue-body');
    body.append(
      create('div', 'issue-title', `نطق • ${PRON_TYPE_LABELS[item.type] ?? 'ملاحظة'}`),
      create('div', 'issue-sample', `${item.message}${item.sample ? ` — «${item.sample}»` : ''}`),
    );
    if (item.suggestion) body.append(create('div', 'issue-suggest', item.suggestion));
    node.append(body);
    notes.append(node);
  }

  const emphasis = (direction.segments ?? []).flatMap((segment) => segment.emphasis ?? []);
  if (emphasis.length) {
    notes.append(create('div', 'director-note', `كلمات تُبرَز في النبرة: ${[...new Set(emphasis)].slice(0, 8).join(' • ')}`));
  }
}

function directorFact(label, value, note) {
  const box = create('div', 'director-fact');
  box.append(
    create('span', 'director-fact-label', label),
    create('b', 'director-fact-value', value),
  );
  if (note) box.append(create('small', '', note));
  return box;
}

const ARIABLE = {
  spelling: 'خطأ إملائي',
  dialect: 'لهجة',
  latin: 'كلمة أجنبية',
  number: 'رقم',
  symbol: 'رمز',
  'long-sentence': 'جملة طويلة',
  punctuation: 'ترقيم',
  repeat: 'تكرار',
  'dialect-low': 'لهجة ضعيفة',
  mixed: 'لغة مختلطة',
};

function chip(text) {
  return create('span', 'chip', text);
}

function applySuggestion(issue) {
  const segment = state.segments[issue.segmentIndex];
  if (!segment) return;
  const sample = String(issue.sample ?? '');
  const suggestion = String(issue.suggestion ?? '');
  if (!sample || !suggestion) return;
  if (!segment.text.includes(sample)) {
    toast('تغيّر النص بعد التحليل — أعد المراجعة ثم طبّق.', 'warn');
    return;
  }
  segment.text = segment.text.replace(sample, suggestion);
  state.script = scriptFromSegments();
  $('scriptInput').value = state.script;
  save();
  renderSegments();
  runAnalyze();
  toast(`تم استبدال «${sample}» بـ«${suggestion}».`);
}

/* ------------------------------ المعاينة ------------------------------ */

async function previewSegment(id, card) {
  const segment = state.segments.find((item) => item.id === id);
  if (!segment) return;
  const holder = card.querySelector('.spoken-box');
  if (holder) {
    holder.hidden = false;
    holder.textContent = 'جارٍ التوليد…';
  }
  try {
    const response = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: segment.text,
        voice: state.voice,
        englishVoice: state.englishVoice,
        intent: segment.intent,
        intensity: segment.intensity,
        settings: settingsPayload(),
        dictionary: state.dictionary,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'فشل التوليد');
    if (!holder) return;
    holder.replaceChildren();
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = data.url;
    audio.className = 'audio-inline';
    holder.append(audio, create('div', '', `النطق: ${data.spoken}`), create('div', '', `المدة: ${data.duration} ث • التشكيل: ${data.coverage}%`));
    audio.play().catch(() => {});
  } catch (error) {
    if (holder) holder.textContent = `خطأ: ${error.message}`;
    toast(`فشلت المعاينة: ${error.message}`, 'error');
  }
}

async function previewAll() {
  const holder = $('renderStatus');
  for (const [index, segment] of state.segments.entries()) {
    const card = document.querySelector(`.segment[data-id="${segment.id}"]`);
    if (!card) continue;
    holder.textContent = `معاينة ${index + 1} من ${state.segments.length}…`;
    // eslint-disable-next-line no-await-in-loop
    await previewSegment(segment.id, card);
  }
  holder.textContent = 'تم توليد معاينات لكل المقاطع — شغّلها من بطاقة كل مقطع.';
}

/* ------------------------------ القاموس ------------------------------ */

function renderDictionary() {
  const container = $('dictChips');
  container.replaceChildren();
  if (!state.dictionary.length) {
    container.append(create('p', 'empty', 'لا توجد كلمات مخصصة بعد. أي كلمة تضيفها هنا تُطبَّق تلقائياً قبل التشكيل.'));
  }
  state.dictionary.forEach((entry, index) => {
    const chipNode = create('span', 'dict-chip');
    chipNode.append(create('span', '', `${escape(entry.orig)} → ${escape(entry.phon)}`));
    const remove = create('button', '', '×');
    remove.type = 'button';
    remove.title = 'حذف';
    remove.addEventListener('click', () => {
      state.dictionary.splice(index, 1);
      save();
      renderDictionary();
      updateMeta();
      scheduleAnalyze();
    });
    chipNode.append(remove);
    container.append(chipNode);
  });
}

/* ------------------------------ التوليد ------------------------------ */

let currentJobId = null;
let jobPollTimer = null;

const JOB_STAGE_LABELS = {
  queued: 'في الانتظار',
  prepare: 'تطبيع النص والتشكيل',
  synth: 'توليد وحدات النطق',
  timing: 'ضبط المدة',
  segments: 'تركيب المقاطع',
  final: 'التركيب النهائي',
  done: 'تم التوليد',
  error: 'فشل التوليد',
  cancelled: 'أُلغيت المهمة',
};

function setBusy(busy) {
  rendering = busy;
  $('renderBtn').disabled = busy;
  $('renderTop').disabled = busy;
  const cancel = $('cancelRender');
  if (cancel) cancel.hidden = !busy;
}

function stopPolling() {
  if (jobPollTimer) clearInterval(jobPollTimer);
  jobPollTimer = null;
}

/** يعرض تقدّماً حقيقياً قادماً من الطابور (لا أرقام عشوائية). */
function paintProgress(job) {
  const bar = $('progressBar');
  const fill = $('progressFill');
  const status = $('renderStatus');
  const meta = $('progressMeta');
  bar.classList.add('show');

  const percent = Math.round(job.progress?.percent ?? 0);
  fill.style.width = `${percent}%`;

  if (job.state === 'queued') {
    status.className = 'status-note';
    status.textContent = `في الانتظار… (${job.queuePosition ? `الموضع ${job.queuePosition}` : 'قريباً'})`;
  } else if (job.state === 'running') {
    status.className = 'status-note';
    status.textContent = job.progress?.label || 'جارٍ التوليد…';
    if (job.cancelRequested) status.textContent = 'جارٍ الإلغاء…';
  } else if (job.state === 'done') {
    status.className = 'status-note ok';
    const result = job.result || {};
    status.textContent = `تم! المدة النهائية ${result.durationSec} ث • ${result.stats?.utterances ?? 0} وحدة نطق • ${result.stats?.words ?? 0} كلمة`;
  } else if (job.state === 'cancelled') {
    status.className = 'status-note';
    status.textContent = 'أُلغيت المهمة — لم يُنتج أي ملف.';
  }

  if (meta) {
    const parts = [`${percent}%`];
    if (job.progress?.totalUnits) parts.push(`${job.progress.doneUnits || 0}/${job.progress.totalUnits} وحدة`);
    if (job.state === 'running') parts.push(JOB_STAGE_LABELS[job.progress?.stage] || '');
    meta.textContent = parts.filter(Boolean).join(' • ');
  }
}

async function cancelRender() {
  if (!currentJobId) return;
  try {
    await fetch(`/api/jobs/${currentJobId}/cancel`, { method: 'POST' });
    toast('تم إرسال طلب الإلغاء — يتوقف عند أول نقطة آمنة.', 'warn');
  } catch (error) {
    toast(`تعذّر الإلغاء: ${error.message}`, 'error');
  }
}

async function renderVoiceover() {
  if (rendering) return;
  if (!state.segments.length) {
    toast('اكتب سكريبت أولاً.', 'warn');
    return;
  }

  setBusy(true);
  stopPolling();
  const status = $('renderStatus');
  const fill = $('progressFill');
  fill.style.width = '0%';
  status.className = 'status-note';
  status.textContent = 'إرسال المهمة إلى الطابور…';

  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voice: state.voice,
        englishVoice: state.englishVoice,
        settings: settingsPayload(),
        segments: state.segments,
        dictionary: state.dictionary,
      }),
    });
    const created = await response.json();
    if (!response.ok) throw new Error(created.error || 'فشل إنشاء المهمة');

    currentJobId = created.id;
    paintProgress(created);

    // متابعة الحالة كل ٦٠٠ مللي — تعمل خلف أي وسيط ولا تحتاج SSE
    await new Promise((resolve) => {
      const tick = async () => {
        try {
          const res = await fetch(`/api/jobs/${currentJobId}`);
          if (!res.ok) return;
          const job = await res.json();
          paintProgress(job);

          if (job.state === 'done') {
            stopPolling();
            showOutput(job.result);
            analysis = null;
            updateMeta();
            refreshJobs();
            resolve();
          } else if (job.state === 'error') {
            stopPolling();
            fill.style.width = '0%';
            status.className = 'status-note err';
            status.textContent = `تعذّر التوليد: ${job.error}`;
            toast(`تعذّر التوليد: ${job.error}`, 'error');
            refreshJobs();
            resolve();
          } else if (job.state === 'cancelled') {
            stopPolling();
            fill.style.width = '0%';
            status.className = 'status-note';
            status.textContent = 'أُلغيت المهمة.';
            refreshJobs();
            resolve();
          }
        } catch {
          /* نتجاهل انقطاعاً عابراً ونكمل المحاولة */
        }
      };
      tick();
      jobPollTimer = setInterval(tick, 600);
    });
  } catch (error) {
    status.className = 'status-note err';
    status.textContent = `تعذّر التوليد: ${error.message}`;
    toast(`تعذّر التوليد: ${error.message}`, 'error');
  } finally {
    stopPolling();
    currentJobId = null;
    setBusy(false);
    setTimeout(() => $('progressBar').classList.remove('show'), 1800);
    refreshJobs();
  }
}

/** سجل المهام الأخيرة مع روابط مباشرة للملفات. */
async function refreshJobs() {
  const container = $('jobsList');
  if (!container) return;
  try {
    const response = await fetch('/api/jobs');
    const data = await response.json();
    container.replaceChildren();
    if (data.queue && $('queueChip')) {
      $('queueChip').textContent = `الطابور: ${data.queue.queued || 0} منتظر • ${data.queue.running || 0} قيد التشغيل`;
    }
    const jobs = (data.jobs || []).slice(0, 8);
    if (!jobs.length) {
      container.append(create('p', 'empty', 'لا توجد مهام بعد — أول توليد سيظهر هنا.'));
      return;
    }
    for (const job of jobs) {
      const row = create('div', 'job-row');
      const when = new Date(job.createdAt).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
      const stateLabel = {
        queued: 'في الانتظار',
        running: 'جارٍ',
        done: 'مكتملة',
        error: 'فاشلة',
        cancelled: 'ملغاة',
      }[job.state] || job.state;
      row.append(
        create('span', 'time', when),
        create('span', '', job.label || job.type),
        create('span', `chip ${job.state === 'done' ? 'chip-green' : job.state === 'error' ? 'chip-warn' : ''}`, stateLabel),
      );
      if (job.state === 'done' && job.result) {
        row.append(create('span', '', `${job.result.durationSec} ث`));
        const mp3 = document.createElement('a');
        mp3.href = job.result.url;
        mp3.download = `${job.id}.mp3`;
        mp3.textContent = 'MP3';
        const srt = document.createElement('a');
        srt.href = job.result.srtUrl;
        srt.download = `${job.id}.srt`;
        srt.textContent = 'SRT';
        row.append(mp3, srt);
      }
      if (job.state === 'error' && job.error) {
        row.append(create('span', 'job-error', job.error.slice(0, 90)));
      }
      container.append(row);
    }
  } catch {
    /* السجل ميزة إضافية */
  }
}

function showOutput(data) {
  const box = $('outputBox');
  box.hidden = false;
  const audio = $('finalAudio');
  audio.src = data.url;
  $('downloadMp3').href = data.url;
  $('downloadMp3').setAttribute('download', `${data.jobId}.mp3`);
  $('downloadSrt').href = data.srtUrl;
  $('downloadSrt').setAttribute('download', `${data.jobId}.srt`);
  audio.play().catch(() => {});

  const container = $('outputSegments');
  container.replaceChildren();
  for (const segment of data.segments) {
    const row = create('div', 'output-row');
    row.append(
      create('span', 'time', `${segment.startSec.toFixed(2)}→${segment.endSec.toFixed(2)}`),
      create('span', '', `${segment.index + 1}. ${segment.text.slice(0, 70)}`),
      create('span', 'chip', segment.intentLabel),
    );
    if (segment.targetMissed) row.append(create('span', 'chip chip-warn', 'خارج المدة'));
    else if (segment.target) row.append(create('span', 'chip chip-green', `دقة ${segment.timingErrorPercent ?? 0}%`));
    if (segment.pausesScaled !== undefined && segment.pausesScaled < 100) {
      row.append(create('span', 'chip', `وقفات ${segment.pausesScaled}%`));
    }
    if (segment.paddedMs || segment.trimmedMs) {
      row.append(create('span', 'chip', segment.paddedMs ? `تمدّد ${segment.paddedMs}ms` : `قُصّ ${segment.trimmedMs}ms`));
    }
    const link = document.createElement('a');
    link.href = segment.url;
    link.download = segment.fileName;
    link.textContent = 'MP3';
    row.append(link);
    container.append(row);
  }
}

/* ------------------------------ إجراءات ------------------------------ */

async function dialectize() {
  if (!state.script.trim()) {
    toast('اكتب سكريبت أولاً.', 'warn');
    return;
  }
  try {
    const response = await fetch('/api/dialectize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: state.script }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'فشل التحويل');
    if (!data.changes.length) {
      toast('ما لقيت كلمات فصحى قابلة للتحويل — النص سعودي أصلاً.');
      return;
    }
    state.script = data.text;
    $('scriptInput').value = state.script;
    syncSegmentsFromScript();
    save();
    renderSegments();
    runAnalyze();
    toast(`تم تحويل ${data.changes.length} كلمة إلى اللهجة السعودية. راجع النتيجة قبل التوليد.`);
  } catch (error) {
    toast(`فشل التحويل: ${error.message}`, 'error');
  }
}

function syncWorkspace() {
  const hasContent = state.script.trim().length > 0 || state.segments.length > 0;
  $('studioWorkspace').classList.toggle('is-revealed', hasContent);
  $('renderTop').disabled = !state.script.trim();
  $('renderBtn').disabled = !state.script.trim() || rendering;
}

function clearScript() {
  state.script = '';
  state.segments = [];
  $('scriptInput').value = '';
  analysis = null;
  save();
  renderSegments();
  renderReview(null);
  renderTimeline();
  updateMeta();
  syncWorkspace();
}

function usePreset(name) {
  state.script = PRESETS[name] ?? SAMPLE_SCRIPT;
  $('scriptInput').value = state.script;
  syncSegmentsFromScript();
  save();
  renderSegments();
  syncWorkspace();
  runAnalyze();
}

function exportProject() {
  const blob = new Blob([JSON.stringify({ ...state, version: 3 }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `finix-voice-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  toast('تم حفظ ملف المشروع.');
}

async function importProject(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    Object.assign(state, parsed);
    if (!Array.isArray(state.segments)) state.segments = [];
    if (!Array.isArray(state.dictionary)) state.dictionary = [];
    $('scriptInput').value = state.script ?? '';
    $('voice').value = state.voice;
    $('englishVoice').value = state.englishVoice;
    $('style').value = state.style;
    $('directorToggle').checked = state.director !== 'off';
    $('diacritics').value = state.diacritics;
    $('rate').value = state.rate;
    $('pitch').value = state.pitch;
    $('volume').value = state.volume;
    $('gap').value = state.gap;
    save();
    renderSegments();
    renderDictionary();
    syncWorkspace();
    updateMeta();
    runAnalyze();
    toast('تم استيراد المشروع.');
  } catch (error) {
    toast(`ملف غير صالح: ${error.message}`, 'error');
  }
}

/* ------------------------------ التهيئة ------------------------------ */

function bindEvents() {
  const script = $('scriptInput');
  script.addEventListener('input', () => {
    state.script = script.value;
    syncSegmentsFromScript();
    save();
    renderSegments();
    syncWorkspace();
    scheduleAnalyze();
  });

  $('voice').addEventListener('change', () => {
    state.voice = $('voice').value;
    save();
    updateMeta();
  });
  $('englishVoice').addEventListener('change', () => {
    state.englishVoice = $('englishVoice').value;
    save();
  });
  $('style').addEventListener('change', () => {
    state.style = $('style').value;
    save();
    updateMeta();
    scheduleAnalyze();
  });
  $('directorToggle').addEventListener('change', () => {
    state.director = $('directorToggle').checked ? 'on' : 'off';
    save();
    updateMeta();
    runAnalyze(true);
    toast(state.director === 'on' ? 'مدير الاستوديو يعمل: يقرأ النص ويوجّه الأداء.' : 'أُوقف مدير الاستوديو — اختياراتك اليدوية فقط.');
  });
  $('diacritics').addEventListener('change', () => {
    state.diacritics = $('diacritics').value;
    save();
    scheduleAnalyze();
  });
  for (const key of ['rate', 'pitch', 'volume']) {
    $(key).addEventListener('input', () => {
      state[key] = Number($(key).value) || 0;
      updateMeta();
      save();
      scheduleAnalyze();
    });
  }
  $('gap').addEventListener('change', () => {
    state.gap = Math.max(0, Number($('gap').value) || 0);
    save();
    scheduleAnalyze();
  });
  $('timingMode').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    state.timingMode = button.dataset.mode;
    for (const item of $('timingMode').querySelectorAll('button')) {
      item.classList.toggle('active', item === button);
    }
    save();
  });

  $('addSegment').addEventListener('click', () => {
    state.segments.push({ id: uid(), text: '', intent: 'auto', intensity: null, target: null, start: null, style: '', voice: '' });
    state.script = scriptFromSegments();
    $('scriptInput').value = state.script;
    save();
    renderSegments();
    syncWorkspace();
  });
  $('relayout').addEventListener('click', () => {
    state.segments.forEach((segment) => {
      segment.start = null;
      segment.target = null;
    });
    save();
    renderSegments();
    toast('أُعيد توزيع المقاطع بالتتابع الطبيعي.');
  });
  $('sampleScript').addEventListener('click', () => usePreset('sample'));
  for (const button of document.querySelectorAll('[data-preset]')) {
    button.addEventListener('click', () => usePreset(button.dataset.preset));
  }
  $('clearScript').addEventListener('click', clearScript);
  $('dialectizeBtn').addEventListener('click', dialectize);
  $('analyzeBtn').addEventListener('click', () => runAnalyze(true));
  $('renderBtn').addEventListener('click', renderVoiceover);
  $('renderTop').addEventListener('click', renderVoiceover);
  $('previewAll').addEventListener('click', previewAll);
  $('cancelRender').addEventListener('click', cancelRender);
  $('refreshJobs').addEventListener('click', refreshJobs);
  $('exportProject').addEventListener('click', exportProject);
  $('importProject').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) importProject(file);
  });

  $('addDict').addEventListener('click', () => {
    const orig = $('dictOrig').value.trim();
    const phon = $('dictPhon').value.trim();
    if (!orig || !phon) {
      toast('اكتب الكلمة وطريقة نطقها.', 'warn');
      return;
    }
    state.dictionary = state.dictionary.filter((entry) => entry.orig !== orig);
    state.dictionary.push({ orig, phon });
    $('dictOrig').value = '';
    $('dictPhon').value = '';
    save();
    renderDictionary();
    updateMeta();
    scheduleAnalyze();
    toast(`أُضيفت «${orig}».`);
  });

  const timingButtons = { natural: 'طبيعي (متتالي)', exact: 'مطابق بالثانية' };
  void timingButtons;
}

async function init() {
  load();
  bindEvents();
  try {
    const response = await fetch('/api/config');
    config = await response.json();
  } catch (error) {
    toast(`تعذّر تحميل الإعدادات: ${error.message}`, 'error');
    config = { voices: [], englishVoices: [], intents: [], styles: [], lexicalStats: { gulfWords: 0, pronunciations: 0 } };
  }
  populateConfig();
  for (const button of $('timingMode').querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.mode === state.timingMode);
  }
  $('scriptInput').value = state.script ?? '';
  if (!state.script && !state.segments.length) {
    state.script = SAMPLE_SCRIPT;
    $('scriptInput').value = state.script;
    syncSegmentsFromScript();
  }
  renderSegments();
  renderDictionary();
  renderReview(null);
  renderDirector(null);
  syncWorkspace();
  updateMeta();
  refreshJobs();
  if (state.script.trim()) runAnalyze();
}

init();
