// تحميل ملف .env المحلي.
// كان الدليل يطلب إنشاء .env (مثل PYTHON_BIN) بينما لا يقرأه الخادم إطلاقاً،
// فتبقى المتغيرات بلا أثر. نقرأه هنا بلا أي حزمة خارجية، ونحمي القيم
// المضبوطة في البيئة فعلياً (env الحقيقي له الأولوية على الملف).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * يقرأ ملف .env ويضبط المتغيرات غير المعرّفة مسبقاً.
 * @param {string} [file]
 * @returns {Record<string, string>} المتغيرات التي قرأها الملف
 */
export function loadEnv(file = path.join(ROOT, '.env')) {
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return {}
  }

  const loaded = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator < 1) continue
    const key = trimmed.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = trimmed.slice(separator + 1).trim()
    if (value.length >= 2) {
      const quoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      if (quoted) value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
    loaded[key] = process.env[key]
  }
  return loaded
}

// أثر جانبي عند الاستيراد: يجب أن يسبق أي وحدة تقرأ process.env (مثل PYTHON_BIN).
export const envLoaded = loadEnv()
