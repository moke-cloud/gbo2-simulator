"""
バトオペ2 atwiki 一括ダウンロードツール
ブラウザのCookieを利用してCloudflareを通過し、MSページを一括ダウンロードする

使い方:
1. ブラウザでatwikiのページを1つ開いてCAPTCHAを解除する
2. ブラウザの開発者ツール(F12) > Network > 任意のリクエスト > Headers から
   Cookie ヘッダーの値をコピーする
3. このスクリプトを実行し、Cookie値を入力する
   または環境変数 ATWIKI_COOKIE に設定する

python batch_download_ms.py
"""
import json
import os
import sys
import time
import re
import urllib.request
import urllib.error
from datetime import datetime


def download_page(url, cookie, output_dir, delay=2.0):
    """1ページをダウンロード"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
        'Cookie': cookie,
        'Referer': 'https://w.atwiki.jp/battle-operation2/',
    }
    
    req = urllib.request.Request(url, headers=headers)
    
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            html = response.read().decode('utf-8')
            
            # ページIDをファイル名にする
            page_match = re.search(r'/pages/(\d+)\.html', url)
            if page_match:
                page_id = page_match.group(1)
                output_path = os.path.join(output_dir, f"{page_id}.html")
                with open(output_path, 'w', encoding='utf-8') as f:
                    f.write(html)
                return True
    except urllib.error.HTTPError as e:
        if e.code == 403:
            print(f"  ✗ 403 Forbidden - Cookieが無効です")
        elif e.code == 429:
            print(f"  ✗ 429 Too Many Requests - レート制限。待機時間を延長します")
            time.sleep(30)
        else:
            print(f"  ✗ HTTP {e.code}")
        return False
    except Exception as e:
        print(f"  ✗ {e}")
        return False
    
    return False


def main():
    # MS URL一覧を読み込み
    data_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data')
    url_list_path = os.path.join(data_dir, 'ms_url_list.json')
    
    if not os.path.exists(url_list_path):
        print("ERROR: ms_url_list.json が見つかりません。先に extract_ms_urls.py を実行してください")
        sys.exit(1)
    
    with open(url_list_path, 'r', encoding='utf-8') as f:
        url_data = json.load(f)
    
    ms_list = url_data['msList']
    print(f"ダウンロード対象: {len(ms_list)}体のMS")
    
    # 出力ディレクトリ
    output_dir = os.path.join(data_dir, 'ms_html_cache')
    os.makedirs(output_dir, exist_ok=True)
    
    # 既にダウンロード済みのファイルをチェック
    existing = set()
    for f in os.listdir(output_dir):
        if f.endswith('.html'):
            existing.add(f.replace('.html', ''))
    
    remaining = [ms for ms in ms_list if str(ms['pageId']) not in existing]
    print(f"未ダウンロード: {len(remaining)}体 (既存: {len(existing)}体)")
    
    if not remaining:
        print("全てのMSが既にダウンロード済みです")
        return
    
    # Cookie取得
    cookie = os.environ.get('ATWIKI_COOKIE', '')
    if not cookie:
        print("\n--- Cookieの取得方法 ---")
        print("1. ブラウザで https://w.atwiki.jp/battle-operation2/ を開く")
        print("2. F12キー > Network タブ > 任意のリクエストをクリック")
        print("3. Request Headers の Cookie の値をコピー")
        print("4. 以下に貼り付け")
        print("-" * 50)
        cookie = input("Cookie: ").strip()
    
    if not cookie:
        print("ERROR: Cookieが指定されていません")
        sys.exit(1)
    
    # テストダウンロード（最初の1ページ）
    print("\nテストダウンロード...")
    test_ms = remaining[0]
    success = download_page(test_ms['url'], cookie, output_dir, delay=0)
    
    if not success:
        print("テストダウンロード失敗。Cookieを確認してください。")
        sys.exit(1)
    
    print(f"  ✓ {test_ms['name']} - 成功!")
    
    # 残りをダウンロード
    delay = 2.5  # サーバー負荷軽減のため2.5秒間隔
    total = len(remaining)
    success_count = 1  # テスト分
    fail_count = 0
    
    print(f"\n残り {total - 1}ページをダウンロードします (間隔: {delay}秒)")
    print(f"予想所要時間: 約{int((total - 1) * delay / 60)}分")
    print("-" * 50)
    
    for i, ms in enumerate(remaining[1:], start=2):
        time.sleep(delay)
        
        sys.stdout.write(f"\r[{i}/{total}] {ms['name']:<30s}")
        sys.stdout.flush()
        
        if download_page(ms['url'], cookie, output_dir, delay):
            success_count += 1
        else:
            fail_count += 1
            if fail_count > 5:
                print(f"\n連続失敗が多いため中断します。後で再実行してください。")
                break
    
    print(f"\n\n完了: 成功={success_count}, 失敗={fail_count}")
    print(f"HTML保存先: {output_dir}")
    
    # ダウンロード後にパースも実行するか確認
    if success_count > 0:
        print(f"\n次のステップ: parse_all_ms.py を実行して全MSデータをJSONに変換してください")


if __name__ == '__main__':
    main()
