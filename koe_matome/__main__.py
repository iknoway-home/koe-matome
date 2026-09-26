"""コマンドの入口。

  python3 -m koe_matome members 戌亥                  # ライバーを名前で探す
  python3 -m koe_matome update --member 戌亥とこ      # 指定したライバーの分を取得してHTMLを作る
  python3 -m koe_matome update                       # 前回指定したライバーの分を差分で更新
  python3 -m koe_matome update --all                 # 全員分（初回は数時間かかる）
  python3 -m koe_matome build                        # 取得せずHTMLだけ作り直す
"""

import argparse
import sys
from pathlib import Path

from . import __version__
from .catalog import Catalog
from .page import build
from .sites import SITES


def summarize(rows, limit=10):
    rows = list(rows)
    return "、".join(rows[:limit]) + (f" ほか{len(rows) - limit}件" if len(rows) > limit else "")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="koe_matome", description="ボイス販売サイトの商品を購入リストにまとめる（非公式）")
    ap.add_argument("--version", action="version", version=__version__)
    ap.add_argument("--site", default="nijisanji", choices=sorted(SITES), help="取得先（今は nijisanji のみ）")
    ap.add_argument("--data", default="koe-data", help="データの置き場所（既定: ./koe-data）")
    sub = ap.add_subparsers(dest="command", required=True)

    p_members = sub.add_parser("members", help="ライバー一覧を取得して名前で探す")
    p_members.add_argument("query", nargs="?", default="", help="名前の一部（省略すると全員）")

    p_update = sub.add_parser("update", help="商品を取得してHTMLを作る")
    who = p_update.add_mutually_exclusive_group()
    who.add_argument("--member", action="append", default=[], help="取得するライバー（名前の一部かID。複数指定可）")
    who.add_argument("--all", action="store_true", help="全員分を取る（初回は数時間。卒業生の自動登録もする）")
    p_update.add_argument("--full", action="store_true", help="保存済みの商品も全部取り直す")
    p_update.add_argument("--offline", action="store_true", help="通信せず保存済みのデータから作り直す")
    p_update.add_argument("--max-age", type=float, default=30, help="販売中の商品を取り直す間隔（日、既定30）")

    sub.add_parser("build", help="取得せずHTMLだけ作り直す")
    args = ap.parse_args(argv)

    catalog = Catalog(SITES[args.site], args.data)
    out = Path(args.data) / f"koe-matome-{args.site}.html"

    if args.command == "members":
        changes = catalog.update_members()
        catalog.save()
        key = catalog.site.normalize_name(args.query)
        rows = [(i, m) for i, m in catalog.members.items() if not key or key in catalog.site.normalize_name(m["name"])]
        rows.sort(key=lambda r: (r[1]["branch"] != "JP", "order" not in r[1], r[1].get("order", 0), r[1]["name"]))
        for i, m in rows:
            note = "" if m.get("listed") else "（ストアの一覧外）"
            print(f"{i}\t{m['branch']}\t{m['name']}{note}")
        for label, names in changes.items():
            if names:
                print(f"  {label} {len(names)}: {summarize(names)}", file=sys.stderr)
        return

    if args.command == "update":
        if not args.offline:
            catalog.update_members()
        if args.member:
            ids, errors = catalog.resolve(args.member)
            if errors:
                raise SystemExit("\n".join(errors) + "\n`python3 -m koe_matome members 名前` で確かめてから指定してください。")
            catalog.config.update(targets=ids, all=False)
        if args.all:
            catalog.config.update(targets=[], all=True)
        everything = bool(catalog.config.get("all"))
        names = "全員" if everything else "、".join(catalog.members[i]["name"] for i in catalog.config["targets"])
        print(f"対象: {names or '未指定'}")
        fetched, report = catalog.update_voices(everything=everything,
                                                full=args.full, offline=args.offline, max_age=args.max_age)
        catalog.save()
        stats = build(catalog, out)
        print(f"取得 {fetched}件 → 企画 {stats['groups']}・商品 {stats['items']} → {out}（{stats['bytes'] // 1024}KB）")
        for label, rows in report.items():
            if rows:
                print(f"  {label} {len(rows)}: {summarize(rows)}")
        return

    if args.command == "build":
        stats = build(catalog, out)
        print(f"企画 {stats['groups']}・商品 {stats['items']} → {out}（{stats['bytes'] // 1024}KB）")


if __name__ == "__main__":
    main()
