"""手元に保存するデータの読み書き。"""

import json
from pathlib import Path


def load_json(path, fallback):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback


def save_json(path, data, compact=False):
    """途中で止めても壊れたファイルを残さないよう、書き終えてから置き換える。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":")) if compact else \
        json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True)
    tmp.write_text(text + "\n", encoding="utf-8")
    tmp.replace(path)
