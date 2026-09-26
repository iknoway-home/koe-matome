import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from koe_matome.catalog import Catalog
from koe_matome.page import build, build_data
from koe_matome.sites import nijisanji


def catalog_with(targets):
    cat = Catalog(nijisanji, tempfile.mkdtemp())
    cat.members = {
        "1070": {"name": "戌亥とこ", "branch": "JP", "listed": True, "order": 1},
        "1154": {"name": "栞葉るり", "branch": "JP", "listed": True, "order": 0},
        "4002": {"name": "エリーラ ペンドラ", "branch": "EN", "listed": True, "order": 2},
    }
    cat.voices = {"groups": {"g1": {"title": "約束ボイス"}}, "products": {"dig-1_A": {
        "group": "g1", "name": "約束ボイス", "start": None, "end": None, "limited": False, "onSale": True, "seq": 1,
        "items": [
            {"id": "v1", "name": "戌亥とこ 約束ボイス</script><b>", "price": 1200, "livers": ["1070"]},
            {"id": "v2", "name": "栞葉るり 約束ボイス", "price": 1200, "livers": ["1154"]},
            {"id": "v3", "name": "エリーラ ペンドラ 約束ボイス", "price": 1200, "livers": ["4002"]},
        ]}}}
    cat.config = {"targets": targets}
    return cat


class PageTest(unittest.TestCase):
    def test_only_target_members_are_included(self):
        data, stats = build_data(catalog_with(["1070"]))
        self.assertEqual(stats["items"], 1)
        self.assertEqual([m[0] for m in data["members"]], ["1070"])
        self.assertEqual(data["defaultPicked"], ["1070"])

    def test_all_members_in_store_order(self):
        data, _ = build_data(catalog_with([]))
        self.assertEqual([m[0] for m in data["members"]], ["1154", "1070", "4002"])

    def test_script_end_tag_in_names_cannot_break_the_page(self):
        cat = catalog_with(["1070"])
        out = Path(cat.dir) / "out.html"
        build(cat, out)
        page = out.read_text(encoding="utf-8")
        self.assertEqual(page.count("</script>"), 2)  # データ用と本体用の閉じタグだけ
        self.assertNotIn("{{", page)

    def test_resolve_member_names(self):
        cat = catalog_with([])
        self.assertEqual(cat.resolve(["戌亥", "エリーラペンドラ", "1154"]), (["1070", "4002", "1154"], []))
        ids, errors = cat.resolve(["存在しない人"])
        self.assertEqual(ids, [])
        self.assertEqual(len(errors), 1)


if __name__ == "__main__":
    unittest.main()
