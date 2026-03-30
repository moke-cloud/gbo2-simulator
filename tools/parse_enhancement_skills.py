"""
バトオペ2 拡張スキル HTMLパーサー
保存済みHTMLから拡張スキル一覧データをJSON形式で抽出する
"""
import json
import re
import os
import sys
from bs4 import BeautifulSoup


def parse_enhancement_skills(html_path):
    """拡張スキル一覧HTMLを解析してデータを抽出"""
    with open(html_path, 'rb') as f:
        soup = BeautifulSoup(f.read().decode('utf-8'), 'html.parser')
    
    wikibody = soup.find('div', id='wikibody')
    if not wikibody:
        print("ERROR: wikibody not found")
        return []
    
    skills_list = []
    tables = wikibody.find_all('table')
    
    for table in tables:
        rows = table.find_all('tr')
        if len(rows) < 3:
            continue
        
        # ヘッダー確認
        headers = rows[0].find_all(['th', 'td'])
        header_text = ' '.join(h.get_text(strip=True) for h in headers)
        if '名称' not in header_text or '効果' not in header_text:
            continue
        
        current_category = None
        current_skill_name = None
        
        for row in rows[1:]:
            cells = row.find_all(['th', 'td'])
            if not cells:
                continue
            
            # カテゴリヘッダー行（colspan=4のth）
            first_cell = cells[0]
            if first_cell.name == 'th' and first_cell.get('colspan'):
                colspan = int(first_cell.get('colspan', 1))
                if colspan >= 4:
                    cat_text = first_cell.get_text(strip=True)
                    if '攻撃' in cat_text:
                        current_category = 'attack'
                    elif '防御' in cat_text:
                        current_category = 'defense'
                    elif '移動' in cat_text:
                        current_category = 'mobility'
                    elif 'カスタムパーツ' in cat_text:
                        current_category = 'custom_parts'
                    elif '複合' in cat_text:
                        current_category = 'composite'
                    continue
            
            # スキル名（rowspan付きth）
            offset = 0
            if first_cell.name == 'th' and first_cell.get('rowspan'):
                current_skill_name = first_cell.get_text(strip=True)
                offset = 1
            elif first_cell.name == 'th' and not first_cell.get('colspan'):
                current_skill_name = first_cell.get_text(strip=True)
                offset = 1
            
            if not current_skill_name:
                continue
            
            data_cells = cells[offset:]
            if len(data_cells) < 2:
                continue
            
            # LV
            lv_text = data_cells[0].get_text(strip=True)
            lv_match = re.search(r'[Ll][Vv](\d+)', lv_text)
            if not lv_match:
                continue
            level = int(lv_match.group(1))
            
            # 効果テキスト
            effect_text = data_cells[1].get_text(strip=True)
            
            # 備考
            remarks = data_cells[2].get_text(strip=True) if len(data_cells) > 2 else ''
            
            # 効果を構造化データに変換
            effects = parse_enhancement_effect(current_skill_name, effect_text)
            
            skill = {
                "name": current_skill_name,
                "level": level,
                "category": current_category,
                "description": effect_text,
                "effects": effects,
                "remarks": remarks
            }
            
            skills_list.append(skill)
    
    return skills_list


def parse_enhancement_effect(skill_name, text):
    """拡張スキルの効果テキストを構造化データに変換"""
    effects = []

    # per_custom_part 記述より前のテキストのみを直接効果パースに使用
    per_part_marker = 'カスタムパーツを1つ装備するごとに'
    if per_part_marker in text:
        direct_text = text[:text.index(per_part_marker)]
    else:
        direct_text = text

    # 直接的なステータス増加 (耐格闘補正を格闘補正と混同しないよう負後読みを使用)
    patterns = [
        (r'射撃補正が(\d+)増加', 'shooting_correction'),
        (r'(?<!耐)格闘補正が(\d+)増加', 'melee_correction'),
        (r'耐実弾補正が(\d+)増加', 'ballistic_armor'),
        (r'耐ビーム補正が(\d+)増加', 'beam_armor'),
        (r'耐格闘補正が(\d+)増加', 'melee_armor'),
        (r'スラスターが(\d+)増加', 'thruster'),
        (r'高速移動(?:速)?が(\d+)増加', 'boost_speed'),
    ]

    for pattern, effect_type in patterns:
        m = re.search(pattern, direct_text)
        if m:
            effects.append({
                "type": effect_type,
                "value": int(m.group(1)),
                "direct": True
            })

    # 上限値増加 (耐格闘補正の上限値を格闘補正の上限値と混同しないよう負後読みを使用)
    cap_patterns = [
        (r'射撃補正の上限値が(\d+)増加', 'shooting_correction_cap'),
        (r'(?<!耐)格闘補正の上限値が(\d+)増加', 'melee_correction_cap'),
        (r'耐実弾補正の上限値が(\d+)増加', 'ballistic_armor_cap'),
        (r'耐ビーム補正の上限値が(\d+)増加', 'beam_armor_cap'),
        (r'耐格闘補正の上限値が(\d+)増加', 'melee_armor_cap'),
        (r'スラスターの上限値が(\d+)増加', 'thruster_cap'),
        (r'高速移動の上限値が(\d+)増加', 'boost_speed_cap'),
    ]

    for pattern, effect_type in cap_patterns:
        m = re.search(pattern, direct_text)
        if m:
            effects.append({
                "type": effect_type,
                "value": int(m.group(1)),
                "direct": True
            })
    
    # カスタムパーツ連動型（パーツ個数に応じて効果発生）
    if 'カスタムパーツを1つ装備するごとに' in text:
        # 対象パーツタイプを特定
        target_types = []
        type_match = re.search(r'「(.+?)」(?:「(.+?)」)?(?:「(.+?)」)?タイプのカスタムパーツ', text)
        if type_match:
            type_map = {
                '攻撃': 'attack', '防御': 'defense', '移動': 'mobility',
                '補助': 'support', '特殊': 'special'
            }
            for g in type_match.groups():
                if g and g in type_map:
                    target_types.append(type_map[g])
        
        per_part_effects = []
        
        # HP増加
        hp_m = re.search(r'機体HPが(\d+)増加', text)
        if hp_m:
            per_part_effects.append({"type": "hp", "value": int(hp_m.group(1))})
        
        # シールドHP
        shield_m = re.search(r'シールドHPが(\d+)増加', text)
        if shield_m:
            per_part_effects.append({"type": "shield_hp", "value": int(shield_m.group(1))})
        
        # 格闘補正 (耐格闘補正を誤検出しないよう負後読み使用)
        melee_m = re.search(r'(?<!耐)格闘補正が(\d+)', text)
        if melee_m:
            per_part_effects.append({"type": "melee_correction", "value": int(melee_m.group(1))})
        
        # 射撃補正
        shoot_m = re.search(r'射撃補正が(\d+)', text)
        if shoot_m:
            per_part_effects.append({"type": "shooting_correction", "value": int(shoot_m.group(1))})
        
        # 耐実弾/ビーム/格闘
        for label, etype in [('耐実弾補正が', 'ballistic_armor'), ('耐ビーム補正が', 'beam_armor'), ('耐格闘補正が', 'melee_armor')]:
            m = re.search(label + r'(\d+)', text)
            if m:
                per_part_effects.append({"type": etype, "value": int(m.group(1))})
        
        # スラスター
        sla_m = re.search(r'スラスターが(\d+)(?:増加)?', text)
        if sla_m:
            per_part_effects.append({"type": "thruster", "value": int(sla_m.group(1))})
        
        # 高速移動
        boost_m = re.search(r'高速移動(?:速)?が(\d+)', text)
        if boost_m:
            per_part_effects.append({"type": "boost_speed", "value": int(boost_m.group(1))})
        
        # リロードOH短縮
        reload_m = re.search(r'(?:リロード|オーバーヒート).*?(\d+)[%％]短縮', text)
        if reload_m:
            per_part_effects.append({"type": "reload_oh_reduction_pct", "value": int(reload_m.group(1))})
        
        if per_part_effects:
            effects.append({
                "type": "per_custom_part",
                "targetPartTypes": target_types,
                "perPartEffects": per_part_effects
            })
    
    # リペアツール回復量
    repair_m = re.search(r'リペアツールのHP回復量が(\d+)[%％]', text)
    if repair_m:
        effects.append({
            "type": "repair_tool_pct",
            "value": int(repair_m.group(1)),
            "direct": True
        })
    
    # 複合拡張の直接補正値（MS戦複合拡張）
    if '格闘補正と上限値が' in text:
        combined_patterns = [
            (r'格闘補正と上限値が(\d+)', 'melee_correction', 'melee_correction_cap'),
            (r'射撃補正と上限値が(\d+)', 'shooting_correction', 'shooting_correction_cap'),
            (r'耐実弾補正と上限値が(\d+)', 'ballistic_armor', 'ballistic_armor_cap'),
            (r'耐ビーム補正と上限値が(\d+)', 'beam_armor', 'beam_armor_cap'),
            (r'耐格闘補正と上限値が(\d+)', 'melee_armor', 'melee_armor_cap'),
        ]
        for pattern, stat_type, cap_type in combined_patterns:
            m = re.search(pattern, text)
            if m:
                val = int(m.group(1))
                effects.append({"type": stat_type, "value": val, "direct": True})
                effects.append({"type": cap_type, "value": val, "direct": True})
    
    return effects


def main():
    html_dir = r"E:\SHIGOTOBA\.antigravity"
    html_files = [f for f in os.listdir(html_dir) if '拡張スキル' in f and f.endswith('.html')]
    
    if not html_files:
        print("ERROR: 拡張スキルのHTMLファイルが見つかりません")
        sys.exit(1)
    
    html_path = os.path.join(html_dir, html_files[0])
    print(f"解析対象: {html_files[0]}")
    
    skills = parse_enhancement_skills(html_path)
    
    output_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'enhancement_skills.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump({
            "version": "2026-03-29",
            "totalSkills": len(skills),
            "skills": skills
        }, f, ensure_ascii=False, indent=2)
    
    print(f"完了: {len(skills)}件の拡張スキルを抽出")
    print(f"出力先: {output_path}")
    
    # カテゴリ別サマリー
    categories = {}
    for s in skills:
        cat = s.get('category', '不明')
        categories[cat] = categories.get(cat, 0) + 1
    print("\n--- カテゴリ別件数 ---")
    for cat, count in categories.items():
        print(f"  {cat}: {count}件")
    
    # サンプル出力
    print("\n--- サンプル ---")
    for s in skills[:3]:
        print(f"  {s['name']} LV{s['level']}: {s['description'][:50]}...")


if __name__ == '__main__':
    main()
