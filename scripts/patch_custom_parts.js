const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "..", "data", "custom_parts.json");
const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

function findPart(name, level) {
  return data.parts.find((p) => p.name === name && p.level === level);
}

function patchPart(name, level, effects) {
  const part = findPart(name, level);
  if (!part) {
    console.error(`NOT FOUND: ${name} LV${level}`);
    return false;
  }
  if (part.effects.length > 0) {
    console.log(`SKIPPED (already has effects): ${name} LV${level}`);
    return false;
  }
  part.effects = effects;
  console.log(`PATCHED: ${name} LV${level} -> ${effects.length} effect(s)`);
  return true;
}

let patchCount = 0;

// 1. 教育型コンピューター［特防］ LV1: 10% all-attribute damage cut
if (
  patchPart("教育型コンピューター［特防］", 1, [
    { type: "ballistic_damage_cut_pct", value: 10 },
    { type: "beam_damage_cut_pct", value: 10 },
    { type: "melee_damage_cut_pct", value: 10 },
  ])
)
  patchCount++;

// 2. 教育型コンピューター LV1: 3% damage dealt + 3% damage received reduction
if (
  patchPart("教育型コンピューター", 1, [
    { type: "shooting_damage_pct", value: 3 },
    { type: "melee_damage_pct", value: 3 },
    { type: "ballistic_damage_cut_pct", value: 3 },
    { type: "beam_damage_cut_pct", value: 3 },
    { type: "melee_damage_cut_pct", value: 3 },
  ])
)
  patchCount++;

// 3. 教育型コンピューター［特射］ LV1: 4% shooting damage + 4% ranged damage cut
if (
  patchPart("教育型コンピューター［特射］", 1, [
    { type: "shooting_damage_pct", value: 4 },
    { type: "ballistic_damage_cut_pct", value: 4 },
    { type: "beam_damage_cut_pct", value: 4 },
  ])
)
  patchCount++;

// 4. 新型緩衝材 LV1: 3% all-attribute damage cut
if (
  patchPart("新型緩衝材", 1, [
    { type: "ballistic_damage_cut_pct", value: 3 },
    { type: "beam_damage_cut_pct", value: 3 },
    { type: "melee_damage_cut_pct", value: 3 },
  ])
)
  patchCount++;

// 5. オーバーチューン［実弾装甲］ LV1: 3% ballistic cut, +4%/level, max 15%
if (
  patchPart("オーバーチューン［実弾装甲］", 1, [
    {
      type: "ballistic_damage_cut_pct",
      value: 3,
      msLevelScaling: { perLevel: 4, max: 15 },
    },
  ])
)
  patchCount++;

// 6. オーバーチューン［ビーム装甲］ LV1: 3% beam cut, +4%/level, max 15%
if (
  patchPart("オーバーチューン［ビーム装甲］", 1, [
    {
      type: "beam_damage_cut_pct",
      value: 3,
      msLevelScaling: { perLevel: 4, max: 15 },
    },
  ])
)
  patchCount++;

// 7. オーバーチューン［格闘装甲］ LV1: 3% melee cut, +4%/level, max 15%
if (
  patchPart("オーバーチューン［格闘装甲］", 1, [
    {
      type: "melee_damage_cut_pct",
      value: 3,
      msLevelScaling: { perLevel: 4, max: 15 },
    },
  ])
)
  patchCount++;

// 8. フィールドモーター LV1/2/3: turn_speed +5/10/15
if (patchPart("フィールドモーター", 1, [{ type: "turn_speed", value: 5 }]))
  patchCount++;
if (patchPart("フィールドモーター", 2, [{ type: "turn_speed", value: 10 }]))
  patchCount++;
if (patchPart("フィールドモーター", 3, [{ type: "turn_speed", value: 15 }]))
  patchCount++;

// 9. カテゴリ特攻プログラム［強襲］ LV1: shooting +7, melee +7
if (
  patchPart("カテゴリ特攻プログラム［強襲］", 1, [
    { type: "shooting_correction", value: 7 },
    { type: "melee_correction", value: 7 },
  ])
)
  patchCount++;

fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
console.log(`\nDone. ${patchCount} part(s) patched.`);
