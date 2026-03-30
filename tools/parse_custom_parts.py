"""
バトオペ2 カスタムパーツ HTMLパーサー
atwikiの保存済みHTMLからカスタムパーツデータをJSON形式で抽出する
"""
import json
import re
import sys
import os
from bs4 import BeautifulSoup

def parse_rarity(text):
    """☆の数をカウントしてレアリティ数値に変換"""
    return text.count('☆')

def parse_slot_value(text):
    """スロット値をintに変換"""
    text = text.strip()
    if text == '' or text == '-':
        return 0
    try:
        return int(text)
    except ValueError:
        return 0

def parse_effect_text(desc):
    """説明テキストからエフェクトを抽出"""
    effects = []
    
    # 射撃補正増加
    m = re.search(r'射撃補正が(\d+)増加', desc)
    if m:
        effects.append({"type": "shooting_correction", "value": int(m.group(1))})
    
    # 格闘補正増加
    m = re.search(r'格闘補正が(\d+)増加', desc)
    if m:
        effects.append({"type": "melee_correction", "value": int(m.group(1))})
    
    # HP増加
    m = re.search(r'(?:機体HP|HP)(?:が|を)(\d+)増加', desc)
    if m:
        effects.append({"type": "hp", "value": int(m.group(1))})
    
    # HP減少
    m = re.search(r'(?:機体HP|HP)(?:が|を)(\d+)減少', desc)
    if m:
        effects.append({"type": "hp", "value": -int(m.group(1))})
    
    # 耐実弾補正
    m = re.search(r'耐実弾補正が(\d+)増加', desc)
    if m:
        effects.append({"type": "ballistic_armor", "value": int(m.group(1))})
    
    # 耐ビーム補正
    m = re.search(r'耐ビーム補正が(\d+)増加', desc)
    if m:
        effects.append({"type": "beam_armor", "value": int(m.group(1))})
    
    # 耐格闘補正  
    m = re.search(r'耐格闘補正が(\d+)増加', desc)
    if m:
        effects.append({"type": "melee_armor", "value": int(m.group(1))})
    
    # スピード増加
    m = re.search(r'スピードが(\d+)増加', desc)
    if m:
        effects.append({"type": "speed", "value": int(m.group(1))})
    
    # スラスター増加
    m = re.search(r'スラスターが(\d+)増加', desc)
    if m:
        effects.append({"type": "thruster", "value": int(m.group(1))})
    
    # 旋回増加
    m = re.search(r'旋回(?:性能)?が(\d+)増加', desc)
    if m:
        effects.append({"type": "turn_speed", "value": int(m.group(1))})
    
    # 高速移動増加
    m = re.search(r'高速移動が(\d+)増加', desc)
    if m:
        effects.append({"type": "boost_speed", "value": int(m.group(1))})

    # 射撃ダメージ%増加
    m = re.search(r'射撃攻撃による敵に与えるダメージが(\d+)[％%]増加', desc)
    if m:
        effects.append({"type": "shooting_damage_pct", "value": int(m.group(1))})
    
    # 格闘ダメージ%増加
    m = re.search(r'格闘攻撃による敵に与えるダメージが(\d+)[％%]増加', desc)
    if m:
        effects.append({"type": "melee_damage_pct", "value": int(m.group(1))})

    # 射撃ダメージ%減少
    m = re.search(r'射撃攻撃による敵に与えるダメージが(\d+)[％%]減少', desc)
    if m:
        effects.append({"type": "shooting_damage_pct", "value": -int(m.group(1))})
    
    # 格闘ダメージ%減少
    m = re.search(r'格闘攻撃による敵に与えるダメージが(\d+)[％%]減少', desc)
    if m:
        effects.append({"type": "melee_damage_pct", "value": -int(m.group(1))})

    # 頭部特殊装甲/脚部特殊装甲/背部特殊装甲
    m = re.search(r'(頭部|脚部|背部)(?:の)?HPが(\d+)増加', desc)
    if m:
        part_map = {"頭部": "head", "脚部": "legs", "背部": "back"}
        effects.append({"type": f"{part_map[m.group(1)]}_hp", "value": int(m.group(2))})
    
    # シールドHP増加
    m = re.search(r'シールド(?:の)?HPが(\d+)増加', desc)
    if m:
        effects.append({"type": "shield_hp", "value": int(m.group(1))})

    # 強制冷却（OH復帰時間短縮）
    m = re.search(r'オーバーヒートから(?:の)?復帰(?:する)?時間(?:が|を)(\d+)[％%]短縮', desc)
    if m:
        effects.append({"type": "oh_recovery_pct", "value": int(m.group(1))})

    return effects

def parse_custom_parts_html(html_path):
    """カスタムパーツHTMLを解析してデータを抽出"""
    with open(html_path, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f, 'html.parser')
    
    # wikibody内のコンテンツを取得
    wikibody = soup.find('div', id='wikibody')
    if not wikibody:
        print("ERROR: wikibody not found")
        return []
    
    # カテゴリ名のマッピング
    category_names = {
        '攻撃系': 'attack',
        '防御系': 'defense',
        '移動系': 'mobility',
        '補助系': 'support',
        '特殊系': 'special'
    }
    
    parts_list = []
    current_category = None
    
    # h3タグでカテゴリを検出し、直後のtableからデータを抽出
    for element in wikibody.find_all(['h3', 'table']):
        if element.name == 'h3':
            text = element.get_text(strip=True)
            for jp_name, en_name in category_names.items():
                if jp_name in text:
                    current_category = en_name
                    break
        
        elif element.name == 'table' and current_category:
            rows = element.find_all('tr')
            if len(rows) < 3:
                continue
            
            # ヘッダー確認
            headers = rows[0].find_all(['th', 'td'])
            header_text = ' '.join(h.get_text(strip=True) for h in headers)
            if '名称' not in header_text and 'LV' not in header_text:
                continue
            
            current_name = None
            
            for row in rows[2:]:  # ヘッダー2行を飛ばす
                cells = row.find_all(['th', 'td'])
                if not cells:
                    continue
                
                # 名称セル（th でrowspan持ち or 最初のth）
                first_cell = cells[0]
                offset = 0
                
                if first_cell.name == 'th':
                    # 新しいパーツ名
                    a_tag = first_cell.find('a')
                    if a_tag:
                        current_name = a_tag.get_text(strip=True)
                    else:
                        current_name = first_cell.get_text(strip=True)
                    offset = 1
                else:
                    # rowspanにより名称セルが省略されている
                    offset = 0
                
                if not current_name:
                    continue
                
                # 残りのセルを取得
                data_cells = cells[offset:]
                if len(data_cells) < 7:
                    continue
                
                try:
                    lv_text = data_cells[0].get_text(strip=True)
                    lv_match = re.search(r'(\d+)', lv_text)
                    level = int(lv_match.group(1)) if lv_match else 1
                    
                    rarity = parse_rarity(data_cells[1].get_text(strip=True))
                    
                    slot_close = parse_slot_value(data_cells[2].get_text(strip=True))
                    slot_mid = parse_slot_value(data_cells[3].get_text(strip=True))
                    slot_long = parse_slot_value(data_cells[4].get_text(strip=True))
                    
                    description = data_cells[5].get_text(strip=True)
                    # brタグを改行に変換
                    for br in data_cells[5].find_all('br'):
                        br.replace_with('\n')
                    description = data_cells[5].get_text(strip=True)
                    
                    ticket_text = data_cells[6].get_text(strip=True)
                    ticket_cost = int(ticket_text) if ticket_text.isdigit() else 0
                    
                    dp_text = data_cells[7].get_text(strip=True) if len(data_cells) > 7 else ''
                    dp_match = re.search(r'(\d+)', dp_text.replace(',', ''))
                    dp_cost = int(dp_match.group(1)) if dp_match else 0
                    
                    effects = parse_effect_text(description)
                    
                    part = {
                        "name": current_name,
                        "level": level,
                        "rarity": rarity,
                        "category": current_category,
                        "slots": {
                            "close": slot_close,
                            "mid": slot_mid,
                            "long": slot_long
                        },
                        "description": description,
                        "effects": effects,
                        "dpCost": dp_cost,
                        "ticketCost": ticket_cost
                    }
                    
                    parts_list.append(part)
                    
                except (IndexError, ValueError) as e:
                    print(f"  WARN: パース失敗 ({current_name} {lv_text if 'lv_text' in dir() else '?'}): {e}")
                    continue
    
    return parts_list


def main():
    # HTMLファイルのパス
    html_dir = r"E:\SHIGOTOBA\.antigravity"
    html_files = [f for f in os.listdir(html_dir) if 'カスタムパーツ' in f and f.endswith('.html')]
    
    if not html_files:
        print("ERROR: カスタムパーツのHTMLファイルが見つかりません")
        sys.exit(1)
    
    html_path = os.path.join(html_dir, html_files[0])
    print(f"解析対象: {html_files[0]}")
    
    parts = parse_custom_parts_html(html_path)
    
    # 出力
    output_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'custom_parts.json')
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump({
            "version": "2026-03-27",
            "totalParts": len(parts),
            "parts": parts
        }, f, ensure_ascii=False, indent=2)
    
    print(f"完了: {len(parts)}件のカスタムパーツを抽出")
    print(f"出力先: {output_path}")
    
    # カテゴリ別サマリー
    categories = {}
    for p in parts:
        cat = p['category']
        categories[cat] = categories.get(cat, 0) + 1
    
    print("\n--- カテゴリ別件数 ---")
    for cat, count in categories.items():
        print(f"  {cat}: {count}件")


if __name__ == '__main__':
    main()
