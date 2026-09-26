"""にじさんじオフィシャルストア（shop.nijisanji.jp）用の取得と読み取り。

koe-matome は非公式のツールで、ANYCOLOR株式会社・株式会社ソニー・ミュージックソリューションズとは関係ない。
取得するのは公開されている商品ページの情報だけで、ログインが必要な場所（/mypage）には触れない。
"""

import html
import json
import re
import unicodedata
import urllib.parse
from datetime import datetime, timedelta, timezone

from ..net import fetch

NAME = "nijisanji"
TITLE = "にじさんじオフィシャルストア"
DISCLAIMER = ("ANYCOLOR株式会社、株式会社ソニー・ミュージックソリューションズ、にじさんじオフィシャルストアとは関係ありません。"
              "商品情報は同ストアの公開ページから取得したもので、権利は各権利者に帰属します。")
SHOP = "https://shop.nijisanji.jp"
API = SHOP + "/on/demandware.store/Sites-shop-nijisanji-niji-Site/ja_JP"
JST = timezone(timedelta(hours=9))

# デジタルグッズのうちボイス系のカテゴリ。壁紙などは入れない。
VOICE_CATEGORIES = ("M02-01", "M02-02", "M02-03", "M02-04", "M02-05", "M02-06", "M02-07", "M02-08")
LIMITED_CATEGORY = "M02-01"
PERMANENT_CATEGORY = "M02-02"
# サイトマップにある商品のうち、ボイスを含みうる番号帯。
VOICE_PREFIXES = ("dig-", "HBS-", "HB-")
WITH_ENDED = "販売中|販売終了も含める"
ON_SALE = "販売中"


def product_url(pid):
    return f"{SHOP}/{urllib.parse.quote(pid)}.html"


# ---- メンバー ----

def fetch_members():
    """[(ID, 名前, "JP"/"EN")]。ストアのライバー一覧（五十音順）の並びのまま返す。"""
    found = []
    for path, branch in (("nijisanji", "JP"), ("nijisanji_en", "EN")):
        page = fetch(f"{SHOP}/{path}")
        for artist_id, name in re.findall(r'<a href="/([^"/]+)" class="link text-bold">([^<]+)</a>', page):
            if artist_id.isdigit():
                found.append((artist_id, html.unescape(name).strip(), branch))
    return found


def normalize_name(name):
    """表記ゆれを吸収した照合用の名前。空白・中点・記号・全角半角の違いを無視する。"""
    return re.sub(r"[\s　・･.\-‐－_\u200b\ufeff]", "", unicodedata.normalize("NFKC", name)).lower()


# ---- 商品一覧 ----

def fetch_sitemap():
    """商品ID → 最終更新日時。全商品が載り、商品が変わると日時が変わる。"""
    found = {}
    index = fetch(f"{SHOP}/sitemap_index.xml")
    for url in re.findall(r"<loc>([^<]*product[^<]*)</loc>", index):
        xml = fetch(url)
        for pid, lastmod in re.findall(
                r"<loc>https://shop\.nijisanji\.jp/([^<]+?)\.html</loc>\s*<lastmod>([^<]+)</lastmod>", xml):
            found[urllib.parse.unquote(pid)] = lastmod
    return found


def list_member_products(artist_id):
    """ライバーのデジタルグッズ一覧（販売終了を含む）。販売中の商品はほぼ漏れなく載るが、
    古い販売終了品は載らないことがある。ストアの並びが不安定なので、ページ送りせず1回で取る。"""
    query = urllib.parse.urlencode({
        "cgid": artist_id, "secondCgid": "M02", "prefn1": "endOfSale", "prefv1": WITH_ENDED,
        "sz": 600, "start": 0,
    })
    page = fetch(f"{API}/Search-UpdateGrid?{query}", timeout=100)
    return list(dict.fromkeys(re.findall(r'data-pid="([^"]+)"', page)))


def list_limited_on_sale():
    """販売中の期間限定ボイス。物販とまとめた誕生日グッズなど、番号帯の外の商品を拾う。"""
    ids, start = [], 0
    while start < 1000:
        query = urllib.parse.urlencode({
            "cgid": LIMITED_CATEGORY, "prefn1": "endOfSale", "prefv1": ON_SALE, "sz": 100, "start": start,
        })
        found = re.findall(r'data-pid="([^"]+)"', fetch(f"{API}/Search-UpdateGrid?{query}"))
        ids.extend(pid for pid in found if pid not in ids)
        if len(found) < 100:
            break
        start += 100
    return ids


# ---- 商品 ----

def fetch_product(pid):
    raw = json.loads(fetch(f"{API}/Product-Variation?pid={urllib.parse.quote(pid)}"))
    return trim_product(raw["product"])


def _price(value):
    try:
        return int(value["sales"]["value"])
    except (TypeError, KeyError, ValueError):
        return None


def trim_product(p):
    """読み取りに使う項目だけ残す。キャッシュもこの形で持つ。"""
    variants = [{
        "id": v.get("selectedID"), "name": (v.get("name") or "").strip(),
        "price": _price(v.get("price")), "available": bool(v.get("available")),
    } for v in p.get("variationProducts") or []]
    if not variants:
        variants.append({
            "id": p["id"], "name": (p.get("productName") or "").strip(),
            "price": _price(p.get("price")), "available": bool(p.get("available")),
        })
    return {
        "id": p["id"],
        "name": (p.get("productName") or "").strip(),
        "artists": [[a["ID"], a.get("displayName", "")] for a in p.get("artist") or []],
        "tags": sorted({t["ID"] for t in p.get("tag") or []}),
        "description": _text(p.get("longDescription") or ""),
        "orderAcceptedTo": p.get("orderAcceptedTo"),
        "online": bool(p.get("online")),
        "variants": variants,
        "fetchedAt": datetime.now(JST).isoformat(timespec="seconds"),
    }


def _text(raw):
    text = html.unescape(re.sub(r"<[^>]+>", "", re.sub(r"<br\s*/?>", "\n", raw)))
    return re.sub(r"[ \t]+", " ", text).strip()[:2000]


def is_voice(product):
    return any(t in VOICE_CATEGORIES for t in product["tags"])


# ---- 販売期間 ----

_DATE = r"(?:(\d{4})年)?\s*(\d{1,2})月(\d{1,2})日\s*(?:[(（][^)）]*[)）])?\s*(\d{1,2})[:：](\d{2})"
_RANGE = re.compile(_DATE + r"\s*[〜～~]\s*" + _DATE)


def _is_permanent(product):
    tags = product.get("tags", [])
    return any(t.startswith(PERMANENT_CATEGORY) for t in tags) and not any(t.startswith(LIMITED_CATEGORY) for t in tags)


def accepted_until(product, now=None):
    """受付終了時刻。常設品の仮の期限（2037-12-31 や 2099-12-31）は期限として扱わない。

    5年以上先の期限と、常設品の1年以上先の期限は「期限なし」。過去の期限（卒業で販売終了など）は本物。
    """
    accepted = product.get("orderAcceptedTo")
    if not accepted:
        return None
    when = datetime.fromisoformat(accepted.replace("Z", "+00:00"))
    now = now or datetime.now(timezone.utc)
    if when > now + timedelta(days=5 * 365) or (_is_permanent(product) and when > now + timedelta(days=365)):
        return None
    return when


def _iso(y, mo, d, h, mi, sec=0):
    return datetime(int(y), int(mo), int(d), int(h), int(mi), sec, tzinfo=JST).isoformat()


def sale_period(product):
    """(開始, 終了) を日本時間の ISO 文字列で。終了は受付終了時刻、開始は説明文の「〜」の範囲から読む。"""
    start = end = None
    m = _RANGE.search(product.get("description") or "")
    if m:
        y1, mo1, d1, h1, mi1, y2, mo2, d2, h2, mi2 = m.groups()
        if y1:
            start = _iso(y1, mo1, d1, h1, mi1)
            y2 = y2 or (int(y1) + 1 if int(mo2) < int(mo1) else y1)
            end = _iso(y2, mo2, d2, h2, mi2, 59)
    accepted = accepted_until(product)
    if accepted:
        end = accepted.astimezone(JST).replace(microsecond=0).isoformat()
    return start, end


def on_sale(product, now=None):
    """今買えるか。受付期限前で、買える選択肢が1つでもあれば販売中。"""
    accepted = accepted_until(product)
    if accepted and accepted < (now or datetime.now(timezone.utc)):
        return False
    return product.get("online", True) and any(v["available"] for v in product["variants"])


def is_limited(product):
    return any(t.startswith(LIMITED_CATEGORY) for t in product["tags"]) or (
        accepted_until(product) is not None and not any(t.startswith(PERMANENT_CATEGORY) for t in product["tags"]))


# ---- 購入候補と担当ライバー ----

def voice_variants(product):
    """ボイスを含む購入候補。デジタル商品（dig-）は全部、物販とまとめたページはボイスの選択肢だけ。"""
    if product["id"].startswith("dig-"):
        return list(product["variants"])
    prefix = product["name"]

    def own_part(name):
        rest = name[len(prefix):].strip() if name.startswith(prefix) else name
        return rest or name
    return [v for v in product["variants"] if "ボイス" in own_part(v["name"])]


def liver_artists(product):
    """商品に登録されたライバー。「にじさんじ」などグループ単位の登録（数字でないID）は除く。"""
    return [[i, n] for i, n in product["artists"] if i.isdigit() and n]


_EDGE = r"\s【】\[\]()（）「」、,，×/／：:&＆"


def _mentions(text, name):
    """text に name が名前として出てくるか。2文字以下の名前（える、叶）は前後の区切りも見る。"""
    text, name = unicodedata.normalize("NFKC", text), unicodedata.normalize("NFKC", name)
    core = re.sub(r"[\s・]", "", name)
    body = r"[\s・]?".join(re.escape(ch) for ch in core)
    tail = "" if len(core) >= 3 else rf"(?=$|[{_EDGE}]|ボイス|の)"
    return re.search(rf"(?:^|(?<=[{_EDGE}]))(?:EX\s*)?{body}{tail}", text) is not None


def variant_livers(product, variant, registry=()):
    """選択肢の担当ライバーID。

    1. 商品に登録されたライバーの名前が選択肢名にあればその人（複数可）。1人だけの商品はその人。
    2. 登録にない人（ストアの担当情報から外れた卒業生など）は registry [(ID, 名前)] から、選択肢名 → 商品名の順に探す。
    決まらなければ空リスト。
    """
    artists = liver_artists(product)
    name = normalize_name(variant["name"])
    hits = [(name.find(normalize_name(n)), i) for i, n in artists if normalize_name(n) in name]
    if hits:
        return list(dict.fromkeys(i for _, i in sorted(hits)))
    if len(artists) == 1:
        return [artists[0][0]]
    clean = re.sub(r"[\u200b\ufeff_]", " ", variant["name"])
    found = [i for i, n in registry if _mentions(clean, n)]
    if not found and not artists:
        title = re.sub(r"[\u200b\ufeff_]", " ", product["name"])
        found = [i for i, n in registry if _mentions(title, n)]
        found = found if len(found) == 1 else []
    return list(dict.fromkeys(found))


_NOT_A_NAME = re.compile(r"常設|再販|再版|期間|Voice|ボイス|記念|限定|セット|20\d\d|\d+年|\d+月|グループ|ASMR|にじさんじ|NIJISANJI|特典|Vol|第|版$|Another")
_NAMED = [
    re.compile(r"^(?:【[^】]*】\s*)*(.+?)\s*誕生日ボイス"),
    re.compile(r"^(.+?)\s*ボイスセット$"),
    re.compile(r"^【Welcome Voice】\s*(.+)$"),
    re.compile(r"^(.+?)_シチュエーションボイス"),
    re.compile(r"^【([^】]+)】にじさんじ季節ボイス"),
    re.compile(r"^\d+\s+\S+.*【([^】]+)】$"),
]


def name_candidate(product, variant):
    """担当が決まらなかった選択肢から、ライバー名らしき部分を (名前, "strong"/"weak") で返す。

    strong は「〇〇 誕生日ボイス」「〇〇 ボイスセット」のように名前の位置が決まった形、
    weak は「成瀬鳴 怪談ボイス2021」から企画名を除いた残り。
    """
    def valid(cand):
        cand = (cand or "").strip(" _")
        return cand if 1 < len(cand) <= 16 and not _NOT_A_NAME.search(cand) else None

    for text in (variant["name"], product["name"]):
        text = re.sub(r"[\u200b\ufeff]", "", text).strip()
        for pattern in _NAMED:
            m = pattern.search(text)
            if m and valid(m.group(1)):
                return valid(m.group(1)), "strong"
    core = re.sub(r"^(【[^】]*】\s*)+", "", group_title(product["name"])).strip()
    text = re.sub(r"[\u200b\ufeff]", "", variant["name"])
    text = re.sub(r"^(【[^】]*】\s*)+", "", text)
    text = re.sub(r"^EX\s*(?:-Another-)?\s*", "", text).strip()
    if core and text.endswith(core) and text != core and valid(text[:-len(core)]):
        return valid(text[:-len(core)]), "weak"
    return None


def group_base(pid):
    """同じ企画をライバー別に分けたページ（dig-00097_A, _B, _EN …）の共通部分。"""
    return re.sub(r"_(?:[A-Z]|EN)$", "", pid)


def group_title(name):
    return re.sub(r"\s*[-－–‐]\s*(?:[A-Z]|EN)グループ$", "", name).strip()
