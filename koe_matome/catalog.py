"""メンバーとボイス商品の更新。取得先ごとの処理は sites/ のモジュールに任せる。

データは手元の data ディレクトリにだけ置き、どこにも送らない。
購入記録は選択肢のID（ストアの商品ID）に紐づくので、ストアから消えた商品も削除しない。
"""

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .storage import load_json, save_json


class Catalog:
    def __init__(self, site, data_dir):
        self.site = site
        self.dir = Path(data_dir) / site.NAME
        self.cache = self.dir / "cache" / "products"
        self.members_path = self.dir / "members.json"
        self.voices_path = self.dir / "voices.json"
        self.config_path = self.dir / "config.json"
        self.members = load_json(self.members_path, {})
        self.voices = load_json(self.voices_path, {"groups": {}, "products": {}})
        self.config = load_json(self.config_path, {"targets": []})

    def save(self):
        save_json(self.members_path, self.members)
        save_json(self.voices_path, self.voices)
        save_json(self.config_path, self.config)

    # ---- メンバー ----

    def update_members(self):
        """ストアのライバー一覧から members を更新する。一覧から消えた人も削除しない（listed=false）。"""
        found = self.site.fetch_members()
        if len(found) < 100:
            raise SystemExit(f"ライバー一覧が {len(found)} 人しか読めなかった。サイトの構造が変わった可能性があるので保存しない。")
        changes = {"追加": [], "名前変更": [], "一覧から消えた": []}
        seen = set()
        for order, (artist_id, name, branch) in enumerate(found):
            seen.add(artist_id)
            m = self.members.get(artist_id)
            if m is None:
                self.members[artist_id] = m = {"name": name, "branch": branch}
                changes["追加"].append(name)
            elif m["name"] != name:
                changes["名前変更"].append(f"{m['name']} → {name}")
                m["name"] = name
            m.update(listed=True, order=order)
        for artist_id, m in self.members.items():
            if artist_id not in seen and m.get("listed"):
                m["listed"] = False
                m.pop("order", None)
                changes["一覧から消えた"].append(m["name"])
        # 英語表記はダウンロードしたファイル名（ローマ字）との照合に使う補助情報。取れなくても続ける。
        if hasattr(self.site, "fetch_en_names"):
            try:
                changed = self.site.apply_en_names(self.members, self.site.fetch_en_names())
                changes["英語表記を更新"] = [f"{changed}人"] if changed else []
            except Exception as e:
                changes["英語表記を取得できなかった"] = [str(getattr(e, "code", type(e).__name__))]
        return changes

    def resolve(self, words):
        """名前（一部でよい）かIDのリストを、ライバーIDのリストにする。"""
        ids, errors = [], []
        for word in words:
            if word in self.members:
                ids.append(word)
                continue
            key = self.site.normalize_name(word)
            hits = [i for i, m in self.members.items() if key and key in self.site.normalize_name(m["name"])]
            exact = [i for i in hits if self.site.normalize_name(self.members[i]["name"]) == key]
            hits = exact or hits
            if len(hits) == 1:
                ids.append(hits[0])
            else:
                names = "、".join(self.members[i]["name"] for i in hits[:8])
                errors.append(f"「{word}」" + (f"に当てはまる人が複数いる：{names}" if hits else "に当てはまる人がいない"))
        return list(dict.fromkeys(ids)), errors

    def registry(self):
        """名前で探すときの [(ID, 名前)]。別名（aliases）も含め、長い名前から照合する。"""
        rows = [(i, n) for i, m in self.members.items() for n in [m["name"], *m.get("aliases", [])]]
        return sorted(rows, key=lambda r: -len(r[1]))

    # ---- ボイス ----

    def cached(self, pid):
        return load_json(self.cache / f"{pid}.json", None)

    def needs_fetch(self, pid, lastmod, max_age, full):
        """新しい商品、サイトマップの更新日時が変わった商品、販売中で古くなった商品だけ取り直す。"""
        product = self.cached(pid)
        record = self.voices["products"].get(pid)
        if full or product is None:
            return True
        if lastmod and lastmod != product.get("lastmod"):
            return True
        if not (record or {}).get("onSale"):
            return False
        age = datetime.now(timezone.utc) - datetime.fromisoformat(product["fetchedAt"])
        return age > timedelta(days=max_age)

    def update_voices(self, everything=False, full=False, offline=False, max_age=30, progress=print):
        site, products, groups = self.site, self.voices["products"], self.voices["groups"]
        targets = [] if everything else self.config["targets"]
        if not everything and not targets:
            raise SystemExit("取得するライバーが決まっていない。--member で指定するか、--all で全員分を取る。")

        if offline:
            sitemap = {}
            candidates = sorted(path.stem for path in self.cache.glob("*.json"))
        else:
            sitemap = site.fetch_sitemap()
            if len(sitemap) < 3000:
                raise SystemExit(f"サイトマップが {len(sitemap)} 件しか読めなかった。サイトの構造が変わった可能性があるので保存しない。")
            if everything:
                candidates = [pid for pid in sitemap if pid.startswith(site.VOICE_PREFIXES)] + site.list_limited_on_sale()
            else:
                candidates = [pid for artist_id in targets for pid in site.list_member_products(artist_id)]
            candidates = list(dict.fromkeys(candidates + list(products)))

        fetched, failed, missing = 0, [], {pid for pid, p in products.items() if p.get("pageGone")}
        gone_pages = []
        if not offline:
            todo = [pid for pid in candidates if self.needs_fetch(pid, sitemap.get(pid), max_age, full)]
            progress(f"取得: {len(todo)}件（候補 {len(candidates)}件、1件あたり数秒）")
            for n, pid in enumerate(todo, 1):
                try:
                    product = site.fetch_product(pid)
                    product["lastmod"] = sitemap.get(pid)
                    save_json(self.cache / f"{pid}.json", product)
                    missing.discard(pid)
                    fetched += 1
                except Exception as e:  # 1件の失敗で全体を止めない
                    if getattr(e, "code", None) == 404 and pid in products:
                        missing.add(pid)
                        if products[pid].get("onSale"):
                            gone_pages.append(pid)
                    else:
                        failed.append(f"{pid}({getattr(e, 'code', type(e).__name__)})")
                if n % 50 == 0:
                    progress(f"  {n}/{len(todo)}")

        report = {k: [] for k in ["新しい企画", "新しい商品", "販売終了", "販売再開", "価格変更", "期間変更",
                                  "担当不明", "消えた選択肢", "卒業生として追加", "取得失敗"]}
        report["取得失敗"] = failed
        voice = [p for p in map(self.cached, candidates) if p is not None and site.is_voice(p)]
        self._add_graduates(voice, report)
        registry = self.registry()
        now = datetime.now(timezone.utc)
        next_seq = max((p.get("seq", 0) for p in products.values()), default=0)
        known_ids = {item["id"] for p in products.values() for item in p["items"]}

        for product in sorted(voice, key=lambda p: _creation_order(p["id"])):
            pid = product["id"]
            record = products.get(pid)
            for artist_id, name in site.liver_artists(product):
                if artist_id not in self.members:
                    self.members[artist_id] = {"name": name, "branch": "EN" if artist_id.startswith("4") else "JP",
                                               "listed": False}
            gid = record["group"] if record else self._group_for(pid, candidates)
            if gid not in groups:
                groups[gid] = {"title": site.group_title(product["name"])}
                report["新しい企画"].append(groups[gid]["title"])
            if record is None:
                next_seq += 1
            selling = site.on_sale(product, now) and pid not in missing
            start, end = site.sale_period(product)
            old_items = {item["id"]: item for item in (record or {}).get("items", [])}
            items = []
            for v in site.voice_variants(product):
                livers = site.variant_livers(product, v, registry)
                if not livers:
                    # 誰か1人の選択肢らしいのに担当が決まらないときは空にする（別の人の商品として出さない）。
                    # 全員セットのような選択肢だけ、商品に登録された全員を担当にする。
                    livers = [] if site.name_candidate(product, v) else [a for a, _ in site.liver_artists(product)]
                    if v["id"] not in known_ids:
                        report["担当不明"].append(f"{pid} {v['name']}")
                old = old_items.pop(v["id"], None)
                if v["id"] not in known_ids and record is not None:
                    report["新しい商品"].append(f"{product['name']} {v['name']}")
                elif old and old["price"] != v["price"]:
                    report["価格変更"].append(f"{v['name']} {old['price']}→{v['price']}円")
                known_ids.add(v["id"])
                items.append({"id": v["id"], "name": v["name"], "price": v["price"] or 0, "livers": livers})
            for old in old_items.values():
                if not old.get("gone"):
                    report["消えた選択肢"].append(f"{pid} {old['name']}")
                items.append({**old, "gone": True})
            if record is not None:
                if record.get("onSale") and not selling:
                    report["販売終了"].append(product["name"])
                elif record.get("onSale") is False and selling:
                    report["販売再開"].append(product["name"])
                if (record.get("start"), record.get("end")) != (start, end):
                    report["期間変更"].append(f"{product['name']} {start}〜{end}")
            products[pid] = {"group": gid, "name": product["name"], "start": start, "end": end,
                             "limited": site.is_limited(product), "onSale": selling,
                             "seq": record["seq"] if record else next_seq, "items": items}
            if pid in missing:
                products[pid]["pageGone"] = True
        report["販売終了"] += [products[pid]["name"] for pid in gone_pages]
        return fetched, report

    def _group_for(self, pid, candidates):
        gid = self.site.group_base(pid)
        if gid == pid:
            # 分割ページの企画（dig-00056_A …）と同じ番号の単独商品は別の企画にする。
            family = re.compile(re.escape(pid) + r"_(?:[A-Z]|EN)$")
            if any(family.match(other) for other in [*candidates, *self.voices["products"]]):
                gid = pid + "~solo"
        return gid

    def _add_graduates(self, voice, report):
        """ストアの担当情報から外れた卒業生を商品名・選択肢名から見つけて登録する。

        名前の位置が決まった形で取れた名前か、2件以上の商品に出てくる名前だけ登録する。
        """
        site, registry = self.site, self.registry()
        known = {site.normalize_name(n) for _, n in registry}
        seen = {}
        for product in voice:
            for v in site.voice_variants(product):
                if site.variant_livers(product, v, registry):
                    continue
                found = site.name_candidate(product, v)
                if not found or site.normalize_name(found[0]) in known:
                    continue
                entry = seen.setdefault(site.normalize_name(found[0]),
                                        {"name": found[0], "products": set(), "strong": False, "en": False})
                entry["products"].add(product["id"])
                entry["strong"] |= found[1] == "strong"
                entry["en"] |= product["id"].endswith("_EN") or "M02-06" in product["tags"]
        accepted = {k: e for k, e in seen.items() if e["strong"] or len(e["products"]) >= 2}
        for key, entry in sorted(accepted.items()):
            # 「出雲霞に告白される」のように、別の候補名で始まる語は企画名の一部。
            if any(key != other and key.startswith(other) for other in accepted):
                continue
            self.members["g-" + entry["name"]] = {"name": entry["name"], "branch": "EN" if entry["en"] else "JP",
                                                  "listed": False, "inferred": True}
            report["卒業生として追加"].append(entry["name"])


def _creation_order(pid):
    m = re.search(r"(\d+)", pid)
    return (not pid.startswith("dig-"), int(m.group(1)) if m else 0, pid)
