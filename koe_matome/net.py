"""取得先サイトへのアクセス。

取得間隔は 1 秒に固定し、設定や引数で短くできないようにしている。多くの人が使っても
取得先に負担をかけないための約束なので、変更しないこと。
"""

import time
import urllib.error
import urllib.request

MIN_INTERVAL = 1.0
USER_AGENT = "koe-matome/0.1 (personal voice list tool; +https://github.com/iknoway-home/koe-matome)"

_last_request = 0.0


def fetch(url, timeout=120):
    """URL を取得して文字列で返す。通信エラーは 2 回まで待って取り直す。"""
    global _last_request
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "ja"})
    for attempt in range(3):
        wait = MIN_INTERVAL - (time.monotonic() - _last_request)
        if wait > 0:
            time.sleep(wait)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                body = res.read().decode("utf-8")
            _last_request = time.monotonic()
            return body
        except urllib.error.HTTPError as e:
            _last_request = time.monotonic()
            if e.code < 500 or attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))
        except OSError:
            _last_request = time.monotonic()
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))
