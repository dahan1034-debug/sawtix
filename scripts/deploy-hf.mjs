// نشر SAWTIX على Hugging Face Spaces (Docker) — يتطلب خطة PRO لمساحات Docker.
//
// الاستخدام:
//   HF_TOKEN=... npm run deploy:hf            # ينشئ/يحدّث مساحة خاصة باسم sawtix
//   HF_SPACE=sawtix HF_PRIVATE=0 ...          # مساحة عامة (فعّل APP_PASSWORD)
//   DRY_RUN=1 npm run deploy:hf               # يجهّز الحزمة ويعرض الملفات بلا رفع
//
// لا يُكتب التوكن في أي ملف أو رابط: يمر عبر GIT_ASKPASS من البيئة.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SPACE = process.env.HF_SPACE || 'sawtix'
const PRIVATE = process.env.HF_PRIVATE !== '0'
const DRY_RUN = process.env.DRY_RUN === '1'
const TOKEN = process.env.HF_TOKEN || ''

const EXCLUDED = [
  /^node_modules($|\/)/,
  /^\.venv($|\/)/,
  /^out($|\/)/,
  /^\.tmp($|\/)/,
  /^\.git($|\/)/,
  /^\.gitignore$/,
  /^docs($|\/)/,
  /^test($|\/)/,
  /\.zip$/,
  /\.log$/,
  /^server\.pid$/,
  /^\.env($|\.)/,
]

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', ...options })
}

async function stageProject() {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'sawtix-space-'))
  await fs.cp(ROOT, stage, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(ROOT, source).split(path.sep).join('/')
      if (!relative) return true
      return !EXCLUDED.some((pattern) => pattern.test(relative))
    },
  })
  // مساحة Hugging Face تحتاج README بترويسة sdk/docker — لا نستبدل README المشروع محلياً.
  await fs.copyFile(path.join(ROOT, 'deploy', 'hf', 'README.md'), path.join(stage, 'README.md'))
  const files = []
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else files.push(path.relative(stage, absolute))
    }
  }
  await walk(stage)
  return { stage, files }
}

async function api(pathname, init = {}) {
  const response = await fetch(`https://huggingface.co${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { response, body }
}

async function main() {
  const { stage, files } = await stageProject()
  const bytes = await Promise.all(files.map(async (file) => (await fs.stat(path.join(stage, file))).size))
  const total = bytes.reduce((sum, value) => sum + value, 0)
  console.log(`📦 الحزمة: ${files.length} ملفاً • ${Math.round(total / 1024)} كيلوبايت`)
  if (DRY_RUN) {
    console.log(`📁 المجلد المؤقت: ${stage}`)
    console.log(files.sort().join('\n'))
    return
  }
  if (!TOKEN) {
    throw new Error('HF_TOKEN غير مضبوط. أضفه في Settings → Project settings → Secrets ثم أعد المحاولة.')
  }

  const who = await api('/api/whoami-v2')
  if (!who.response.ok) throw new Error(`تعذّر التحقق من حساب Hugging Face (${who.response.status})`)
  const user = who.body?.name || who.body?.user
  if (!user) throw new Error('لم يرجع الحساب اسم مستخدم صالحاً')

  console.log(`👤 الحساب: ${user}`)
  const created = await api('/api/repos/create', {
    method: 'POST',
    body: JSON.stringify({ type: 'space', name: SPACE, private: PRIVATE, sdk: 'docker' }),
  })
  if (!created.response.ok && created.response.status !== 409) {
    throw new Error(`تعذّر إنشاء المساحة (${created.response.status}): ${JSON.stringify(created.body)}`)
  }
  console.log(created.response.status === 409 ? 'ℹ️ المساحة موجودة — سنحدّثها.' : '✨ أُنشئت المساحة.')

  const askpass = path.join(os.tmpdir(), `sawtix-askpass-${process.pid}.sh`)
  await fs.writeFile(
    askpass,
    '#!/bin/sh\ncase "$1" in\n  *sername*) printf \'%s\\n\' "$HF_GIT_USER" ;;\n  *) printf \'%s\\n\' "$HF_TOKEN" ;;\nesac\n',
    { mode: 0o700 },
  )
  const gitEnv = {
    ...process.env,
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: '0',
    HF_GIT_USER: user,
    HF_TOKEN: TOKEN,
  }
  const repoUrl = `https://${user}@huggingface.co/spaces/${user}/${SPACE}`
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sawtix-repo-'))

  try {
    // نبدأ مستودعاً محلياً دائماً، ثم نجلب التاريخ إن كانت المساحة موجودة.
    run('git', ['init', '-b', 'main'], { cwd: repoDir, env: gitEnv })
    run('git', ['remote', 'add', 'origin', repoUrl], { cwd: repoDir, env: gitEnv })
    try {
      run('git', ['fetch', '--depth', '1', 'origin', 'main'], { cwd: repoDir, env: gitEnv })
      run('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: repoDir, env: gitEnv })
    } catch {
      // مساحة جديدة بلا أي commits.
    }

    // مزامنة كاملة: نحذف محتوى العمل القديم (عدا .git) ثم ننسخ الحزمة.
    for (const entry of await fs.readdir(repoDir)) {
      if (entry === '.git') continue
      await fs.rm(path.join(repoDir, entry), { recursive: true, force: true })
    }
    await fs.cp(stage, repoDir, { recursive: true })

    run('git', ['config', 'user.name', user], { cwd: repoDir, env: gitEnv })
    run('git', ['config', 'user.email', `${user}@users.noreply.huggingface.co`], { cwd: repoDir, env: gitEnv })
    run('git', ['add', '-A'], { cwd: repoDir, env: gitEnv })

    let hasChanges = true
    try {
      run('git', ['diff', '--cached', '--quiet'], { cwd: repoDir, env: gitEnv })
      hasChanges = false
    } catch {
      hasChanges = true
    }
    if (!hasChanges) {
      console.log('✅ لا تغييرات — المساحة محدّثة بالفعل.')
    } else {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
      run('git', ['commit', '-m', `SAWTIX deploy ${stamp}`], { cwd: repoDir, env: gitEnv })
      run('git', ['push', 'origin', 'HEAD:main'], { cwd: repoDir, env: gitEnv })
      console.log('🚀 تم الرفع — Hugging Face يبني الصورة الآن.')
    }

    console.log(`\n🔗 صفحة المساحة: https://huggingface.co/spaces/${user}/${SPACE}`)
    console.log(`🔗 التطبيق مباشرة: https://${user}-${SPACE}.hf.space`)
    if (PRIVATE) console.log('🔒 المساحة خاصة: افتح الرابط بعد تسجيل الدخول بحساب Hugging Face.')
    if (!PRIVATE) console.log('⚠️ المساحة عامة: اضبط APP_PASSWORD في إعدادات المساحة قبل مشاركة الرابط.')
  } finally {
    await fs.unlink(askpass).catch(() => {})
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
    await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(`❌ ${error.message}`)
  process.exit(1)
})
