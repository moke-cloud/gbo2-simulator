# ダメージシミュレーション機能 — 設計書

> ステータス: **設計確定中（実装前）** / 起票 2026-06-10
> 上位ドキュメント: [[DAMAGE_SIMULATION_CONCEPT.md]]（構想・要調査メモ）
> 本書は「コーディング着手前に UI・データモデル・エンジン API を確定させる」ための設計書。
> 実装は本書を Fable で実行する前提。**研究待ち（§A）の定数が埋まるまで、計算結果の数値は暫定**。

---

## 0. このドキュメントの読み方

- **確定** … 既存 `js/calculator.js` で検証済み、または本セッションでユーザーと合意済み。そのまま実装してよい。
- **研究待ち** … deep research（CONCEPT §3）の結果で確定する。構造は決めるが定数・分岐は仮。`⏳` で示す。
- **後段** … Phase 4 以降。Phase 1 では作らない。`▶` で示す。

実装順は §8（Fable向けタスク分解）に従う。UI は §6、データモデルは §4、エンジンは §5。

---

## 1. スコープ（Phase 1 で作る / 作らない）

### 1-1. 作る（Phase 1）
- 保存構成2つを「攻撃側 / 防御側」に割り当て、**攻撃側の武装を1つ選んで** 防御側への与ダメージを計算・表示。
- 入替ボタンで攻守反転。武装は ◀ ▶ / プルダウンで切替。
- **1武装フォーカス詳細カード**（選択中の武装の素ダメージ・内訳・備考原文）。
- 計算要素: **武器威力 × 攻撃補正 × (1 − 防御カット) × 三すくみ × 格闘方向補正 × 耐性無視**（静的1発/斉射）。
- **スキル発動トグル**: 保存時 ON を初期値に、攻撃側・防御側の条件付きスキル/状態をトグルして即再計算。
- 内訳（breakdown）のツールチップ/展開表示。

### 1-2. 作らない（後段 ▶）
- ▶ DPS（リロード・OH復帰・切替込みの時間あたりダメージ）
- ▶ 距離減衰・誘導・爆風範囲
- ▶ 部位別ダメージ・部位耐久・急所
- ▶ マガジン全弾の累積・撃墜までの斉射数（TTK）※ Phase 1 では「素の1発/斉射」に限定
- ▶ EXAM/トランザム等の時限バフの厳密モデル化

> スコープを「静的ダメージ計算」に絞るのは [[feedback_no_half_finished]] と矛盾しない。
> **Phase 1 は「1武装の静的与ダメ計算＋スキル条件反映」で1機能完結**。DPS等は独立した次フェーズ。

---

## 2. 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│ data-repo (Python)                                        │
│  parse_ms_weapons.py（新設）→ ms_data.json に weapons[] 付与  │  ← Phase 1-D（データ）
└─────────────────────────────────────────────────────────┘
                         │ ms_data.json（weapons 付き）
                         ▼
┌─────────────────────────────────────────────────────────┐
│ js/app.js（オーケストレーション・UI）                         │
│  ・getCombatProfile(buildData)  保存構成→戦闘プロファイル     │  ← Phase 1-A
│  ・DamageSimUI（パネル描画・select/トグル/武装切替・再計算）    │  ← Phase 1-C
└─────────────────────────────────────────────────────────┘
                         │ profile(attacker), profile(defender), opts
                         ▼
┌─────────────────────────────────────────────────────────┐
│ js/calculator.js（ピュア計算・テスト容易）                    │
│  ・calcWeaponDamage(weapon, attacker, defender, opts)       │  ← Phase 1-B（エンジン）
│    既存 calcCutRate / 三すくみ定数 / extractSkillEffects 流用  │
└─────────────────────────────────────────────────────────┘
                         │ { perHit, perVolley, byDirection, breakdown }
                         ▼
                    DamageSimUI が詳細カードへ整形描画
```

**設計原則（既存スタイル踏襲）**
- `calcWeaponDamage` は **ピュア関数**（DOM 非依存・副作用なし）。テストは `tests/test_calculator.js` に追加。
- 既存 `calcOffenseScore`（武器なし抽象スコア）は**温存**し、本機能とは別経路（回帰リスク隔離）。CONCEPT §6 の方針を維持。
- 武器テキスト解析（備考フリーテキスト）は **Python（パーサ）と JS（フォールバック整形）両方に出る可能性** → [[feedback_dual_fix]] 厳守。
- 解析しきれない特殊効果は捨てず `weapon.notes` に原文保全（[[feedback_data_integrity]]）。UI で「未モデル」を明示し過大評価を避ける。

---

## 3. データフロー（1回の再計算）

1. ユーザーが攻撃側/防御側 select、武装、スキル条件トグルを操作。
2. `DamageSimUI.recompute()`:
   - `attacker = getCombatProfile(buildA)` / `defender = getCombatProfile(buildB)`
   - `opts = collectOpts()`（方向・距離・三すくみ自動・ON条件集合）
   - `result = GBO2Calculator.calcWeaponDamage(selectedWeapon, attacker, defender, opts)`
3. `result.breakdown` を詳細カードに描画。トグル変更は 2 から再実行（軽量・同期）。

> `getCombatProfile` は既存 `calcStatsFromBuild` と同じ `applyParts` 経路を通すが、
> **戻り値は `_computeCalcResult` 整形済みではなく「生 modified ＋カテゴリ＋武装＋条件付きスキル一覧」**。
> 既存比較機能には手を入れない（新規アクセサとして分離）。

---

## 4. データモデル

### 4-1. 武器スキーマ（`ms_data.json` の機体直下 `weapons[]`）

CONCEPT §2-2 で確認した Wiki 実カラムに対応。**LV 依存威力があるため `power` は LV別オブジェクト**。

```jsonc
{
  "name": "リゼルN型用B・サーベル",
  "category": "melee",            // "shooting" | "melee" | "shield"（shield は表示のみ・与ダメ計算外）
  "attribute": "melee",           // "ballistic" | "beam" | "melee" | "special"   ⏳special細分は§A-2
  "power": { "1": 2500, "2": 2700 }, // LV → 1ヒット威力（命中部位補正前）。LV非依存なら {"1": x} のみ
  "hits": 1,                      // 1トリガーの多段ヒット数（Gランチャー=2 等）。斉射 = power × hits
  "modes": null,                  // 集束/変形など複数威力モード。無ければ null。§4-2
  // ── 射撃系の参考値（Phase 1 は計算に未使用 / ▶DPS拡張で使用）──
  "magazine": null, "reloadSec": null, "ohReturnSec": null,
  "fireIntervalSec": null, "switchSec": null, "rangeM": 300,
  // ── よろけ・特殊（備考フリーテキストから抽出）──
  "staggerValue": 30,             // よろけ蓄積（数値 or %表記。原文に応じ number|null）
  "downValue": 0,
  "special": {
    "resistIgnore": null,         // ⏳§A-3: { mode:"pct"|"flat", value:n } | null
    "penetration": false,         // ユニット貫通（§A-3で割合/全無視のどちらに正規化するか確定）
    "vsStaggerDmgPct": 0,         // ▶ よろけ/ダウン中の敵への与ダメUP（武器固有分。スキル分は別レイヤ）
    "heavyAttack": false,         // ヘビーアタック対応（格闘）⏳§A-4倍率
    "comboCorrection": null       // ▶ コンボ段数別倍率（§A-4）。Phase 1 は単発のみ
  },
  "chargeable": false,            // 集束可否（true なら modes に非集束/集束）
  "notes": "集束可/集束時大よろけ/倍率1.727/よろけ値30% …（原文ママ）"
}
```

**設計判断**
- `attribute` は **カテゴリ節見出し（実弾/ビーム/格闘/シールド/その他）で確定**（CONCEPT §2-2-2: 色は CSS 由来で不可）。
  フォールバックはカラム構成（格闘=クールタイム/武装切替, 射撃=弾数/リロード/OH）→ 武器名キーワード。
- `power` を LV別 dict にするのは CONCEPT §2-2-1（威力 LV 依存）への対応。`weapon.power[String(msLevel)] ?? weapon.power["1"]` で解決。
- 部位/モードの揺れは `notes` に原文保全。解析できた分だけ構造化。

### 4-2. 複数威力モード（集束/変形）

```jsonc
"modes": [
  { "key": "normal",  "label": "非集束", "power": { "1": 850,  "2": 1000 } },
  { "key": "charged", "label": "集束",   "power": { "1": 2800, "2": 2800 },
    "special": { "penetration": true } }   // モード固有の特殊効果はここで上書き
]
```

- `modes` がある武器は UI で **モード選択（非集束/集束・通常/変形）** を出す。各モードが `power`／`special` を持つ。
- `modes` 無し武器は `power` 直読み。**正規化: 内部的には常に「現在モードの power/special」に解決してからエンジンへ渡す**（エンジンはモードを知らない）。

### 4-3. 戦闘プロファイル（`getCombatProfile` の戻り値・app.js）

エンジンに渡す中間表現。**生 modified を再利用**しつつ、武装とカテゴリと条件付きスキルを束ねる。

```jsonc
{
  "name": "リゼルN型",            // 表示名（buildData.name は構成名、こちらは機体名）
  "buildName": "対ザク構成",
  "msLevel": 1,
  "category": "汎用",             // 三すくみ用（ms_data top.category）
  "hp": 18000,
  "armor":      { "ballistic": 22, "beam": 18, "melee": 30 },  // modified（キャップ適用済）
  "correction": { "shooting": 45, "melee": 60 },               // modified
  "dmgPct":     { "shooting": 0, "melee": 0 },     // 常時の与ダメ%（パーツ shooting/melee_damage_pct）
  "cutPct":     { "ballistic": 0, "beam": 10, "melee": 0 },     // 常時の属性カット%
  "weapons": [ /* §4-1 の配列。modes は未解決のまま渡し、UI が選択モードを opts で指定 */ ],
  "skillConditions": [
    // extractSkillEffects 由来。UI のトグル生成と、ON時のダメージ反映に使う（§5-4）
    { "id":"atk-firepower-always", "side":"attacker", "label":"与ダメUP（常時）",
      "category":"firepower", "value":15, "condition":"常時", "defaultOn":true },
    { "id":"atk-firepower-downed", "side":"attacker", "label":"よろけ/ダウン中の敵に+10%",
      "category":"firepower", "value":10, "condition":"よろけ/ダウン中の敵に", "defaultOn":false },
    { "id":"def-cut-low-hp", "side":"defender", "label":"瀕死時カット20%",
      "category":"damage_cut", "value":20, "condition":"瀕死/緊急時", "defaultOn":false }
  ]
}
```

> `armor.beam` 等は `applyParts` でキャップ（素50＋拡張）適用済の値。`cutPct` は `modified.beamDamageCutPct` 等。
> `skillConditions` は攻撃側プロファイルからは攻撃系（firepower/stat_bonus）、防御側からは防御系（damage_cut/stagger）を採用。
> `defaultOn`: 条件が `常時` のものは true、`瀕死/よろけ中の敵に/静止時…` は false（CONCEPT のユーザー合意「保存ONを初期値＋トグル」）。
> ※「保存時 ON だったスキル」は `buildData.activeSkillIndices` で判定し、該当する条件付きスキルの `defaultOn` を true に上書き。

---

## 5. 計算エンジン（`calculator.js` 拡張）

### 5-1. 関数シグネチャ

```js
/**
 * 1武装の静的与ダメージを計算する（ピュア関数）。
 * @param {object} weapon   §4-1 を「選択モード解決済み」にしたもの（power:dict, attribute, special, hits…）
 * @param {object} attacker §4-3 戦闘プロファイル（攻撃側）
 * @param {object} defender §4-3 戦闘プロファイル（防御側）
 * @param {object} opts {
 *   msLevelAtk:number, direction:"front"|"side"|"back",
 *   triad:"auto"|"advantage"|"disadvantage"|"none",
 *   activeConditions:Set<string>,   // ON の skillConditions.id（攻守両方）
 *   defenderState:{ staggered:boolean, downed:boolean, hpRatio:number }  // ▶一部は後段
 * }
 * @returns {{
 *   perHit:number, perVolley:number,
 *   byDirection:{front:number, side:number, back:number}|null, // 格闘のみ。射撃は null
 *   breakdown:{
 *     basePower:number, atkCorrMul:number, atkSkillMul:number,
 *     defCutMul:number, defSkillMul:number, triadMul:number,
 *     directionMul:number, resistIgnoreMul:number, hits:number
 *   },
 *   notes:string, unmodeled:string[]   // 未反映の特殊効果ラベル（UIで「未モデル」明示）
 * }}
 */
calcWeaponDamage(weapon, attacker, defender, opts) { ... }
```

### 5-2. 計算式（基本＝**確定**、拡張＝研究待ち）

既存 `calculator.js` 冒頭コメントで検証済みの基本式を踏襲する。

```
perHit =
  basePower                                   // weapon.power[msLevelAtk]（確定）
  × atkCorrMul                                // 1 + 攻撃補正/100（射撃 or 格闘）上限100→×2（確定）
  × atkSkillMul                               // Π(1 + 与ダメUP%/100)  ※ON条件のみ（§5-4・確定）
  × defCutMul                                 // (1 − 防御カット)  ※§5-3（確定: 線形 1pt=1% 上限50）
  × defSkillMul                               // Π(1 − カット%/100)  ※ON条件のみ（§5-4・確定）
  × triadMul                                  // 三すくみ ×1.30 / ×0.80 / ×1（確定: 既存定数）
  × directionMul                              // 格闘方向 ⏳§A-4（front=1, side=?, back=?）射撃=1
  × resistIgnoreMul                           // 耐性無視 ⏳§A-3（無しは1）

perVolley = perHit × weapon.hits             // 1トリガー多段（Gランチャー=2 等）
byDirection = 格闘なら {front, side, back}（directionMul を各方向で差し替え再計算）/ 射撃は null
```

**確定事項（calculator.js 由来＋§A-0 deep research で裏付け）**
- **正準順序（確定）**: 攻撃力 → 防御力 → 格闘方向補正 → 連撃補正 → 三すくみ。floor が段ごとに入るため**順序を守る**（§5-5）。
- 攻撃補正: `1 + correction/100`（`calcShootingMultiplier`/`calcMeleeMultiplier`）。上限100=×2。実測一致（39pt→×1.39）。
- 防御カット: **線形 `cutRate = min(armor,99)/100`**（`calcCutRate`）。素上限50＝50%カット。逓減モデルは誤りとして不採用（研究で線形を再確認）。
- 三すくみ: `ADVANTAGE_MULTIPLIER=1.30 / DISADVANTAGE_MULTIPLIER=0.80`、`TYPE_ADVANTAGE`（汎用>強襲>支援>汎用＝研究と一致）。
  式末尾に乗算・双方向効果（攻撃側の有利＝×1.30 で A→B 計算には片側のみ乗る）。`triad:"auto"` は attacker.category vs defender.category。**%は諸説ありだが 1.30/0.80 を採用**（§A-5）。
- 端数処理: 各段 floor（§5-5・確定）。
- スキル合成（§5-4）: **異カテゴリ=乗算 / 同カテゴリ=加算**（§A-0 Q9 確定）。

**⏳ 研究待ち（数値が未確定・§A-1。暫定値＋TODO で実装）**
- `directionMul`（§A-4）: 項の**存在は確定**だが正面/側面/背面の**倍率・コンボ段・ヘビーアタックは数値未確定** → 暫定 1.0。
- `resistIgnoreMul`（§A-3）: 割合/固定/適用段すべて**未確定** → 暫定 ×1。
- 特殊属性（榴弾/ミサイル/爆発）が `defCutMul` でどの armor を引くか（§A-2）**未確定** → 暫定 実弾扱い。

### 5-3. 防御カットの合成（属性 → カット率）

```
attr = weapon.attribute  // ballistic | beam | melee | (special→§A-2)
armorCut = calcCutRate(defender.armor[attrToArmorKey(attr)])          // 線形・上限50（確定）
partsCut = defender.cutPct[attr] / 100                                 // 常時の属性カット%（確定）
defCutMul = (1 − armorCut) × (1 − partsCut)                            // 乗算合成（既存方針）
// 耐性無視は §A-3 確定後、armorCut を resistIgnore 分だけ減衰させてから合成
```

`attrToArmorKey`: `ballistic→ballistic, beam→beam, melee→melee`。special は §A-2 で確定（暫定: 実弾扱い）。

### 5-4. スキル発動の接続（**確定**・既存 `extractSkillEffects` 流用）

- `getCombatProfile` が機体の全スキルを `extractSkillEffects` で解析 → `{category, value, condition}` を得る。
- これを `skillConditions[]`（§4-3）に整形。`condition` ラベルは既存 `_parseCondition` の語彙をそのまま使う:
  `常時 / 瀕死・緊急時 / 静止時 / 射撃時のみ / 実弾属性のみ / ビーム属性のみ / 格闘属性のみ / よろけ・ダウン中の敵に / 高速移動中 / …`
- UI のトグルは `skillConditions` から生成。**ON のもの（`opts.activeConditions` に id がある）だけ**エンジンで乗算:
  - 攻撃側 `category:"firepower"` または `stat_bonus.shooting/melee` → `atkSkillMul *= (1 + value/100)`
    （属性限定 `ビーム属性のみ` 等は、選択武器の attribute と一致するときだけ適用）
  - 防御側 `category:"damage_cut"` → `defSkillMul *= (1 − value/100)`
- `condition:"常時"` は `defaultOn=true`（初期 ON）。それ以外は `false`。保存時 ON のスキルは初期 ON に上書き。

**合成順（§A-0 Q9 確定）の適用**
- **異カテゴリ＝乗算**: 与ダメ%（firepower）と被ダメカット%（damage_cut）は別カテゴリ → `atkSkillMul` と `defSkillMul` で**別個に乗算**（既に別変数なので自然に満たす）。
- **与ダメ%スキル同士＝独立した追加補正項として乗算**: オーバーチューン等が「基本ダメージに独立 ×(100+v)/100」と実測されたのと同様、firepower 各スキルは `atkSkillMul *= (1+value/100)` で各々乗算。
- **同カテゴリの補正値（射撃/格闘補正pt）＝加算**: これは `applyParts` が既に `profile.correction` へ合算済み → `atkSkillMul` では扱わない（二重計上回避）。
- 端数: `atkSkillMul`/`defSkillMul` 各係数も小数2桁・適用後 floor（§5-5）。

> stat_bonus（射撃補正＋N 等の一律上昇）のうち**補正系は既に `applyParts` 経由で `correction` に反映済み**。
> よって二重計上を避け、`atkSkillMul` で扱うのは**与ダメ%系（firepower）のみ**。補正フラット加算は profile.correction 側で完結。

### 5-5. 端数処理（**確定**・§A-0 deep research）

実ゲームは2層の端数処理を行う。**round-to-nearest ではなく floor（切り捨て）**。

- **補正係数**: 各補正の計算は**小数第3位以下を切り捨て**（=小数2桁で保持）。例 `(100+39)/100 = 1.39`、`(100−26)/100 = 0.74`。
- **武器威力との乗算**: 威力に補正を掛けるたび**その都度 floor で整数化**。`Math.floor(power × corr)` を段ごとに適用。
- 実装方針: `calcWeaponDamage` は各乗算段で `Math.floor` する正確モードを基本とする。breakdown 表示用の各倍率は小数2桁。
- ⚠ floor を段ごとに行うため**乗算順序が結果に影響する**（§5-2 の正準順 攻撃→防御→格闘方向→連撃→三すくみ を守る）。
- 表示はカンマ区切り `toLocaleString()` で既存と桁を揃える。
- テスト（§8 1-B）の期待値も floor 基準で固定する（note弱小賢者の実測値 2875→2957 等を回帰固定に使う）。

---

## 6. UI 設計（**確定**：1武装フォーカス詳細）

### 6-1. 配置
- 新パネル `<section id="damage-sim-section" class="panel hidden">`。
- 既存 `compare-section`（構成比較）の**直後**に追加。「基準比較」「構成比較」に続く**第3の比較軸**。
- セクションタイトル: `⚔ ダメージシミュレーション`。
- 表示制御は既存パネル同様 `hidden` トグル＋構成が1件以上で有効化。

### 6-2. レイアウト（確定モック）

```
⚔ ダメージシミュレーション
攻撃[構成A ▼] → 防御[構成B ▼]            [⇄ 入替]
武装: ◀ [B・サーベル ▼] ▶            (modes有: [非集束/集束])

┌────────────────────────────────────┐
│ B・サーベル （格闘 / melee）                       │
│ ─────────────────────────────── │
│  正面 1,900    側面 1,520    背面 2,470          │  ← 格闘=方向3値
│ ─────────────────────────────── │
│  よろけ蓄積 —    クールタイム 2.0s   ヘビーアタック対応 │
│  内訳 ▸  2,500 ×(1+0.60 補正) ×(1−0.30 耐格闘)      │
│         ×1.30 三すくみ(有利) ×1.30 背面                │
│  備考: ヘビーアタック対応（原文ママ）                    │
│  ⚠ 未モデル: コンボ段数別倍率                          │
└────────────────────────────────────┘

発動スキル / 状態（ダメージに反映）
攻撃側  [✓ 与ダメUP（常時）] [ 瀕死時 ] [ 静止射撃 ]
        [ よろけ中の敵に ] [ 高速移動中 ]
防御側  [✓ 常時カット ] [ 瀕死時カット ]
[ 三すくみ: 自動 ▼ ]  [ 距離: — ]   ※距離は▶後段
```

- **射撃武器のとき**: 方向3値の行を出さず、`1発 1,520 / 斉射(×hits) 1,520 / よろけ 30%` の行に差し替え。
- **shield カテゴリ**: 武装プルダウンから除外（与ダメ計算対象外）。
- 内訳 `▸` はデフォルト折りたたみ、タップで展開（モバイル省スペース）。

### 6-3. インタラクション
| 操作 | 挙動 |
|---|---|
| 攻撃/防御 select 変更 | プロファイル再取得 → 武装プルダウンを攻撃側武装で再構築 → 再計算 |
| ⇄ 入替 | 攻撃/防御を入替（select の値スワップ）→ 再計算 |
| 武装 ◀ ▶ / プルダウン | 選択武装を変更 → 詳細カード再描画 |
| モード（非集束/集束 等） | `weapon.modes` を解決して再計算 |
| スキル/状態トグル | `opts.activeConditions` 更新 → 再計算（同期・軽量） |
| 三すくみ select | auto/有利/不利/なし を `opts.triad` へ |

### 6-4. select の供給
- 既存 `updateBuildSelectOptions()` のパターンを流用し、`#dsim-build-a` / `#dsim-build-b` を保存構成＋「現在の構成」で満たす。
- 武装プルダウン `#dsim-weapon` は攻撃側プロファイルの `weapons`（shield 除外）から生成。

### 6-5. 状態・空表示・エラー
- 構成0件: パネル非表示（既存挙動に合わせる）。
- 攻撃側機体に `weapons` が無い（パーサ未取得の機体）: 「この機体は武装データ未収録」を明示（ダミーを出さない＝[[feedback_data_integrity]]）。
- 同一構成 A=B: 警告（既存 compare と同様）だが**ミラーマッチは許可**（自己対面の検証用途）。

### 6-6. モバイル/アクセシビリティ
- 詳細カードは1カラム・縦積み。武装切替 ◀ ▶ は親指届く位置。トグルは折返し（flex-wrap）。
- select / button に `aria-label`。トグルは `role="switch"` + `aria-checked`。
- 既存 `css/style.css` のトークン（パネル/ボタン/比較表の配色）を流用し新規色を増やさない。

---

## 7. ファイル / モジュール分割

| ファイル | 追加内容 | 行数目安 |
|---|---|---|
| `data-repo/parse_ms_weapons.py`（新設） | 武装表パーサ（カテゴリ節→属性確定、rowspan継承、include展開、備考解析） | 〜400 |
| `data/ms_data.json` | 各機体に `weapons[]` 付与（パーサ出力） | データ |
| `js/calculator.js` | `calcWeaponDamage` ＋補助（`attrToArmorKey`、方向/耐性無視ヘルパ） | 〜120 |
| `js/app.js` | `getCombatProfile`、`DamageSimUI`（描画/イベント/再計算） | 〜250 |
| `index.html` | `#damage-sim-section` マークアップ | 〜40 |
| `css/style.css` | 詳細カード・トグルの最小スタイル（既存トークン流用） | 〜60 |
| `tests/test_calculator.js` | `calcWeaponDamage` ユニットテスト | 〜200 |

> `app.js` が 800 行制限に近い場合は `DamageSimUI` を `js/damage-sim.js` に切り出す（[[coding-style]] 多数小ファイル原則）。
> 着手時に app.js の現行行数を確認して判断。

---

## 8. 実装タスク分解（Fable向け・順序と受入基準）

> 各タスクは **TDD**（[[development-workflow]]）: 失敗テスト→最小実装→リファクタ。完了ごとに `code-reviewer`。

### Phase 1-A: 戦闘プロファイル取得（app.js）
- `getCombatProfile(buildData)` 実装。生 modified＋category＋weapons＋skillConditions を返す。
- 受入: リゼルN型 LV1 の保存構成から armor/correction/cutPct/weapons/skillConditions が正しく出る（既存 `calcStatsFromBuild` と armor 値一致）。

### Phase 1-B: 計算エンジン（calculator.js）★研究待ち定数は仮値でテスト
- `calcWeaponDamage` 実装。基本式（§5-2 確定部）＋ breakdown。方向/耐性無視は **仮定数 + TODO コメント**。
- ユニットテスト（`tests/test_calculator.js`）:
  - 射撃ビーム: 威力×補正×(1−耐ビーム)×三すくみ が手計算と一致
  - 格闘: directionMul 切替で byDirection が変わる
  - スキル ON/OFF で atkSkillMul/defSkillMul が乗る
  - 属性カット合成（armorCut × partsCut）
  - 三すくみ auto 判定（汎用→強襲=不利 等）
- 受入: 全テスト green、カバレッジ ≥80%。

### Phase 1-C: UI（app.js / index.html / css）
- `#damage-sim-section` ＋ `DamageSimUI`。§6 の挙動を実装。
- 受入: Playwright 実機で 攻守select→武装切替→トグルで数値が再計算される。スマホ幅で崩れない。

### Phase 1-D: データ（data-repo・別リポジトリ作業）
- `parse_ms_weapons.py` 新設。まず **変形機/支援機/格闘機を含む複数機体**で実データ検証（CONCEPT §9 パーサ頑健性）。
- Python/JS 双方に解析ロジックが出る場合は [[feedback_dual_fix]]。
- daily/monthly CI へ統合（内容ハッシュ版管理・スタブガード）。
- 受入: リゼルN型8武装が §4-1 スキーマで取得でき、`notes` 原文保全。スタブ混入なし。

> **順序の注意**: 1-A/1-B/1-C は **ダミーでない最小実データ**（リゼルN型の手入力 weapons でも可）で先行可能。
> ただし最終的に 1-D の実パーサ出力へ差し替えるまで「完成」としない（[[feedback_data_integrity]]）。

---

## 9. テスト計画

- **ユニット（必須）**: `calcWeaponDamage` の各分岐（§8 1-B）。手計算の期待値をテストに固定。
- **回帰**: 既存 `calcOffenseScore`・比較機能・EHP に影響しないこと（別経路なので原則無影響、テストで担保）。
- **E2E（Playwright）**: パネル表示→攻守選択→武装切替→スキルトグル→数値更新の一連。スマホビューポート。
- **データ検証**: パーサ出力を数機体で目視＋スキーマバリデーション（属性が節見出しと一致するか）。

---

## A. 研究結果と残課題（deep research 完了 2026-06-10）

> CONCEPT §3-0 に総括。97エージェント・主張25件を3票検証（23確定/2棄却）。出典: gameline.jp / note弱小賢者(実測) / atwiki pages/83.html(3rd Season) / 公式 bo2.ggame.jp / fav-reco / dengeki。
> **公式は式・数値非公開**＝確定の大半はコミュニティのリバースエンジニアリング（パッチ変動あり）。

### A-0. 確定（実装に反映済み / してよい）
- **全体構造＝乗算チェーン**: `威力 ×(攻撃補正×他攻撃) ×(防御補正×他防御) × [格闘方向] × [連撃] × 三すくみ`。順序 = 攻撃→防御→格闘方向→連撃→三すくみ。**基本式は実測一致** → §5-2 確定部のとおり。
- **攻撃補正** 1pt=+1%・上限100（×2カンスト） / **防御・属性耐性** 1pt=−1% 線形・逓減なし・実効上限50 → §5-2/§5-3 のとおり。
- **端数処理（新発見）**: 補正計算は小数第3位以下切り捨て、武器威力との乗算は**都度 floor**（round-not-nearest）。→ §5-5 に反映。
- **三すくみ**: 循環 汎用>強襲>支援>汎用（既存 `TYPE_ADVANTAGE` と一致）、式末尾に `×(1+属性補正/100)`、双方向。**正確な%は諸説あり** → 既存 1.30/0.80 を採用（§5-2）。
- **スキル合成（Q9）**: 異カテゴリ=乗算 / **同カテゴリ=加算**、追加補正項は独立乗算 → §5-4 に反映。

### A-1. 未確定（暫定値で実装・▶後段または要追加調査）
| ID | 項目 | 影響箇所 | 状態 / 暫定扱い |
|---|---|---|---|
| §A-2 | 特殊属性（榴弾/ミサイル/爆発/火炎）の対応 armor | `attrToArmorKey` / `defCutMul` | **未確定**（確定出典なし）→ 暫定: 実弾扱い。weapon.notes に原文保全しUIで「未確定」明示 |
| §A-3 | 耐性無視 / ユニット貫通の挙動 | `resistIgnoreMul` / §5-3 | **未確定**（割合/固定/適用段すべて不明）→ 暫定: ×1。武器に効果がある場合は notes 保全＋UIで「未モデル」 |
| §A-4 | 格闘方向倍率・連撃補正・ヘビーアタック | `directionMul` / `byDirection` | **2026-06-10 ほぼ確定（Wiki構造で発見）**: 「格闘方向補正」の正体は**N格/横格/下格（入力方向）**であり正面/側面/背面ではない。Wiki武器ページに「格闘方向補正」表（格闘方向/標準倍率/本武器倍率）があり、**標準倍率 = N格100% / 横格75% / 下格130%**・武器ごとに上書きあり（例: 横格100%(50%x2)）。「連撃補正」表も同様に存在（例: 1撃目100%/2撃目50%）。→ エンジンは標準値で実装・武器別上書きはパーサで取得。ヘビーアタック倍率のみ未確定 |
| §A-5 | 三すくみの正確な% | `triadMul` | **確定（方向・双方向・乗算位置）/ %のみ諸説あり** → 1.30/0.80 採用 |
| §A-6 | よろけ/ダウン/空中の与ダメUP・ダウン追撃 | `defenderState` / `vsStaggerDmgPct` | **未確定** → ▶後段（Phase 1 等倍） |
| §A-7 | 距離減衰・部位/急所別倍率 | `opts.distance` / 部位 | **未確定**（部位は atwiki も「再現不可」と明言）→ ▶後段 |
| §A-8 | 蓄積よろけ（武器別固定値・閾値100・3秒リセット・ダメコン/マニューバー） | `weapon.staggerValue` / ▶ TTK | **仕組みは確定** / Phase 1 は表示のみ・蓄積判定は▶後段 |

### A-2. 既に確定済み（CONCEPT §2-2 / §3-1）
- 武器属性判定 = ~~カテゴリ節見出し~~ → **`table_weapon_{shell|beam|close|other}` の div id で確定**（1-D実装済・見出しより頑健）。
- 集束/変形の複数威力モードは**式でなくデータ駆動**（武装表のノン/フル実値）→ §4-2 `modes`。1-D実装済。

### A-3. 既知の課題（2026-06-10 ユーザー指摘・今回は実装しない）

1. **NT-D / 覚醒系「能力UP」スキルがダメージシミュレーション上で切替できない**
   （フェネクス/ユニコーン等）。stat_bonus（射撃/格闘補正・装甲の一律上昇）は
   `applyParts` 経由で構成保存時の ON 状態が補正値に固定で織り込まれるのみで、
   dsim のトグル対象は firepower/damage_cut に限定している（二重計上回避のため §5-4）。
   - 対応案: `skillConditions` に stat_bonus 条件を追加（攻撃側=補正系 / 防御側=装甲系の両面）。
     トグル変更時は `getCombatProfile(buildData, overrideIndices)` で modified を再計算して
     プロファイルごと差し替える（エンジン側の乗算ではなく入力の再構築で扱う）。
2. **変形による機体性能変化（補正・装甲・機動の変化）が非モデル**。
   変形時武装の威力・備考（＜変形時＞表記）はデータ収録済みだが、変形中の機体側ステータス変化は
   Wiki に体系的な表が無く未対応。扱う場合はスキルテキスト解析 or 手動データが必要。

---

## 10. 既存コードとの接続点（実装入口・確定）

| 接続先 | 用途 |
|---|---|
| `App.savedBuilds` / `calcStatsFromBuild`（app.js） | `getCombatProfile` が同じ applyParts 経路で modified 算出 |
| `GBO2Calculator.calcCutRate` / 三すくみ定数（calculator.js） | 防御カット・有利不利の流用（§5-2/5-3） |
| `extractSkillEffects` / `_parseCondition`（calculator.js） | スキル条件トグルの語彙・与ダメ/カット値の供給（§5-4） |
| `updateBuildSelectOptions`（app.js） | 攻守 select の構成リスト供給（§6-4） |
| 計算方法モーダル（index.html） | ダメージ式を出典付きで公開・拡張（research 完了後） |
| data-repo `parse_ms_data.py` / CI | 武装パーサ追加・自動更新統合（§8 1-D） |
