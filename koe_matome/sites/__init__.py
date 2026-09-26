"""取得先サイトごとのモジュール。サイトを足すときは同じ関数をそろえたモジュールを作り、SITES に登録する。"""

from . import nijisanji

SITES = {nijisanji.NAME: nijisanji}
