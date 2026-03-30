/**
 * GBO2 Calculator テストスイート (Node.js で実行)
 * 実行: node tests/test_calculator.js
 */

// calculator.js を Node.js で読み込む (const は eval スコープ外に漏れないため Function ラッパーを使用)
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../js/calculator.js', 'utf8');
const GBO2Calculator = (new Function(src + '\nreturn GBO2Calculator;'))();

// ===== テストユーティリティ =====
let passed = 0, failed = 0;

function assert(label, actual, expected, tolerance = 0) {
  const ok = tolerance > 0
    ? Math.abs(actual - expected) <= tolerance
    : actual === expected;
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`      expected: ${expected}, got: ${actual}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n── ${name} ──`);
}

// ===== 1. calcCutRate =====
section('calcCutRate: 防御値 → カット率');
assert('armor=0  → cutRate=0',        GBO2Calculator.calcCutRate(0),   0);
assert('armor=50 → cutRate≈33.3%',    GBO2Calculator.calcCutRate(50),  50/150, 0.0001);
assert('armor=100 → cutRate=50%',     GBO2Calculator.calcCutRate(100), 100/200, 0.0001);
assert('armor=200 → cutRate≈66.7%',   GBO2Calculator.calcCutRate(200), 200/300, 0.0001);
assert('armor=負 → cutRate=0',        GBO2Calculator.calcCutRate(-10), 0);

// ===== 2. calcWeightedCutRate =====
section('calcWeightedCutRate: 加重平均カット率');
const armor3 = { ballistic: 100, beam: 50, melee: 0 };
const ratioEq = { ballistic: 1/3, beam: 1/3, melee: 1/3 };
const expected3 = (100/200 + 50/150 + 0) / 3;
assert('均等比率での加重平均',
  GBO2Calculator.calcWeightedCutRate(armor3, ratioEq), expected3, 0.0001
);
// 実弾100% のみ
const ratioBallOnly = { ballistic: 1, beam: 0, melee: 0 };
assert('実弾100%比率',
  GBO2Calculator.calcWeightedCutRate(armor3, ratioBallOnly), 100/200, 0.0001
);

// ===== 3. calcShootingMultiplier / calcMeleeMultiplier =====
section('calcShootingMultiplier / calcMeleeMultiplier');
assert('補正0  → 倍率1.00', GBO2Calculator.calcShootingMultiplier(0),   1.0);
assert('補正50 → 倍率1.50', GBO2Calculator.calcShootingMultiplier(50),  1.5);
assert('補正100→ 倍率2.00', GBO2Calculator.calcShootingMultiplier(100), 2.0);
assert('格闘補正50 → 1.50', GBO2Calculator.calcMeleeMultiplier(50),     1.5);

// ===== 4. calcEffectiveHP =====
section('calcEffectiveHP: HP / (1 - 加重カット率)');
const armorZero = { ballistic: 0, beam: 0, melee: 0 };
assert('防御0 → 有効HP=HP',
  GBO2Calculator.calcEffectiveHP(10000, armorZero, ratioEq), 10000
);
// armor=100 全属性 → cutRate=50% → HP÷0.5 = HP×2
const armor100all = { ballistic: 100, beam: 100, melee: 100 };
assert('全防御100 均等 → HP×2',
  GBO2Calculator.calcEffectiveHP(5000, armor100all, ratioEq), 10000
);

// ===== 5. calcEffectiveHPFromCutRates =====
section('calcEffectiveHPFromCutRates: カット率直接指定');
const cuts50 = { ballistic: 0.5, beam: 0.5, melee: 0.5 };
assert('全カット率0.5 → HP×2',
  GBO2Calculator.calcEffectiveHPFromCutRates(5000, cuts50, ratioEq), 10000
);
const cuts0 = { ballistic: 0, beam: 0, melee: 0 };
assert('全カット率0 → HP変化なし',
  GBO2Calculator.calcEffectiveHPFromCutRates(8000, cuts0, ratioEq), 8000
);
// スキルDC 20% + パーツカット50% = 1-(1-0.5)*(1-0.2) = 1-0.4 = 0.6 → HP/(1-0.6)=HP/0.4=HP×2.5
const cutsWithSkill = { ballistic: 0.6, beam: 0.6, melee: 0.6 };
assert('合算カット率0.6 → HP÷0.4',
  GBO2Calculator.calcEffectiveHPFromCutRates(4000, cutsWithSkill, ratioEq), 10000
);

// ===== 6. よろけ耐性計算ロジック =====
section('よろけ耐性: 100 / combined');
function staggerResistance(combined) {
  if (combined <= 0) return Infinity;
  return Math.round(100 / combined);
}
assert('スキル×0.5 → 耐性200%', staggerResistance(0.5),  200);
assert('スキル×0.8 → 耐性125%', staggerResistance(0.8),  125);
assert('スキル×1.0 → 耐性100%', staggerResistance(1.0),  100);
assert('スキル×0.25→ 耐性400%', staggerResistance(0.25), 400);

// ===== 7. applyParts: 上限クランプ =====
section('applyParts: 防御補正の上限(50)クランプ');
const baseStats = {
  hp: 10000,
  ballistic_armor: 30,
  beam_armor: 30,
  melee_armor: 0,
  shooting_correction: 10,
  melee_correction: 10,
  speed: 100,
  thruster: 50
};
const heavyDefenseParts = [
  { effects: [{ type: 'ballistic_armor', value: 40 }] }, // 30+40=70 → clamp→50
  { effects: [{ type: 'beam_armor', value: 5 }] },        // 30+5=35 → OK
];
const after = GBO2Calculator.applyParts(baseStats, heavyDefenseParts, []);
assert('耐実弾: 30+40=70 → 上限50でクランプ', after.ballistic_armor, 50);
assert('耐ビーム: 30+5=35 → クランプなし',     after.beam_armor, 35);
assert('HP: 変化なし',                         after.hp, 10000);

// ===== 8. applyParts: 攻撃補正の上限(100)クランプ =====
section('applyParts: 攻撃補正の上限(100)クランプ');
const baseWithHighCorr = { ...baseStats, shooting_correction: 80, melee_correction: 80 };
const attackParts = [
  { effects: [{ type: 'shooting_correction', value: 40 }] }, // 80+40=120 → 100
  { effects: [{ type: 'melee_correction', value: 10 }] },    // 80+10=90 → OK
];
const afterAtk = GBO2Calculator.applyParts(baseWithHighCorr, attackParts, []);
assert('射撃補正: 80+40=120 → 上限100でクランプ', afterAtk.shooting_correction, 100);
assert('格闘補正: 80+10=90  → クランプなし',       afterAtk.melee_correction, 90);

// ===== 9. 構成比較ロジック（スタンドアロン関数テスト）=====
section('renderCompareResults: 優劣判定ロジック');
// 直接テストできないが、_computeCalcResult の入力検証
function computeSimple(hp, ballArm) {
  const cut = GBO2Calculator.calcCutRate(ballArm);
  const ratio = { ballistic: 1, beam: 0, melee: 0 };
  const cuts = { ballistic: cut, beam: 0, melee: 0 };
  return GBO2Calculator.calcEffectiveHPFromCutRates(hp, cuts, ratio);
}
assert('HP10000 armor=100 → 有効HP20000', computeSimple(10000, 100), 20000);
assert('HP5000  armor=0   → 有効HP5000',  computeSimple(5000, 0),   5000);

// ===== 結果サマリ =====
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`結果: ${passed} 件成功 / ${failed} 件失敗 / 計 ${passed + failed} 件`);
if (failed > 0) {
  console.error('一部テスト失敗。calculator.js を確認してください。');
  process.exit(1);
} else {
  console.log('全テスト通過！');
  process.exit(0);
}
