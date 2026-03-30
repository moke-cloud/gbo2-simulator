"""
ms_data.json の品質検証スクリプト
パース後に実行してノイズ・欠落・値範囲の問題を検出する
"""
import json
import re
import sys
import os

# ノイズとして除外すべきスキル名パターン
SKILL_NOISE_PATTERN = re.compile(r'^(LV\d+|攻撃|防御|足回り|索敵|特殊|補助|その他|スキル名|効果)$')

# 強化リストのノイズパターン
ENH_NOISE_PATTERN = re.compile(r'^(リスト名|Lv\d+)', re.IGNORECASE)

# ステータス値の合理的な範囲
STAT_RANGES = {
    'hp':                   (3000,  60000),
    'ballistic_armor':      (0,     80),
    'beam_armor':           (0,     80),
    'melee_armor':          (0,     80),
    'shooting_correction':  (0,     100),
    'melee_correction':     (0,     100),
    'speed':                (50,    250),
    'boost_speed':          (100,   350),
    'thruster':             (10,    100),
    'turn_speed_ground':    (20,    180),
    'turn_speed_space':     (20,    180),
}

# コアステータス（これらが揃っていれば最低限OK）
CORE_STATS = ['hp', 'ballistic_armor', 'beam_armor', 'melee_armor',
              'shooting_correction', 'melee_correction']


def validate(data_path: str) -> bool:
    with open(data_path, encoding='utf-8') as f:
        data = json.load(f)

    ms_list = data.get('msList', [])
    errors = []
    warnings = []

    for ms in ms_list:
        name = ms.get('name', '?')

        # --- スキルノイズチェック ---
        for s in ms.get('skills', []):
            if SKILL_NOISE_PATTERN.match(s):
                errors.append(f'[スキルノイズ] {name}: {s!r}')

        # --- 強化リストノイズチェック ---
        for e in ms.get('enhancements', []):
            sn = e.get('skill_name', '')
            eff = e.get('effect', '')
            if ENH_NOISE_PATTERN.match(sn) or re.match(r'^Lv\d+$', eff, re.IGNORECASE):
                errors.append(f'[強化リストノイズ] {name}: {sn!r} / {eff!r}')

        # --- ステータス欠落チェック ---
        for lv, stats in ms.get('levels', {}).items():
            missing = [k for k in CORE_STATS if k not in stats]
            if missing:
                warnings.append(f'[ステータス欠落] {name} LV{lv}: {missing}')

            # 値範囲チェック
            for stat, (lo, hi) in STAT_RANGES.items():
                val = stats.get(stat)
                if val is not None and not (lo <= val <= hi):
                    warnings.append(f'[範囲外] {name} LV{lv}: {stat}={val} (期待: {lo}-{hi})')

        # --- スロット欠落チェック ---
        slots = ms.get('slots', {})
        if not slots:
            warnings.append(f'[スロットなし] {name}')
        else:
            for lv in ms.get('levels', {}):
                for stype in ['close', 'mid', 'long']:
                    if lv not in slots.get(stype, {}):
                        warnings.append(f'[スロット欠落] {name} LV{lv}: {stype}')

    # --- サマリー出力 ---
    total = len(ms_list)
    print(f'=== GBO2 データ品質レポート ===')
    print(f'対象: {total}体')
    print(f'エラー: {len(errors)}件  警告: {len(warnings)}件')

    if errors:
        print('\n--- エラー (修正必須) ---')
        for msg in errors[:30]:
            print(f'  {msg}')
        if len(errors) > 30:
            print(f'  ... 他{len(errors)-30}件')

    if warnings:
        print('\n--- 警告 (確認推奨) ---')
        for msg in warnings[:30]:
            print(f'  {msg}')
        if len(warnings) > 30:
            print(f'  ... 他{len(warnings)-30}件')

    if not errors and not warnings:
        print('\n✓ 問題なし')

    return len(errors) == 0


if __name__ == '__main__':
    data_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'ms_data.json')
    ok = validate(data_path)
    sys.exit(0 if ok else 1)
