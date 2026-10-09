#!/usr/bin/env python3
"""Merge bilingual UI strings into messages/fr.json and messages/ar.json.

Input: a JSON file {"namespace.key.sub": ["French", "العربية"], ...}. Existing keys are overwritten,
so both locales always stay in sync (section 0 rule 5: no hard-coded UI strings).
Usage: python3 scripts/i18n-merge.py new-strings.json
"""
import json, sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent / "messages"
entries = json.load(open(sys.argv[1], encoding="utf-8"))
for idx, locale in enumerate(["fr", "ar"]):
    path = root / f"{locale}.json"
    data = json.load(open(path, encoding="utf-8"))
    for dotted, pair in entries.items():
        node = data
        parts = dotted.split(".")
        for p in parts[:-1]:
            node = node.setdefault(p, {})
        node[parts[-1]] = pair[idx]
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"merged {len(entries)} keys")
