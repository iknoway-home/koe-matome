"""手元のデータから、ダブルクリックで開ける1ファイルのHTMLを作る。

CSS・JS・商品データをすべてHTMLに埋め込むので、サーバーもネット接続もいらない。
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent / "template"
FORMAT = 1
JST = timezone(timedelta(hours=9))


def build_data(catalog):
    site, members, voices = catalog.site, catalog.members, catalog.voices
    targets = set(catalog.config.get("targets") or [])

    def wanted(item):
        return not targets or bool(targets & set(item["livers"]))

    # 表示に必要なメンバーだけ、JP → EN、ストアの一覧と同じ五十音順（一覧にいない人は名前順で後ろ）。
    used = {a for p in voices["products"].values() for item in p["items"] if wanted(item) for a in item["livers"]}
    order = sorted((i for i in members if i in used),
                   key=lambda i: (members[i]["branch"] != "JP", "order" not in members[i],
                                  members[i].get("order", 0), members[i]["name"]))
    index = {artist_id: n for n, artist_id in enumerate(order)}
    member_rows = [[i, members[i]["name"], members[i]["branch"], int(bool(members[i].get("listed"))),
                    int(not targets or i in targets), members[i].get("en", "")] for i in order]

    by_group = {}
    for pid, p in voices["products"].items():
        by_group.setdefault(p["group"], []).append((pid, p))
    group_rows, item_count = [], 0
    for gid, entries in by_group.items():
        entries.sort(key=lambda e: e[1].get("seq", 0))
        items = [[item["id"], item["name"], item["price"], [index[a] for a in item["livers"] if a in index],
                  pid, int(bool(item.get("gone")))]
                 for pid, p in entries for item in p["items"] if wanted(item)]
        if not items:
            continue
        timed = next((p for _, p in entries if p.get("end")), None)
        sale = [p.get("onSale") for _, p in entries]
        group_rows.append([
            gid, voices["groups"].get(gid, {}).get("title", gid),
            int(any(p.get("limited") for _, p in entries)),
            timed["start"] if timed else None, timed["end"] if timed else None,
            1 if any(sale) else (0 if all(s is False for s in sale) else None),
            max(p.get("seq", 0) for _, p in entries), items,
        ])
        item_count += len(items)
    group_rows.sort(key=lambda g: -g[6])
    data = {
        "format": FORMAT, "site": site.NAME,
        "productUrl": site.product_url("{pid}").replace("%7Bpid%7D", "{pid}"),
        "updated": datetime.now(JST).strftime("%Y-%m-%d %H:%M"),
        "defaultPicked": [i for i in (catalog.config.get("targets") or []) if i in index],
        "members": member_rows, "groups": group_rows,
    }
    return data, {"groups": len(group_rows), "items": item_count}


def build(catalog, out_path):
    site = catalog.site
    data, stats = build_data(catalog)
    # </script> で埋め込みが途切れないよう、"</" をエスケープする。
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    page = (TEMPLATE / "page.html").read_text(encoding="utf-8")
    replacements = {
        "{{SOURCE}}": site.TITLE,
        "{{DISCLAIMER}}": site.DISCLAIMER,
        "{{UPDATED}}": data["updated"],
        "{{CSS}}": (TEMPLATE / "page.css").read_text(encoding="utf-8"),
        "{{JS}}": (TEMPLATE / "page.js").read_text(encoding="utf-8"),
        "{{DATA}}": payload,
    }
    for key, value in replacements.items():
        page = page.replace(key, value)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(page, encoding="utf-8")
    stats["bytes"] = out_path.stat().st_size
    return stats
