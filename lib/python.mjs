// طبقة تشغيل بايثون المشتركة:
// - مسار مفسّر بايثون قابل للضبط (PYTHON_BIN) بدل الاعتماد على python3 حرفياً،
//   لأن ويندوز وبعض البيئات لا تعرف هذا الاسم.
// - ترجمة أخطاء بايثون الشائعة إلى رسائل عربية مفهومة بدل Traceback خام.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * المفسّر الافتراضي: بيئة المشروع .venv إن وُجدت (npm run setup ينشئها)،
 * وإلا مفسّر النظام. هذا يجعل التثبيت المعزول يعمل بلا أي إعداد إضافي.
 */
function defaultPython() {
  const venv = process.platform === 'win32'
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python')
  if (fs.existsSync(venv)) return venv
  return process.platform === 'win32' ? 'python' : 'python3'
}

/**
 * مفسّر بايثون المستخدم. يمكن تجاوزه عبر متغير البيئة PYTHON_BIN.
 * على ويندوز: PYTHON_BIN=py أو PYTHON_BIN=python
 */
export const PYTHON_BIN = process.env.PYTHON_BIN || defaultPython()

/**
 * ينفّذ أمر بايثون ويعيد { ok, stdout, stderr, error }.
 * @param {string[]} args
 * @param {{timeout?: number, maxBuffer?: number, env?: object}} options
 */
export function runPython(args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      PYTHON_BIN,
      args,
      {
        timeout: options.timeout ?? 240_000,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(options.env ?? {}) },
      },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
      },
    )
  })
}

/** هل الحزمة مثبّتة؟ */
export async function hasModule(moduleName) {
  const { ok } = await runPython(['-c', `import ${moduleName}`], { timeout: 20_000 })
  return ok
}

/** يقرأ إصدار بايثون أو null. */
export async function pythonVersion() {
  const { ok, stdout, stderr } = await runPython(['-V'], { timeout: 15_000 })
  const text = `${stdout} ${stderr}`.trim()
  return ok ? text.replace(/^Python\s*/i, '') : null
}

/**
 * يترجم فشل عملية بايثون إلى رسالة عربية قابلة للتنفيذ.
 * @param {{stderr?: string, message?: string}} failure
 * @param {'tts'|'tashkeel'|'generic'} kind
 */
export function friendlyPythonError(failure, kind = 'generic') {
  const raw = `${failure?.stderr ?? ''} ${failure?.message ?? ''}`
  const hints = {
    tts: 'محرك الصوت (edge-tts) غير مثبّت. نفّذ: pip install -r requirements.txt',
    tashkeel: 'مشكّل العربية (text2tashkeel) غير مثبّت. نفّذ: pip install -r requirements.txt',
    generic: 'تعذّر تشغيل بايثون. تأكد من تثبيت Python 3.10+ أو اضبط PYTHON_BIN.',
  }

  if (/ENOENT/.test(raw) || /not found/i.test(raw)) {
    return `لم أجد مفسّر بايثون باسم «${PYTHON_BIN}». ثبّت Python 3.10+ أو اضبط المتغير PYTHON_BIN في ملف .env.`
  }
  if (/No module named ['"]?edge_tts/.test(raw)) return hints.tts
  if (/No module named ['"]?text2tashkeel/.test(raw)) return hints.tashkeel
  if (/No module named ['"]?onnxruntime/.test(raw)) {
    return 'حزمة onnxruntime مفقودة (يحتاجها المشكّل). نفّذ: pip install -r requirements.txt'
  }
  if (/No module named ['"]?(\w+)/.test(raw)) {
    const match = /No module named ['"]?([\w.]+)/.exec(raw)
    return `حزمة بايثون «${match?.[1]}» غير مثبّتة. نفّذ: pip install -r requirements.txt`
  }
  if (/Permission denied|EACCES/.test(raw)) return 'صلاحيات بايثون غير كافية لتشغيل السكربت.'
  if (/timed out|ETIMEDOUT|killed/i.test(raw)) return 'تجاوز محرك الصوت المهلة المحددة. جرّب تقصير النص أو إعادة المحاولة.'
  return hints[kind] ?? hints.generic
}

/**
 * يشخّص البيئة كاملة (يُستخدم في /api/health و npm run doctor).
 * @returns {Promise<{ok: boolean, python: string|null, tts: boolean, tashkeel: boolean, ffmpeg: boolean, messages: string[]}>}
 */
export async function diagnose({ ffmpegPath = null } = {}) {
  const [python, tts, tashkeel] = await Promise.all([
    pythonVersion(),
    hasModule('edge_tts'),
    hasModule('text2tashkeel'),
  ])
  const ffmpeg = Boolean(ffmpegPath)
  const messages = []
  if (!python) messages.push(`مفسّر بايثون «${PYTHON_BIN}» غير متاح — اضبط PYTHON_BIN أو ثبّت Python 3.10+.`)
  if (python && !tts) messages.push('محرك الصوت edge-tts غير مثبّت — pip install -r requirements.txt (بدونه لا يمكن توليد أي صوت).')
  if (python && !tashkeel) messages.push('المشكّل text2tashkeel غير مثبّت — سيعمل وضع «قاموس اللهجة فقط» بلا تشكيل آلي.')
  if (!ffmpeg) messages.push('ffmpeg غير متاح — أعد تثبيت حزم npm (npm install).')
  return { ok: Boolean(python) && tts && ffmpeg, python, tts, tashkeel, ffmpeg, messages }
}
