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

// ===== 1. calcCutRate（線形モデル: 防御補正1pt = 1%カット, 上限50） =====
section('calcCutRate: 防御値 → カット率（線形）');
assert('armor=0  → cutRate=0',          GBO2Calculator.calcCutRate(0),   0);
assert('armor=30 → cutRate=30%',        GBO2Calculator.calcCutRate(30),  0.30, 0.0001);
assert('armor=50 → cutRate=50%(上限)',  GBO2Calculator.calcCutRate(50),  0.50, 0.0001);
assert('armor=99 → cutRate=99%',        GBO2Calculator.calcCutRate(99),  0.99, 0.0001);
assert('armor=100→ cutRate=99%(クランプ)', GBO2Calculator.calcCutRate(100), 0.99, 0.0001);
assert('armor=負 → cutRate=0',          GBO2Calculator.calcCutRate(-10), 0);

// ===== 2. calcWeightedCutRate =====
section('calcWeightedCutRate: 加重平均カット率');
const armor3 = { ballistic: 50, beam: 30, melee: 0 };
const ratioEq = { ballistic: 1/3, beam: 1/3, melee: 1/3 };
const expected3 = (0.50 + 0.30 + 0) / 3;
assert('均等比率での加重平均',
  GBO2Calculator.calcWeightedCutRate(armor3, ratioEq), expected3, 0.0001
);
// 実弾100% のみ
const ratioBallOnly = { ballistic: 1, beam: 0, melee: 0 };
assert('実弾100%比率',
  GBO2Calculator.calcWeightedCutRate(armor3, ratioBallOnly), 0.50, 0.0001
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
// armor=50 全属性 → cutRate=50% → HP÷0.5 = HP×2
const armor50all = { ballistic: 50, beam: 50, melee: 50 };
assert('全防御50 均等 → HP×2',
  GBO2Calculator.calcEffectiveHP(5000, armor50all, ratioEq), 10000
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

// ===== 8b. applyParts: 高速移動(300)/旋回(200)上限・OH回復累積 =====
section('applyParts: 高速移動/旋回の上限・OH回復累積');
const mobBase = {
  hp: 10000, ballistic_armor: 0, beam_armor: 0, melee_armor: 0,
  shooting_correction: 0, melee_correction: 0, speed: 130,
  thruster: 50, boost_speed: 290, turn_speed_ground: 195, turn_speed_space: 195
};
const mobParts = [
  { effects: [{ type: 'boost_speed', value: 30 }] }, // 290+30=320 → 上限300
  { effects: [{ type: 'turn_speed', value: 20 }] },   // 195+20=215 → 上限200
  { effects: [{ type: 'oh_recovery_pct', value: 10 }] },
  { effects: [{ type: 'oh_recovery_pct', value: 15 }] },
];
const mobAfter = GBO2Calculator.applyParts(mobBase, mobParts, []);
assert('高速移動: 290+30=320 → 上限300',     mobAfter.boost_speed, 300);
assert('旋回(地上): 195+20=215 → 上限200',    mobAfter.turn_speed_ground, 200);
assert('旋回(宇宙): 195+20=215 → 上限200',    mobAfter.turn_speed_space, 200);
assert('OH回復: 10+15=25%累積',               mobAfter.ohRecoveryPct, 25);

// ===== 8c. applyParts: HP%バフ・補正乗算%・乗算後キャップ・上限capBonus =====
section('applyParts: HP%/補正乗算%/上限上昇');
const pctBase = {
  hp: 10000, ballistic_armor: 45, beam_armor: 10, melee_armor: 0,
  shooting_correction: 30, melee_correction: 90, speed: 130, thruster: 50
};
// HP%: 基準10000の5% = +500
const hpPctAfter = GBO2Calculator.applyParts(pctBase, [{ effects: [{ type: 'hp_pct', value: 5 }] }], []);
assert('HP%+5% → 10000+500=10500', hpPctAfter.hp, 10500);
// 射撃補正乗算 +20%: 30×1.2=36
const multAfter = GBO2Calculator.applyParts(pctBase, [{ effects: [{ type: 'shooting_correction_mult_pct', value: 20 }] }], []);
assert('射撃補正 30×1.2 = 36', multAfter.shooting_correction, 36);
// 格闘補正乗算 +20%: 90×1.2=108 → 上限100でクランプ
const meleeMultAfter = GBO2Calculator.applyParts(pctBase, [{ effects: [{ type: 'melee_correction_mult_pct', value: 20 }] }], []);
assert('格闘補正 90×1.2=108 → 上限100', meleeMultAfter.melee_correction, 100);
// 耐実弾乗算 +20%: 45×1.2=54 → 上限50でクランプ
const armMult = GBO2Calculator.applyParts(pctBase, [{ effects: [{ type: 'ballistic_armor_mult_pct', value: 20 }] }], []);
assert('耐実弾 45×1.2=54 → 上限50', armMult.ballistic_armor, 50);
// 拡張スキルで射撃補正上限+12 → 90+20(パーツ)=110 → 上限112でクランプされず110
const capSkill = [{ name: 'X', level: 1, effects: [{ type: 'shooting_correction_cap', value: 12, direct: true }] }];
const capUpBase = { ...pctBase, shooting_correction: 90 };
const capAfter = GBO2Calculator.applyParts(capUpBase, [{ effects: [{ type: 'shooting_correction', value: 20 }] }], capSkill);
assert('上限+12時: 射撃90+20=110 ≤ 112 → 110', capAfter.shooting_correction, 110);

// ===== 9. 構成比較ロジック（スタンドアロン関数テスト）=====
section('renderCompareResults: 優劣判定ロジック');
// 直接テストできないが、_computeCalcResult の入力検証
function computeSimple(hp, ballArm) {
  const cut = GBO2Calculator.calcCutRate(ballArm);
  const ratio = { ballistic: 1, beam: 0, melee: 0 };
  const cuts = { ballistic: cut, beam: 0, melee: 0 };
  return GBO2Calculator.calcEffectiveHPFromCutRates(hp, cuts, ratio);
}
assert('HP10000 armor=50 → 有効HP20000', computeSimple(10000, 50), 20000);
assert('HP5000  armor=0   → 有効HP5000',  computeSimple(5000, 0),   5000);

// ===== 10. _greedySelect / optimizeFocused =====
section('optimizeFocused: 攻撃特化');
const focusBase = {
  hp: 15000, ballistic_armor: 20, beam_armor: 20, melee_armor: 10,
  shooting_correction: 30, melee_correction: 20, speed: 120, thruster: 60
};
const focusParts = [
  { name: 'A', slots: { close: 1, mid: 0, long: 0 }, effects: [{ type: 'shooting_correction', value: 15 }] },
  { name: 'B', slots: { close: 0, mid: 1, long: 0 }, effects: [{ type: 'melee_correction', value: 10 }] },
  { name: 'C', slots: { close: 0, mid: 0, long: 1 }, effects: [{ type: 'hp', value: 2000 }] },
  { name: 'D', slots: { close: 1, mid: 0, long: 0 }, effects: [{ type: 'thruster', value: 10 }] },
  { name: 'E', slots: { close: 0, mid: 1, long: 0 }, effects: [{ type: 'ballistic_armor', value: 8 }] },
];
const focusSlots = { close: 3, mid: 3, long: 3 };
const focusConfig = { msLevel: 1, enhanceLevel: 0, expansionSkillsList: [], equippedParts: [] };

const atkResult = GBO2Calculator.optimizeFocused(focusBase, focusSlots, focusParts, {
  ...focusConfig, mode: 'attack', atkRatio: { shooting: 0.5, melee: 0.5 }
});
const atkNames = atkResult.map(p => p.name);
assert('攻撃特化: AとBを選択', atkNames.includes('A') && atkNames.includes('B'), true);
assert('攻撃特化: Dは非選択', !atkNames.includes('D'), true);

section('optimizeFocused: 防御特化');
const defResult = GBO2Calculator.optimizeFocused(focusBase, focusSlots, focusParts, {
  ...focusConfig, mode: 'defense', damageRatio: { ballistic: 1/3, beam: 1/3, melee: 1/3 }
});
const defNames = defResult.map(p => p.name);
assert('防御特化: CとEを選択', defNames.includes('C') && defNames.includes('E'), true);

section('optimizeFocused: スラスター特化');
const thrResult = GBO2Calculator.optimizeFocused(focusBase, focusSlots, focusParts, {
  ...focusConfig, mode: 'thruster'
});
assert('スラスター特化: Dを選択', thrResult.length >= 1 && thrResult[0].name === 'D', true);
assert('スラスター特化: D以外は選ばない', thrResult.every(p => p.name === 'D'), true);

section('optimizeFocused: 上限到達時に停止');
const capBase = { ...focusBase, shooting_correction: 95 };
const capResult = GBO2Calculator.optimizeFocused(capBase, focusSlots, focusParts, {
  ...focusConfig, mode: 'attack', atkRatio: { shooting: 1, melee: 0 }
});
// 射撃補正が95→上限100で5しか効かないが、他に射撃系がないので A は選ばれうる
// B(格闘)はatk比率melee=0なので貢献0 → 選ばれない
const capNames = capResult.map(p => p.name);
assert('上限近接時: Bは不選択(格闘配分0)', !capNames.includes('B'), true);

section('optimize: 同名+同LVは重複不可 / LV違いは追加可');
const optBase = { ...focusBase };
const aLv1 = { name: 'A', level: 1, slots: { close: 1, mid: 0, long: 0 }, effects: [{ type: 'shooting_correction', value: 15 }] };
const aLv2 = { name: 'A', level: 2, slots: { close: 1, mid: 0, long: 0 }, effects: [{ type: 'shooting_correction', value: 20 }] };
const preEquipped = [aLv1]; // A LV1 を既装備
const optResult = GBO2Calculator.optimize(optBase, focusSlots, [aLv1, aLv2], {
  ...focusConfig, equippedParts: preEquipped, selectedStats: ['shooting_correction']
});
// 同名+同LV(A LV1)は重複不可。同名でもLV違い(A LV2)は追加できる。
assert('既装備と同名+同LV(A LV1)は重複追加されない', optResult.some(p => p.name === 'A' && p.level === 1), false);
assert('同名でもLV違い(A LV2)は追加されうる', optResult.some(p => p.name === 'A' && p.level === 2), true);

// ===== 11. カスタムパーツ相互排他 (partsConflict / 最適化) =====
section('排他: partsConflict 基本');
const pSameA1 = { name: '射撃強化プログラム', level: 1, slots: { close: 1, mid: 0, long: 0 }, effects: [{ type: 'shooting_correction', value: 4 }], description: '射撃補正が増加。' };
const pSameA3 = { name: '射撃強化プログラム', level: 3, slots: { close: 2, mid: 0, long: 0 }, effects: [{ type: 'shooting_correction', value: 8 }], description: '射撃補正が増加。' };
const pFrameA = { name: '特殊強化フレーム［Type-A］', level: 1, slots: { close: 3, mid: 7, long: 5 }, effects: [{ type: 'hp_pct', value: 5 }], description: '機体HPが5%増加。耐実弾補正と耐ビーム補正が9増加。特殊強化フレーム系パーツは複数装備できない。' };
const pFrameB = { name: '特殊強化フレーム［Type-B］', level: 1, slots: { close: 11, mid: 1, long: 3 }, effects: [{ type: 'hp_pct', value: 5 }], description: '機体HPが5%増加。耐格闘補正が18増加。特殊強化フレーム系パーツは複数装備できない。' };
const pDevG = { name: '特殊強化装置［Type-γ］', level: 1, slots: { close: 4, mid: 4, long: 4 }, effects: [{ type: 'hp', value: 1200 }], description: '各補正が14%増加。機体HPが1200増加。なお特殊強化装置系のパーツは複数装備不可。' };
const pDevA = { name: '特殊強化装置［Type-α］', level: 1, slots: { close: 4, mid: 4, long: 4 }, effects: [{ type: 'hp', value: 1000 }], description: '格闘補正が20%増加。機体HPが1000増加。なお特殊強化装置系のパーツは複数装備不可。' };
const pSpeedX = { name: '運動性能強化機構', level: 1, slots: { close: 2, mid: 2, long: 2 }, effects: [{ type: 'speed', value: 10 }, { type: 'turn_speed', value: 5 }], description: 'スピードが10増加し、旋回性能が5増加。なおスピードまたは旋回性能が上昇するパーツとの同時装備は行えない。' };
const pSpeedY = { name: 'サイコフレーム', level: 1, slots: { close: 1, mid: 1, long: 1 }, effects: [{ type: 'turn_speed', value: 7 }], description: '旋回性能が増加。' };
const pThruster = { name: '噴射制御装置', level: 1, slots: { close: 1, mid: 0, long: 0 }, effects: [{ type: 'thruster', value: 10 }], description: 'スラスターが増加。' };

assert('通常パーツは同名でもLV違いなら共存可', GBO2Calculator.partsConflict(pSameA1, pSameA3), false);
assert('全く同じパーツ(同名+同LV)は重複不可', GBO2Calculator.partsConflict(pSameA1, pSameA1), true);
assert('特殊強化フレーム Type-A と Type-B は共存不可', GBO2Calculator.partsConflict(pFrameA, pFrameB), true);
assert('特殊強化フレーム Type-A 同士も共存不可(系統で1つ)', GBO2Calculator.partsConflict(pFrameA, pFrameA), true);
assert('特殊強化装置 γ と α は共存不可(「不可」表記)', GBO2Calculator.partsConflict(pDevG, pDevA), true);
assert('運動性能強化機構 と 旋回上昇パーツは共存不可', GBO2Calculator.partsConflict(pSpeedX, pSpeedY), true);
assert('運動性能強化機構 と スラスターのみは共存可', GBO2Calculator.partsConflict(pSpeedX, pThruster), false);
assert('別系統パーツ同士は共存可', GBO2Calculator.partsConflict(pFrameA, pThruster), false);
assert('スラスターと旋回パーツは共存可(排他指定なし)', GBO2Calculator.partsConflict(pThruster, pSpeedY), false);

section('重複: 同名+同LVは複数装備できない / LV違いは可');
const stackPartLv5 = { name: '射撃強化プログラム', level: 5, slots: { close: 1, mid: 0, long: 0 }, effects: [{ type: 'shooting_correction', value: 5 }], description: '射撃補正が増加。' };
const stackPartLv1 = { name: '射撃強化プログラム', level: 1, slots: { close: 1, mid: 0, long: 0 }, effects: [{ type: 'shooting_correction', value: 3 }], description: '射撃補正が増加。' };
const stackBase = { ...focusBase, shooting_correction: 0 };
const stackResSame = GBO2Calculator.optimize(stackBase, { close: 5, mid: 0, long: 0 }, [stackPartLv5], {
  ...focusConfig, selectedStats: ['shooting_correction']
});
assert('同名+同LVは最適化で1つだけ(重複しない)', stackResSame.filter(p => p.name === '射撃強化プログラム').length, 1);
const stackResMixed = GBO2Calculator.optimize(stackBase, { close: 5, mid: 0, long: 0 }, [stackPartLv5, stackPartLv1], {
  ...focusConfig, selectedStats: ['shooting_correction']
});
assert('同名でもLV違いは併用されうる', stackResMixed.filter(p => p.name === '射撃強化プログラム').length >= 2, true);

section('排他: 最適化が共存不可パーツを同時選択しない');
const exParts = [pFrameA, pFrameB, pDevG, pDevA, pSameA1, pSameA3];
const exSlots = { close: 40, mid: 40, long: 40 }; // スロットは潤沢にして排他のみで制限
const exResult = GBO2Calculator.optimize(focusBase, exSlots, exParts, {
  ...focusConfig, selectedStats: ['hp', 'shooting_correction', 'melee_correction', 'ballistic_armor', 'beam_armor', 'melee_armor']
});
const frameCount = exResult.filter(p => p.name.startsWith('特殊強化フレーム')).length;
const devCount = exResult.filter(p => p.name.startsWith('特殊強化装置')).length;
assert('特殊強化フレーム系は最大1つ', frameCount <= 1, true);
assert('特殊強化装置系は最大1つ', devCount <= 1, true);

section('排他: 既装備との競合を回避');
const exResult2 = GBO2Calculator.optimize(focusBase, exSlots, exParts, {
  ...focusConfig, equippedParts: [pFrameA], selectedStats: ['hp', 'melee_correction']
});
assert('既装備 特殊強化フレームType-A がある時 Type-B を追加しない',
  !exResult2.some(p => p.name === '特殊強化フレーム［Type-B］'), true);

// ===== 12. 拡張スキル: カスタムパーツ複合拡張α (per_custom_part) =====
section('拡張スキル: 複合拡張α(攻撃タイプ毎にHP/スラスター/高速移動/リロード短縮)');
const compAlphaLv5 = {
  name: 'カスタムパーツ複合拡張α', level: 5, category: 'custom_parts',
  effects: [{
    type: 'per_custom_part', targetPartTypes: ['attack'],
    perPartEffects: [
      { type: 'hp', value: 250 }, { type: 'thruster', value: 2 },
      { type: 'boost_speed', value: 2 }, { type: 'reload_oh_reduction_pct', value: 1 },
    ],
  }],
};
const compBase = { hp: 19500, thruster: 55, boost_speed: 220, shooting_correction: 30, melee_correction: 20, ballistic_armor: 20, beam_armor: 20, melee_armor: 10 };
const atk3 = [
  { name: '射撃強化プログラム', level: 1, category: 'attack', slots: { close: 1, mid: 0, long: 0 }, effects: [{ type: 'shooting_correction', value: 4 }], description: '射撃補正が増加。' },
  { name: '射撃強化プログラム', level: 2, category: 'attack', slots: { close: 1, mid: 0, long: 0 }, effects: [{ type: 'shooting_correction', value: 5 }], description: '射撃補正が増加。' },
  { name: '射撃強化プログラム', level: 3, category: 'attack', slots: { close: 1, mid: 0, long: 0 }, effects: [{ type: 'shooting_correction', value: 7 }], description: '射撃補正が増加。' },
];
const compMod = GBO2Calculator.applyParts(compBase, atk3, [compAlphaLv5], 1, 0);
assert('複合拡張α: HP +250×3=750', compMod.hp - compBase.hp, 750);
assert('複合拡張α: スラスター +2×3=6', compMod.thruster - compBase.thruster, 6);
assert('複合拡張α: 高速移動 +2×3=6', compMod.boost_speed - compBase.boost_speed, 6);
assert('複合拡張α: リロード/OH短縮 -1%×3=-3%', compMod.reloadOhReductionPct, 3);
// 攻撃タイプ以外のパーツには発動しない
const def1 = [{ name: 'シールド補強材', level: 1, category: 'defense', slots: { close: 0, mid: 1, long: 0 }, effects: [{ type: 'hp', value: 500 }], description: '機体HPが増加。' }];
const compModDef = GBO2Calculator.applyParts(compBase, def1, [compAlphaLv5], 1, 0);
assert('複合拡張α: 防御タイプには発動しない(HP増分はパーツ分のみ)', compModDef.hp - compBase.hp, 500);

// ===== 13. 目標値(下限)最適化 optimizeToTargets =====
section('目標値最適化: 達成可能ケース');
const tgtBase = { hp: 15000, ballistic_armor: 20, beam_armor: 20, melee_armor: 10, shooting_correction: 30, melee_correction: 20, speed: 120, thruster: 50 };
// 同名+同LV重複は不可のため、目標到達には個々のパーツが十分強いか、複数の別パーツが必要。
const tgtParts = [
  { name: 'P-armor', level: 1, category: 'defense', slots: { close: 1, mid: 0, long: 0 }, effects: [{ type: 'ballistic_armor', value: 15 }], description: '耐実弾補正が増加。' },
  { name: 'P-thr', level: 1, category: 'defense', slots: { close: 0, mid: 1, long: 0 }, effects: [{ type: 'thruster', value: 20 }], description: 'スラスターが増加。' },
  { name: 'P-hp', level: 1, category: 'support', slots: { close: 0, mid: 0, long: 1 }, effects: [{ type: 'hp', value: 2000 }], description: '機体HPが増加。' },
];
const tgtSlots = { close: 5, mid: 5, long: 5 };
const tgtCfg = { msLevel: 1, enhanceLevel: 0, expansionSkillsList: [], equippedParts: [] };
const feasible = GBO2Calculator.optimizeToTargets(tgtBase, tgtSlots, tgtParts, { ...tgtCfg, targets: { ballistic_armor: 35, thruster: 70 } });
assert('達成可能: allMet=true', feasible.allMet, true);
assert('達成可能: 耐実弾が目標35以上', feasible.results.find(r => r.stat === 'ballistic_armor').achieved >= 35, true);
assert('達成可能: スラスターが目標70以上', feasible.results.find(r => r.stat === 'thruster').achieved >= 70, true);

section('目標値最適化: スロット不足で未達');
const tinySlots = { close: 1, mid: 0, long: 0 };
const infeasSlot = GBO2Calculator.optimizeToTargets(tgtBase, tinySlots, tgtParts, { ...tgtCfg, targets: { ballistic_armor: 40, thruster: 90, hp: 20000 } });
assert('スロット不足: allMet=false', infeasSlot.allMet, false);
assert('スロット不足: usedAllSlots=true', infeasSlot.usedAllSlots, true);

section('目標値最適化: ステータス上限超過で到達不可');
const capInfeas = GBO2Calculator.optimizeToTargets(tgtBase, tgtSlots, tgtParts, { ...tgtCfg, targets: { ballistic_armor: 60 } });
assert('上限超過: allMet=false', capInfeas.allMet, false);
assert('上限超過: capExceeded=true (上限50)', capInfeas.results.find(r => r.stat === 'ballistic_armor').capExceeded, true);

// ===== 14. 強化リスト: 同名強化(上限開放)の置換（二重計上しない） =====
section('強化: 同名強化は最高Lvのみ採用（上限開放の二重計上を防ぐ）');
const enhListDup = [
  { skill_name: '耐ビーム装甲補強 Lv1', effect: '耐ビーム補正が1増加', ms_levels: [1, 2] },
  { skill_name: 'AD-PA Lv1', effect: '格闘補正が1増加', ms_levels: [1, 2] },
  { skill_name: 'シールド構造強化 Lv1', effect: 'シールドHPが100増加', ms_levels: [1, 2] },
  { skill_name: '複合拡張パーツスロット Lv1', effect: '近・中・遠のパーツスロットが1スロずつ増加', ms_levels: [1, 2] },
  { skill_name: '耐ビーム装甲補強 Lv4', effect: '耐ビーム補正が5増加', ms_levels: [1, 2] },
  { skill_name: 'AD-PA Lv4', effect: '格闘補正が5増加', ms_levels: [1, 2] },
];
const enhBase = { hp: 29000, beam_armor: 37, melee_correction: 44 };
// 強化6段階・MS LV2: 耐ビームは Lv1(+1)+Lv4(+5) ではなく Lv4(+5) のみ → 37+5=42
const enhMod6 = GBO2Calculator.applyEnhancements(enhBase, enhListDup, 6, 2);
assert('上限開放: 耐ビームは最高Lv(+5)で置換 (二重計上なし)', enhMod6.beam_armor, 42);
assert('上限開放: 格闘補正は最高Lv(+5)で置換', enhMod6.melee_correction, 49);
// Lv4到達前(4段階)は Lv1(+1)
const enhMod4 = GBO2Calculator.applyEnhancements(enhBase, enhListDup, 4, 2);
assert('4段階(上限開放前): 耐ビームはLv1(+1)', enhMod4.beam_armor, 38);
// resolveActiveEnhancements: 6エントリ → ベース名4種に集約
const active6 = GBO2Calculator.resolveActiveEnhancements(enhListDup, 6, 2);
assert('適用強化は4種(同名は最高Lvのみ)', active6.length, 4);
assert('採用された耐ビームはLv4', active6.some(e => e.skill_name === '耐ビーム装甲補強 Lv4'), true);
assert('Lv1の耐ビームは不採用', active6.some(e => e.skill_name === '耐ビーム装甲補強 Lv1'), false);

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
