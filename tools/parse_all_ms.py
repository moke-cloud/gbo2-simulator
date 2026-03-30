"""
バトオペ2 全MSデータ一括パース
batch_download_ms.py でダウンロードした HTML を全て解析して ms_data.json に統合する
"""
import json
import os
import sys

# parse_ms_data の関数を再利用
sys.path.insert(0, os.path.dirname(__file__))
from parse_ms_data import parse_ms_page


def main():
    data_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data')
    html_cache_dir = os.path.join(data_dir, 'ms_html_cache')
    
    if not os.path.exists(html_cache_dir):
        print("ERROR: ms_html_cache ディレクトリが見つかりません")
        print("  先に batch_download_ms.py を実行してください")
        sys.exit(1)
    
    html_files = [f for f in os.listdir(html_cache_dir) if f.endswith('.html')]
    print(f"解析対象: {len(html_files)}ファイル")
    
    # URL一覧もロードしてname -> pageId のマッピングを取得
    url_list_path = os.path.join(data_dir, 'ms_url_list.json')
    url_map = {}
    if os.path.exists(url_list_path):
        with open(url_list_path, 'r', encoding='utf-8') as f:
            url_data = json.load(f)
        for ms in url_data['msList']:
            url_map[str(ms['pageId'])] = ms
    
    all_ms = []
    failed = []
    
    for i, html_file in enumerate(sorted(html_files)):
        page_id = html_file.replace('.html', '')
        html_path = os.path.join(html_cache_dir, html_file)
        
        if (i + 1) % 50 == 0:
            print(f"  ... {i + 1}/{len(html_files)}")
        
        try:
            ms_data = parse_ms_page(html_path)
            if ms_data:
                # URL一覧から追加情報を取得
                if page_id in url_map:
                    url_info = url_map[page_id]
                    if not ms_data.get('category'):
                        ms_data['category'] = url_info.get('category')
                
                all_ms.append(ms_data)
            else:
                failed.append(html_file)
        except Exception as e:
            print(f"  ERROR: {html_file}: {e}")
            failed.append(html_file)
    
    # 出力
    output_path = os.path.join(data_dir, 'ms_data.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump({
            "version": "2026-03-29",
            "totalMS": len(all_ms),
            "msList": all_ms
        }, f, ensure_ascii=False, indent=2)
    
    print(f"\n完了: {len(all_ms)}体のMSデータを抽出")
    if failed:
        print(f"失敗: {len(failed)}ファイル")
        for f_name in failed[:10]:
            print(f"  - {f_name}")
    print(f"出力先: {output_path}")
    
    # カテゴリ別サマリー
    categories = {}
    for ms in all_ms:
        cat = ms.get('category', '不明')
        categories[cat] = categories.get(cat, 0) + 1
    print("\n--- カテゴリ別件数 ---")
    for cat, count in sorted(categories.items()):
        print(f"  {cat}: {count}体")


if __name__ == '__main__':
    main()
