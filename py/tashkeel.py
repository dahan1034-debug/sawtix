#!/usr/bin/env python3
"""مشكّل عربي يعمل محلياً على المعالج (ONNX) بلا إنترنت وبلا مفاتيح.

الاستخدام: python3 py/tashkeel.py texts.json
المدخل: ["نص أول", "نص ثاني"]
المخرج: {"results": ["النَّصّ الأَوَّل", ...], "engine": "text2tashkeel"}
"""
import json
import sys


def load_diacritizer():
    try:
        from text2tashkeel import Diacritizer

        return Diacritizer()
    except Exception:  # noqa: BLE001 - نرجع خطأ واضحاً للطبقة العليا
        return None


def main():
    with open(sys.argv[1], encoding="utf-8") as handle:
        texts = json.load(handle)

    diacritizer = load_diacritizer()
    if diacritizer is None:
        sys.stdout.write(json.dumps({"results": texts, "engine": "none"}))
        return

    results = []
    for text in texts:
        try:
            results.append(diacritizer.diacritize(text))
        except Exception:  # noqa: BLE001 - نتجاوز الجملة التي فشل تشكيلها
            results.append(text)
    sys.stdout.write(json.dumps({"results": results, "engine": "text2tashkeel"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
