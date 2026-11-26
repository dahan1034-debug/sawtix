# SAWTIX — FINIX Voice Studio
# صورة واحدة تشغّل الاستوديو كاملاً: Node + Python (edge-tts / المشكّل) + ffmpeg.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=7860 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# طبقة الحزم أولاً حتى يستفيد البناء من الكاش
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY requirements.txt ./
RUN python3 -m venv /app/.venv \
  && /app/.venv/bin/pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p out/_cache .tmp \
  && chown -R node:node /app

# مستخدم غير جذري (uid 1000) كما تتوقع منصات الاستضافة
USER node

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7860)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
