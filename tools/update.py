"""
GBO2 シミュレーター 定期更新スクリプト
=============================================
使い方:
  python tools/update.py --mode check    # 新着MSのチェックのみ (ダウンロード不要)
  python tools/update.py --mode weekly   # 新着MS取得・追加 (毎週木曜)
  python tools/update.py --mode monthly  # 全MS再取得・再生成 (月末調整)

Cloudflare通過: curl_cffi によるブラウザTLS偽装を使用 (Cookie不要)
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime

try:
    from curl_cffi import requests as cffi_requests
    _USE_CURL_CFFI = True
except ImportError:
    import urllib.request
    import urllib.error
    _USE_CURL_CFFI = False
    print("WARNING: curl_cffi が未インストールです。pip install curl_cffi を実行してください。")
    print("         フォールバックとして urllib を使用しますが、Cloudflareに弾かれる可能性があります。")


# ベースディレクトリ
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR   = os.path.dirname(SCRIPT_DIR)
DATA_DIR   = os.path.join(ROOT_DIR, 'data')
CACHE_DIR  = os.path.join(DATA_DIR, 'ms_html_cache')
URL_LIST   = os.path.join(DATA_DIR, 'ms_url_list.json')
MS_DATA    = os.path.join(DATA_DIR, 'ms_data.json')

ATWIKI_BASE = 'https://w.atwiki.jp/battle-operation2'

# カスタムパーツページID (サイドバーにMS一覧が含まれている)
SIDEBAR_PAGE_ID = 199


def fetch_page(url: str, delay: float = 0) -> str | None:
    """1ページをHTMLとして取得して返す (curl_cffi でCloudflare通過)"""
    if delay > 0:
        time.sleep(delay)

    if _USE_CURL_CFFI:
        try:
            resp = cffi_requests.get(
                url,
                impersonate="chrome120",
                headers={'Referer': f'{ATWIKI_BASE}/'},
                timeout=30,
            )
            if resp.status_code == 429:
                print(f"  429 Too Many Requests - 30秒待機...")
                time.sleep(30)
                resp = cffi_requests.get(url, impersonate="chrome120", timeout=30)
            resp.raise_for_status()
            return resp.text
        except Exception as e:
            print(f"  エラー: {e}")
        return None
    else:
        # curl_cffi 未インストール時のフォールバック
        import urllib.request, urllib.error
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
            'Referer': f'{ATWIKI_BASE}/',
        }
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode('utf-8')
        except urllib.error.HTTPError as e:
            if e.code == 403:
                print(f"  403 Forbidden - Cloudflareに弾かれました (curl_cffi をインストールしてください)")
            elif e.code == 429:
                print(f"  429 Too Many Requests - 30秒待機...")
                time.sleep(30)
            else:
                print(f"  HTTP {e.code}: {url}")
        except Exception as e:
            print(f"  エラー: {e}")
        return None


def save_cached_page(page_id: int, html: str) -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(os.path.join(CACHE_DIR, f"{page_id}.html"), 'w', encoding='utf-8') as f:
        f.write(html)


def load_url_list() -> list:
    """ms_url_list.json を読み込む。なければ空リストを返す"""
    if not os.path.exists(URL_LIST):
        return []
    with open(URL_LIST, 'rb') as f:
        return json.loads(f.read().decode('utf-8')).get('msList', [])


def save_url_list(ms_list: list) -> None:
    payload = {"totalMS": len(ms_list), "msList": ms_list}
    with open(URL_LIST, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def extract_ms_from_sidebar(html: str) -> list:
    """サイドバーのHTMLからMS URL一覧を抽出"""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')
    menubar = soup.find('div', id='menubar')
    if not menubar:
        return []

    ms_entries = []
    category_map = {'menu_kyoushu': '強襲', 'menu_hanyou': '汎用', 'menu_sien': '支援'}

    for div_id, cat_name in category_map.items():
        div = menubar.find('div', id=div_id)
        if not div:
            continue
        current_cost = None
        for el in div.find_all(['h4', 'a']):
            if el.name == 'h4':
                m = re.search(r'(\d+)', el.get_text(strip=True))
                if m:
                    current_cost = int(m.group(1))
            elif el.name == 'a' and current_cost is not None:
                href = el.get('href', '')
                m = re.search(r'/pages/(\d+)\.html', href)
                name = el.get_text(strip=True)
                if m and '一覧' not in name:
                    ms_entries.append({
                        "name": name,
                        "pageId": int(m.group(1)),
                        "url": f"{ATWIKI_BASE}/pages/{m.group(1)}.html",
                        "category": cat_name,
                        "minCost": current_cost,
                    })

    return ms_entries


def detect_new_ms() -> list:
    """
    現在のms_url_list.jsonと比較して新しいMSを検出する
    Returns: 新規MSエントリのリスト
    """
    print("サイドバーページを取得中...")
    url = f"{ATWIKI_BASE}/pages/{SIDEBAR_PAGE_ID}.html"
    html = fetch_page(url)
    if not html:
        print("ERROR: サイドバーページの取得に失敗しました")
        return []

    latest_list = extract_ms_from_sidebar(html)
    print(f"  Wikiに登録: {len(latest_list)}体")

    current_list = load_url_list()
    current_ids  = {ms['pageId'] for ms in current_list}
    print(f"  ローカル登録: {len(current_list)}体")

    new_ms = [ms for ms in latest_list if ms['pageId'] not in current_ids]
    print(f"  新規検出: {len(new_ms)}体")
    for ms in new_ms:
        print(f"    + {ms['name']} (LV{ms['minCost']}, {ms['category']}, pageId={ms['pageId']})")

    return new_ms


def download_ms_pages(ms_list: list, force: bool = False, delay: float = 2.5) -> list:
    """
    指定MSページをダウンロードしてキャッシュに保存する
    Returns: 成功したMSのリスト
    """
    os.makedirs(CACHE_DIR, exist_ok=True)
    existing = {f.replace('.html', '') for f in os.listdir(CACHE_DIR) if f.endswith('.html')}
    targets = ms_list if force else [ms for ms in ms_list if str(ms['pageId']) not in existing]

    if not targets:
        print("ダウンロード対象なし (全て既存キャッシュ)")
        return []  # 空リストを返すが失敗ではない

    print(f"ダウンロード: {len(targets)}体 (間隔: {delay}秒)")
    success = []

    for i, ms in enumerate(targets, 1):
        if i > 1:
            time.sleep(delay)
        sys.stdout.write(f"\r  [{i}/{len(targets)}] {ms['name']:<30s}")
        sys.stdout.flush()

        html = fetch_page(ms['url'])
        if html:
            save_cached_page(ms['pageId'], html)
            success.append(ms)
        else:
            print(f"\n  失敗: {ms['name']}")

    print(f"\n  完了: 成功={len(success)}/{len(targets)}")
    return success


def run_parse_all_ms() -> bool:
    """parse_all_ms.py を実行してms_data.jsonを再生成"""
    parse_script = os.path.join(SCRIPT_DIR, 'parse_all_ms.py')
    if not os.path.exists(parse_script):
        print("ERROR: parse_all_ms.py が見つかりません")
        return False

    print("ms_data.json を再生成中...")
    ret = os.system(f'python "{parse_script}"')
    return ret == 0


def mode_check() -> None:
    """新規MS検出のみ (ダウンロードなし)"""
    new_ms = detect_new_ms()
    if new_ms:
        print(f"\n{len(new_ms)}体の新規MSが見つかりました。")
        print("ダウンロードするには: python tools/update.py --mode weekly")
    else:
        print("\n新規MSはありません。")


def mode_weekly() -> None:
    """新規MS検出→ダウンロード→パース"""
    new_ms = detect_new_ms()
    if not new_ms:
        print("新規MSなし。終了します。")
        return

    print(f"\n{len(new_ms)}体の新規MSをダウンロードします...")
    success = download_ms_pages(new_ms)
    if success is None:
        print("ダウンロード失敗。終了します。")
        return

    # ms_url_list.json を更新
    current_list = load_url_list()
    current_ids  = {ms['pageId'] for ms in current_list}
    added = [ms for ms in new_ms if ms['pageId'] not in current_ids]
    updated = current_list + added
    save_url_list(updated)
    print(f"ms_url_list.json を更新: {len(added)}体追加 (合計{len(updated)}体)")

    # パース実行
    if run_parse_all_ms():
        print("ms_data.json の更新完了")
    else:
        print("WARNING: パース失敗。手動で parse_all_ms.py を実行してください。")


def mode_monthly() -> None:
    """全MS再ダウンロード→パース (月末調整対応)"""
    current_list = load_url_list()
    if not current_list:
        print("ERROR: ms_url_list.json が空です。先に extract_ms_urls.py を実行してください。")
        return

    # まず新規MSも追加
    new_ms = detect_new_ms()
    if new_ms:
        current_ids = {ms['pageId'] for ms in current_list}
        added = [ms for ms in new_ms if ms['pageId'] not in current_ids]
        current_list = current_list + added
        save_url_list(current_list)
        print(f"  新規{len(added)}体を追加")

    print(f"\n全{len(current_list)}体を再ダウンロードします (force=True)...")
    # CI環境（GitHub Actions等）では自動続行、ローカルでは確認
    if not os.environ.get('CI'):
        confirm = input("続行しますか? [y/N]: ").strip().lower()
        if confirm != 'y':
            print("中断しました。")
            return

    success = download_ms_pages(current_list, force=True)
    print(f"ダウンロード完了: {len(success)}/{len(current_list)}")

    if run_parse_all_ms():
        print("ms_data.json の月次更新完了")
    else:
        print("WARNING: パース失敗。手動で parse_all_ms.py を実行してください。")


def main():
    parser = argparse.ArgumentParser(description='GBO2シミュレーター データ更新ツール')
    parser.add_argument(
        '--mode',
        choices=['check', 'weekly', 'monthly'],
        default='check',
        help='check=新着確認のみ / weekly=新着取得追加 / monthly=全MS再取得'
    )
    args = parser.parse_args()

    print(f"=== GBO2 更新ツール [{args.mode}モード] ===")
    print(f"実行日時: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"取得方式: {'curl_cffi (Cloudflare通過)' if _USE_CURL_CFFI else 'urllib (フォールバック)'}\n")

    if args.mode == 'check':
        mode_check()
    elif args.mode == 'weekly':
        mode_weekly()
    elif args.mode == 'monthly':
        mode_monthly()


if __name__ == '__main__':
    main()
