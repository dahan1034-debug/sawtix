#!/usr/bin/env node
// تثبيت متطلبات بايثون بطريقة تعمل على كل الأنظمة:
// - ينشئ .venv داخل المشروع (خادم بايثون يكتشفها تلقائياً) ويتجنب قيد
//   «externally-managed-environment» في توزيعات لينكس الحديثة و macOS.
// - إن تعذّر إنشاء البيئة المعزولة، يرجع إلى تثبيت المستخدم --user.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const REQUIREMENTS = path.join(ROOT, 'requirements.txt')
const isWindows = process.platform === 'win32'
const venvPython = path.join(ROOT, '.venv', isWindows ? 'Scripts/python.exe' : 'bin/python')
const systemPython = process.env.PYTHON_BIN || (isWindows ? 'python' : 'python3')

const run = (command, args) => execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' })

function ensureVenv() {
  if (fs.existsSync(venvPython)) return true
  try {
    console.log('• إنشاء بيئة بايثون معزولة في .venv …')
    run(systemPython, ['-m', 'venv', path.join(ROOT, '.venv')])
    return fs.existsSync(venvPython)
  } catch {
    return false
  }
}

console.log('\nإعداد FINIX Voice Studio — متطلبات بايثون\n' + '─'.repeat(44))

let installed = false
if (ensureVenv()) {
  run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet'])
  run(venvPython, ['-m', 'pip', 'install', '-r', REQUIREMENTS])
  installed = true
  console.log(`\n✅ تم التثبيت في .venv — الخادم سيستخدمه تلقائياً (${path.relative(ROOT, venvPython)}).`)
} else {
  console.log('• تعذّر إنشاء .venv — أحاول تثبيت المستخدم (pip install --user) …')
  try {
    run(systemPython, ['-m', 'pip', 'install', '--user', '-r', REQUIREMENTS])
    installed = true
    console.log('\n✅ تم التثبيت لمستخدم النظام.')
  } catch {
    console.error('\n❌ فشل تثبيت متطلبات بايثون. تأكد من Python 3.10+ ثم أعد المحاولة:')
    console.error(`   ${systemPython} -m pip install -r requirements.txt`)
  }
}

if (installed) {
  console.log('التالي: npm run doctor ثم npm start\n')
}
process.exit(installed ? 0 : 1)
