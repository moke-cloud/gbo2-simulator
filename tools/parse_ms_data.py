"""
バトオペ2 MSデータ HTMLパーサー
保存済みの各MS個別ページHTMLからステータスデータを抽出してJSONに変換する
"""
import json
import re
import os
import sys
import glob
from bs4 import BeautifulSoup


def parse_ms_page(html_path, ms_url_map=None):
    """個別MS HTMLページを解析してデータを抽出"""
    with open(html_path, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f, 'html.parser')
    
    # ページタイトル取得
    pagetitle = soup.find('h2', id='pagetitle')
    if not pagetitle:
        return None
    
    ms_name = pagetitle.get_text(strip=True).strip()
    
    # wikibody取得
    wikibody = soup.find('div', id='wikibody')
    if not wikibody:
        return None
    
    # 機体属性を判定 (3段構えで抽出)
    category = None
    
    # 1. label_zokusei から探す
    # div IDの末尾（_kyoushu / _hanyou / _sien）で判定する。
    # テキストは「機体属性強襲汎用支援」のように全カテゴリを含むため使用しない。
    for div in wikibody.find_all('div'):
        div_id = div.get('id', '')
        if 'label_zokusei' in div_id:
            if 'kyoushu' in div_id:
                category = '強襲'
            elif 'sien' in div_id:
                category = '支援'
            elif 'hanyou' in div_id:
                category = '汎用'
            break
            
    # 2. メインステータステーブルのIDから探す（確実性が高い）
    if not category:
        for table_id, cat_name in [('table_hanyou', '汎用'), ('table_kyoushu', '強襲'), ('table_sien', '支援')]:
            if wikibody.find('div', id=table_id) or wikibody.find('table', id=table_id):
                category = cat_name
                break
                
    # 3. ページ内の最初のほうのテキストや見出しから探す（fallback）
    if not category:
        intro_text = wikibody.get_text()[:1000] # 上部1000文字程度
        if '【強襲】' in intro_text or '強襲機' in intro_text or '兵科：強襲' in intro_text:
            category = '強襲'
        elif '【支援】' in intro_text or '支援機' in intro_text or '兵科：支援' in intro_text:
            category = '支援'
        elif '【汎用】' in intro_text or '汎用機' in intro_text or '兵科：汎用' in intro_text:
            category = '汎用'
            
    if not category:
        category = '汎用' # 最終的なデフォルト
    
    # 出撃制限
    ground = False
    space = False
    for div in wikibody.find_all('div'):
        div_id = div.get('id', '')
        if 'label_sortie' in div_id:
            text = div.get_text(strip=True)
            ground = '地上' in text
            space = '宇宙' in text
            break
    
    # 環境適正
    env_ground = False
    env_space = False
    for div in wikibody.find_all('div'):
        div_id = div.get('id', '')
        if 'label_env' in div_id:
            text = div.get_text(strip=True)
            env_ground = '地上' in text
            env_space = '宇宙' in text
            break
    
    # メインステータステーブル（table_hanyou / table_kyoushu / table_sien）
    stats_table = None
    for table_id in ['table_hanyou', 'table_kyoushu', 'table_sien']:
        div = wikibody.find('div', id=table_id)
        if div:
            stats_table = div.find('table')
            break
    
    if not stats_table:
        # fallback: h3 "機体" の直後のテーブル
        h3_ms = wikibody.find('h3', id=re.compile(r'id_f2150a0e'))
        if h3_ms:
            stats_table = h3_ms.find_next('table')
    
    if not stats_table:
        return None
    
    # ステータスデータ抽出
    rows = stats_table.find_all('tr')
    if len(rows) < 3:
        return None
    
    # ヘッダーからLV列数を把握
    header_row = rows[0]
    header_cells = header_row.find_all(['th', 'td'])
    levels = []
    for cell in header_cells[1:]:
        text = cell.get_text(strip=True)
        lv_match = re.search(r'LV(\d+)', text)
        if lv_match:
            levels.append(int(lv_match.group(1)))
    
    if not levels:
        return None
    
    # 各行のデータを取得
    stat_rows = {}
    for row in rows[1:]:
        cells = row.find_all(['th', 'td'])
        if not cells:
            continue

        row_header = cells[0]
        if row_header.name == 'th':
            stat_name_raw = row_header.get_text(strip=True)
            # 変形時の行はスキップ（通常時の値を採用）
            if '＜変形時＞' in stat_name_raw:
                continue
            # ＜通常時＞アノテーションを除去
            stat_name = stat_name_raw.replace('＜通常時＞', '').strip()
            # 角括弧アノテーションを除去: [度/秒] など
            stat_name = re.sub(r'\[[^\]]*\]', '', stat_name).strip()
            # 全角括弧アノテーションを除去: （+3）など。ただし（地上）（宇宙）は旋回区別のため保持
            stat_name = re.sub(r'（(?!(?:地上|宇宙)）)[^）]*）', '', stat_name).strip()
            # 半角括弧アノテーションを除去: (+3) など。ただし (地上) (宇宙) は保持
            stat_name = re.sub(r'\((?!(?:地上|宇宙)\))[^)]*\)', '', stat_name).strip()
            
            # 実際のデータセルを取得（colspanを考慮）
            data_values = []
            for cell in cells[1:]:
                colspan = int(cell.get('colspan', 1))
                text = cell.get_text(strip=True)
                # 括弧内のデータを除去してメインの数値を取得
                text = re.sub(r'（.*?）', '', text)
                text = re.sub(r'\(.*?\)', '', text)
                for _ in range(colspan):
                    data_values.append(text)
            
            stat_rows[stat_name] = data_values[:len(levels)]
    
    # LVごとのデータを構築
    level_data = {}
    for i, lv in enumerate(levels):
        data = {}
        
        # Cost
        if 'Cost' in stat_rows and i < len(stat_rows['Cost']):
            v = stat_rows['Cost'][i]
            if v and v.isdigit():
                data['cost'] = int(v)
        
        # 機体HP
        if '機体HP' in stat_rows and i < len(stat_rows['機体HP']):
            v = stat_rows['機体HP'][i]
            v_num = re.sub(r'[^\d]', '', v)
            if v_num:
                data['hp'] = int(v_num)
        
        # 耐実弾補正
        if '耐実弾補正' in stat_rows and i < len(stat_rows['耐実弾補正']):
            v = stat_rows['耐実弾補正'][i]
            v_num = re.sub(r'[^\d]', '', v)
            if v_num:
                data['ballistic_armor'] = int(v_num)
        
        # 耐ビーム補正
        if '耐ビーム補正' in stat_rows and i < len(stat_rows['耐ビーム補正']):
            v = stat_rows['耐ビーム補正'][i]
            v_num = re.sub(r'[^\d]', '', v)
            if v_num:
                data['beam_armor'] = int(v_num)
        
        # 耐格闘補正
        if '耐格闘補正' in stat_rows and i < len(stat_rows['耐格闘補正']):
            v = stat_rows['耐格闘補正'][i]
            v_num = re.sub(r'[^\d]', '', v)
            if v_num:
                data['melee_armor'] = int(v_num)
        
        # 射撃補正
        if '射撃補正' in stat_rows and i < len(stat_rows['射撃補正']):
            v = stat_rows['射撃補正'][i]
            v_num = re.sub(r'[^\d]', '', v)
            if v_num:
                data['shooting_correction'] = int(v_num)
        
        # 格闘補正
        if '格闘補正' in stat_rows and i < len(stat_rows['格闘補正']):
            v = stat_rows['格闘補正'][i]
            v_num = re.sub(r'[^\d]', '', v)
            if v_num:
                data['melee_correction'] = int(v_num)
        
        # スピード
        if 'スピード' in stat_rows and i < len(stat_rows['スピード']):
            v = stat_rows['スピード'][i]
            v_num = re.sub(r'[^\d]', '', v)
            if v_num:
                data['speed'] = int(v_num)
        
        # 高速移動
        if '高速移動' in stat_rows and i < len(stat_rows['高速移動']):
            v = stat_rows['高速移動'][i]
            v_num = re.sub(r'[^\d]', '', v)
            if v_num:
                data['boost_speed'] = int(v_num)
        
        # スラスター
        if 'スラスター' in stat_rows and i < len(stat_rows['スラスター']):
            v = stat_rows['スラスター'][i]
            v_num = re.sub(r'[^\d]', '', v)
            if v_num:
                data['thruster'] = int(v_num)
        
        # 旋回（地上）
        for key in stat_rows:
            if '旋回' in key and '地上' in key:
                if i < len(stat_rows[key]):
                    v = stat_rows[key][i]
                    v_num = re.sub(r'[^\d.]', '', v.split('\n')[0])
                    if v_num:
                        data['turn_speed_ground'] = float(v_num)
                break
        
        # 旋回（宇宙）
        for key in stat_rows:
            if '旋回' in key and '宇宙' in key:
                if i < len(stat_rows[key]):
                    v = stat_rows[key][i]
                    v_num = re.sub(r'[^\d.]', '', v.split('\n')[0])
                    if v_num:
                        data['turn_speed_space'] = float(v_num)
                break
        
        if data.get('cost') or data.get('hp'):
            level_data[str(lv)] = data
    
    # パーツスロットテーブル
    slots_data = {}
    h3_slots = wikibody.find('h3', string=re.compile(r'パーツスロット'))
    if not h3_slots:
        for h3 in wikibody.find_all('h3'):
            if 'パーツスロット' in h3.get_text():
                h3_slots = h3
                break
    
    if h3_slots:
        slots_table = h3_slots.find_next('table')
        if slots_table:
            slot_rows = slots_table.find_all('tr')
            # ヘッダー行からLV番号リストを取得（LV2始まりの機体に対応）
            slot_levels = []
            if slot_rows:
                header_cells = slot_rows[0].find_all(['th', 'td'])
                for cell in header_cells[1:]:
                    colspan = int(cell.get('colspan', 1))
                    lv_match = re.search(r'LV?(\d+)', cell.get_text(strip=True), re.IGNORECASE)
                    lv = int(lv_match.group(1)) if lv_match else None
                    for _ in range(colspan):
                        slot_levels.append(lv)

            for row in slot_rows[1:]:
                cells = row.find_all(['th', 'td'])
                if len(cells) < 2:
                    continue

                slot_type = cells[0].get_text(strip=True)
                slot_type_en = None
                if '近距離' in slot_type:
                    slot_type_en = 'close'
                elif '中距離' in slot_type:
                    slot_type_en = 'mid'
                elif '遠距離' in slot_type:
                    slot_type_en = 'long'

                if slot_type_en:
                    slot_values = {}
                    col_idx = 0
                    for cell in cells[1:]:
                        colspan = int(cell.get('colspan', 1))
                        v = cell.get_text(strip=True)
                        v_num = re.sub(r'[^\d]', '', v)
                        for _ in range(colspan):
                            lv = slot_levels[col_idx] if col_idx < len(slot_levels) else None
                            if v_num and lv is not None:
                                slot_values[str(lv)] = int(v_num)
                            col_idx += 1

                    slots_data[slot_type_en] = slot_values
    
    # スキル情報
    skills = []
    h3_skills = None
    for h3 in wikibody.find_all(['h2', 'h3']):
        if 'スキル情報' in h3.get_text():
            h3_skills = h3
            break
    
    if h3_skills:
        skills_table = h3_skills.find_next('table')
        if skills_table:
            for row in skills_table.find_all('tr')[1:]:
                cells = row.find_all(['th', 'td'])
                if not cells:
                    continue
                first = cells[0]
                # カテゴリ見出し行（th1つのみ: 「足回り」「攻撃」「防御」等）をスキップ
                # ヘッダー行・LV継続行（先頭がtdまたはセル数<4）をスキップ
                if first.name != 'th' or len(cells) < 4:
                    continue
                a_tag = first.find('a')
                skill_name = a_tag.get_text(strip=True) if a_tag else first.get_text(strip=True)
                if not skill_name or skill_name in ['スキル名', '効果', '説明']:
                    continue
                # cells: [スキル名, レベル, 機体LV, 基本効果, (数値効果)]
                # cells[4]が存在する場合、よろけ値%・被ダメ減等の数値効果が含まれる
                level_text = cells[1].get_text(strip=True)
                base_effect = cells[3].get_text(strip=True) if len(cells) > 3 else ''
                num_effect  = cells[4].get_text(strip=True) if len(cells) > 4 else ''
                effect_text = (base_effect + ('・' + num_effect if num_effect else '')).strip('・')
                skills.append({
                    'name': skill_name,
                    'level': level_text,
                    'effect': effect_text
                })
    
    # 強化リスト情報
    enhancements = []
    h2_enhancements = None
    for heading in wikibody.find_all(['h2', 'h3']):
        if '強化リスト情報' in heading.get_text() or '強化設定' in heading.get_text():
            h2_enhancements = heading
            break
            
    if h2_enhancements:
        enh_tables = h2_enhancements.find_all_next('table')
        # その後の無関係なテーブルまで読まないよう、すぐ次の見出しまでの中にあるテーブルだけを対象にする
        next_heading = h2_enhancements.find_next(['h2', 'h3'])
        
        for table in enh_tables:
            if next_heading and table.sourceline and next_heading.sourceline and table.sourceline > next_heading.sourceline:
                break

            rows = table.find_all('tr')
            current_list_name = None
            ms_level_columns = []  # ヘッダー行から抽出したMSレベル列 [1, 2, 3, ...]

            for row in rows:
                cells = row.find_all(['th', 'td'])
                if not cells:
                    continue

                # 全セルがthの行はヘッダー行 → MSレベル列を抽出してスキップ
                if all(c.name == 'th' for c in cells):
                    texts = [c.get_text(strip=True) for c in cells]
                    # 「Lv1」〜「Lv8」形式の列ヘッダーを抽出
                    new_levels = []
                    for t in texts[2:]:
                        m = re.match(r'^Lv(\d+)$', t, re.IGNORECASE)
                        if m:
                            new_levels.append(int(m.group(1)))
                    if new_levels:
                        ms_level_columns = new_levels
                    continue

                first_cell = cells[0]
                first_text = first_cell.get_text(strip=True)
                # LV継続行か新規リスト名行かをテキストで判別
                # 継続行: 先頭セルが「Lv数字」形式
                # 新規行: 先頭セルがスキル名（rowspanあり/なし問わず）
                is_lv_continuation = bool(re.match(r'^Lv\d+$', first_text, re.IGNORECASE))

                if first_cell.name == 'th' and not is_lv_continuation:
                    # 新しいリスト名行（強化ポイントあり＝実際の強化スロット）
                    current_list_name = first_text
                    lv_cell = cells[1] if len(cells) > 1 else None
                else:
                    # LV継続行（Lv2以降: 枠内のアップグレード状態を示すだけ）→スキップ
                    continue

                if not current_list_name or not lv_cell:
                    continue

                lv_text = lv_cell.get_text(strip=True)
                effect_text = cells[-1].get_text(strip=True)

                # 効果テキストが空またはLv数字のみ（ヘッダー残滓）ならスキップ
                if not effect_text or re.match(r'^Lv\d+$', effect_text, re.IGNORECASE):
                    continue

                # 強化ポイントが存在するMSレベルを抽出
                # cells[2:-1] がコスト列（リスト名列・Lv列・効果列を除いた中間）
                cost_cells = cells[2:-1]
                ms_levels_available = []
                for col_idx, cost_cell in enumerate(cost_cells):
                    cost_text = cost_cell.get_text(strip=True)
                    if cost_text and re.match(r'^\d+', cost_text):
                        if col_idx < len(ms_level_columns):
                            ms_levels_available.append(ms_level_columns[col_idx])

                skill_full_name = f"{current_list_name} {lv_text}"
                if not any(e['skill_name'] == skill_full_name for e in enhancements):
                    enhancements.append({
                        "skill_name": skill_full_name,
                        "effect": effect_text,
                        "ms_levels": ms_levels_available
                    })
    
    # pageIdを取得
    page_id = None
    canonical = soup.find('link', rel='canonical')
    if canonical:
        href = canonical.get('href', '')
        m = re.search(r'/pages/(\d+)\.html', href)
        if m:
            page_id = int(m.group(1))
    
    result = {
        "name": ms_name,
        "pageId": page_id,
        "category": category,
        "ground": ground,
        "space": space,
        "envGround": env_ground,
        "envSpace": env_space,
        "levels": level_data,
        "slots": slots_data,
        "skills": skills,
        "enhancements": enhancements,
        "wikiUrl": f"https://w.atwiki.jp/battle-operation2/pages/{page_id}.html" if page_id else None
    }
    
    return result


def main():
    """メイン処理：指定ディレクトリの全MS HTMLをパース"""
    html_dir = r"E:\SHIGOTOBA\.antigravity"
    
    # テスト：ガンダムのページだけパース
    gundam_files = [f for f in os.listdir(html_dir) 
                    if f.startswith('ガンダム') and f.endswith('.html') and 'カスタム' not in f and '戦闘' not in f]
    
    if not gundam_files:
        print("ERROR: ガンダムのHTMLファイルが見つかりません")
        sys.exit(1)
    
    all_ms = []
    
    for html_file in gundam_files:
        html_path = os.path.join(html_dir, html_file)
        print(f"解析中: {html_file}")
        
        ms_data = parse_ms_page(html_path)
        if ms_data:
            all_ms.append(ms_data)
            print(f"  → {ms_data['name']} ({ms_data['category']})")
            print(f"     LV数: {len(ms_data['levels'])}")
            if ms_data['levels']:
                lv1 = ms_data['levels'].get('1', {})
                print(f"     LV1: Cost={lv1.get('cost')}, HP={lv1.get('hp')}, "
                      f"射撃={lv1.get('shooting_correction')}, 格闘={lv1.get('melee_correction')}")
            print(f"     スキル: {len(ms_data['skills'])}個")
            if ms_data['enhancements']:
                print(f"     強化リスト: {len(ms_data['enhancements'])}段階取得成功")
                for e in ms_data['enhancements'][:2]:
                    print(f"       - {e['skill_name']}: {e['effect']}")
        else:
            print(f"  → パース失敗")
    
    # 出力
    output_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'ms_data.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump({
            "version": "2026-03-29",
            "totalMS": len(all_ms),
            "msList": all_ms
        }, f, ensure_ascii=False, indent=2)
    
    print(f"\n完了: {len(all_ms)}体のMSデータを抽出")
    print(f"出力先: {output_path}")


if __name__ == '__main__':
    main()
