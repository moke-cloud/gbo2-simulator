/**
 * GBO2 カスタムパーツ シミュレーター - メインアプリケーション
 */

const App = {
  // データ
  customParts: [],
  msData: [],
  
  // 状態
  selectedMS: null,
  selectedLevel: 1,
  equippedParts: [null, null, null, null, null, null, null, null],
  
  // 設定（比率は整数で保持、計算時に正規化）
  damageRatio: { ballistic: 4, beam: 3, melee: 3 },
  atkRatio: { shooting: 3, melee: 2 },
  selectedStats: [],
  
  partsFilter: 'all',
  partsSearchText: '',
  showUnowned: true,
  unownedParts: new Set(), // 未所持パーツの名前を保持
  enhanceLevel: 0, // 強化施設段階
  activeSkillIndices: new Set(), // ONになっているスキルのインデックス
  _skillEffectCache: [], // 現在表示中の計算可能スキルリスト
  expansionSkillsData: [], // enhancement_skills.json の全拡張スキルデータ
  expansionSkillLevels: {}, // {skillName: selectedLevel} e.g. {'射撃補正拡張': 3, ...}

  async init() {
    try {
      this.loadSettings();
      await this.loadData();
      this.bindEvents();
      this.renderExpansionSkillsUI();
      this.renderPartsList();
    } catch (e) {
      // 初期化失敗はサイレントに（UIは機能しない状態になる）
    }
  },

  async loadData() {
    try {
      const partsRes = await fetch('data/custom_parts.json');
      const partsData = await partsRes.json();
      this.customParts = partsData.parts || [];
    } catch (e) {
      this.customParts = [];
    }

    try {
      const msRes = await fetch('data/ms_data.json');
      const msDataRaw = await msRes.json();
      this.msData = msDataRaw.msList || [];
    } catch (e) {
      this.msData = [];
    }

    try {
      const expRes = await fetch('data/enhancement_skills.json');
      const expData = await expRes.json();
      this.expansionSkillsData = expData.skills || [];
      // 初期状態: 全スキルをLV0（未選択）に設定
      const names = [...new Set(this.expansionSkillsData.map(s => s.name))];
      names.forEach(n => { if (!(n in this.expansionSkillLevels)) this.expansionSkillLevels[n] = 0; });
    } catch (e) {
      this.expansionSkillsData = [];
    }
  },

  loadSettings() {
    try {
      const savedUnowned = localStorage.getItem('gbo2_unowned_parts');
      if (savedUnowned) {
        this.unownedParts = new Set(JSON.parse(savedUnowned));
      }
      const showUnowned = localStorage.getItem('gbo2_show_unowned');
      if (showUnowned !== null) {
        this.showUnowned = showUnowned === 'true';
      }
    } catch (e) {
      // 設定読み込み失敗時はデフォルト値を使用
    }
  },

  saveSettings() {
    localStorage.setItem('gbo2_unowned_parts', JSON.stringify(Array.from(this.unownedParts)));
    localStorage.setItem('gbo2_show_unowned', this.showUnowned);
  },

  bindEvents() {
    // 機体検索とフィルター
    const msSearch = document.getElementById('ms-search');
    const msFilterCategory = document.getElementById('ms-filter-category');
    const msFilterCost = document.getElementById('ms-filter-cost');
    const msFilterLevel = document.getElementById('ms-filter-level');

    msSearch.addEventListener('input', (e) => this.onMSSearch(e.target.value));
    msSearch.addEventListener('focus', (e) => this.onMSSearch(e.target.value));
    
    msFilterCategory.addEventListener('change', () => this.onMSSearch(msSearch.value));
    msFilterCost.addEventListener('change', () => this.onMSSearch(msSearch.value));
    msFilterLevel.addEventListener('change', () => this.onMSSearch(msSearch.value));

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#ms-select-section')) {
        document.getElementById('ms-search-results').classList.add('hidden');
      }
    });

    // 機体LVと強化段階
    document.getElementById('ms-level').addEventListener('change', (e) => {
      this.selectedLevel = parseInt(e.target.value);
      this.updateDisplay();
    });
    document.getElementById('ms-enhance-level').addEventListener('change', (e) => {
      this.enhanceLevel = parseInt(e.target.value);
      this.updateDisplay();
    });

    // 被弾配分（比率入力）
    ['ballistic', 'beam', 'melee'].forEach(type => {
      document.getElementById(`ratio-${type}`).addEventListener('input', (e) => {
        this.damageRatio[type] = Math.max(0, parseInt(e.target.value) || 0);
        this.updateCalculations();
      });
    });
    document.getElementById('btn-equal-damage').addEventListener('click', () => {
      this.damageRatio = { ballistic: 1, beam: 1, melee: 1 };
      document.getElementById('ratio-ballistic').value = 1;
      document.getElementById('ratio-beam').value = 1;
      document.getElementById('ratio-melee').value = 1;
      this.updateCalculations();
    });

    // 攻撃配分（比率入力）
    ['shooting', 'melee'].forEach(type => {
      const id = type === 'shooting' ? 'atk-shooting' : 'atk-melee';
      document.getElementById(id).addEventListener('input', (e) => {
        this.atkRatio[type] = Math.max(0, parseInt(e.target.value) || 0);
        this.updateCalculations();
      });
    });
    document.getElementById('btn-equal-attack').addEventListener('click', () => {
      this.atkRatio = { shooting: 1, melee: 1 };
      document.getElementById('atk-shooting').value = 1;
      document.getElementById('atk-melee').value = 1;
      this.updateCalculations();
    });

    // 優先ステータス（チェックボックス、最大3つ）
    document.getElementById('priority-stats-grid').addEventListener('change', (e) => {
      if (!e.target.matches('input[type="checkbox"]')) return;
      const checked = Array.from(
        document.querySelectorAll('#priority-stats-grid input[type="checkbox"]:checked')
      ).map(cb => cb.value);
      if (checked.length > 3) {
        e.target.checked = false;
        document.getElementById('priority-stats-hint').textContent = '最大3つまで選択できます';
        return;
      }
      document.getElementById('priority-stats-hint').textContent = '';
      this.selectedStats = checked;
    });

    // 自動最適化ボタン
    document.getElementById('btn-optimize').addEventListener('click', () => this.runOptimize());

    // パーツクリアボタン
    document.getElementById('btn-clear').addEventListener('click', () => this.clearParts());

    // パーツカテゴリフィルター
    document.getElementById('parts-category-tabs').addEventListener('click', (e) => {
      if (e.target.classList.contains('filter-tab')) {
        document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');
        this.partsFilter = e.target.dataset.category;
        this.renderPartsList();
      }
    });

    // パーツ検索と未所持表示
    document.getElementById('parts-search').addEventListener('input', (e) => {
      this.partsSearchText = e.target.value;
      this.renderPartsList();
    });
    const unownedCb = document.getElementById('show-unowned');
    unownedCb.checked = this.showUnowned;
    unownedCb.addEventListener('change', (e) => {
      this.showUnowned = e.target.checked;
      this.saveSettings();
      this.renderPartsList();
    });

    // 装備スロットクリック（パーツ削除）
    document.getElementById('equipped-parts').addEventListener('click', (e) => {
      const slot = e.target.closest('.part-slot');
      if (slot && slot.classList.contains('filled')) {
        const idx = parseInt(slot.dataset.slot);
        this.removePart(idx);
      }
    });
  },

  // === 拡張スキルUI ===
  renderExpansionSkillsUI() {
    const container = document.getElementById('expansion-skills-grid');
    if (!container) return;

    // スキル名一覧 (重複なし、元の順序維持)
    const names = [...new Set(this.expansionSkillsData.map(s => s.name))];
    if (names.length === 0) { container.innerHTML = '<p style="color:var(--text-secondary);font-size:0.8rem;">データなし</p>'; return; }

    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    container.innerHTML = names.map(name => {
      const maxLv = this.expansionSkillsData.filter(s => s.name === name).length;
      const cur = this.expansionSkillLevels[name] || 0;
      const opts = Array.from({length: maxLv + 1}, (_, i) =>
        `<option value="${i}" ${i === cur ? 'selected' : ''}>${i === 0 ? '未装備' : 'LV' + i}</option>`
      ).join('');
      return `<div class="expansion-skill-row">
        <span class="expansion-skill-name" title="${esc(name)}">${esc(name)}</span>
        <select class="expansion-skill-select filter-select" data-skill-name="${esc(name)}">${opts}</select>
      </div>`;
    }).join('');

    container.querySelectorAll('.expansion-skill-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const skillName = e.target.dataset.skillName;
        this.expansionSkillLevels[skillName] = parseInt(e.target.value);
        this.updateDisplay();
      });
    });
  },

  // === 機体検索 ===
  onMSSearch(query) {
    const results = document.getElementById('ms-search-results');
    const filterCat = document.getElementById('ms-filter-category').value;
    const filterCost = document.getElementById('ms-filter-cost').value;
    const filterLevel = document.getElementById('ms-filter-level').value;

    const showAll = !query && filterCat === 'all' && filterCost === 'all' && filterLevel === 'all';

    let matches = [];
    
    // 全機体を走査して、条件に合う「機体とレベルの組み合わせ」を探す
    for (const ms of this.msData) {
      if (filterCat !== 'all' && ms.category !== filterCat) continue;
      if (query && !ms.name.toLowerCase().includes(query.toLowerCase())) continue;
      
      const levels = ms.levels || {};
      let matchedLvs = [];
      
      for (const [lv, data] of Object.entries(levels)) {
        if (filterLevel !== 'all' && lv !== filterLevel) continue;
        if (filterCost !== 'all' && String(data.cost) !== filterCost) continue;
        matchedLvs.push(lv);
      }
      
      if (matchedLvs.length > 0) {
        // 代表として見つかった最初のレベルを結果に表示
        matches.push({ ms, lv: matchedLvs[0] });
      }
    }

    if (!showAll) {
      matches = matches.slice(0, 50); // パフォーマンスのため上限
    } else {
      results.classList.add('hidden');
      return;
    }

    if (matches.length === 0) {
      results.classList.add('hidden');
      return;
    }

    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    results.innerHTML = matches.map(match => {
      const ms = match.ms;
      const data = ms.levels[match.lv];
      const catClass = ms.category === '強襲' ? 'raid' : ms.category === '汎用' ? 'general' : 'support';
      return `<div class="search-result-item" data-ms-name="${esc(ms.name)}" data-ms-lv="${Number(match.lv)}">
        <span>${esc(ms.name)} (LV${Number(match.lv)})</span>
        <span class="ms-type ${catClass}">${esc(ms.category || '?')} ${esc(data.cost || '?')}</span>
      </div>`;
    }).join('');

    results.classList.remove('hidden');

    results.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const msName = item.dataset.msName;
        const msLv = parseInt(item.dataset.msLv);
        this.selectMS(msName, msLv);
        results.classList.add('hidden');
        document.getElementById('ms-search').value = msName;
        
        // フィルターをリセットしておく（検索窓での直感性のため）
        document.getElementById('ms-filter-category').value = 'all';
        document.getElementById('ms-filter-cost').value = 'all';
        document.getElementById('ms-filter-level').value = 'all';
      });
    });
  },

  selectMS(name, initialLevel = null) {
    this.selectedMS = this.msData.find(ms => ms.name === name) || null;
    if (this.selectedMS) {
      // LV選択肢を更新
      const lvSelect = document.getElementById('ms-level');
      const availableLvs = Object.keys(this.selectedMS.levels || {}).map(Number).sort((a, b) => a - b);
      
      if (initialLevel && availableLvs.includes(initialLevel)) {
        this.selectedLevel = initialLevel;
      } else if (!availableLvs.includes(this.selectedLevel)) {
        this.selectedLevel = availableLvs[0] || 1;
      }
      
      lvSelect.innerHTML = availableLvs.map(lv => 
        `<option value="${lv}" ${lv === this.selectedLevel ? 'selected' : ''}>LV${lv}</option>`
      ).join('');
      
      document.getElementById('btn-optimize').disabled = false;
      document.getElementById('ms-enhance-level').value = "0";
      this.enhanceLevel = 0;
    }

    // 機体切り替え時にスキルトグルをリセット
    this.activeSkillIndices = new Set();
    this._skillEffectCache = [];
    this.clearParts();
    this.updateDisplay();
  },

  // === 比率正規化ヘルパー ===
  getNormalizedDamageRatio() {
    const { ballistic, beam, melee } = this.damageRatio;
    const total = ballistic + beam + melee;
    if (total === 0) return { ballistic: 1/3, beam: 1/3, melee: 1/3 };
    return { ballistic: ballistic / total, beam: beam / total, melee: melee / total };
  },

  getNormalizedAtkRatio() {
    const { shooting, melee } = this.atkRatio;
    const total = shooting + melee;
    if (total === 0) return { shooting: 0.5, melee: 0.5 };
    return { shooting: shooting / total, melee: melee / total };
  },

  _getActiveSkillDC() {
    const activeItems = this._skillEffectCache.filter((_, i) => this.activeSkillIndices.has(i));
    const dcItems = activeItems.filter(s => s.category === 'damage_cut');
    return dcItems.reduce((acc, s) => acc + s.value, 0);
  },

  // === 表示更新 ===
  updateDisplay() {
    this.updateMSCard();
    this.updateStats();
    this.updateSlots();
    this.updateEquippedParts();
    this.updateCalculations();
    this.updateSkillPanel();
    this.renderPartsList();
  },

  updateMSCard() {
    const card = document.getElementById('ms-info-card');
    if (!this.selectedMS) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');

    const ms = this.selectedMS;
    const lv = ms.levels?.[String(this.selectedLevel)] || {};

    document.getElementById('ms-card-name').textContent = ms.name;
    
    const catEl = document.getElementById('ms-card-category');
    catEl.textContent = ms.category || '?';
    catEl.className = 'ms-category ' + (ms.category === '強襲' ? 'raid' : ms.category === '汎用' ? 'general' : 'support-ms');

    document.getElementById('ms-card-cost').textContent = lv.cost || '-';
    
    const sortie = [];
    if (ms.ground) sortie.push('地上');
    if (ms.space) sortie.push('宇宙');
    document.getElementById('ms-card-sortie').textContent = sortie.join(' / ') || '-';
    
    const env = [];
    if (ms.envGround) env.push('地上');
    if (ms.envSpace) env.push('宇宙');
    document.getElementById('ms-card-env').textContent = env.join(' / ') || 'なし';
  },

  getBaseStats() {
    if (!this.selectedMS) return null;
    const lv = this.selectedMS.levels?.[String(this.selectedLevel)];
    if (!lv) return null;
    const stats = { ...lv };
    return GBO2Calculator.applyEnhancements(stats, this.selectedMS.enhancements || [], this.enhanceLevel, this.selectedLevel);
  },

  /**
   * 現在選択中の拡張スキルオブジェクト配列を返す
   * @returns {Array} [{name, level, category, effects, description}]
   */
  getSelectedExpansionSkills() {
    const result = [];
    for (const [name, level] of Object.entries(this.expansionSkillLevels)) {
      if (!level) continue;
      const skill = this.expansionSkillsData.find(s => s.name === name && s.level === level);
      if (skill) result.push(skill);
    }
    return result;
  },

  getMaxSlots() {
    if (!this.selectedMS || !this.selectedMS.slots) return { close: 0, mid: 0, long: 0 };
    const slots = this.selectedMS.slots;
    const base = {
      close: slots.close?.[String(this.selectedLevel)] || 0,
      mid: slots.mid?.[String(this.selectedLevel)] || 0,
      long: slots.long?.[String(this.selectedLevel)] || 0
    };

    // 複合拡張パーツスロット: 強化段階で解放済みの分だけ各スロットに加算
    const enhancements = this.selectedMS.enhancements || [];
    const slotBonus = enhancements.slice(0, this.enhanceLevel)
      .filter(e => (e.skill_name || '').includes('複合拡張パーツスロット'))
      .reduce((sum, e) => {
        const m = (e.effect || '').match(/(\d+)スロ/);
        return sum + (m ? parseInt(m[1]) : 1);
      }, 0);

    return {
      close: base.close + slotBonus,
      mid: base.mid + slotBonus,
      long: base.long + slotBonus
    };
  },

  getUsedSlots() {
    const used = { close: 0, mid: 0, long: 0 };
    for (const part of this.equippedParts) {
      if (part) {
        used.close += part.slots.close || 0;
        used.mid += part.slots.mid || 0;
        used.long += part.slots.long || 0;
      }
    }
    return used;
  },

  updateStats() {
    const base = this.getBaseStats();
    const statMap = {
      'hp': 'stat-hp',
      'ballistic_armor': 'stat-ballistic',
      'beam_armor': 'stat-beam',
      'melee_armor': 'stat-melee-armor',
      'shooting_correction': 'stat-shooting',
      'melee_correction': 'stat-melee',
      'speed': 'stat-speed',
      'thruster': 'stat-thruster',
      'boost_speed': 'stat-boost',
      'turn_speed_ground': 'stat-turn'
    };

    if (!base) {
      for (const prefix of Object.values(statMap)) {
        document.getElementById(`${prefix}-base`).textContent = '-';
        document.getElementById(`${prefix}-arrow`).classList.add('hidden');
        document.getElementById(`${prefix}-modified`).classList.add('hidden');
      }
      return;
    }

    const modified = GBO2Calculator.applyParts(base, this.equippedParts.filter(Boolean), this.getSelectedExpansionSkills());
    const hasParts = this.equippedParts.some(Boolean);

    for (const [key, prefix] of Object.entries(statMap)) {
      const baseVal = base[key] || 0;
      const modVal = modified[key] || 0;

      document.getElementById(`${prefix}-base`).textContent = baseVal;

      if (hasParts && modVal !== baseVal) {
        document.getElementById(`${prefix}-arrow`).classList.remove('hidden');
        const modEl = document.getElementById(`${prefix}-modified`);
        modEl.classList.remove('hidden');
        modEl.textContent = modVal;
        modEl.classList.toggle('decreased', modVal < baseVal);
      } else {
        document.getElementById(`${prefix}-arrow`).classList.add('hidden');
        document.getElementById(`${prefix}-modified`).classList.add('hidden');
      }
    }
  },

  updateSlots() {
    const maxSlots = this.getMaxSlots();
    const usedSlots = this.getUsedSlots();

    ['close', 'mid', 'long'].forEach(type => {
      const max = maxSlots[type] || 0;
      const used = usedSlots[type] || 0;
      const pct = max > 0 ? (used / max * 100) : 0;

      document.getElementById(`slot-used-${type}`).textContent = used;
      document.getElementById(`slot-max-${type}`).textContent = max;
      document.getElementById(`slot-fill-${type}`).style.width = Math.min(pct, 100) + '%';
    });
  },

  updateEquippedParts() {
    const container = document.getElementById('equipped-parts');
    const slots = container.querySelectorAll('.part-slot');
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    slots.forEach((slot, idx) => {
      const part = this.equippedParts[idx];
      if (part) {
        slot.classList.remove('empty');
        slot.classList.add('filled');
        slot.innerHTML = `
          <span class="part-name">${esc(part.name)}</span>
          <span class="part-lv">LV${esc(part.level)}</span>
          <span class="part-remove" title="取り外す">✕</span>
        `;
      } else {
        slot.classList.add('empty');
        slot.classList.remove('filled');
        slot.innerHTML = `<span class="part-slot-label">${idx + 1}</span>`;
      }
      slot.dataset.slot = idx;
    });
  },

  updateCalculations() {
    const base = this.getBaseStats();
    if (!base) {
      document.getElementById('calc-shooting-power').textContent = '×1.00';
      document.getElementById('calc-melee-power').textContent = '×1.00';
      document.getElementById('calc-offense-score').textContent = '-';
      document.getElementById('calc-ballistic-cut').textContent = '0%';
      document.getElementById('calc-beam-cut').textContent = '0%';
      document.getElementById('calc-melee-cut').textContent = '0%';
      document.getElementById('calc-avg-cut').textContent = '0%';
      document.getElementById('calc-effective-hp').textContent = '-';
      ['combined-dc-section', 'combined-dc-row-ballistic', 'combined-dc-row-beam',
       'combined-dc-row-melee', 'combined-dc-row-all'].forEach(id => {
        document.getElementById(id).style.display = 'none';
      });
      return;
    }

    const normDmgRatio = this.getNormalizedDamageRatio();
    const normAtkRatio = this.getNormalizedAtkRatio();

    const modified = GBO2Calculator.applyParts(base, this.equippedParts.filter(Boolean), this.getSelectedExpansionSkills());

    // 射撃・格闘倍率
    const shootMul = GBO2Calculator.calcShootingMultiplier(modified.shooting_correction || 0) * (1 + (modified.shootingDmgPct || 0) / 100);
    const meleeMul = GBO2Calculator.calcMeleeMultiplier(modified.melee_correction || 0) * (1 + (modified.meleeDmgPct || 0) / 100);

    document.getElementById('calc-shooting-power').textContent = `×${shootMul.toFixed(2)}`;
    document.getElementById('calc-melee-power').textContent = `×${meleeMul.toFixed(2)}`;

    // 総合火力スコア (等倍 / 有利 1.3 / 不利 0.8)
    const offScore = GBO2Calculator.calcOffenseScore(
      modified.shooting_correction || 0,
      modified.melee_correction || 0,
      normAtkRatio,
      modified.shootingDmgPct || 0,
      modified.meleeDmgPct || 0
    );
    document.getElementById('calc-offense-score').textContent = `×${offScore.toFixed(3)} (基準)`;
    document.getElementById('calc-offense-adv').textContent = `×${(offScore * 1.3).toFixed(3)}`;
    document.getElementById('calc-offense-dis').textContent = `×${(offScore * 0.8).toFixed(3)}`;

    // カット率（パーツのみ）
    const armor = {
      ballistic: modified.ballistic_armor || 0,
      beam: modified.beam_armor || 0,
      melee: modified.melee_armor || 0
    };

    const bCut = GBO2Calculator.calcCutRate(armor.ballistic);
    const beCut = GBO2Calculator.calcCutRate(armor.beam);
    const mCut = GBO2Calculator.calcCutRate(armor.melee);

    document.getElementById('calc-ballistic-cut').textContent = `${(bCut * 100).toFixed(1)}%`;
    document.getElementById('calc-beam-cut').textContent = `${(beCut * 100).toFixed(1)}%`;
    document.getElementById('calc-melee-cut').textContent = `${(mCut * 100).toFixed(1)}%`;

    const avgCut = GBO2Calculator.calcWeightedCutRate(armor, normDmgRatio);
    document.getElementById('calc-avg-cut').textContent = `${(avgCut * 100).toFixed(1)}%`;

    // スキル+パーツ合算カット率
    const skillDC = this._getActiveSkillDC(); // %（スキルによる固定カット）
    if (skillDC > 0) {
      // 合算カット率 = 1 - (1 - パーツカット率) × (1 - スキルDC/100)
      const combB  = (1 - (1 - bCut)  * (1 - skillDC / 100)) * 100;
      const combBe = (1 - (1 - beCut) * (1 - skillDC / 100)) * 100;
      const combM  = (1 - (1 - mCut)  * (1 - skillDC / 100)) * 100;
      const combAvg = combB * normDmgRatio.ballistic + combBe * normDmgRatio.beam + combM * normDmgRatio.melee;
      document.getElementById('calc-combined-ballistic').textContent = `${combB.toFixed(1)}%`;
      document.getElementById('calc-combined-beam').textContent = `${combBe.toFixed(1)}%`;
      document.getElementById('calc-combined-melee').textContent = `${combM.toFixed(1)}%`;
      document.getElementById('calc-combined-all').textContent = `${combAvg.toFixed(1)}%`;
      ['combined-dc-section', 'combined-dc-row-ballistic', 'combined-dc-row-beam',
       'combined-dc-row-melee', 'combined-dc-row-all'].forEach(id => {
        document.getElementById(id).style.display = '';
      });
    } else {
      ['combined-dc-section', 'combined-dc-row-ballistic', 'combined-dc-row-beam',
       'combined-dc-row-melee', 'combined-dc-row-all'].forEach(id => {
        document.getElementById(id).style.display = 'none';
      });
    }

    // 有効HP（スキルDCも考慮: 受ける実ダメージが減る分だけHPを水増し換算）
    const skillDCFactor = skillDC > 0 ? 1 / (1 - skillDC / 100) : 1;
    const armorForHP = skillDC > 0
      ? {
          ballistic: 1 - (1 - bCut) * (1 - skillDC / 100),
          beam:      1 - (1 - beCut) * (1 - skillDC / 100),
          melee:     1 - (1 - mCut) * (1 - skillDC / 100)
        }
      : {
          ballistic: bCut,
          beam: beCut,
          melee: mCut
        };
    const effHP = GBO2Calculator.calcEffectiveHPFromCutRates(modified.hp || 0, armorForHP, normDmgRatio);
    document.getElementById('calc-effective-hp').textContent = effHP.toLocaleString() + ' (基準)';
    document.getElementById('calc-effective-hp-adv').textContent = Math.round(effHP / 0.8).toLocaleString();
    document.getElementById('calc-effective-hp-dis').textContent = Math.round(effHP / 1.3).toLocaleString();
  },

  // === スキルパネル ===
  updateSkillPanel() {
    const section = document.getElementById('skills-section');
    if (!this.selectedMS) {
      section.classList.add('hidden');
      return;
    }

    // 効果項目リストを構築（1効果=1トグル）
    // effectItems: [{skillLabel, category, value, condition}]
    const effectItems = [];

    const pushEffects = (skillLabel, effectsArr) => {
      for (const eff of effectsArr) {
        effectItems.push({ skillLabel, ...eff });
      }
    };

    // 機体固有スキル
    for (const skill of (this.selectedMS.skills || [])) {
      if (typeof skill !== 'object') continue;
      const effects = GBO2Calculator.extractSkillEffects(skill);
      if (effects.length > 0) pushEffects(`${skill.name} ${skill.level}`, effects);
    }

    // 強化リスト（現在の強化段階で解放済み）
    const enhancements = this.selectedMS.enhancements || [];
    const activeEnhs = enhancements
      .filter(e => !e.ms_levels || e.ms_levels.length === 0 || e.ms_levels.includes(this.selectedLevel))
      .slice(0, this.enhanceLevel);
    for (const enh of activeEnhs) {
      const effects = GBO2Calculator.extractSkillEffects(enh);
      if (effects.length > 0) pushEffects(enh.skill_name, effects);
    }

    if (effectItems.length === 0) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');

    // 項目数が変わった（機体切替・強化段階変更）場合は全ONで再初期化
    if (this._skillEffectCache.length !== effectItems.length) {
      this._skillEffectCache = effectItems;
      this.activeSkillIndices = new Set(effectItems.map((_, i) => i));
    } else {
      this._skillEffectCache = effectItems;
    }

    const activeItems = effectItems.filter((_, i) => this.activeSkillIndices.has(i));
    const hp = this.getBaseStats()?.hp || 0;

    // よろけ蓄積閾値は常に100%固定（武器よろけ値[%]の累積が100%超えでよろけ発生）
    // calc-stagger-threshold は index.html で静的に「100%（固定）」と表示済み

    // よろけ値: 積算 (例 80%×50%=40%) → 受けたよろけ値が X% で計算される
    const staggerItems = activeItems.filter(s => s.category === 'stagger');
    if (staggerItems.length > 0) {
      const combined = staggerItems.reduce((acc, s) => acc * s.value / 100, 1.0);
      document.getElementById('stagger-effective-row').style.display = '';
      document.getElementById('calc-stagger-effective').textContent =
        `受けたよろけ値 ×${combined.toFixed(3)} （${(combined * 100).toFixed(1)}%）`;
    } else {
      document.getElementById('stagger-effective-row').style.display = 'none';
    }

    // ダメージカット: 加算合計
    const dcItems = activeItems.filter(s => s.category === 'damage_cut');
    if (dcItems.length > 0) {
      const total = dcItems.reduce((acc, s) => acc + s.value, 0);
      document.getElementById('damage-cut-skill-row').style.display = '';
      document.getElementById('calc-skill-damage-cut').textContent = `-${total}%`;
    } else {
      document.getElementById('damage-cut-skill-row').style.display = 'none';
    }

    // 火力: 加算合計
    const fpItems = activeItems.filter(s => s.category === 'firepower');
    if (fpItems.length > 0) {
      const total = fpItems.reduce((acc, s) => acc + s.value, 0);
      document.getElementById('firepower-skill-row').style.display = '';
      document.getElementById('calc-skill-firepower').textContent = `+${total}%`;
    } else {
      document.getElementById('firepower-skill-row').style.display = 'none';
    }

    // トグルリスト描画（1効果=1行）
    const catLabel = { stagger: 'よろけ値', damage_cut: 'ダメージカット', firepower: '火力' };
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const safeCategory = (c) => ['stagger', 'damage_cut', 'firepower'].includes(c) ? c : '';
    const container = document.getElementById('skill-toggles-list');
    container.innerHTML = effectItems.map((item, i) => {
      const isOn = this.activeSkillIndices.has(i);
      const badge = catLabel[item.category] || '';
      const cat = safeCategory(item.category);
      const valueText = item.category === 'stagger'
        ? `よろけ値を ${Number(item.value)}% で計算`
        : item.category === 'damage_cut'
        ? `被ダメージ -${Number(item.value)}%`
        : `ダメージ +${Number(item.value)}%`;
      return `
        <div class="skill-toggle-item ${isOn ? 'active' : ''}">
          <div class="skill-toggle-header">
            <label class="toggle-switch">
              <input type="checkbox" ${isOn ? 'checked' : ''} onchange="App.toggleSkill(${i})">
              <span class="toggle-slider"></span>
            </label>
            <span class="skill-toggle-name">${esc(item.skillLabel)}</span>
            <span class="skill-category-badge ${cat}">${esc(badge)}</span>
          </div>
          <div class="skill-effect-row">
            <span>【${esc(item.condition)}】${valueText}</span>
            <span class="skill-effect-value">${item.category === 'stagger' ? `×${(Number(item.value) / 100).toFixed(2)}` : (item.category === 'damage_cut' ? `-${Number(item.value)}%` : `+${Number(item.value)}%`)}</span>
          </div>
        </div>`;
    }).join('');
  },

  toggleSkill(idx) {
    if (this.activeSkillIndices.has(idx)) {
      this.activeSkillIndices.delete(idx);
    } else {
      this.activeSkillIndices.add(idx);
    }
    this.updateSkillPanel();
    this.updateCalculations();
  },

  // === パーツ操作 ===
  equipPart(part) {
    const emptyIdx = this.equippedParts.indexOf(null);
    if (emptyIdx === -1) return; // 8個制限

    const maxSlots = this.getMaxSlots();
    const usedSlots = this.getUsedSlots();
    const remaining = {
      close: maxSlots.close - usedSlots.close,
      mid: maxSlots.mid - usedSlots.mid,
      long: maxSlots.long - usedSlots.long
    };

    if (!GBO2Calculator.canEquip(part, remaining)) return;

    // 同名パーツ重複チェック
    if (this.equippedParts.some(p => p && p.name === part.name)) return;

    this.equippedParts[emptyIdx] = part;
    this.updateDisplay();
  },

  removePart(index) {
    this.equippedParts[index] = null;
    this.updateDisplay();
  },

  clearParts() {
    this.equippedParts = [null, null, null, null, null, null, null, null];
    this.updateDisplay();
  },

  runOptimize() {
    if (!this.selectedMS) return;

    const base = this.getBaseStats();
    if (!base) return;

    const maxSlots = this.getMaxSlots();
    
    const result = GBO2Calculator.optimize(base, maxSlots, this.customParts.filter(p => !this.unownedParts.has(p.name)), {
      damageRatio: this.getNormalizedDamageRatio(),
      atkRatio: this.getNormalizedAtkRatio(),
      selectedStats: this.selectedStats,
      enhanceLevel: this.enhanceLevel
    });

    this.equippedParts = [null, null, null, null, null, null, null, null];
    result.forEach((part, idx) => {
      if (idx < 8) this.equippedParts[idx] = part;
    });

    this.updateDisplay();
  },

  // === パーツ一覧レンダリング ===
  renderPartsList() {
    const container = document.getElementById('parts-list');

    let filtered = this.customParts;

    if (this.partsFilter !== 'all') {
      filtered = filtered.filter(p => p.category === this.partsFilter);
    }

    if (this.partsSearchText) {
      const q = this.partsSearchText.toLowerCase();
      filtered = filtered.filter(p => p.name.toLowerCase().includes(q));
    }

    // 同名パーツをグループ化（LV昇順）
    const groupMap = {};
    for (const part of filtered) {
      if (!groupMap[part.name]) groupMap[part.name] = [];
      groupMap[part.name].push(part);
    }
    for (const name of Object.keys(groupMap)) {
      groupMap[name].sort((a, b) => a.level - b.level);
    }

    const maxSlots = this.getMaxSlots();
    const usedSlots = this.getUsedSlots();
    const remaining = {
      close: maxSlots.close - usedSlots.close,
      mid: maxSlots.mid - usedSlots.mid,
      long: maxSlots.long - usedSlots.long
    };

    const equippedNames = new Set(this.equippedParts.filter(Boolean).map(p => p.name));
    const isFull = this.equippedParts.filter(Boolean).length >= 8;

    const categoryMap = {
      attack: '攻撃',
      defense: '防御',
      mobility: '移動',
      support: '補助',
      special: '特殊'
    };

    const escapeHtml = (str) => String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const html = Object.entries(groupMap).map(([name, levels]) => {
      const isUnowned = this.unownedParts.has(name);
      if (isUnowned && !this.showUnowned) return '';

      const maxLvPart = levels[levels.length - 1];
      const equippedPart = this.equippedParts.find(p => p && p.name === name);
      const isEquipped = !!equippedPart;
      const hasMultipleLvs = levels.length > 1;

      // グループヘッダー用スロット情報（最大LV基準）
      const slotsHtml = [];
      if (maxLvPart.slots.close > 0) slotsHtml.push(`<span class="slot-close">近${maxLvPart.slots.close}</span>`);
      if (maxLvPart.slots.mid > 0) slotsHtml.push(`<span class="slot-mid">中${maxLvPart.slots.mid}</span>`);
      if (maxLvPart.slots.long > 0) slotsHtml.push(`<span class="slot-long">遠${maxLvPart.slots.long}</span>`);

      const groupClasses = ['part-group'];
      if (isUnowned) groupClasses.push('unowned');
      if (isEquipped) groupClasses.push('equipped');

      // LV行のHTML（アコーディオン内）
      const lvRowsHtml = levels.map(part => {
        const canEquip = this.selectedMS
          && !isFull
          && !equippedNames.has(part.name)
          && GBO2Calculator.canEquip(part, remaining);
        const isThisEquipped = equippedPart && equippedPart.level === part.level;
        const lvClass = ['part-lv-row'];
        if (!canEquip && !isThisEquipped) lvClass.push('unequippable');
        if (isThisEquipped) lvClass.push('lv-equipped');
        return `<div class="${lvClass.join(' ')}" data-part-name="${escapeHtml(name)}" data-part-lv="${part.level}">
          <span class="lv-badge">LV${part.level}</span>
          <span class="lv-desc">${escapeHtml(part.description)}</span>
          ${isThisEquipped ? '<span class="lv-equipped-badge">装備中</span>' : ''}
        </div>`;
      }).join('');

      const lvBadge = isEquipped
        ? `<span class="part-equipped-lv">LV${equippedPart.level} 装備中</span>`
        : `<span class="part-lv-range">${hasMultipleLvs ? `LV1〜${maxLvPart.level}` : `LV${maxLvPart.level}`}</span>`;

      return `<div class="${groupClasses.join(' ')}" data-part-group="${escapeHtml(name)}">
        <div class="part-group-header">
          <div class="part-group-title">
            <span class="part-item-name">${escapeHtml(name)}</span>
            ${lvBadge}
            <span class="part-item-category ${maxLvPart.category}">${categoryMap[maxLvPart.category] || maxLvPart.category}</span>
          </div>
          <div class="part-group-actions">
            <div class="part-item-slots">${slotsHtml.join('')}</div>
            <button class="btn-own-toggle ${!isUnowned ? 'owned' : ''}" data-part-name="${escapeHtml(name)}" title="所持/未所持の切り替え">★</button>
            ${hasMultipleLvs ? `<button class="btn-accordion" data-part-group="${escapeHtml(name)}" title="LV一覧を展開">▼</button>` : ''}
          </div>
        </div>
        ${hasMultipleLvs ? `<div class="part-lv-list collapsed">${lvRowsHtml}</div>` : `<div class="part-item-detail">${escapeHtml(maxLvPart.description)}</div>`}
      </div>`;
    }).join('');

    container.innerHTML = html || '<p class="no-parts">該当するパーツがありません</p>';

    // アコーディオントグル
    container.querySelectorAll('.btn-accordion').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const groupName = btn.dataset.partGroup;
        const groupEl = container.querySelector(`.part-group[data-part-group="${CSS.escape(groupName)}"]`);
        const lvList = groupEl && groupEl.querySelector('.part-lv-list');
        if (!lvList) return;
        const isCollapsed = lvList.classList.contains('collapsed');
        lvList.classList.toggle('collapsed', !isCollapsed);
        btn.textContent = isCollapsed ? '▲' : '▼';
      });
    });

    // LV行クリックで装備
    container.querySelectorAll('.part-lv-row:not(.unequippable)').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.btn-own-toggle')) return;
        const partName = row.dataset.partName;
        const partLv = parseInt(row.dataset.partLv, 10);
        const part = (groupMap[partName] || []).find(p => p.level === partLv);
        if (part && !this.unownedParts.has(partName)) {
          this.equipPart(part);
        }
      });
    });

    // LVが1つだけのグループ: ヘッダークリックで装備
    container.querySelectorAll('.part-group').forEach(groupEl => {
      const groupName = groupEl.dataset.partGroup;
      const levels = groupMap[groupName] || [];
      if (levels.length === 1) {
        groupEl.querySelector('.part-group-header').addEventListener('click', (e) => {
          if (e.target.closest('.btn-own-toggle') || e.target.closest('.btn-accordion')) return;
          const part = levels[0];
          const canEquip = this.selectedMS
            && !isFull
            && !equippedNames.has(part.name)
            && GBO2Calculator.canEquip(part, remaining);
          if (canEquip && !this.unownedParts.has(part.name)) {
            this.equipPart(part);
          }
        });
      }
    });

    // 所持トグルの処理
    container.querySelectorAll('.btn-own-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const partName = btn.dataset.partName;
        if (this.unownedParts.has(partName)) {
          this.unownedParts.delete(partName);
        } else {
          this.unownedParts.add(partName);
          // 装備中なら外す
          const equippedIdx = this.equippedParts.findIndex(p => p && p.name === partName);
          if (equippedIdx !== -1) {
            this.removePart(equippedIdx);
          }
        }
        this.saveSettings();
        this.renderPartsList();
      });
    });
  }
};

// アプリ起動
document.addEventListener('DOMContentLoaded', () => App.init());
