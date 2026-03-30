"""
バトオペ2 MS URL抽出ツール
保存済みHTMLのサイドバーからMS一覧のURLとページID/機体名を抽出する
"""
import json
import re
import os
import sys
from bs4 import BeautifulSoup


def extract_ms_urls(html_path):
    """サイドバーからMSのURL一覧を抽出"""
    with open(html_path, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f, 'html.parser')
    
    menubar = soup.find('div', id='menubar')
    if not menubar:
        print("ERROR: menubar not found")
        return []
    
    ms_data = []
    current_category = None
    current_cost = None
    
    # 強襲/汎用/支援のメニューを探す
    category_map = {
        'menu_kyoushu': '強襲',
        'menu_hanyou': '汎用',
        'menu_sien': '支援'
    }
    
    for div_id, category_name in category_map.items():
        div = menubar.find('div', id=div_id)
        if not div:
            print(f"  WARN: {div_id} not found")
            continue
        
        current_category = category_name
        current_cost = None
        
        for element in div.find_all(['h4', 'a']):
            if element.name == 'h4':
                cost_text = element.get_text(strip=True)
                cost_match = re.search(r'(\d+)', cost_text)
                if cost_match:
                    current_cost = int(cost_match.group(1))
            
            elif element.name == 'a':
                href = element.get('href', '')
                title = element.get('title', '')
                name = element.get_text(strip=True)
                
                # ページのURLパターンに一致するもののみ
                page_match = re.search(r'/pages/(\d+)\.html', href)
                if page_match and current_cost is not None:
                    page_id = int(page_match.group(1))
                    
                    # 一覧ページやログページを除外
                    if '一覧' in name or 'ログ' in title:
                        continue
                    
                    ms_data.append({
                        "name": name,
                        "pageId": page_id,
                        "url": f"https://w.atwiki.jp/battle-operation2/pages/{page_id}.html",
                        "category": current_category,
                        "minCost": current_cost
                    })
    
    return ms_data


def main():
    html_dir = r"E:\SHIGOTOBA\.antigravity"
    html_files = [f for f in os.listdir(html_dir) if 'カスタムパーツ' in f and f.endswith('.html')]
    
    if not html_files:
        print("ERROR: HTMLファイルが見つかりません")
        sys.exit(1)
    
    html_path = os.path.join(html_dir, html_files[0])
    print(f"解析対象: {html_files[0]}")
    
    ms_list = extract_ms_urls(html_path)
    
    # 出力
    output_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'ms_url_list.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump({
            "totalMS": len(ms_list),
            "msList": ms_list
        }, f, ensure_ascii=False, indent=2)
    
    print(f"完了: {len(ms_list)}体のMSのURLを抽出")
    print(f"出力先: {output_path}")
    
    # カテゴリ別サマリー
    categories = {}
    for ms in ms_list:
        cat = ms['category']
        categories[cat] = categories.get(cat, 0) + 1
    print("\n--- カテゴリ別件数 ---")
    for cat, count in categories.items():
        print(f"  {cat}: {count}体")
    
    # URL一覧テキストも出力（wget/curl用）
    url_list_path = os.path.join(os.path.dirname(output_path), 'ms_urls.txt')
    with open(url_list_path, 'w', encoding='utf-8') as f:
        for ms in ms_list:
            f.write(f"{ms['url']}\n")
    print(f"\nURL一覧: {url_list_path}")


if __name__ == '__main__':
    main()
