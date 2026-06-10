/**
 * GBO2 ダメージ計算エンジン
 *
 * 計算式の根拠（実ゲーム仕様・一次/二次ソースで確認済み）:
 *   ダメージ = 武器威力 × (100 + 攻撃補正)/100 × (100 − 防御補正)/100 × その他乗算カット
 *   - 攻撃補正(射撃/格闘): 1pt = +1% の線形バフ。上限100（=与ダメ2倍）
 *   - 防御補正(耐実弾/耐ビーム/耐格闘): 1pt = 1% の線形カット。上限50（=被ダメ50%減）
 *   - 部位カット・属性ダメージ軽減等は乗算で合成（例: 0.6 × 0.6 = 0.36）
 * 出典:
 *   - ゲームライン 戦闘システム https://gameline.jp/gundam-battleoperation2/game-system/battle-system/
 *   - バトオペ2攻略wiki(Gamerch) https://gamerch.com/batoope/39352
 *   - 弱小賢者の備忘録（補正計算） https://note.com/jakushoukennja/n/n1eb582715459
 *
 * ※ 旧実装は防御を armor/(100+armor) の逓減近似としていたが、これは誤り。
 *   実ゲームは 1pt=1% の線形（耐50→50%カット）。本エンジンは線形モデルを採用する。
 */

const GBO2Calculator = {
  // 三すくみ補正（強襲>支援>汎用>強襲）。有利+30% / 不利-20%
  TYPE_ADVANTAGE: {
    '強襲': { strong: '支援', weak: '汎用' },
    '汎用': { strong: '強襲', weak: '支援' },
    '支援': { strong: '汎用', weak: '強襲' }
  },
  ADVANTAGE_MULTIPLIER: 1.30,
  DISADVANTAGE_MULTIPLIER: 0.80,

  // 各ステータス上限（拡張スキルによる上限上昇は capBonus で加算）
  ATTACK_CAP: 100,      // 射撃補正 / 格闘補正
  DEFENSE_CAP: 50,      // 耐実弾 / 耐ビーム / 耐格闘
  SPEED_CAP: 200,       // スピード
  THRUSTER_CAP: 100,    // スラスター
  BOOST_SPEED_CAP: 300, // 高速移動
  TURN_CAP: 200,        // 旋回（地上/宇宙）

  // cap上昇エフェクトの type → 上限ボーナスを足し込む stat キー。
  // 拡張スキル（耐ビーム補正拡張 等）と新型装甲系カスタムパーツ（新型耐ビーム装甲 等）が
  // 持つ「○○の上限値が N 増加」を一元的に解釈する単一の情報源。
  // applyParts のクランプと optimizeToTargets の到達可否判定の両方で共用し、
  // 上限定義の二重管理（＝50超を見落とす原因）を防ぐ。
  CAP_EFFECT_TO_KEY: {
    shooting_correction_cap: 'shooting_correction',
    melee_correction_cap:    'melee_correction',
    ballistic_armor_cap:     'ballistic_armor',
    beam_armor_cap:          'beam_armor',
    melee_armor_cap:         'melee_armor',
    thruster_cap:            'thruster',
    boost_speed_cap:         'boost_speed',
    speed_cap:               'speed',
    turn_speed_cap:          'turn_speed',
  },

  // capBonus の初期オブジェクト（全キー0）を生成する
  _emptyCapBonus() {
    return {
      shooting_correction: 0, melee_correction: 0,
      ballistic_armor: 0, beam_armor: 0, melee_armor: 0,
      thruster: 0, boost_speed: 0, speed: 0, turn_speed: 0,
    };
  },

  /**
   * 拡張スキル（direct な cap 効果）＋装備パーツ（cap 効果）から上限値ボーナスを集計する。
   * applyParts のクランプ上限と、目標値最適化の到達可否判定で共用する。
   * @param {Array} parts - 装備パーツ配列
   * @param {Array} expansionSkillsList - 選択中の拡張スキル配列
   * @param {number} msLevel
   * @param {number} enhanceLevel
   * @returns {object} capBonus（stat キー → 上限加算値）
   */
  collectCapBonus(parts, expansionSkillsList, msLevel = 1, enhanceLevel = 0) {
    const capBonus = this._emptyCapBonus();
    const MAP = this.CAP_EFFECT_TO_KEY;
    for (const skill of (expansionSkillsList || [])) {
      for (const eff of (skill.effects || [])) {
        if (eff.type === 'per_custom_part' || !eff.direct) continue;
        const key = MAP[eff.type];
        if (key) capBonus[key] += eff.value;
      }
    }
    for (const part of (parts || [])) {
      if (!part || !part.effects) continue;
      for (const eff of part.effects) {
        const key = MAP[eff.type];
        if (key) capBonus[key] += this.resolveEffectValue(eff, msLevel, enhanceLevel);
      }
    }
    return capBonus;
  },

  /**
   * 防御補正によるダメージカット率（0〜1）を計算
   * 実ゲーム: 被ダメ倍率 = (100 − 防御補正)/100 → カット率 = 防御補正/100（線形）
   * 防御補正の上限は素で50（=50%カット）、拡張スキルで上限上昇しうる。引数は
   * applyParts でキャップ適用済みの値を渡す前提。99 クランプは 0 除算・∞EHP を防ぐ
   * 安全弁であり、素の防御補正カット自体の仕様上限（通常50）とは別物。
   * @param {number} armor - 防御補正値（キャップ適用済み）
   * @returns {number} カット率 0〜0.99
   */
  calcCutRate(armor) {
    if (armor <= 0) return 0;
    return Math.min(armor, 99) / 100;
  },

  /**
   * 射撃火力倍率を計算
   * 攻撃補正による与ダメージ増加率
   */
  calcShootingMultiplier(shootingCorrection) {
    return 1 + (shootingCorrection / 100);
  },

  /**
   * 格闘火力倍率を計算
   */
  calcMeleeMultiplier(meleeCorrection) {
    return 1 + (meleeCorrection / 100);
  },

  /**
   * 加重平均カット率を計算
   * @param {object} armor - { ballistic, beam, melee }
   * @param {object} ratio - { ballistic, beam, melee } (0-1, 合計=1)
   */
  calcWeightedCutRate(armor, ratio) {
    const bCut = this.calcCutRate(armor.ballistic);
    const beCut = this.calcCutRate(armor.beam);
    const mCut = this.calcCutRate(armor.melee);
    
    return bCut * ratio.ballistic + beCut * ratio.beam + mCut * ratio.melee;
  },

  /**
   * 有効HPを計算（防御値から）
   * 有効HP = HP / (1 - 加重カット率)
   */
  calcEffectiveHP(hp, armor, damageRatio) {
    const avgCut = this.calcWeightedCutRate(armor, damageRatio);
    return Math.round(hp / (1 - avgCut));
  },

  /**
   * 有効HPを計算（カット率から直接）
   * @param {number} hp
   * @param {{ ballistic, beam, melee }} cutRates - 各属性のカット率 (0-1)
   * @param {{ ballistic, beam, melee }} damageRatio
   */
  calcEffectiveHPFromCutRates(hp, cutRates, damageRatio) {
    const avgCut = cutRates.ballistic * damageRatio.ballistic
      + cutRates.beam * damageRatio.beam
      + cutRates.melee * damageRatio.melee;
    const denom = 1 - avgCut;
    if (denom <= 0) return hp;
    return Math.round(hp / denom);
  },

  /**
   * HP閾値で発動するダメージカット/耐性上昇を考慮した「区間加重 有効HP」を計算する。
   * HPバーをしきい値で区切り、各区間で発動中スキルのカット（装甲上昇＋被ダメ%軽減）を
   * 乗算合成して区間ごとの実効HPを合算する。閾値=1（HP非依存・常時/発動中ON）の効果は
   * 全区間に適用される。EHP本体（装甲＋パーツのみ）には影響を与えない独立計算。
   *
   * @param {number} hp - 最大HP（しきい値で変化しない素のHP）
   * @param {{ballistic,beam,melee}} armor - 装甲補正pt（パーツ込み・スキル装甲ボーナスは含めない）
   * @param {{ballistic,beam,melee}} partsCutPct - パーツの属性ダメージカット%（常時）
   * @param {Array} effects - [{threshold:0〜1, dcPct?:{ballistic,beam,melee}, armorAdd?:{ballistic,beam,melee}}]
   * @param {{ballistic,beam,melee}} damageRatio - 被弾配分（正規化済み）
   * @returns {number} 区間加重 有効HP
   */
  calcThresholdedEffectiveHP(hp, armor, partsCutPct, effects, damageRatio) {
    if (!hp || hp <= 0) return 0;
    const list = effects || [];
    // 区間境界 = 1.0 と 各しきい値(0<t<1) と 0.0
    const ths = [...new Set(list.map(e => e.threshold).filter(t => t > 0 && t < 1))].sort((a, b) => b - a);
    const bounds = [1, ...ths, 0];
    // 装甲上限: 素のパーツ装甲が上限超なら（拡張スキルcap）それを維持、通常は素上限50
    const armorCap = {
      ballistic: Math.max(armor.ballistic || 0, this.DEFENSE_CAP),
      beam:      Math.max(armor.beam || 0,      this.DEFENSE_CAP),
      melee:     Math.max(armor.melee || 0,     this.DEFENSE_CAP),
    };
    const cutFor = (active, attr) => {
      let arm = armor[attr] || 0;
      for (const s of active) arm += (s.armorAdd && s.armorAdd[attr]) || 0;
      arm = Math.min(arm, armorCap[attr]);
      let cut = this.calcCutRate(arm);
      const pPct = partsCutPct[attr] || 0;
      if (pPct > 0) cut = 1 - (1 - cut) * (1 - pPct / 100);
      for (const s of active) {
        const dc = (s.dcPct && s.dcPct[attr]) || 0;
        if (dc > 0) cut = 1 - (1 - cut) * (1 - dc / 100);
      }
      return cut;
    };
    let ehp = 0;
    for (let i = 0; i < bounds.length - 1; i++) {
      const hi = bounds[i], lo = bounds[i + 1];
      const frac = hi - lo;
      if (frac <= 0) continue;
      // この区間（HP割合 lo〜hi）で発動中の効果 = しきい値が区間上端以上
      const active = list.filter(s => (s.threshold || 1) >= hi - 1e-9);
      const bCut  = cutFor(active, 'ballistic');
      const beCut = cutFor(active, 'beam');
      const mCut  = cutFor(active, 'melee');
      const wCut = bCut * damageRatio.ballistic + beCut * damageRatio.beam + mCut * damageRatio.melee;
      ehp += (hp * frac) / (1 - wCut);
    }
    return Math.round(ehp);
  },

  /**
   * 総合火力スコアを計算
   * @param {number} shootingCorr - 射撃補正値
   * @param {number} meleeCorr - 格闘補正値
   * @param {object} atkRatio - { shooting, melee } (0-1, 合計=1)
   * @param {number} shootingDmgPct - 射撃ダメージ増加%
   * @param {number} meleeDmgPct - 格闘ダメージ増加%
   */
  calcOffenseScore(shootingCorr, meleeCorr, atkRatio, shootingDmgPct = 0, meleeDmgPct = 0) {
    const shootMul = this.calcShootingMultiplier(shootingCorr) * (1 + shootingDmgPct / 100);
    const meleeMul = this.calcMeleeMultiplier(meleeCorr) * (1 + meleeDmgPct / 100);
    
    return shootMul * atkRatio.shooting + meleeMul * atkRatio.melee;
  },

  /**
   * 強化施設のリスト（拡張スキル）をベースステータスに適用する
   * @param {object} baseStats - 基本ステータス
   * @param {Array} enhancements - 全拡張スキルリスト
   * @param {number} level - 適用する強化段階 (0 ~ 6)
   * @param {number} msLevel - 機体レベル（MSレベル別強化リストフィルタ用）
   */
  /**
   * 強化リストのバリアントを解決する（MSレベルに応じた効果テキストを返す）
   * @param {object} enhancement - 強化リストエントリ
   * @param {number} msLevel - 機体レベル
   * @returns {string} 解決された効果テキスト
   */
  resolveEnhancementEffect(enhancement, msLevel) {
    if (enhancement.variants && enhancement.variants[String(msLevel)]) {
      return enhancement.variants[String(msLevel)].effect;
    }
    return enhancement.effect || '';
  },

  /**
   * 強化リスト名から「ベース強化名」と「強化Lv」を分離する。
   * 例: "耐ビーム装甲補強 Lv4" → { base: "耐ビーム装甲補強", lv: 4 }
   */
  _enhancementBase(skillName) {
    const m = /^(.*)\s+Lv(\d+)$/.exec(skillName || '');
    return m ? { base: m[1], lv: parseInt(m[2], 10) } : { base: skillName || '', lv: 0 };
  },

  /**
   * 現在のMSレベル・強化段階で「実際に適用される強化」配列を返す。
   *   1) ms_levels で現MSレベルに該当する強化のみ
   *   2) 強化段階数 (level) 件にスライス
   *   3) 同名(ベース名が同じ)強化は最高Lvのみ採用＝置換。上限開放で同じ強化が
   *      Lv1とLv4の2エントリに分かれて二重計上される問題を防ぐ
   * applyEnhancements(ステータス) と getMaxSlots(スロット) で共用する。
   * @returns {Array} 適用すべき強化エントリ配列
   */
  resolveActiveEnhancements(enhancements, level, msLevel) {
    if (level <= 0 || !enhancements || enhancements.length === 0) return [];
    const sliced = enhancements
      .filter(e => !e.ms_levels || e.ms_levels.length === 0 || e.ms_levels.includes(msLevel))
      .slice(0, level);
    // ベース名ごとに最高Lvエントリだけ残す（出現順は維持）
    const bestByBase = new Map();
    for (const e of sliced) {
      const { base, lv } = this._enhancementBase(e.skill_name);
      const cur = bestByBase.get(base);
      if (!cur || lv > cur.lv) bestByBase.set(base, { entry: e, lv });
    }
    const keep = new Set([...bestByBase.values()].map(v => v.entry));
    return sliced.filter(e => keep.has(e));
  },

  applyEnhancements(baseStats, enhancements, level, msLevel) {
    if (level <= 0 || !enhancements || enhancements.length === 0) return baseStats;

    const modified = { ...baseStats };

    const targetEnhancements = this.resolveActiveEnhancements(enhancements, level, msLevel);

    for (const enhancement of targetEnhancements) {
      const text = this.resolveEnhancementEffect(enhancement, msLevel);
      let match;

      // 機体HP
      if ((match = text.match(/機体HPが(\d+)増加/))) {
        modified.hp = (modified.hp || 0) + parseInt(match[1]);
      }
      // 耐実弾補正（「耐」付きを先にチェック）
      if ((match = text.match(/耐実弾補正が(\d+)増加/))) {
        modified.ballistic_armor = (modified.ballistic_armor || 0) + parseInt(match[1]);
      }
      // 耐ビーム補正
      if ((match = text.match(/耐ビーム補正が(\d+)増加/))) {
        modified.beam_armor = (modified.beam_armor || 0) + parseInt(match[1]);
      }
      // 耐格闘補正
      if ((match = text.match(/耐格闘補正が(\d+)増加/))) {
        modified.melee_armor = (modified.melee_armor || 0) + parseInt(match[1]);
      }
      // 射撃補正
      if ((match = text.match(/(?<!耐.{0,4})射撃補正が(\d+)増加/))) {
        modified.shooting_correction = (modified.shooting_correction || 0) + parseInt(match[1]);
      }
      // 格闘補正（「耐格闘補正」を除外）
      if (!/耐格闘/.test(text) && (match = text.match(/格闘補正が(\d+)増加/))) {
        modified.melee_correction = (modified.melee_correction || 0) + parseInt(match[1]);
      }
      // スピード
      if ((match = text.match(/スピードが(\d+)増加/))) {
        modified.speed = (modified.speed || 0) + parseInt(match[1]);
      }
      // 高速移動
      if ((match = text.match(/高速移動が(\d+)増加/))) {
        modified.boost_speed = (modified.boost_speed || 0) + parseInt(match[1]);
      }
      // スラスター
      if ((match = text.match(/スラスターが(\d+)増加/))) {
        modified.thruster = (modified.thruster || 0) + parseInt(match[1]);
      }
      // 旋回
      if ((match = text.match(/旋回(?:性能)?が(\d+)増加/))) {
        modified.turn_speed_ground = (modified.turn_speed_ground || 0) + parseInt(match[1]);
        modified.turn_speed_space  = (modified.turn_speed_space  || 0) + parseInt(match[1]);
      }
      // シールドHP（強化リストで付与される場合）
      if ((match = text.match(/シールドHPが(\d+)増加/))) {
        modified.shield_hp = (modified.shield_hp || 0) + parseInt(match[1]);
      }
    }

    return modified;
  },

  /**
   * 拡張スキルの直接効果を基本ステータスに適用し、上限値ボーナスも返す
   * @param {object} baseStats
   * @param {Array} expansionSkillsList - 選択中の拡張スキルオブジェクト配列 [{name, level, effects}]
   * @returns {{stats: object, capBonus: object}}
   */
  applyExpansionSkillsDirect(baseStats, expansionSkillsList) {
    const stats = { ...baseStats };
    const capBonus = this._emptyCapBonus();
    const CAP_MAP = this.CAP_EFFECT_TO_KEY;

    for (const skill of (expansionSkillsList || [])) {
      for (const eff of (skill.effects || [])) {
        if (eff.type === 'per_custom_part' || !eff.direct) continue;
        const capKey = CAP_MAP[eff.type];
        if (capKey) { capBonus[capKey] += eff.value; continue; }
        switch (eff.type) {
          case 'shooting_correction':   stats.shooting_correction = (stats.shooting_correction || 0) + eff.value; break;
          case 'melee_correction':      stats.melee_correction    = (stats.melee_correction    || 0) + eff.value; break;
          case 'ballistic_armor':       stats.ballistic_armor     = (stats.ballistic_armor     || 0) + eff.value; break;
          case 'beam_armor':            stats.beam_armor          = (stats.beam_armor          || 0) + eff.value; break;
          case 'melee_armor':           stats.melee_armor         = (stats.melee_armor         || 0) + eff.value; break;
          case 'thruster':              stats.thruster            = (stats.thruster            || 0) + eff.value; break;
          case 'boost_speed':           stats.boost_speed         = (stats.boost_speed         || 0) + eff.value; break;
          case 'hp':                    stats.hp                  = (stats.hp                  || 0) + eff.value; break;
        }
      }
    }

    return { stats, capBonus };
  },

  /**
   * パーツ効果値を機体LV・強化段階を考慮して解決する
   * @param {object} effect - パーツエフェクトオブジェクト
   * @param {number} msLevel - 現在の機体レベル
   * @param {number} enhanceLevel - 現在の強化段階 (0〜6)
   * @returns {number} 解決された効果量
   */
  resolveEffectValue(effect, msLevel = 1, enhanceLevel = 0) {
    let val = effect.value;
    if (effect.msLevelScaling) {
      const { perLevel, max } = effect.msLevelScaling;
      val = Math.min(val + (msLevel - 1) * perLevel, max);
    }
    if (effect.enhanceSteps) {
      for (const step of effect.enhanceSteps) {
        if (enhanceLevel >= step.minEnhance) val += step.bonus;
      }
    }
    return val;
  },

  /**
   * パーツ効果を機体ステータスに適用（拡張スキル対応版）
   * @param {object} baseStats - 強化適用済みの基本ステータス
   * @param {Array} parts - 装備中のパーツ配列
   * @param {Array} expansionSkillsList - 選択中の拡張スキル配列 (デフォルト: [])
   * @param {number} msLevel - 機体レベル (デフォルト: 1)
   * @param {number} enhanceLevel - 強化段階 (デフォルト: 0)
   * @param {object} skillStatBonuses - 発動系スキル（バイオセンサー等）による一律ステータス
   *        上昇のフラット加算（キー→値）。火力に限らず補正・装甲・移動を加算し、各上限へクランプ。
   * @returns {object} 修正後のステータス
   */
  applyParts(baseStats, parts, expansionSkillsList = [], msLevel = 1, enhanceLevel = 0, skillStatBonuses = {}) {
    // 拡張スキルの直接効果を適用し上限値ボーナスを取得
    const { stats: expanded, capBonus } = this.applyExpansionSkillsDirect(baseStats, expansionSkillsList);

    // パーツからも上限ボーナスを収集（先に集めてから上限値を確定する）
    const CAP_MAP = this.CAP_EFFECT_TO_KEY;
    for (const part of parts) {
      if (!part || !part.effects) continue;
      for (const effect of part.effects) {
        const capKey = CAP_MAP[effect.type];
        if (capKey) capBonus[capKey] += this.resolveEffectValue(effect, msLevel, enhanceLevel);
      }
    }

    const modified = { ...expanded };
    let shootingDmgPct = 0;
    let meleeDmgPct = 0;
    let ballisticDamageCutPct = 0;
    let beamDamageCutPct = 0;
    let meleeDamageCutPct = 0;
    let ohRecoveryPct = 0;
    let hpPct = 0;
    // 補正・装甲の乗算%バフ（「補正がN%増加」等）。フラット加算後にまとめて適用する。
    const multPct = { shooting_correction: 0, melee_correction: 0, ballistic_armor: 0, beam_armor: 0, melee_armor: 0 };

    const shootingCap    = this.ATTACK_CAP      + (capBonus.shooting_correction || 0);
    const meleeCap       = this.ATTACK_CAP      + (capBonus.melee_correction    || 0);
    const ballisticCap   = this.DEFENSE_CAP     + (capBonus.ballistic_armor     || 0);
    const beamCap        = this.DEFENSE_CAP     + (capBonus.beam_armor          || 0);
    const meleeArmorCap  = this.DEFENSE_CAP     + (capBonus.melee_armor         || 0);
    const thrusterCap    = this.THRUSTER_CAP    + (capBonus.thruster            || 0);
    const speedCap       = this.SPEED_CAP       + (capBonus.speed               || 0);
    const boostSpeedCap  = this.BOOST_SPEED_CAP + (capBonus.boost_speed         || 0);
    const turnCap        = this.TURN_CAP        + (capBonus.turn_speed          || 0);
    const baseHp         = baseStats.hp || 0;  // HP%バフの基準（強化適用済み素のHP）

    // 上限クランプで捨てられた分（＝無駄になった補正/装甲/移動値）を可視化するため、
    // クランプ前の理論値を並走集計する。modified への加算と完全に同じ順序・同じ effectVal で
    // 積み上げるが Math.min を掛けない点だけが異なる（クランプの単一情報源を二重化しない）。
    const CAPPED = {
      shooting_correction: shootingCap, melee_correction: meleeCap,
      ballistic_armor: ballisticCap, beam_armor: beamCap, melee_armor: meleeArmorCap,
      speed: speedCap, thruster: thrusterCap, boost_speed: boostSpeedCap,
      turn_speed_ground: turnCap, turn_speed_space: turnCap,
    };
    const uncapped = {};
    for (const k of Object.keys(CAPPED)) uncapped[k] = modified[k] || 0;
    // 1つの stat キーへ add を加算しつつ、理論値（uncapped）も並走加算する
    const clampAdd = (key, add) => {
      uncapped[key] = (uncapped[key] || 0) + add;
      modified[key] = Math.min((modified[key] || 0) + add, CAPPED[key]);
    };

    for (const part of parts) {
      if (!part || !part.effects) continue;
      for (const effect of part.effects) {
        const effectVal = this.resolveEffectValue(effect, msLevel, enhanceLevel);
        switch (effect.type) {
          case 'hp':
            modified.hp = (modified.hp || 0) + effectVal;
            break;
          case 'ballistic_armor':
            clampAdd('ballistic_armor', effectVal);
            break;
          case 'beam_armor':
            clampAdd('beam_armor', effectVal);
            break;
          case 'melee_armor':
            clampAdd('melee_armor', effectVal);
            break;
          case 'shooting_correction':
            clampAdd('shooting_correction', effectVal);
            break;
          case 'melee_correction':
            clampAdd('melee_correction', effectVal);
            break;
          case 'speed':
            clampAdd('speed', effectVal);
            break;
          case 'thruster':
            clampAdd('thruster', effectVal);
            break;
          case 'turn_speed':
            clampAdd('turn_speed_ground', effectVal);
            clampAdd('turn_speed_space', effectVal);
            break;
          case 'boost_speed':
            clampAdd('boost_speed', effectVal);
            break;
          case 'oh_recovery_pct':
            ohRecoveryPct += effectVal;
            break;
          case 'shooting_damage_pct':
            shootingDmgPct += effectVal;
            break;
          case 'melee_damage_pct':
            meleeDmgPct += effectVal;
            break;
          case 'ballistic_damage_cut_pct':
            ballisticDamageCutPct += effectVal;
            break;
          case 'beam_damage_cut_pct':
            beamDamageCutPct += effectVal;
            break;
          case 'melee_damage_cut_pct':
            meleeDamageCutPct += effectVal;
            break;
          // 機体HP%バフ（基準HPに対する割合）
          case 'hp_pct':
            hpPct += effectVal;
            break;
          // 補正・装甲の乗算%バフ（フラット加算後に適用）
          case 'shooting_correction_mult_pct': multPct.shooting_correction += effectVal; break;
          case 'melee_correction_mult_pct':    multPct.melee_correction    += effectVal; break;
          case 'ballistic_armor_mult_pct':     multPct.ballistic_armor     += effectVal; break;
          case 'beam_armor_mult_pct':          multPct.beam_armor          += effectVal; break;
          case 'melee_armor_mult_pct':         multPct.melee_armor         += effectVal; break;
          // 部位特殊装甲・部位与ダメ等（部位HP元データが無く集計不可。値は保持して表示・将来対応用に残す）
          case 'legs_hp_alloc_pct': case 'head_hp_alloc_pct': case 'back_hp_alloc_pct':
          case 'legs_hit_damage_cut_pct': case 'head_hit_damage_cut_pct': case 'back_hit_damage_cut_pct':
          case 'legs_part_damage_pct': case 'head_part_damage_pct': case 'back_part_damage_pct':
          case 'shield_hp': case 'head_hp': case 'legs_hp': case 'back_hp':
            modified[effect.type] = (modified[effect.type] || 0) + effectVal;
            break;
        }
      }
    }

    // 機体HP%バフ: 基準HP（強化適用済みの素HP）に対する割合を加算
    if (hpPct > 0) {
      modified.hp = (modified.hp || 0) + Math.round(baseHp * hpPct / 100);
    }

    // 補正・装甲の乗算%バフ: フラット加算後の値に乗算し、再度キャップにクランプ
    // （理論値 uncapped 側も同率で乗算してクランプ前の値を保つ）
    const applyMult = (key) => {
      if (multPct[key] > 0) {
        const f = 1 + multPct[key] / 100;
        uncapped[key] = Math.round((uncapped[key] || 0) * f);
        modified[key] = Math.min(Math.round((modified[key] || 0) * f), CAPPED[key]);
      }
    };
    applyMult('shooting_correction');
    applyMult('melee_correction');
    applyMult('ballistic_armor');
    applyMult('beam_armor');
    applyMult('melee_armor');

    // 発動系スキル（バイオセンサー等）の一律ステータス上昇をフラット加算し、各上限へクランプ。
    // パーツ・乗算バフ適用後に重ねる（スキルバフは独立した加算レイヤーとして扱う）。
    const sb = skillStatBonuses || {};
    const addSkillBonus = (key) => {
      const v = sb[key] || 0;
      if (v) clampAdd(key, v);
    };
    if (sb.hp) modified.hp = (modified.hp || 0) + sb.hp;
    addSkillBonus('shooting_correction');
    addSkillBonus('melee_correction');
    addSkillBonus('ballistic_armor');
    addSkillBonus('beam_armor');
    addSkillBonus('melee_armor');
    addSkillBonus('speed');
    addSkillBonus('thruster');
    addSkillBonus('boost_speed');
    if (sb.turn_speed) {
      clampAdd('turn_speed_ground', sb.turn_speed);
      clampAdd('turn_speed_space', sb.turn_speed);
    }

    // per_custom_part 効果：装備中の該当タイプのパーツ数に応じてボーナス
    for (const skill of (expansionSkillsList || [])) {
      for (const expEff of (skill.effects || [])) {
        if (expEff.type !== 'per_custom_part') continue;
        const targetTypes = expEff.targetPartTypes || [];
        const matchCount = parts.filter(p => p && targetTypes.includes(p.category)).length;
        if (matchCount === 0) continue;
        for (const perPart of (expEff.perPartEffects || [])) {
          const bonus = perPart.value * matchCount;
          switch (perPart.type) {
            case 'hp':                  modified.hp                  = (modified.hp                  || 0) + bonus; break;
            case 'shooting_correction': clampAdd('shooting_correction', bonus); break;
            case 'melee_correction':    clampAdd('melee_correction', bonus); break;
            case 'ballistic_armor':     clampAdd('ballistic_armor', bonus); break;
            case 'beam_armor':          clampAdd('beam_armor', bonus); break;
            case 'melee_armor':         clampAdd('melee_armor', bonus); break;
            case 'thruster':            clampAdd('thruster', bonus); break;
            case 'boost_speed':         clampAdd('boost_speed', bonus); break;
            case 'shield_hp':           modified.shield_hp           = (modified.shield_hp           || 0) + bonus; break;
            case 'reload_oh_reduction_pct': modified.reloadOhReductionPct = (modified.reloadOhReductionPct || 0) + bonus; break;
          }
        }
      }
    }

    modified.shootingDmgPct = shootingDmgPct;
    modified.meleeDmgPct = meleeDmgPct;
    modified.ballisticDamageCutPct = ballisticDamageCutPct;
    modified.beamDamageCutPct = beamDamageCutPct;
    modified.meleeDamageCutPct = meleeDamageCutPct;
    modified.ohRecoveryPct = ohRecoveryPct;

    // 上限超過（無駄）の集計：クランプで捨てられた分を stat キー → 超過量で返す。
    // 素の値が単独で上限超のとき（パーツ無加算）は誤検出しないよう、加算で上限を
    // 超えた場合（uncapped が素のベースより大きい）に限って計上する。
    const overflow = {};
    for (const [key, cap] of Object.entries(CAPPED)) {
      const over = Math.round((uncapped[key] || 0) - cap);
      if (over > 0 && (uncapped[key] || 0) > (baseStats[key] || 0)) overflow[key] = over;
    }
    modified._caps = { ...CAPPED };
    modified._overflow = overflow;

    return modified;
  },

  /**
   * スキルテキストから全ての計算可能効果を抽出（複数対応）
   * @param {object} skill - {name, level, effect} または {skill_name, effect}
   * @returns {Array} - [{category, value, condition}, ...] (空配列もありうる)
   */
  extractSkillEffects(skill) {
    const text = skill.effect || '';
    if (!text) return [];
    const results = [];
    // 条件判定用の前方コンテキスト幅。発動条件（瀕死/静止/高速移動中 等）が
    // 効果値の手前に離れて書かれることが多いため広めに取る。
    const CTX = 120;
    let m;

    // よろけ値（被弾よろけ蓄積への補正＝防御的よろけ耐性。「受けた攻撃のよろけ値をX%で計算」等）
    const staggerRe = /よろけ値を\s*(\d+)%/g;
    while ((m = staggerRe.exec(text)) !== null) {
      const ctx = text.substring(Math.max(0, m.index - CTX), m.index);
      results.push({ category: 'stagger', value: parseInt(m[1]), condition: this._parseCondition(ctx) });
    }

    // ダメージカット (複数マッチ対応)
    const dcRe = /被ダメージ\s*[－\-ー]\s*(\d+)%|受けるダメージを(\d+)%軽減|機体HPへのダメージを(\d+)%軽減|ダメージを(\d+)%軽減/g;
    while ((m = dcRe.exec(text)) !== null) {
      const value = parseInt(m[1] ?? m[2] ?? m[3] ?? m[4]);
      const ctx = text.substring(Math.max(0, m.index - CTX), m.index);
      results.push({ category: 'damage_cut', value, condition: this._parseCondition(ctx) });
    }

    // 火力ボーナス (複数マッチ対応)
    // 「与えるダメージが X% 増加/上昇」「威力が X% 増加/上昇」、短縮形「与ダメージ＋X%」。
    // タックル専用威力（例「タックルの威力が120%増加」）は通常射撃/格闘火力ではないため除外。
    const fpRe = /与えるダメージ(?:が|を)?\s*(\d+)%\s*(?:増加|上昇)|威力(?:が|を)?\s*(\d+)%\s*(?:増加|上昇)|攻撃力(?:が|を)?\s*(\d+)%\s*(?:増加|上昇)|与ダメージ[＋+]\s*(\d+)%/g;
    while ((m = fpRe.exec(text)) !== null) {
      const value = parseInt(m[1] ?? m[2] ?? m[3] ?? m[4]);
      const ctx = text.substring(Math.max(0, m.index - CTX), m.index);
      if (/タックル/.test(ctx)) continue;
      results.push({ category: 'firepower', value, condition: this._parseCondition(ctx) });
    }

    // ステータス一律上昇（火力に限らない）。
    // バイオセンサー等の「システム発動で各種ステータスが上昇する」効果を捕捉する。
    // 例: 「発動中は・射撃補正＋10・格闘補正＋20・スピード＋15・高速移動＋20・旋回＋15」
    // 「○○＋N」「○○が N 増加/上昇」の2形式に対応。フラット加算（整数）のみが対象で、
    // 「N%上昇」（乗算）・減少（－/低下）・「スラスター消費」減は除外する。
    // 強化リスト由来は applyEnhancements で既にベースへ加算済みのため、呼び出し側
    // （_buildSkillEffectItems）で stat_bonus を除外して二重計上を防ぐ。
    const statBonus = this._extractStatBonuses(text);
    if (Object.keys(statBonus.bonuses).length > 0) {
      results.push({
        category: 'stat_bonus',
        bonuses: statBonus.bonuses,
        condition: this._parseActivationCondition(text, statBonus.firstIdx),
      });
    }

    // HP閾値で発動するスキル（瀕死/緊急時等）には発動しきい値を付与する。
    // 「発動考慮 有効HP」（区間加重EHP）で、しきい値以下の区間だけ効果を適用するために使う。
    const hpThreshold = this._parseHpThreshold(text);
    if (hpThreshold != null) for (const r of results) r.hpThreshold = hpThreshold;

    return results;
  },

  /**
   * スキル文からHP発動しきい値（最大HPに対する割合 0〜1）を抽出する。
   * 「HPが50%以下」→0.5。明示%の無い 瀕死/根性/不屈 は 0.5 で近似。無ければ null。
   * @param {string} text
   * @returns {number|null}
   */
  _parseHpThreshold(text) {
    const m = (text || '').match(/HPが?\s*(\d+)\s*%?\s*以下/);
    if (m) { const p = parseInt(m[1], 10); if (p > 0 && p < 100) return p / 100; }
    if (/瀕死|根性|不屈/.test(text || '')) return 0.5;
    return null;
  },

  // ステータス名 → 内部キー。長い/限定的な名前を先に並べ、部分一致の誤マッチを防ぐ
  // （例: 「耐格闘補正」を「格闘補正」より先に判定する）。
  _STAT_NAME_TO_KEY: [
    ['耐実弾補正', 'ballistic_armor'],
    ['耐ビーム補正', 'beam_armor'],
    ['耐格闘補正', 'melee_armor'],
    ['射撃補正', 'shooting_correction'],
    ['格闘補正', 'melee_correction'],
    ['高速移動', 'boost_speed'],
    ['スピード', 'speed'],
    ['スラスター', 'thruster'],
    ['旋回性能', 'turn_speed'],
    ['旋回', 'turn_speed'],
    ['機体HP', 'hp'],
  ],

  /**
   * スキル/強化テキストからフラットなステータス上昇量を抽出する。
   * @param {string} text
   * @returns {{bonuses: object, firstIdx: number}} bonuses はキー→加算値、firstIdx は最初の一致位置
   */
  _extractStatBonuses(text) {
    if (!this._statBonusRe) {
      const names = this._STAT_NAME_TO_KEY.map(([n]) => n).join('|');
      // 「(名前)(が)? ＋N」または「(名前)が N 増加/上昇」。% を伴う乗算表現は弾く。
      this._statBonusRe = new RegExp(
        `(${names})(?:が)?\\s*(?:[＋+]\\s*(\\d+)(?!\\s*%)|(\\d+)\\s*(?:増加|上昇))`, 'g');
      this._statNameToKey = new Map(this._STAT_NAME_TO_KEY);
    }
    const re = this._statBonusRe;
    re.lastIndex = 0;
    const bonuses = {};
    let firstIdx = -1, m;
    while ((m = re.exec(text)) !== null) {
      const key = this._statNameToKey.get(m[1]);
      const val = parseInt(m[2] ?? m[3], 10);
      if (!key || !Number.isFinite(val) || val <= 0) continue;
      bonuses[key] = (bonuses[key] || 0) + val;
      if (firstIdx < 0) firstIdx = m.index;
    }
    return { bonuses, firstIdx };
  },

  /**
   * ステータス一律上昇（stat_bonus）専用の発動条件判定。
   * 一般の _parseCondition は広い前方文脈を見るため、防御系プロセ（例「射撃攻撃による
   * 被弾時のリアクションを軽減」）を「射撃時のみ」と誤検出しやすい。stat_bonus では
   * (1)発動条件文（先頭文のHP閾値/自動発動）、(2)効果直前の「・○○中・」状態タグ、を
   * 優先して読む。属性限定の誤検出は条件付きトグル（発動中）へ丸め、常時パッシブの
   * 除外判定が誤って効かないようにする。
   * @param {string} text - スキル効果全文
   * @param {number} idx - 最初のステータス上昇マッチ位置
   * @returns {string} 条件ラベル
   */
  _parseActivationCondition(text, idx) {
    const head = (text.split(/[。\n]/)[0] || '');                 // 発動条件を述べる先頭文
    const sepEnd = Math.max(text.lastIndexOf('。', idx), text.lastIndexOf('\n', idx));
    const local = text.substring(sepEnd + 1, idx);                // 効果値の直前クローズ（・タグ列）
    const scope = head + '' + local;

    // 1) HP閾値・撃墜回避での自動発動 → 瀕死/緊急時
    if (/撃墜される|HPが?\s*\d+\s*%?\s*以下|瀕死|根性|不屈/.test(scope)) return '瀕死/緊急時';
    // 2) 手動発動（タッチパッド/任意発動）
    if (/タッチパッド|任意発動|任意で発動|長押しで発動/.test(scope)) return '発動中（手動）';
    // 3) 効果直前の「・○○中・」状態タグ（格闘兵装装備中 等）を最優先で採用
    const bullets = local.split('・').map(s => s.trim()).filter(Boolean);
    const tag = bullets.length ? bullets[bullets.length - 1] : '';
    if (tag && tag.length <= 18 && !/[＋+]\s*\d/.test(tag) && /(?:装備中|発動中|展開中|移動中|攻撃中|発生中|開始中|変形中|状態|時|場合)/.test(tag)) {
      if (/高速移動|ブースト/.test(tag)) return '高速移動中';
      const cleaned = tag
        .replace(/^(?:さらに|なお|また|かつ|同時に|その際|その他)/u, '')
        .replace(/(?:の|は|に|、)$/u, '');
      return cleaned || tag;
    }
    // 4) 既存の汎用判定（広い窓）にフォールバック。属性限定の誤検出は「発動中」に丸める
    //    （常時に丸めると base 込みとして除外され、計上できなくなるため避ける）。
    const wide = text.substring(Math.max(0, idx - 120), idx);
    const c = this._parseCondition(wide);
    if (['射撃時のみ', '実弾属性のみ', 'ビーム属性のみ', '格闘属性のみ'].includes(c)) return '発動中';
    return c;
  },

  _parseCondition(ctx) {
    // 緊急時・瀕死発動（常時ではない＝既定ではEHP/カット率に含めない）
    if (/撃墜される|HPが?\s*\d+\s*%?\s*以下|瀕死|根性|不屈/.test(ctx)) return '瀕死/緊急時';
    if (/静止射撃|静止状態|停止状態/.test(ctx)) return '静止時';
    if (/判定発生中/.test(ctx)) return '判定発生中';
    if (/動作開始中/.test(ctx)) return '動作開始中';
    if (/実弾属性/.test(ctx)) return '実弾属性のみ';
    if (/ビーム属性/.test(ctx)) return 'ビーム属性のみ';
    if (/格闘属性/.test(ctx)) return '格闘属性のみ';
    if (/射撃属性|射撃攻撃/.test(ctx)) return '射撃時のみ';
    if (/背部/.test(ctx)) return '背部被弾時';
    if (/高速移動|ブースト移動/.test(ctx)) return '高速移動中';
    if (/ジャンプ|落下|空中/.test(ctx)) return 'ジャンプ/落下中';
    if (/変形中/.test(ctx)) return '変形中';
    if (/シールド/.test(ctx)) return 'シールド被弾時';
    if (/タッチパッド/.test(ctx)) return '発動中（手動）';
    if (/発動中|展開中|動作中/.test(ctx)) return '発動中';
    if (/攻撃を受けた際|攻撃を受けた場合|部位/.test(ctx)) return '部位被弾時';
    // 「よろけ/ダウン状態の敵に与ダメージUP」のみ（「よろけの発生を軽減」等との誤マッチ防止）
    if (/よろけ状態|ダウン状態|ダウン中の|よろけ中の|よろけしている/.test(ctx)) return 'よろけ/ダウン中の敵に';
    return '常時';
  },

  /**
   * よろけ閾値を計算 (HP × 0.2 の近似値)
   * @param {number} hp
   * @returns {number}
   */
  calcStaggerThreshold(hp) {
    return Math.round(hp * 0.2);
  },

  /**
   * パーツの装備可能性チェック
   * @param {object} part - パーツデータ
   * @param {object} availableSlots - { close, mid, long } 残りスロット
   * @returns {boolean}
   */
  canEquip(part, availableSlots) {
    return (
      part.slots.close <= availableSlots.close &&
      part.slots.mid <= availableSlots.mid &&
      part.slots.long <= availableSlots.long
    );
  },

  // ===== カスタムパーツの相互排他（GBO2の「複数装備できない」制約） =====
  // ルールは custom_parts.json の name / description / effects から導出する。
  _SPEED_TURN_TYPES: new Set(['speed', 'turn_speed', 'turn_speed_ground', 'turn_speed_space']),

  /**
   * パーツの排他メタ情報を算出（パーツに非列挙でキャッシュ）。
   * - groups: 共有すると共存不可になるキー集合（同名 / ○○系）
   * - raisesSpeedTurn: スピードまたは旋回が上昇する
   * - speedExclusive: 「スピード/旋回が上昇するパーツと同時装備不可」を持つ
   */
  partMutex(part) {
    if (part._mutex) return part._mutex;
    const desc = part.description || '';
    const groups = new Set();
    // GBO2では通常のカスタムパーツは同名でも複数装備(スタック)できる。
    // 制限は「○○系パーツは複数装備できない/不可」等が明記されたものだけ。
    // 1) 「○○系パーツは複数装備できない/不可」（特殊強化フレーム/複合装甲材/複合フレーム/特殊強化装置 等）
    //    「装備」と否定語の間に語が挟まる表記（新型装甲系の「複数装備することは不可」等）も許容する。
    const fam = desc.match(/(?:なお|また|尚)?\s*([^。、,；\s]+?)系(?:統)?(?:の)?(?:カスタム)?パーツは(?:複数|同時)装備[^。]*?(?:でき(?:ない|ません)|不可|行えない)/);
    if (fam) {
      groups.add('family:' + fam[1].replace(/^(?:なお|また|尚)/, ''));
    } else if (/(?:複数|同時)装備[^。]*?(?:でき(?:ない|ません)|不可|行えない)/.test(desc)) {
      // 系統指定の無い自己制限（このパーツ単体を複数装備不可）→ 同名で1つに限定
      groups.add('name:' + part.name);
    }
    // 2) スピード/旋回 上昇系の排他
    const raisesSpeedTurn = (part.effects || []).some(e =>
      this._SPEED_TURN_TYPES.has(e.type) && (e.value || 0) > 0);
    const speedExclusive = /(?:スピード|旋回性能)(?:または旋回性能)?が上昇するパーツと/.test(desc);
    const meta = { groups, raisesSpeedTurn, speedExclusive };
    try { Object.defineProperty(part, '_mutex', { value: meta, enumerable: false, configurable: true }); }
    catch (_) { /* frozen object などは無視 */ }
    return meta;
  },

  /** 2つのパーツが同時装備できない場合 true（同一/同名インスタンスも対象） */
  partsConflict(a, b) {
    if (!a || !b) return false;
    // 全く同じパーツ（同名・同レベル）は重複装備不可。同名でもLV違いは装備可。
    if (a.name === b.name && (a.level || 0) === (b.level || 0)) return true;
    const ma = this.partMutex(a), mb = this.partMutex(b);
    for (const g of ma.groups) if (mb.groups.has(g)) return true; // 同名 / 同系統
    // スピード/旋回上昇系: 片方が排他指定で他方が speed/turn を上げるなら不可
    if ((ma.speedExclusive && mb.raisesSpeedTurn) || (mb.speedExclusive && ma.raisesSpeedTurn)) return true;
    return false;
  },

  /** part が equippedList のいずれかと共存不可なら true */
  conflictsWithAny(part, equippedList) {
    for (const p of equippedList) if (p && this.partsConflict(part, p)) return true;
    return false;
  },

  /**
   * modified ステータスオブジェクトから STAT_SCALES キーに対応する値を取得
   */
  _getModifiedStat(modified, statKey) {
    const MAP = {
      shooting_damage_pct: 'shootingDmgPct',
      melee_damage_pct: 'meleeDmgPct',
      ballistic_damage_cut_pct: 'ballisticDamageCutPct',
      beam_damage_cut_pct: 'beamDamageCutPct',
      melee_damage_cut_pct: 'meleeDamageCutPct',
      turn_speed: 'turn_speed_ground',
    };
    return modified[MAP[statKey] || statKey] || 0;
  },

  /**
   * 限界利得再計算付き貪欲法（共通エンジン）
   * 毎ステップ applyParts を呼び直し、キャップ・逓減・乗算シナジーを正確に反映する。
   * 計算量 O(N × K)  N=候補パーツ数, K=空きスロット数（最大8）
   *
   * @param {object} baseStats - 強化適用済みベースステータス
   * @param {object} maxSlots - { close, mid, long }
   * @param {Array} candidateParts - 装備候補パーツ一覧
   * @param {object} config - { msLevel, enhanceLevel, expansionSkillsList, equippedParts }
   * @param {function} objectiveFn - (modifiedStats) => number  最大化する目的関数
   * @returns {Array} 選択されたパーツ配列（空きスロットに追加する分のみ）
   */
  _greedySelect(baseStats, maxSlots, candidateParts, config, objectiveFn) {
    const MAX_PARTS = 8;
    const {
      msLevel = 1,
      enhanceLevel = 0,
      expansionSkillsList = [],
      equippedParts = []
    } = config;

    const currentParts = equippedParts.filter(Boolean);
    const usedSlots = { close: 0, mid: 0, long: 0 };
    for (const part of currentParts) {
      usedSlots.close += part.slots.close || 0;
      usedSlots.mid   += part.slots.mid   || 0;
      usedSlots.long  += part.slots.long  || 0;
    }

    const selected = [];

    while (currentParts.length < MAX_PARTS) {
      const remaining = {
        close: maxSlots.close - usedSlots.close,
        mid:   maxSlots.mid   - usedSlots.mid,
        long:  maxSlots.long  - usedSlots.long
      };
      if (remaining.close <= 0 && remaining.mid <= 0 && remaining.long <= 0) break;

      const currentModified = this.applyParts(baseStats, currentParts, expansionSkillsList, msLevel, enhanceLevel);
      const currentValue = objectiveFn(currentModified);

      let bestPart = null;
      let bestGain = 0;

      for (const candidate of candidateParts) {
        // 同名(LV違い含む)・○○系・スピード/旋回排他で既選択と共存不可なものを除外
        if (this.conflictsWithAny(candidate, currentParts)) continue;
        if (!this.canEquip(candidate, remaining)) continue;

        const trialParts = [...currentParts, candidate];
        const trialModified = this.applyParts(baseStats, trialParts, expansionSkillsList, msLevel, enhanceLevel);
        const gain = objectiveFn(trialModified) - currentValue;

        if (gain > bestGain) {
          bestGain = gain;
          bestPart = candidate;
        }
      }

      if (!bestPart) break;

      selected.push(bestPart);
      currentParts.push(bestPart);
      usedSlots.close += bestPart.slots.close || 0;
      usedSlots.mid   += bestPart.slots.mid   || 0;
      usedSlots.long  += bestPart.slots.long  || 0;
    }

    return selected;
  },

  /**
   * 汎用自動最適化（限界利得法）
   * 優先ステータスと被弾/攻撃配分に基づき、加重スコアを最大化する。
   * applyParts を毎回呼ぶため、キャップ到達・_cap パーツ・per_custom_part を正しく反映。
   */
  optimize(baseStats, maxSlots, allParts, config) {
    const {
      damageRatio = { ballistic: 1/3, beam: 1/3, melee: 1/3 },
      atkRatio = { shooting: 0.6, melee: 0.4 },
      selectedStats = [],
    } = config;

    // ステータス分類。防御系は線形和ではなく有効HPを直接最大化する（カット率の限界価値が
    // 非線形なため。例: 40→41 と 49→50 では後者の有効HP増が大きい）。
    const DEF_STATS = new Set(['hp', 'ballistic_armor', 'beam_armor', 'melee_armor',
      'ballistic_damage_cut_pct', 'beam_damage_cut_pct', 'melee_damage_cut_pct']);
    const ATK_STATS = new Set(['shooting_correction', 'melee_correction', 'shooting_damage_pct', 'melee_damage_pct']);
    const MOB_SCALE = { speed: 0.3, boost_speed: 0.2, thruster: 0.5, turn_speed: 0.2 };

    const allStats = ['hp', 'ballistic_armor', 'beam_armor', 'melee_armor', 'shooting_correction',
      'melee_correction', 'shooting_damage_pct', 'melee_damage_pct', 'ballistic_damage_cut_pct',
      'beam_damage_cut_pct', 'melee_damage_cut_pct', 'speed', 'boost_speed', 'thruster', 'turn_speed'];
    const activeStats = selectedStats.length > 0 ? selectedStats : allStats;
    const hasDef = activeStats.some(s => DEF_STATS.has(s));
    const hasAtk = activeStats.some(s => ATK_STATS.has(s));

    const self = this;
    const objectiveFn = (modified) => {
      let score = 0;

      // 防御: 有効HP（装甲カット×属性ダメージ軽減を乗算合成、被弾配分で加重）を直接指標化
      if (hasDef) {
        const aB = self.calcCutRate(modified.ballistic_armor || 0);
        const aBe = self.calcCutRate(modified.beam_armor || 0);
        const aM = self.calcCutRate(modified.melee_armor || 0);
        const pB = modified.ballisticDamageCutPct || 0, pBe = modified.beamDamageCutPct || 0, pM = modified.meleeDamageCutPct || 0;
        const bCut = pB > 0 ? 1 - (1 - aB) * (1 - pB / 100) : aB;
        const beCut = pBe > 0 ? 1 - (1 - aBe) * (1 - pBe / 100) : aBe;
        const mCut = pM > 0 ? 1 - (1 - aM) * (1 - pM / 100) : aM;
        const effHP = self.calcEffectiveHPFromCutRates(
          modified.hp || 0, { ballistic: bCut, beam: beCut, melee: mCut }, damageRatio
        );
        score += effHP / 500;
      }

      // 攻撃: 総合火力スコア（~1〜2）を桁合わせして加点
      if (hasAtk) {
        const off = self.calcOffenseScore(
          modified.shooting_correction || 0, modified.melee_correction || 0,
          atkRatio, modified.shootingDmgPct || 0, modified.meleeDmgPct || 0
        );
        score += off * 100;
      }

      // 移動系: 選択されたもののみ線形加点
      for (const stat of activeStats) {
        if (MOB_SCALE[stat]) score += self._getModifiedStat(modified, stat) * MOB_SCALE[stat];
      }

      return score;
    };

    return this._greedySelect(baseStats, maxSlots, allParts, config, objectiveFn);
  },

  /**
   * カテゴリ特化最適化（限界利得法）
   * 空きスロットのみを使い、指定カテゴリの実ゲーム指標を最大化する。
   *
   * @param {object} baseStats - 強化適用済みベースステータス
   * @param {object} maxSlots - { close, mid, long }
   * @param {Array} allParts - 装備候補パーツ一覧
   * @param {object} config - optimize() と同等 + mode
   * @param {string} config.mode - 'attack' | 'defense' | 'thruster'
   * @returns {Array} 選択されたパーツ配列
   */
  optimizeFocused(baseStats, maxSlots, allParts, config) {
    const {
      mode = 'attack',
      damageRatio = { ballistic: 1/3, beam: 1/3, melee: 1/3 },
      atkRatio = { shooting: 0.6, melee: 0.4 },
    } = config;

    const self = this;
    let objectiveFn;

    switch (mode) {
      case 'attack':
        objectiveFn = (modified) => self.calcOffenseScore(
          modified.shooting_correction || 0,
          modified.melee_correction || 0,
          atkRatio,
          modified.shootingDmgPct || 0,
          modified.meleeDmgPct || 0
        );
        break;

      case 'defense':
        objectiveFn = (modified) => {
          const armorBCut  = self.calcCutRate(modified.ballistic_armor || 0);
          const armorBeCut = self.calcCutRate(modified.beam_armor || 0);
          const armorMCut  = self.calcCutRate(modified.melee_armor || 0);
          const bCut  = (modified.ballisticDamageCutPct || 0) > 0
            ? 1 - (1 - armorBCut)  * (1 - modified.ballisticDamageCutPct / 100) : armorBCut;
          const beCut = (modified.beamDamageCutPct || 0) > 0
            ? 1 - (1 - armorBeCut) * (1 - modified.beamDamageCutPct / 100) : armorBeCut;
          const mCut  = (modified.meleeDamageCutPct || 0) > 0
            ? 1 - (1 - armorMCut)  * (1 - modified.meleeDamageCutPct / 100) : armorMCut;
          return self.calcEffectiveHPFromCutRates(
            modified.hp || 0,
            { ballistic: bCut, beam: beCut, melee: mCut },
            damageRatio
          );
        };
        break;

      case 'thruster':
        objectiveFn = (modified) => modified.thruster || 0;
        break;

      default:
        return [];
    }

    return this._greedySelect(baseStats, maxSlots, allParts, config, objectiveFn);
  },

  // 目標値（下限）最適化で参照するステータスの「素の」上限値。
  // 実際の到達可能上限は、選択中の拡張スキルcap＋装備可能な新型装甲系パーツcapを
  // 加算した動的値（_reachableCap / optimizeToTargets 内で算出）。素値だけで判定すると
  // 耐性50超（新型装甲・拡張スキル）を誤って到達不可と表示してしまうので注意。
  STAT_HARD_CAP: {
    ballistic_armor: 50, beam_armor: 50, melee_armor: 50,
    shooting_correction: 100, melee_correction: 100,
    speed: 200, thruster: 100, boost_speed: 300, turn_speed: 200,
  },

  /**
   * 目標値（下限）最適化：指定した各ステータスの「最低◯◯以上」を全て満たすパーツ構成を
   * 空きスロットから探索する。満たせない場合も最善構成と不足情報を返す（呼び出し側で
   * メッセージ化する）。各目標を均等に正規化した不足量を最も減らすパーツを貪欲に追加する。
   *
   * @param {object} baseStats - 強化適用済みベースステータス
   * @param {object} maxSlots - { close, mid, long }
   * @param {Array} allParts - 装備候補パーツ一覧
   * @param {object} config - { targets:{statKey:minValue}, msLevel, enhanceLevel, expansionSkillsList, equippedParts }
   * @returns {{parts:Array, allMet:boolean, results:Array, remainingSlots:object, usedAllSlots:boolean}}
   */
  optimizeToTargets(baseStats, maxSlots, allParts, config) {
    const {
      targets = {},
      msLevel = 1,
      enhanceLevel = 0,
      expansionSkillsList = [],
      equippedParts = [],
    } = config;

    const MAX_PARTS = 8;
    const targetEntries = Object.entries(targets)
      .filter(([, v]) => typeof v === 'number' && v > 0);

    const currentParts = equippedParts.filter(Boolean);
    const usedSlots = { close: 0, mid: 0, long: 0 };
    for (const p of currentParts) {
      usedSlots.close += p.slots.close || 0;
      usedSlots.mid   += p.slots.mid   || 0;
      usedSlots.long  += p.slots.long  || 0;
    }

    const statOf = (modified, key) => this._getModifiedStat(modified, key);
    const selected = [];

    // 不足の正規化合計（各目標を 1 として均等扱い）を最も減らすパーツを貪欲に追加
    while (currentParts.length < MAX_PARTS && targetEntries.length > 0) {
      const remaining = {
        close: maxSlots.close - usedSlots.close,
        mid:   maxSlots.mid   - usedSlots.mid,
        long:  maxSlots.long  - usedSlots.long,
      };
      if (remaining.close <= 0 && remaining.mid <= 0 && remaining.long <= 0) break;

      const curMod = this.applyParts(baseStats, currentParts, expansionSkillsList, msLevel, enhanceLevel);
      const deficits = targetEntries
        .map(([k, t]) => ({ k, t, def: Math.max(0, t - statOf(curMod, k)) }))
        .filter(d => d.def > 0);
      if (deficits.length === 0) break; // 全目標達成

      let bestPart = null;
      let bestReduction = 0;
      for (const cand of allParts) {
        if (this.conflictsWithAny(cand, currentParts)) continue;
        if (!this.canEquip(cand, remaining)) continue;
        const trialMod = this.applyParts(baseStats, [...currentParts, cand], expansionSkillsList, msLevel, enhanceLevel);
        let reduction = 0;
        for (const d of deficits) {
          const newDef = Math.max(0, d.t - statOf(trialMod, d.k));
          reduction += (d.def - newDef) / d.t; // 目標値で正規化した不足削減量
        }
        if (reduction > bestReduction) { bestReduction = reduction; bestPart = cand; }
      }
      if (!bestPart) break; // これ以上不足を減らせるパーツが無い

      selected.push(bestPart);
      currentParts.push(bestPart);
      usedSlots.close += bestPart.slots.close || 0;
      usedSlots.mid   += bestPart.slots.mid   || 0;
      usedSlots.long  += bestPart.slots.long  || 0;
    }

    // 到達可能な実効上限 = 素の上限 + 選択中拡張スキルのcap + 装備可能な最大cap上昇パーツ。
    // 新型装甲系cap（新型耐ビーム装甲 等）は複数装備不可のため候補中の「単一最大」を採用する。
    // これにより耐性50超が可能なケースを capExceeded として誤判定しない。
    const skillCapBonus = this.collectCapBonus([], expansionSkillsList, msLevel, enhanceLevel);
    const bestPartCapBonus = this._maxPartCapBonus(allParts, msLevel, enhanceLevel);

    const finalMod = this.applyParts(baseStats, currentParts, expansionSkillsList, msLevel, enhanceLevel);
    const results = targetEntries.map(([k, t]) => {
      const achieved = statOf(finalMod, k);
      const hard = this.STAT_HARD_CAP[k];
      const reachableCap = hard != null
        ? hard + (skillCapBonus[k] || 0) + (bestPartCapBonus[k] || 0)
        : null;
      return {
        stat: k,
        target: t,
        achieved,
        met: achieved >= t,
        deficit: Math.max(0, t - achieved),
        capExceeded: reachableCap != null && t > reachableCap,
        cap: reachableCap,
      };
    });
    const remainingSlots = {
      close: maxSlots.close - usedSlots.close,
      mid:   maxSlots.mid   - usedSlots.mid,
      long:  maxSlots.long  - usedSlots.long,
    };
    return {
      parts: selected,
      allMet: results.every(r => r.met),
      results,
      remainingSlots,
      usedAllSlots: remainingSlots.close <= 0 && remainingSlots.mid <= 0 && remainingSlots.long <= 0,
    };
  },

  /**
   * 候補パーツ群の中で、各 stat について単一パーツが与える最大の上限上昇量を返す。
   * 新型装甲系 cap パーツは複数装備不可のため「最大1枚」を到達可能上限の見積りに用いる。
   * @param {Array} parts
   * @param {number} msLevel
   * @param {number} enhanceLevel
   * @returns {object} stat キー → 単一パーツ最大cap上昇量
   */
  _maxPartCapBonus(parts, msLevel = 1, enhanceLevel = 0) {
    const best = this._emptyCapBonus();
    const MAP = this.CAP_EFFECT_TO_KEY;
    for (const part of (parts || [])) {
      if (!part || !part.effects) continue;
      for (const eff of part.effects) {
        const key = MAP[eff.type];
        if (!key) continue;
        const v = this.resolveEffectValue(eff, msLevel, enhanceLevel);
        if (v > best[key]) best[key] = v;
      }
    }
    return best;
  },

  /**
   * ある拡張スキル（全レベルのエントリ配列）が影響しうる stat キーの集合を返す。
   * 直接フラット効果（耐ビーム+N）と上限上昇効果（耐ビーム上限+N）の両方を対象 stat とみなす。
   * @param {Array} skillLevelEntries - 同名スキルの全レベルエントリ [{level, effects}, ...]
   * @returns {Set<string>}
   */
  _statKeysAffectedBySkill(skillLevelEntries) {
    const keys = new Set();
    const CAP_MAP = this.CAP_EFFECT_TO_KEY;
    const DIRECT = new Set(['shooting_correction', 'melee_correction',
      'ballistic_armor', 'beam_armor', 'melee_armor', 'thruster', 'boost_speed', 'speed', 'hp']);
    for (const entry of (skillLevelEntries || [])) {
      for (const eff of (entry.effects || [])) {
        if (CAP_MAP[eff.type]) keys.add(CAP_MAP[eff.type]);
        else if (DIRECT.has(eff.type)) keys.add(eff.type);
        else if (eff.type === 'per_custom_part') {
          for (const pe of (eff.perPartEffects || [])) if (DIRECT.has(pe.type)) keys.add(pe.type);
        }
      }
    }
    return keys;
  },

  /**
   * 目標値最適化で未達のステータスについて、付けると到達に寄与する拡張スキルを提案する。
   * 現在の拡張スキル選択を起点に、未達 stat に効くスキルだけを対象として段階的にレベルを
   * 引き上げ、各候補で実際にパーツ最適化(optimizeToTargets)を再実行して効果を検証する貪欲法。
   *
   * @param {object} baseStats
   * @param {object} maxSlots
   * @param {Array} allParts - 装備候補パーツ
   * @param {object} config - {
   *     targets, msLevel, enhanceLevel, equippedParts,
   *     currentSkillLevels: {skillName: level},          // 現在の拡張スキル選択（0=未装備）
   *     expansionSkillsData: [{name, level, effects}, ...] // 全拡張スキル（レベル別エントリ）
   *   }
   * @returns {{
   *     suggestions: Array<{name, fromLevel, toLevel}>,
   *     projectedLevels: object,            // 提案適用後の {skillName: level}
   *     projectedSkillsList: Array,         // 提案適用後の拡張スキルオブジェクト配列
   *     baselineOutcome, projectedOutcome,  // 適用前/後の optimizeToTargets 結果
   *     improved: boolean,
   *     resolvesAll: boolean                // 提案適用で全目標を満たせるか
   *   }}
   */
  suggestExpansionSkills(baseStats, maxSlots, allParts, config) {
    const {
      targets = {},
      msLevel = 1,
      enhanceLevel = 0,
      equippedParts = [],
      currentSkillLevels = {},
      expansionSkillsData = [],
    } = config;

    // スキル名 → レベル別エントリ（昇順）
    const byName = new Map();
    for (const s of expansionSkillsData) {
      if (!byName.has(s.name)) byName.set(s.name, []);
      byName.get(s.name).push(s);
    }
    for (const arr of byName.values()) arr.sort((a, b) => a.level - b.level);

    const buildList = (levels) => {
      const list = [];
      for (const [name, lv] of Object.entries(levels)) {
        if (!lv) continue;
        const entry = (byName.get(name) || []).find(s => s.level === lv);
        if (entry) list.push(entry);
      }
      return list;
    };
    const runOpt = (levels) => this.optimizeToTargets(baseStats, maxSlots, allParts, {
      targets, msLevel, enhanceLevel, equippedParts, expansionSkillsList: buildList(levels),
    });
    // 正規化不足合計（小さいほど良い）と未達件数で構成の良さを評価する
    const score = (outcome) => {
      let deficit = 0, unmet = 0;
      for (const r of outcome.results) {
        if (!r.met) { unmet++; deficit += r.deficit / r.target; }
      }
      return { unmet, deficit };
    };
    const better = (a, b) => a.unmet !== b.unmet ? a.unmet < b.unmet : a.deficit < b.deficit - 1e-9;

    const levels = { ...currentSkillLevels };
    const baselineOutcome = runOpt(levels);
    let currentOutcome = baselineOutcome;
    let currentScore = score(currentOutcome);

    const MAX_ITER = 8;
    for (let iter = 0; iter < MAX_ITER && currentScore.unmet > 0; iter++) {
      const unmetStats = new Set(currentOutcome.results.filter(r => !r.met).map(r => r.stat));

      let bestPick = null; // {name, level, outcome, score}
      for (const [name, entries] of byName.entries()) {
        const maxLv = entries[entries.length - 1].level;
        const cur = levels[name] || 0;
        if (cur >= maxLv) continue;
        // 未達 stat に1つでも効くスキルのみ試す（探索枝刈り）
        const affects = this._statKeysAffectedBySkill(entries);
        let relevant = false;
        for (const s of unmetStats) if (affects.has(s)) { relevant = true; break; }
        if (!relevant) continue;

        for (let lv = cur + 1; lv <= maxLv; lv++) {
          const trialLevels = { ...levels, [name]: lv };
          const trialOutcome = runOpt(trialLevels);
          const trialScore = score(trialOutcome);
          if (!better(trialScore, currentScore)) continue;
          if (!bestPick || better(trialScore, bestPick.score)) {
            bestPick = { name, level: lv, outcome: trialOutcome, score: trialScore };
          }
        }
      }

      if (!bestPick) break; // これ以上効く拡張スキルが無い
      levels[bestPick.name] = bestPick.level;
      currentOutcome = bestPick.outcome;
      currentScore = bestPick.score;
    }

    const suggestions = [];
    for (const [name, lv] of Object.entries(levels)) {
      const from = currentSkillLevels[name] || 0;
      if (lv > from) suggestions.push({ name, fromLevel: from, toLevel: lv });
    }

    return {
      suggestions,
      projectedLevels: levels,
      projectedSkillsList: buildList(levels),
      baselineOutcome,
      projectedOutcome: currentOutcome,
      improved: suggestions.length > 0,
      resolvesAll: currentOutcome.allMet,
    };
  },

  // ===== ダメージシミュレーション（武装ベースの静的与ダメ計算） =====
  //
  // 式（deep research 2026-06-10 で確定・docs/DAMAGE_SIMULATION_DESIGN.md §5）:
  //   ダメージ = 武器威力 ×(機体攻撃補正 × その他攻撃補正) ×(機体防御補正 × その他防御補正)
  //              × [格闘方向補正] × [連撃補正] × 三すくみ補正
  //   適用順序は 攻撃→防御→格闘方向→連撃→三すくみ で固定。
  //   端数処理: 補正係数は小数第3位以下切り捨て、威力との乗算は各段で floor（実測準拠）。
  //   出典: gameline.jp戦闘システム / note.com/jakushoukennja/n1eb582715459(実測) / atwiki pages/83.html

  // 格闘の方向補正倍率（格闘入力方向: N格/横格/下格）。
  // Wiki武器ページの「格闘方向補正」表で確認した標準倍率（2026-06-10・DESIGN §A-4）。
  // 武器ごとの上書き（本武器倍率カラム）は weapon.directionMul で渡す。
  WEAPON_DIRECTION_MULTIPLIERS: { n: 1.0, side: 0.75, down: 1.3 },

  // 武器属性 → 防御補正キー。special は帰属未確定のため暫定で実弾扱い（DESIGN §A-2）。
  ATTR_TO_ARMOR_KEY: { ballistic: 'ballistic', beam: 'beam', melee: 'melee', special: 'ballistic' },

  // 補正係数の端数処理: 小数第3位以下を切り捨て（=小数2桁で保持）。
  // ε は浮動小数点誤差対策（例 1.15*100=114.999… が 114 に落ちるのを防ぐ）。
  // 真の端数は 0.01 単位でしか発生しないため 1e-6 で誤切り上げは起きない。
  _truncMul(v) {
    return Math.floor(v * 100 + 1e-6) / 100;
  },

  // 威力との乗算段の floor（整数化）。ε は同上の FP 誤差対策。
  _floorDmg(x) {
    return Math.floor(x + 1e-6);
  },

  /**
   * 武器威力を機体LVで解決する。LV欠落は LV1 → 先頭値へフォールバック。
   * @param {object|number} power - LV別威力 dict（{"1":2200,"2":2400}）または数値
   */
  resolveWeaponPower(power, msLevel) {
    if (power == null) return 0;
    if (typeof power === 'number') return power;
    const v = power[String(msLevel)] ?? power['1'] ?? Object.values(power)[0];
    return v || 0;
  },

  /**
   * 三すくみ倍率を解決する。auto は攻守カテゴリから判定。
   * %は諸説あり（パッチ変動）のため既存定数 1.30/0.80 を採用（DESIGN §A-5）。
   */
  resolveTriadMultiplier(triad, atkCategory, defCategory) {
    if (triad === 'none') return 1;
    if (triad === 'advantage') return this.ADVANTAGE_MULTIPLIER;
    if (triad === 'disadvantage') return this.DISADVANTAGE_MULTIPLIER;
    const rel = this.TYPE_ADVANTAGE[atkCategory];
    if (!rel) return 1;
    if (rel.strong === defCategory) return this.ADVANTAGE_MULTIPLIER;
    if (rel.weak === defCategory) return this.DISADVANTAGE_MULTIPLIER;
    return 1;
  },

  // 属性/カテゴリ限定スキルが選択中の武器に適用されるか
  _weaponSkillApplies(cond, weapon) {
    switch (cond.condition) {
      case '実弾属性のみ':  return weapon.attribute === 'ballistic';
      case 'ビーム属性のみ': return weapon.attribute === 'beam';
      case '格闘属性のみ':  return weapon.attribute === 'melee';
      case '射撃時のみ':    return weapon.category === 'shooting';
      default: return true; // 常時/瀕死/静止等は ON トグル自体が条件を表す
    }
  },

  // ON 中のスキル条件から指定 side/category の乗算係数列を作る（各々独立乗算 = 異カテゴリ乗算則）
  _collectSkillFactors(conditions, side, category, weapon, activeConditions, toFactor) {
    const factors = [];
    for (const c of (conditions || [])) {
      if (c.side !== side || c.category !== category) continue;
      if (!activeConditions.has(c.id)) continue;
      if (!this._weaponSkillApplies(c, weapon)) continue;
      factors.push(this._truncMul(toFactor(c.value)));
    }
    return factors;
  },

  /**
   * 1武装の静的与ダメージを計算する（ピュア関数・DESIGN §5-1）。
   * @param {object} weapon - 選択モード解決済み武器 {name, category, attribute, power, hits, special?, notes?}
   * @param {object} attacker - 戦闘プロファイル {category, msLevel, correction:{shooting,melee}, dmgPct:{shooting,melee}, skillConditions[]}
   * @param {object} defender - 戦闘プロファイル {category, armor:{ballistic,beam,melee}, cutPct:{...}, skillConditions[]}
   * @param {object} opts - {msLevelAtk?, direction?: 'n'|'side'|'down', triad?: 'auto'|'advantage'|'disadvantage'|'none', activeConditions?: Set<string>}
   * @returns {{perHit:number, perVolley:number, byDirection:object|null, breakdown:object, notes:string, unmodeled:string[]}}
   */
  calcWeaponDamage(weapon, attacker, defender, opts = {}) {
    const {
      msLevelAtk = attacker.msLevel || 1,
      direction = 'n',
      triad = 'auto',
      activeConditions = new Set(),
    } = opts;

    const basePower = this.resolveWeaponPower(weapon.power, msLevelAtk);
    const unmodeled = [];
    if (!basePower) unmodeled.push('威力データなし');

    const isMelee = weapon.attribute === 'melee';
    const corr = isMelee ? (attacker.correction.melee || 0) : (attacker.correction.shooting || 0);
    const atkCorrMul = this._truncMul((100 + corr) / 100);

    // その他攻撃補正: パーツ常時与ダメ% + ON の firepower スキル（各々独立乗算）
    const atkFactors = [];
    const partsDmgPct = isMelee ? (attacker.dmgPct?.melee || 0) : (attacker.dmgPct?.shooting || 0);
    if (partsDmgPct) atkFactors.push(this._truncMul(1 + partsDmgPct / 100));
    atkFactors.push(...this._collectSkillFactors(
      attacker.skillConditions, 'attacker', 'firepower', weapon, activeConditions, v => 1 + v / 100));

    // 防御: 属性→装甲の線形カット ×(1−カット)、パーツ属性カット%・ON防御スキルは乗算合成
    const armorKey = this.ATTR_TO_ARMOR_KEY[weapon.attribute] || 'ballistic';
    if (weapon.attribute === 'special') unmodeled.push('特殊属性の防御対応は未確定（暫定: 実弾扱い）');
    const defCutMul = this._truncMul(1 - this.calcCutRate(defender.armor[armorKey] || 0));
    const defFactors = [];
    const partsCutPct = defender.cutPct?.[armorKey] || 0;
    if (partsCutPct) defFactors.push(this._truncMul(1 - partsCutPct / 100));
    defFactors.push(...this._collectSkillFactors(
      defender.skillConditions, 'defender', 'damage_cut', weapon, activeConditions, v => 1 - v / 100));

    // 耐性無視/貫通: 挙動未確定のため未モデル（×1）。TODO(§A-3)
    const resistIgnoreMul = 1;
    const sp = weapon.special || {};
    if (sp.penetration || sp.resistIgnore) unmodeled.push('耐性無視/貫通は未モデル（§A-3 未確定）');
    if (sp.heavyAttack) unmodeled.push('ヘビーアタック倍率は未モデル（§A-4 未確定）');
    if (sp.comboCorrection) unmodeled.push('コンボ段数別倍率は未対応（後段）');

    const triadMul = this.resolveTriadMultiplier(triad, attacker.category, defender.category);

    // 正準順序: 攻撃→防御→(耐性無視)→格闘方向→三すくみ。各段 floor（連撃補正は Phase 1 対象外）
    const computeFor = (dirMul) => {
      let dmg = this._floorDmg(basePower * atkCorrMul);
      for (const f of atkFactors) dmg = this._floorDmg(dmg * f);
      dmg = this._floorDmg(dmg * defCutMul);
      for (const f of defFactors) dmg = this._floorDmg(dmg * f);
      dmg = this._floorDmg(dmg * resistIgnoreMul);
      dmg = this._floorDmg(dmg * dirMul);
      return this._floorDmg(dmg * triadMul);
    };

    // 標準倍率 + 武器ごとの上書き（Wiki「本武器倍率」カラム由来・パーサが weapon.directionMul に格納）
    const DIR = { ...this.WEAPON_DIRECTION_MULTIPLIERS, ...(weapon.directionMul || {}) };
    const directionMul = isMelee ? (DIR[direction] ?? 1) : 1;
    const perHit = computeFor(directionMul);
    const hits = weapon.hits || 1;
    const product = arr => arr.reduce((a, b) => a * b, 1);

    return {
      perHit,
      perVolley: perHit * hits,
      byDirection: isMelee
        ? { n: computeFor(DIR.n), side: computeFor(DIR.side), down: computeFor(DIR.down) }
        : null,
      breakdown: {
        basePower, atkCorrMul,
        atkSkillMul: this._truncMul(product(atkFactors)),
        defCutMul,
        defSkillMul: this._truncMul(product(defFactors)),
        triadMul, directionMul, resistIgnoreMul, hits,
      },
      notes: weapon.notes || '',
      unmodeled,
    };
  }
};
