import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from koe_matome.sites.nijisanji import group_base, group_title, is_limited, name_candidate, on_sale, sale_period, variant_livers, voice_variants


def product(**kw):
    base = {"id": "dig-00072_A", "name": "", "artists": [], "tags": [], "description": "",
            "orderAcceptedTo": None, "variants": []}
    base.update(kw)
    return base


class SalePeriodTest(unittest.TestCase):
    def test_range_with_year_on_both_sides(self):
        p = product(description="2026年9月15日(火)11:00〜2026年9月22日(火)23:59までの期間再販売！")
        self.assertEqual(sale_period(p), ("2026-09-15T11:00:00+09:00", "2026-09-22T23:59:59+09:00"))

    def test_end_without_year_and_accepted_time_wins(self):
        p = product(description="【受注期間】2026年9月20日(日)18:00 ～ 9月26日(土)23:59",
                    orderAcceptedTo="2026-09-26T14:59:59.000Z")
        self.assertEqual(sale_period(p), ("2026-09-20T18:00:00+09:00", "2026-09-26T23:59:59+09:00"))

    def test_range_across_new_year(self):
        p = product(description="2026年12月25日(金)18:00～1月5日(火)23:59")
        self.assertEqual(sale_period(p)[1], "2027-01-05T23:59:59+09:00")

    def test_release_date_alone_is_not_a_period(self):
        p = product(description="【2019年4月～2019年7月】・・・2020年11月13日 18:00より販売開始")
        self.assertEqual(sale_period(p), (None, None))

    def test_permanent_deadline_2099_is_no_deadline(self):
        p = product(orderAcceptedTo="2099-12-31T14:59:59.000Z", tags=["M02-02"])
        self.assertEqual(sale_period(p), (None, None))
        self.assertFalse(is_limited(p))

    def test_placeholder_deadline_on_permanent_product_is_ignored(self):
        p = product(orderAcceptedTo="2037-12-31T14:59:59.000Z", tags=["M02", "M02-02"])
        self.assertEqual(sale_period(p), (None, None))
        self.assertFalse(is_limited(p))

    def test_past_deadline_on_permanent_product_ends_sale(self):
        p = product(orderAcceptedTo="2021-06-30T14:59:59.000Z", tags=["M02", "M02-02"], variants=[{"available": True}])
        self.assertEqual(sale_period(p)[1], "2021-06-30T23:59:59+09:00")
        self.assertFalse(on_sale(p))
        self.assertFalse(is_limited(p))

    def test_limited_by_category_or_deadline(self):
        self.assertTrue(is_limited(product(tags=["M02", "M02-01"])))
        self.assertTrue(is_limited(product(orderAcceptedTo="2026-09-26T14:59:59.000Z")))
        self.assertFalse(is_limited(product(tags=["M02", "M02-02"])))


class VariantTest(unittest.TestCase):
    def test_single_artist_owns_every_variant(self):
        p = product(artists=[["1070", "戌亥とこ"]])
        self.assertEqual(variant_livers(p, {"name": "コンプリートセット"}), ["1070"])

    def test_multi_artist_matches_name_ignoring_spaces(self):
        p = product(artists=[["4002", "エリーラ ペンドラ"], ["4003", "フィナーナ 竜宮"]])
        self.assertEqual(variant_livers(p, {"name": "EX エリーラペンドラ 約束ボイス"}), ["4002"])
        self.assertEqual(variant_livers(p, {"name": "全員セット"}), [])

    def test_multi_artist_keeps_name_order(self):
        p = product(artists=[["1106", "フレン・E・ルスタリオ"], ["1070", "戌亥とこ"]])
        self.assertEqual(variant_livers(p, {"name": "キービジュアルセット(戌亥とこ、フレン・E・ルスタリオ)"}), ["1070", "1106"])

    def test_group_registration_is_not_a_liver(self):
        p = product(artists=[["nijisanji", "にじさんじ"], ["1070", "戌亥とこ"]])
        self.assertEqual(variant_livers(p, {"name": "セット"}), ["1070"])

    def test_graduate_found_by_name_in_variant(self):
        registry = [("g-成瀬鳴", "成瀬鳴"), ("1005", "える")]
        p = product(artists=[["1043", "鷹宮リオン"], ["1116", "東堂コハク"]])
        self.assertEqual(variant_livers(p, {"name": "EX 成瀬鳴 怪談ボイス2021"}, registry), ["g-成瀬鳴"])
        # 2文字の名前は語の一部に含まれても拾わない
        self.assertEqual(variant_livers(p, {"name": "聞こえるボイス"}, registry), [])

    def test_graduate_name_without_space_and_width_variants(self):
        registry = [("1050", "竜胆尊"), ("1010", "ギルザレンⅢ世")]
        p = product(id="HBS-1", name="【再販】竜胆尊誕生日ボイス2023")
        self.assertEqual(variant_livers(p, {"name": "【再販】竜胆尊誕生日ボイス2023"}, registry), ["1050"])
        p = product(artists=[["1", "a"], ["2", "b"]])
        self.assertEqual(variant_livers(p, {"name": "ギルザレンIII世 ハロウィンボイス2019"}, registry), ["1010"])

    def test_name_candidates(self):
        self.assertEqual(name_candidate(product(name="セレン 龍月 ボイスセット"), {"name": "01 アラーム音"}), ("セレン 龍月", "strong"))
        self.assertEqual(name_candidate(product(name="【常設】怪談ボイス2021 - Cグループ"), {"name": "EX 成瀬鳴 怪談ボイス2021"}), ("成瀬鳴", "weak"))
        self.assertIsNone(name_candidate(product(name="【再販】学園祭ボイス2020 - コンプリートセット"), {"name": "コンプリートセット"}))

    def test_goods_page_keeps_only_voice_options(self):
        p = product(id="SSZS-78507", name="栞葉るり誕生日グッズ＆ボイス2026", variants=[
            {"name": "栞葉るり誕生日グッズ＆ボイス2026 アクリルブロックセット"},
            {"name": "栞葉るり誕生日グッズ＆ボイス2026 誕生日ボイス＆特典壁紙"}])
        self.assertEqual([v["name"] for v in voice_variants(p)], ["栞葉るり誕生日グッズ＆ボイス2026 誕生日ボイス＆特典壁紙"])

    def test_option_named_same_as_product_is_kept(self):
        p = product(id="HBS-NF2026-01", name="【再販】魔界ノりりむ 誕生日ボイス2023",
                    variants=[{"name": "【再販】魔界ノりりむ 誕生日ボイス2023"}])
        self.assertEqual(len(voice_variants(p)), 1)

    def test_group_pages_share_one_campaign(self):
        self.assertEqual(group_base("dig-00097_A"), "dig-00097")
        self.assertEqual(group_base("dig-00097_EN"), "dig-00097")
        self.assertEqual(group_base("dig-00097_KV"), "dig-00097_KV")
        self.assertEqual(group_title("【再販】仲直りボイス - Aグループ"), "【再販】仲直りボイス")
        self.assertEqual(group_title("約束ボイス - ENグループ"), "約束ボイス")


if __name__ == "__main__":
    unittest.main()
