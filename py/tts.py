#!/usr/bin/env python3
"""مولّد الصوت: يستقبل ملف JSON فيه قائمة مهام ويولّد MP3 لكل مهمة.

الاستخدام: python3 py/tts.py jobs.json [concurrency]
كل مهمة: {id, text, voice, rate (%), pitch (Hz), volume (%), out (path)}
يطبع JSON على stdout: {"results": [{id, ok, bytes|error}]}
"""
import asyncio
import json
import os
import sys

import edge_tts


def pct(value):
    return f"{int(round(float(value or 0))):+d}%"


def hz(value):
    return f"{int(round(float(value or 0))):+d}Hz"


async def synthesize(job, sem, results, lock):
    async with sem:
        last_error = None
        for attempt in range(1, 4):
            try:
                out = job["out"]
                os.makedirs(os.path.dirname(out), exist_ok=True)
                communicate = edge_tts.Communicate(
                    job["text"],
                    job.get("voice") or "ar-SA-HamedNeural",
                    rate=pct(job.get("rate")),
                    pitch=hz(job.get("pitch")),
                    volume=pct(job.get("volume")),
                )
                buffer = bytearray()
                async for chunk in communicate.stream():
                    if chunk["type"] == "audio":
                        buffer.extend(chunk["data"])
                if len(buffer) < 700:
                    raise RuntimeError(f"ملف صوتي أصغر من المتوقع ({len(buffer)} بايت)")
                with open(out, "wb") as handle:
                    handle.write(buffer)
                async with lock:
                    results.append({"id": job["id"], "ok": True, "bytes": len(buffer), "attempts": attempt})
                return
            except Exception as error:  # noqa: BLE001 - نبلّغ الخطأ للواجهة
                last_error = error
                await asyncio.sleep(0.7 * attempt)
        async with lock:
            results.append({"id": job["id"], "ok": False, "error": str(last_error)})


async def main():
    with open(sys.argv[1], encoding="utf-8") as handle:
        jobs = json.load(handle)
    concurrency = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    sem = asyncio.Semaphore(max(1, concurrency))
    lock = asyncio.Lock()
    results = []
    await asyncio.gather(*(synthesize(job, sem, results, lock) for job in jobs))
    sys.stdout.write(json.dumps({"results": results}, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
