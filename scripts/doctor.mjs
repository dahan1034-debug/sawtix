#!/usr/bin/env node
// فحص بيئة التشغيل قبل الاستخدام: npm run doctor
// يطبع تشخيصاً عربياً واضحاً بدل أن يكتشف المستخدم المشكلة عند أول توليد.

import ffmpegPath from 'ffmpeg-static'
import { diagnose, PYTHON_BIN } from '../lib/python.mjs'

const engines = await diagnose({ ffmpegPath })
const line = (ok, label, detail) => console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)

console.log('\nفحص بيئة FINIX Voice Studio\n' + '─'.repeat(40))
line(Boolean(engines.python), 'بايثون', engines.python ? `الإصدار ${engines.python} (${PYTHON_BIN})` : `لم أجد «${PYTHON_BIN}»`)
line(engines.tts, 'محرك الصوت (edge-tts)', engines.tts ? 'جاهز' : 'غير مثبّت — pip install -r requirements.txt')
line(engines.tashkeel, 'المشكّل (text2tashkeel)', engines.tashkeel ? 'جاهز' : 'غير مثبّت — سيعمل وضع قاموس اللهجة فقط')
line(engines.ffmpeg, 'ffmpeg', engines.ffmpeg ? 'جاهز (ffmpeg-static)' : 'غير متاح — npm install')
console.log('─'.repeat(40))

if (engines.messages.length) {
  console.log('\nملاحظات:')
  for (const message of engines.messages) console.log(' •', message)
}
console.log(engines.ok ? '\nالبيئة سليمة — npm start\n' : '\nالبيئة ناقصة — راجع الملاحظات أعلاه.\n')
process.exit(engines.ok ? 0 : 1)
