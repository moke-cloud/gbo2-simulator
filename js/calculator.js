/**
 * GBO2 ダメージ計算エンジン
 * 戦闘システムwikiページの情報に基づく
 */

const GBO2Calculator = {
  // 三すくみ補正
  TYPE_ADVANTAGE: {
    '強襲': { strong: '支援', weak: '汎用' },
    '汎用': { strong: '強襲', weak: '支援' },
    '支援': { strong: '汎用', weak: '強襲' }
  },
  ADVANTAGE_MULTIPLIER: 1.30,
  DISADVANTAGE_MULTIPLIER: 0.80,

  // 攻撃補正上限: 100 (拡張スキル除く)
  // 防御補正上限: 50 (拡張スキル除く)
  ATTACK_CAP: 100,
  DEFENSE_CAP: 50,

  // スピード上限: 200
  SPEED_CAP: 200,
  // スラスター上限: 100
  THRUSTER_CAP: 100,

  /**
   * ダメージカット率を計算
   * カット率 = 防御補正 / (100 + 防御補正)  (概算)
   * ※ 実際のゲーム内計算式に基づくと: 
   *    ダメージ倍率 = 1 / (1 + 防御補正/100) と近似される
   *    → カット率 = 1 - 1/(1 + armor/100) = armor / (100 + armor)
   */
  calcCutRate(armor) {
    if (armor <= 0) return 0;
    return armor / (100 + armor);
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

  applyEnhancements(baseStats, enhancements, level, msLevel) {
    if (level <= 0 || !enhancements || enhancements.length === 0) return baseStats;

    const modified = { ...baseStats };

    const targetEnhancements = enhancements
      .filter(e => !e.ms_levels || e.ms_levels.length === 0 || e.ms_levels.includes(msLevel))
      .slice(0, level);

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
    const capBonus = {
      shooting_correction: 0, melee_correction: 0,
      ballistic_armor: 0, beam_armor: 0, melee_armor: 0,
      thruster: 0, boost_speed: 0
    };

    for (const skill of (expansionSkillsList || [])) {
      for (const eff of (skill.effects || [])) {
        if (eff.type === 'per_custom_part' || !eff.direct) continue;
        switch (eff.type) {
          case 'shooting_correction':   stats.shooting_correction = (stats.shooting_correction || 0) + eff.value; break;
          case 'melee_correction':      stats.melee_correction    = (stats.melee_correction    || 0) + eff.value; break;
          case 'ballistic_armor':       stats.ballistic_armor     = (stats.ballistic_armor     || 0) + eff.value; break;
          case 'beam_armor':            stats.beam_armor          = (stats.beam_armor          || 0) + eff.value; break;
          case 'melee_armor':           stats.melee_armor         = (stats.melee_armor         || 0) + eff.value; break;
          case 'thruster':              stats.thruster            = (stats.thruster            || 0) + eff.value; break;
          case 'boost_speed':           stats.boost_speed         = (stats.boost_speed         || 0) + eff.value; break;
          case 'hp':                    stats.hp                  = (stats.hp                  || 0) + eff.value; break;
          case 'shooting_correction_cap': capBonus.shooting_correction += eff.value; break;
          case 'melee_correction_cap':    capBonus.melee_correction    += eff.value; break;
          case 'ballistic_armor_cap':     capBonus.ballistic_armor     += eff.value; break;
          case 'beam_armor_cap':          capBonus.beam_armor          += eff.value; break;
          case 'melee_armor_cap':         capBonus.melee_armor         += eff.value; break;
          case 'thruster_cap':            capBonus.thruster            += eff.value; break;
          case 'boost_speed_cap':         capBonus.boost_speed         += eff.value; break;
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
   * @returns {object} 修正後のステータス
   */
  applyParts(baseStats, parts, expansionSkillsList = [], msLevel = 1, enhanceLevel = 0) {
    // 拡張スキルの直接効果を適用し上限値ボーナスを取得
    const { stats: expanded, capBonus } = this.applyExpansionSkillsDirect(baseStats, expansionSkillsList);

    // パーツからも上限ボーナスを収集（先に集めてから上限値を確定する）
    for (const part of parts) {
      if (!part || !part.effects) continue;
      for (const effect of part.effects) {
        const v = this.resolveEffectValue(effect, msLevel, enhanceLevel);
        switch (effect.type) {
          case 'shooting_correction_cap': capBonus.shooting_correction += v; break;
          case 'melee_correction_cap':    capBonus.melee_correction    += v; break;
          case 'ballistic_armor_cap':     capBonus.ballistic_armor     += v; break;
          case 'beam_armor_cap':          capBonus.beam_armor          += v; break;
          case 'melee_armor_cap':         capBonus.melee_armor         += v; break;
          case 'thruster_cap':            capBonus.thruster            += v; break;
          case 'boost_speed_cap':         capBonus.boost_speed         += v; break;
        }
      }
    }

    const modified = { ...expanded };
    let shootingDmgPct = 0;
    let meleeDmgPct = 0;
    let ballisticDamageCutPct = 0;
    let beamDamageCutPct = 0;
    let meleeDamageCutPct = 0;

    const shootingCap    = this.ATTACK_CAP  + (capBonus.shooting_correction || 0);
    const meleeCap       = this.ATTACK_CAP  + (capBonus.melee_correction    || 0);
    const ballisticCap   = this.DEFENSE_CAP + (capBonus.ballistic_armor     || 0);
    const beamCap        = this.DEFENSE_CAP + (capBonus.beam_armor          || 0);
    const meleeArmorCap  = this.DEFENSE_CAP + (capBonus.melee_armor         || 0);
    const thrusterCap    = this.THRUSTER_CAP + (capBonus.thruster           || 0);
    const speedCap       = this.SPEED_CAP   + (capBonus.boost_speed         || 0);

    for (const part of parts) {
      if (!part || !part.effects) continue;
      for (const effect of part.effects) {
        const effectVal = this.resolveEffectValue(effect, msLevel, enhanceLevel);
        switch (effect.type) {
          case 'hp':
            modified.hp = (modified.hp || 0) + effectVal;
            break;
          case 'ballistic_armor':
            modified.ballistic_armor = Math.min((modified.ballistic_armor || 0) + effectVal, ballisticCap);
            break;
          case 'beam_armor':
            modified.beam_armor = Math.min((modified.beam_armor || 0) + effectVal, beamCap);
            break;
          case 'melee_armor':
            modified.melee_armor = Math.min((modified.melee_armor || 0) + effectVal, meleeArmorCap);
            break;
          case 'shooting_correction':
            modified.shooting_correction = Math.min((modified.shooting_correction || 0) + effectVal, shootingCap);
            break;
          case 'melee_correction':
            modified.melee_correction = Math.min((modified.melee_correction || 0) + effectVal, meleeCap);
            break;
          case 'speed':
            modified.speed = Math.min((modified.speed || 0) + effectVal, speedCap);
            break;
          case 'thruster':
            modified.thruster = Math.min((modified.thruster || 0) + effectVal, thrusterCap);
            break;
          case 'turn_speed':
            modified.turn_speed_ground = (modified.turn_speed_ground || 0) + effectVal;
            break;
          case 'boost_speed':
            modified.boost_speed = (modified.boost_speed || 0) + effectVal;
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
        }
      }
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
            case 'shooting_correction': modified.shooting_correction = Math.min((modified.shooting_correction || 0) + bonus, shootingCap); break;
            case 'melee_correction':    modified.melee_correction    = Math.min((modified.melee_correction    || 0) + bonus, meleeCap); break;
            case 'ballistic_armor':     modified.ballistic_armor     = Math.min((modified.ballistic_armor     || 0) + bonus, ballisticCap); break;
            case 'beam_armor':          modified.beam_armor          = Math.min((modified.beam_armor          || 0) + bonus, beamCap); break;
            case 'melee_armor':         modified.melee_armor         = Math.min((modified.melee_armor         || 0) + bonus, meleeArmorCap); break;
            case 'thruster':            modified.thruster            = Math.min((modified.thruster            || 0) + bonus, thrusterCap); break;
            case 'boost_speed':         modified.boost_speed         = (modified.boost_speed         || 0) + bonus; break;
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

    // よろけ値 (複数マッチ対応: 動作開始中35%・判定発生中70% など)
    const staggerRe = /よろけ値を\s*(\d+)%/g;
    let m;
    while ((m = staggerRe.exec(text)) !== null) {
      // コンテキストはマッチ前の40文字のみ（マッチ自体の「よろけ」で誤判定しないよう）
      const ctx = text.substring(Math.max(0, m.index - 40), m.index);
      results.push({ category: 'stagger', value: parseInt(m[1]), condition: this._parseCondition(ctx) });
    }

    // ダメージカット (複数マッチ対応)
    const dcRe = /被ダメージ\s*[－\-ー]\s*(\d+)%|受けるダメージを(\d+)%軽減|機体HPへのダメージを(\d+)%軽減|ダメージを(\d+)%軽減/g;
    while ((m = dcRe.exec(text)) !== null) {
      const value = parseInt(m[1] ?? m[2] ?? m[3] ?? m[4]);
      const ctx = text.substring(Math.max(0, m.index - 40), m.index);
      results.push({ category: 'damage_cut', value, condition: this._parseCondition(ctx) });
    }

    // 火力ボーナス (複数マッチ対応)
    // 通常形式: 「与えるダメージが X% 増加」「威力が X% 増加」
    // 短縮形: 「与ダメージ＋X%」「射撃属性与ダメージ＋X%」「格闘属性与ダメージ＋X%」
    const fpRe = /与えるダメージ(?:が|を)?\s*(\d+)%\s*増加|威力(?:が|を)?\s*(\d+)%\s*増加|攻撃力(?:が|を)?\s*(\d+)%\s*増加|与ダメージ[＋+]\s*(\d+)%/g;
    while ((m = fpRe.exec(text)) !== null) {
      const value = parseInt(m[1] ?? m[2] ?? m[3] ?? m[4]);
      const ctx = text.substring(Math.max(0, m.index - 40), m.index);
      results.push({ category: 'firepower', value, condition: this._parseCondition(ctx) });
    }

    return results;
  },

  _parseCondition(ctx) {
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
    const usedNames = new Set();
    for (const part of currentParts) {
      usedSlots.close += part.slots.close || 0;
      usedSlots.mid   += part.slots.mid   || 0;
      usedSlots.long  += part.slots.long  || 0;
      usedNames.add(part.name);
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
        if (usedNames.has(candidate.name)) continue;
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
      usedNames.add(bestPart.name);
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

    const STAT_SCALES = {
      hp: 1 / 500,
      ballistic_armor: 1.5,
      beam_armor: 1.5,
      melee_armor: 1.5,
      shooting_correction: 2,
      melee_correction: 2,
      shooting_damage_pct: 3,
      melee_damage_pct: 3,
      ballistic_damage_cut_pct: 3,
      beam_damage_cut_pct: 3,
      melee_damage_cut_pct: 3,
      speed: 0.3,
      boost_speed: 0.2,
      thruster: 0.5,
      turn_speed: 0.2
    };

    const activeStats = selectedStats.length > 0
      ? selectedStats
      : Object.keys(STAT_SCALES);
    const w = 1 / activeStats.length;

    const self = this;
    const objectiveFn = (modified) => {
      let score = 0;
      for (const stat of activeStats) {
        const value = self._getModifiedStat(modified, stat);
        const scale = STAT_SCALES[stat] || 1;
        let weight = w;

        if (stat === 'ballistic_armor') weight *= damageRatio.ballistic * 3;
        else if (stat === 'beam_armor') weight *= damageRatio.beam * 3;
        else if (stat === 'melee_armor') weight *= damageRatio.melee * 3;
        else if (stat === 'shooting_correction' || stat === 'shooting_damage_pct')
          weight *= atkRatio.shooting;
        else if (stat === 'melee_correction' || stat === 'melee_damage_pct')
          weight *= atkRatio.melee;

        score += value * scale * weight;
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
  }
};
