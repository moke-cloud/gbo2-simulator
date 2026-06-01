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
  savedBuilds: [], // 保存済み構成リスト
  
  // 設定（比率は整数で保持、計算時に正規化）
  damageRatio: { ballistic: 4, beam: 3, melee: 3 },
  atkRatio: { shooting: 3, melee: 2 },
  selectedStats: [],
  optimizeGoal: 'balance', // 最適化の方針: balance | attack | defense | thruster
  
  partsFilter: 'all',
  partsSearchText: '',
  showUnowned: true,
  unownedParts: new Set(), // 未所持パーツの名前を保持
  enhanceLevel: 0, // 強化施設段階
  activeSkillIndices: new Set(), // ONになっているスキルのインデックス
  _skillEffectCache: [], // 現在表示中の計算可能スキルリスト
  expansionSkillsData: [], // enhancement_skills.json の全拡張スキルデータ
  expansionSkillLevels: {}, // {skillName: selectedLevel} e.g. {'射撃補正拡張': 3, ...}
  _expandedParts: new Set(), // アコーディオン展開中のパーツ名

  async init() {
    try {
      this.loadSettings();
      await this.loadData();
      this.bindEvents();
      this.bindExtraEvents();
      this.renderExpansionSkillsUI();
      this.renderPartsList();
      this.renderSavedBuilds();
      this.updateBuildSelectOptions();
      this.populateOnboardingMeta();
      this.loadSharedBuildFromUrl();
    } catch (e) {
      const content = document.getElementById('content');
      if (content) {
        content.innerHTML = `
          <div style="padding: 2rem; text-align: center; color: var(--accent-red, #ff4060);">
            <h2 style="margin-bottom: 1rem;">初期化エラー</h2>
            <p style="color: var(--text-secondary, #8892a4);">データの読み込みに失敗しました。ページを再読み込みしてください。</p>
            <button onclick="location.reload()" style="margin-top: 1rem; padding: 0.5rem 1.5rem; background: var(--accent-blue, #00b4ff); color: #fff; border: none; border-radius: 6px; cursor: pointer;">再読み込み</button>
          </div>`;
      }
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
      if (savedUnowned) this.unownedParts = new Set(JSON.parse(savedUnowned));

      const showUnowned = localStorage.getItem('gbo2_show_unowned');
      if (showUnowned !== null) this.showUnowned = showUnowned === 'true';

      const savedBuilds = localStorage.getItem('gbo2_saved_builds');
      if (savedBuilds) this.savedBuilds = JSON.parse(savedBuilds);
    } catch (e) {
      // 設定読み込み失敗時はデフォルト値を使用
    }
  },

  saveSettings() {
    try {
      localStorage.setItem('gbo2_unowned_parts', JSON.stringify(Array.from(this.unownedParts)));
      localStorage.setItem('gbo2_show_unowned', this.showUnowned);
    } catch (e) {
      // Safari private mode 等で localStorage が使えない場合は無視
    }
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

    // パーツパネルトグル（モバイル）
    const btnToggleParts = document.getElementById('btn-toggle-parts');
    if (btnToggleParts) {
      btnToggleParts.addEventListener('click', () => {
        const panel = document.getElementById('parts-panel');
        panel.classList.toggle('collapsed');
        btnToggleParts.textContent = panel.classList.contains('collapsed') ? '▶' : '▼';
      });
    }

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

    // 最適化の方針セレクタ
    const goalGrid = document.getElementById('opt-goal-grid');
    if (goalGrid) {
      goalGrid.addEventListener('click', (e) => {
        const btn = e.target.closest('.opt-goal');
        if (!btn || btn.disabled) return;
        goalGrid.querySelectorAll('.opt-goal').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.optimizeGoal = btn.dataset.goal;
        this.updateOptGoalDesc();
      });
    }

    // 自動最適化ボタン（方針に応じてディスパッチ）
    document.getElementById('btn-optimize').addEventListener('click', () => this.runOptimizeDispatch());

    // パーツクリアボタン
    document.getElementById('btn-clear').addEventListener('click', () => this.clearParts());

    // 構成保存
    document.getElementById('btn-save-build').addEventListener('click', () => {
      const name = document.getElementById('build-save-name').value;
      this.saveBuild(name);
      document.getElementById('build-save-name').value = '';
    });
    document.getElementById('build-save-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btn-save-build').click();
    });

    // 構成比較
    document.getElementById('btn-compare').addEventListener('click', () => this.runCompareBuild());

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

    // 装備スロットクリック
    // 装備済みスロット → タップで即解除（PC/スマホ共通、✕が目印）
    // 空きスロット(スマホ) → パーツ選択シートを開く
    document.getElementById('equipped-parts').addEventListener('click', (e) => {
      const slot = e.target.closest('.part-slot');
      if (!slot) return;
      const idx = parseInt(slot.dataset.slot);
      if (slot.classList.contains('filled')) {
        this.removePart(idx);
      } else if (this.isMobileLayout()) {
        this.openPartsSheet();
      }
    });
  },

  // === 追加機能のイベント結線（共有・計算方法モーダル） ===
  bindExtraEvents() {
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    on('btn-share', 'click', () => this.shareCurrentBuild());
    on('btn-methodology', 'click', () => this.openMethodology());
    on('btn-open-methodology', 'click', () => this.openMethodology());
    on('btn-close-methodology', 'click', () => this.closeMethodology());
    const overlay = document.getElementById('methodology-modal');
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) this.closeMethodology(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.closeMethodology(); this.closePartsSheet(); }
    });

    // モバイル用パーツ選択シート
    on('btn-open-parts', 'click', () => this.openPartsSheet());
    on('btn-close-parts-sheet', 'click', () => this.closePartsSheet());
    on('parts-sheet-backdrop', 'click', () => this.closePartsSheet());
    // デスクトップ幅に戻ったらシートを閉じる
    window.addEventListener('resize', () => { if (!this.isMobileLayout()) this.closePartsSheet(); });
  },

  // === モバイル用パーツ選択シート ===
  isMobileLayout() {
    return window.matchMedia('(max-width: 860px)').matches;
  },

  openPartsSheet() {
    if (!this.isMobileLayout()) return;
    document.body.classList.add('parts-sheet-open');
    const bd = document.getElementById('parts-sheet-backdrop');
    if (bd) bd.classList.remove('hidden');
    const panel = document.getElementById('parts-panel');
    if (panel) panel.classList.remove('collapsed');
    this.updateSheetSlotSummary();
  },

  closePartsSheet() {
    document.body.classList.remove('parts-sheet-open');
    const bd = document.getElementById('parts-sheet-backdrop');
    if (bd) bd.classList.add('hidden');
  },

  // シート上部に残りスロット(近/中/遠 使用/上限)をライブ表示する
  updateSheetSlotSummary() {
    const el = document.getElementById('sheet-slot-summary');
    if (!el) return;
    const max = this.getMaxSlots();
    const used = this.getUsedSlots();
    const labels = { close: '近', mid: '中', long: '遠' };
    const chips = ['close', 'mid', 'long'].map(t => {
      const u = used[t] || 0;
      const m = max[t] || 0;
      const full = m > 0 && u >= m;
      return `<span class="sheet-slot-chip slot-${t}${full ? ' full' : ''}">${labels[t]} ${u}/${m}</span>`;
    }).join('');
    el.innerHTML = `<span class="sheet-slot-label">残スロット</span>${chips}`;
  },

  populateOnboardingMeta() {
    const m = document.getElementById('onboarding-ms-count');
    const p = document.getElementById('onboarding-parts-count');
    if (m) m.textContent = this.msData.length.toLocaleString();
    if (p) p.textContent = new Set(this.customParts.map(x => x.name)).size.toLocaleString();
  },

  showToast(msg, isError = false) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('toast-error', !!isError);
    el.classList.remove('hidden');
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.classList.add('hidden'), 250);
    }, 2400);
  },

  openMethodology() {
    const m = document.getElementById('methodology-modal');
    if (m) m.classList.remove('hidden');
  },
  closeMethodology() {
    const m = document.getElementById('methodology-modal');
    if (m) m.classList.add('hidden');
  },

  // === 構成共有 ===
  getCurrentBuildState() {
    if (!this.selectedMS) return null;
    return {
      msName: this.selectedMS.name,
      msLevel: this.selectedLevel,
      enhanceLevel: this.enhanceLevel,
      parts: this.equippedParts.filter(Boolean).map(p => ({ name: p.name, level: p.level })),
      expansionSkillLevels: this.expansionSkillLevels,
      activeSkillIndices: Array.from(this.activeSkillIndices),
      damageRatio: this.damageRatio,
      atkRatio: this.atkRatio,
    };
  },

  async shareCurrentBuild() {
    const state = this.getCurrentBuildState();
    if (!state) { this.showToast('先に機体を選択してください', true); return; }
    const url = BuildShare.encodeToUrl(state);
    try { history.replaceState(null, '', url); } catch (e) { /* noop */ }
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        copied = true;
      }
    } catch (e) { copied = false; }
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        copied = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) { copied = false; }
    }
    this.showToast(copied ? '共有URLをコピーしました' : '共有URLをアドレスバーに反映しました');
  },

  loadSharedBuildFromUrl() {
    const state = BuildShare.readFromUrl();
    if (!state) return;
    this.applySharedBuild(state);
    this.showToast('共有された構成を読み込みました');
  },

  _syncRatioInputs() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('ratio-ballistic', this.damageRatio.ballistic);
    set('ratio-beam', this.damageRatio.beam);
    set('ratio-melee', this.damageRatio.melee);
    set('atk-shooting', this.atkRatio.shooting);
    set('atk-melee', this.atkRatio.melee);
  },

  applySharedBuild(state) {
    const ms = this.msData.find(m => m.name === state.msName);
    if (!ms) { this.showToast(`機体「${state.msName}」が見つかりません`, true); return; }
    this.selectedMS = ms;

    const availableLvs = Object.keys(ms.levels || {}).map(Number).sort((a, b) => a - b);
    this.selectedLevel = availableLvs.includes(state.msLevel) ? state.msLevel : (availableLvs[0] || 1);
    this.enhanceLevel = state.enhanceLevel || 0;

    const lvSelect = document.getElementById('ms-level');
    lvSelect.innerHTML = availableLvs.map(lv =>
      `<option value="${lv}" ${lv === this.selectedLevel ? 'selected' : ''}>LV${lv}</option>`
    ).join('');
    document.getElementById('ms-enhance-level').value = String(this.enhanceLevel);
    document.getElementById('ms-search').value = ms.name;

    this.equippedParts = [null, null, null, null, null, null, null, null];
    const missing = [];
    (state.parts || []).forEach((sp, idx) => {
      if (idx >= 8) return;
      const part = this.customParts.find(p => p.name === sp.name && p.level === sp.level);
      if (part) this.equippedParts[idx] = part;
      else missing.push(`${sp.name} LV${sp.level}`);
    });

    if (state.expansionSkillLevels) {
      Object.keys(this.expansionSkillLevels).forEach(n => { this.expansionSkillLevels[n] = 0; });
      Object.entries(state.expansionSkillLevels).forEach(([n, lv]) => { this.expansionSkillLevels[n] = lv; });
      this.renderExpansionSkillsUI();
    }
    if (state.damageRatio) { this.damageRatio = { ...state.damageRatio }; }
    if (state.atkRatio) { this.atkRatio = { ...state.atkRatio }; }
    this._syncRatioInputs();

    this.activeSkillIndices = new Set();
    this._skillEffectCache = [];
    this.enableBuildControls();
    const guide = document.getElementById('onboarding-guide');
    if (guide) guide.classList.add('hidden');

    this.updateDisplay();

    // スキルトグル状態を復元（updateSkillPanel がキャッシュ構築後）
    if (Array.isArray(state.activeSkillIndices) && this._skillEffectCache.length > 0) {
      this.activeSkillIndices = new Set(state.activeSkillIndices);
      this.updateSkillPanel();
      this.updateCalculations();
    }
    if (missing.length > 0) {
      this.showToast(`一部パーツが見つかりません（${missing.length}件）`, true);
    }
  },

  // === ビルドサマリー（headline） ===
  updateSummary() {
    const section = document.getElementById('summary-section');
    if (!section) return;
    const base = this.selectedMS ? this.getBaseStats() : null;
    if (!base) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');

    const mod = GBO2Calculator.applyParts(base, this.equippedParts.filter(Boolean), this.getSelectedExpansionSkills(), this.selectedLevel, this.enhanceLevel);
    const normDmg = this.getNormalizedDamageRatio();
    const normAtk = this.getNormalizedAtkRatio();

    const shootMul = GBO2Calculator.calcShootingMultiplier(mod.shooting_correction || 0) * (1 + (mod.shootingDmgPct || 0) / 100);
    const meleeMul = GBO2Calculator.calcMeleeMultiplier(mod.melee_correction || 0) * (1 + (mod.meleeDmgPct || 0) / 100);
    const offScore = GBO2Calculator.calcOffenseScore(mod.shooting_correction || 0, mod.melee_correction || 0, normAtk, mod.shootingDmgPct || 0, mod.meleeDmgPct || 0);

    const armorBCut = GBO2Calculator.calcCutRate(mod.ballistic_armor || 0);
    const armorBeCut = GBO2Calculator.calcCutRate(mod.beam_armor || 0);
    const armorMCut = GBO2Calculator.calcCutRate(mod.melee_armor || 0);
    const pB = mod.ballisticDamageCutPct || 0, pBe = mod.beamDamageCutPct || 0, pM = mod.meleeDamageCutPct || 0;
    const bCut = pB > 0 ? 1 - (1 - armorBCut) * (1 - pB / 100) : armorBCut;
    const beCut = pBe > 0 ? 1 - (1 - armorBeCut) * (1 - pBe / 100) : armorBeCut;
    const mCut = pM > 0 ? 1 - (1 - armorMCut) * (1 - pM / 100) : armorMCut;
    const avgCut = bCut * normDmg.ballistic + beCut * normDmg.beam + mCut * normDmg.melee;
    const effHP = GBO2Calculator.calcEffectiveHPFromCutRates(mod.hp || 0, { ballistic: bCut, beam: beCut, melee: mCut }, normDmg);

    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setText('sum-firepower', `×${offScore.toFixed(2)}`);
    setText('sum-firepower-sub', `射撃 ×${shootMul.toFixed(2)} / 格闘 ×${meleeMul.toFixed(2)}`);
    setText('sum-ehp', effHP.toLocaleString());
    setText('sum-ehp-sub', `加重カット率 ${(avgCut * 100).toFixed(1)}%`);
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
      
      this.enableBuildControls();
      document.getElementById('ms-enhance-level').value = "0";
      this.enhanceLevel = 0;

      // ガイダンスを非表示
      const guide = document.getElementById('onboarding-guide');
      if (guide) guide.classList.add('hidden');
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

  /**
   * スキルによるダメージカットを属性別に返す
   * condition が「実弾属性のみ」→ ballistic のみ、「ビーム属性のみ」→ beam のみ、
   * 「格闘属性のみ」→ melee のみ、それ以外は全属性に適用
   * @returns {{ ballistic: number, beam: number, melee: number }}
   */
  _getActiveSkillDCByType() {
    const dc = { ballistic: 0, beam: 0, melee: 0 };
    const activeItems = this._skillEffectCache.filter((_, i) => this.activeSkillIndices.has(i));
    const dcItems = activeItems.filter(s => s.category === 'damage_cut');
    for (const item of dcItems) {
      if (item.condition === '実弾属性のみ') {
        dc.ballistic += item.value;
      } else if (item.condition === 'ビーム属性のみ') {
        dc.beam += item.value;
      } else if (item.condition === '格闘属性のみ') {
        dc.melee += item.value;
      } else {
        dc.ballistic += item.value;
        dc.beam += item.value;
        dc.melee += item.value;
      }
    }
    return dc;
  },

  _getActiveSkillDC() {
    const dc = this._getActiveSkillDCByType();
    return Math.max(dc.ballistic, dc.beam, dc.melee);
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
    this.updateStickyStats();
    this.updateSummary();
  },

  updateStickyStats() {
    const bar = document.getElementById('sticky-stats');
    if (!bar) return;
    if (!this.selectedMS) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');

    const base = this.getBaseStats();
    if (!base) return;
    const mod = GBO2Calculator.applyParts(base, this.equippedParts.filter(Boolean), this.getSelectedExpansionSkills(), this.selectedLevel, this.enhanceLevel);
    const hasParts = this.equippedParts.some(Boolean);

    const set = (id, val, changed) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = val;
      el.classList.toggle('ss-changed', changed);
    };

    set('ss-hp', mod.hp || 0, hasParts && mod.hp !== base.hp);
    set('ss-shoot', mod.shooting_correction || 0, hasParts && mod.shooting_correction !== base.shooting_correction);
    set('ss-melee', mod.melee_correction || 0, hasParts && mod.melee_correction !== base.melee_correction);
    set('ss-bal', mod.ballistic_armor || 0, hasParts && mod.ballistic_armor !== base.ballistic_armor);
    set('ss-beam', mod.beam_armor || 0, hasParts && mod.beam_armor !== base.beam_armor);
    set('ss-marm', mod.melee_armor || 0, hasParts && mod.melee_armor !== base.melee_armor);
    set('ss-thr', mod.thruster || 0, hasParts && mod.thruster !== base.thruster);

    const normDmg = this.getNormalizedDamageRatio();
    const normAtk = this.getNormalizedAtkRatio();
    const offScore = GBO2Calculator.calcOffenseScore(mod.shooting_correction||0, mod.melee_correction||0, normAtk, mod.shootingDmgPct||0, mod.meleeDmgPct||0);
    set('ss-offense', `×${offScore.toFixed(2)}`, hasParts);

    // 装甲カットと属性ダメージ軽減%を乗算合成（サマリー・計算カードと同一ロジック）
    const armorBCut = GBO2Calculator.calcCutRate(mod.ballistic_armor||0);
    const armorBeCut = GBO2Calculator.calcCutRate(mod.beam_armor||0);
    const armorMCut = GBO2Calculator.calcCutRate(mod.melee_armor||0);
    const pB = mod.ballisticDamageCutPct||0, pBe = mod.beamDamageCutPct||0, pM = mod.meleeDamageCutPct||0;
    const bCut = pB > 0 ? 1 - (1 - armorBCut) * (1 - pB / 100) : armorBCut;
    const beCut = pBe > 0 ? 1 - (1 - armorBeCut) * (1 - pBe / 100) : armorBeCut;
    const mCut = pM > 0 ? 1 - (1 - armorMCut) * (1 - pM / 100) : armorMCut;
    const effHP = GBO2Calculator.calcEffectiveHPFromCutRates(mod.hp||0, {ballistic:bCut, beam:beCut, melee:mCut}, normDmg);
    set('ss-ehp', effHP.toLocaleString(), hasParts);

    const maxSlots = this.getMaxSlots();
    const usedSlots = this.getUsedSlots();
    set('ss-slot-c', `${usedSlots.close}/${maxSlots.close}`, false);
    set('ss-slot-m', `${usedSlots.mid}/${maxSlots.mid}`, false);
    set('ss-slot-l', `${usedSlots.long}/${maxSlots.long}`, false);
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

    // 複合拡張パーツスロット: 強化段階で解放済み＆現在MSレベルで有効なもののみ加算
    const enhancements = this.selectedMS.enhancements || [];
    const msLevel = this.selectedLevel;
    const slotBonus = enhancements
      .filter(e => !e.ms_levels || e.ms_levels.length === 0 || e.ms_levels.includes(msLevel))
      .slice(0, this.enhanceLevel)
      .filter(e => (e.skill_name || '').includes('複合拡張パーツスロット'))
      .reduce((sum, e) => {
        const effectText = GBO2Calculator.resolveEnhancementEffect(e, msLevel);
        const m = effectText.match(/(\d+)スロ/);
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

    const modified = GBO2Calculator.applyParts(base, this.equippedParts.filter(Boolean), this.getSelectedExpansionSkills(), this.selectedLevel, this.enhanceLevel);
    const hasParts = this.equippedParts.some(Boolean);

    for (const [key, prefix] of Object.entries(statMap)) {
      const baseVal = base[key] || 0;
      const modVal = modified[key] || 0;

      document.getElementById(`${prefix}-base`).textContent = baseVal;

      if (modVal !== baseVal) {
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

    // パーツ選択シートが開いていれば残スロット表示も更新
    this.updateSheetSlotSummary();
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

    const modified = GBO2Calculator.applyParts(base, this.equippedParts.filter(Boolean), this.getSelectedExpansionSkills(), this.selectedLevel, this.enhanceLevel);

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
    document.getElementById('calc-offense-score').textContent = `×${offScore.toFixed(2)} (等倍)`;
    document.getElementById('calc-offense-adv').textContent = `×${(offScore * 1.3).toFixed(2)}`;
    document.getElementById('calc-offense-dis').textContent = `×${(offScore * 0.8).toFixed(2)}`;

    // カット率（パーツのみ）
    const armor = {
      ballistic: modified.ballistic_armor || 0,
      beam: modified.beam_armor || 0,
      melee: modified.melee_armor || 0
    };

    // 装甲補正によるカット率 + オーバーチューン[装甲系]等の属性ダメージカット率を乗算合成
    const armorBCut = GBO2Calculator.calcCutRate(armor.ballistic);
    const armorBeCut = GBO2Calculator.calcCutRate(armor.beam);
    const armorMCut = GBO2Calculator.calcCutRate(armor.melee);
    const partsBCutPct  = modified.ballisticDamageCutPct || 0;
    const partsBeCutPct = modified.beamDamageCutPct || 0;
    const partsMCutPct  = modified.meleeDamageCutPct || 0;
    const bCut  = partsBCutPct  > 0 ? 1 - (1 - armorBCut)  * (1 - partsBCutPct  / 100) : armorBCut;
    const beCut = partsBeCutPct > 0 ? 1 - (1 - armorBeCut) * (1 - partsBeCutPct / 100) : armorBeCut;
    const mCut  = partsMCutPct  > 0 ? 1 - (1 - armorMCut)  * (1 - partsMCutPct  / 100) : armorMCut;

    document.getElementById('calc-ballistic-cut').textContent = `${(bCut * 100).toFixed(1)}%`;
    document.getElementById('calc-beam-cut').textContent = `${(beCut * 100).toFixed(1)}%`;
    document.getElementById('calc-melee-cut').textContent = `${(mCut * 100).toFixed(1)}%`;

    const avgCut = bCut * normDmgRatio.ballistic + beCut * normDmgRatio.beam + mCut * normDmgRatio.melee;
    document.getElementById('calc-avg-cut').textContent = `${(avgCut * 100).toFixed(1)}%`;

    // スキル+パーツ合算カット率（属性別）
    const skillDCByType = this._getActiveSkillDCByType();
    const hasAnySkillDC = skillDCByType.ballistic > 0 || skillDCByType.beam > 0 || skillDCByType.melee > 0;
    if (hasAnySkillDC) {
      const combB  = (1 - (1 - bCut)  * (1 - skillDCByType.ballistic / 100)) * 100;
      const combBe = (1 - (1 - beCut) * (1 - skillDCByType.beam      / 100)) * 100;
      const combM  = (1 - (1 - mCut)  * (1 - skillDCByType.melee     / 100)) * 100;
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

    // 有効HP（パーツ＋装甲のみ。スキルDCは上の「合算」カット率行で別途提示し、
    // サマリー・構成比較と値が一致するようEHP本体には含めない）
    const effHP = GBO2Calculator.calcEffectiveHPFromCutRates(
      modified.hp || 0, { ballistic: bCut, beam: beCut, melee: mCut }, normDmgRatio
    );
    document.getElementById('calc-effective-hp').textContent = effHP.toLocaleString() + ' (等倍)';
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

    // 強化リスト（現在の強化段階で解放済み、バリアント解決済み）
    const enhancements = this.selectedMS.enhancements || [];
    const activeEnhs = enhancements
      .filter(e => !e.ms_levels || e.ms_levels.length === 0 || e.ms_levels.includes(this.selectedLevel))
      .slice(0, this.enhanceLevel);
    for (const enh of activeEnhs) {
      const resolvedEffect = GBO2Calculator.resolveEnhancementEffect(enh, this.selectedLevel);
      const resolved = { ...enh, effect: resolvedEffect };
      const effects = GBO2Calculator.extractSkillEffects(resolved);
      if (effects.length > 0) pushEffects(enh.skill_name, effects);
    }

    if (effectItems.length === 0) {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');

    // 項目数が変わった（機体切替・強化段階変更）場合は再初期化。
    // 既定ONは「常時」効果のみ。瀕死/緊急時・静止時・状態限定の効果は
    // 既定でOFF（EHP・カット率を過大に見せないため）。ユーザーが任意でON可能。
    if (this._skillEffectCache.length !== effectItems.length) {
      this._skillEffectCache = effectItems;
      this.activeSkillIndices = new Set(
        effectItems.map((it, i) => (it.condition === '常時' ? i : -1)).filter(i => i >= 0)
      );
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
      // 実質よろけ耐性: スキルがよろけ値を圧縮する分、より大きなよろけ値に耐えられる
      // 例: ×0.5 → よろけ閾値100%を割るには元の200%が必要 → 「200%以下を無効化」
      document.getElementById('stagger-resistance-row').style.display = '';
      if (combined <= 0) {
        document.getElementById('calc-stagger-resistance').textContent = '全よろけ値を無効化';
      } else {
        const threshold = Math.round(100 / combined);
        document.getElementById('calc-stagger-resistance').textContent =
          `よろけ値 ${threshold}% 未満のよろけを無効化`;
      }
    } else {
      document.getElementById('stagger-effective-row').style.display = 'none';
      document.getElementById('stagger-resistance-row').style.display = 'none';
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

    // 相互排他チェック（同名LV違い・○○系・スピード/旋回上昇系は同時装備不可）
    const conflictPart = this.equippedParts.find(p => p && GBO2Calculator.partsConflict(p, part));
    if (conflictPart) {
      this.showToast(`「${conflictPart.name}」とは同時に装備できません`, true);
      return;
    }

    this.equippedParts[emptyIdx] = part;
    this.updateDisplay();
  },

  removePart(index) {
    this.equippedParts[index] = null;
    this.updateDisplay();
  },

  // 名前で装備中パーツを1つ解除（最後に装備したインスタンスから外す。スタック対応）
  removePartByName(name) {
    for (let i = this.equippedParts.length - 1; i >= 0; i--) {
      if (this.equippedParts[i] && this.equippedParts[i].name === name) {
        this.removePart(i);
        return;
      }
    }
  },

  clearParts() {
    this.equippedParts = [null, null, null, null, null, null, null, null];
    this.updateDisplay();
  },

  // 機体選択後に最適化・共有系コントロールを有効化
  enableBuildControls() {
    ['btn-optimize', 'btn-share'].forEach(id => {
      const el = document.getElementById(id); if (el) el.disabled = false;
    });
    document.querySelectorAll('#opt-goal-grid .opt-goal').forEach(b => { b.disabled = false; });
  },

  updateOptGoalDesc() {
    const desc = {
      balance: '優先ステータスと配分をもとに総合スコアを最大化します。',
      attack: '射撃・格闘の与ダメージ倍率（攻撃配分）を最大化します。',
      defense: '被弾配分にもとづく有効HPを最大化します。',
      thruster: 'スラスターを最大化します。',
    };
    const el = document.getElementById('opt-goal-desc');
    if (el) el.textContent = desc[this.optimizeGoal] || '';
  },

  // 選択中の方針に応じて最適化を実行
  runOptimizeDispatch() {
    if (this.optimizeGoal === 'balance') this.runOptimize();
    else this.runOptimizeFocused(this.optimizeGoal);
  },

  runOptimize() {
    if (!this.selectedMS) return;

    const base = this.getBaseStats();
    if (!base) return;

    const maxSlots = this.getMaxSlots();
    const currentParts = this.equippedParts.filter(Boolean);

    const result = GBO2Calculator.optimize(base, maxSlots, this.customParts.filter(p => !this.unownedParts.has(p.name)), {
      damageRatio: this.getNormalizedDamageRatio(),
      atkRatio: this.getNormalizedAtkRatio(),
      selectedStats: this.selectedStats,
      msLevel: this.selectedLevel,
      enhanceLevel: this.enhanceLevel,
      expansionSkillsList: this.getSelectedExpansionSkills(),
      equippedParts: currentParts
    });

    // 既装備パーツを保持し、空きスロットに最適化結果を追加
    const newParts = [...this.equippedParts];
    for (const part of result) {
      const emptyIdx = newParts.indexOf(null);
      if (emptyIdx === -1) break;
      newParts[emptyIdx] = part;
    }
    this.equippedParts = newParts;

    this.updateDisplay();
  },

  runOptimizeFocused(mode) {
    if (!this.selectedMS) return;

    const base = this.getBaseStats();
    if (!base) return;

    const maxSlots = this.getMaxSlots();
    const currentParts = this.equippedParts.filter(Boolean);
    const candidates = this.customParts.filter(p => !this.unownedParts.has(p.name));

    let result;
    try {
      result = GBO2Calculator.optimizeFocused(base, maxSlots, candidates, {
        mode,
        damageRatio: this.getNormalizedDamageRatio(),
        atkRatio: this.getNormalizedAtkRatio(),
        msLevel: this.selectedLevel,
        enhanceLevel: this.enhanceLevel,
        expansionSkillsList: this.getSelectedExpansionSkills(),
        equippedParts: currentParts
      });
    } catch (e) {
      alert(`最適化エラー: ${e.message}`);
      return;
    }

    if (!result || result.length === 0) {
      const usedSlots = this.getUsedSlots();
      const remaining = {
        close: maxSlots.close - usedSlots.close,
        mid: maxSlots.mid - usedSlots.mid,
        long: maxSlots.long - usedSlots.long
      };
      const usedKeys = new Set(currentParts.map(p => p.name + '\0' + p.level));
      const fittable = candidates.filter(p => !usedKeys.has(p.name + '\0' + p.level) && GBO2Calculator.canEquip(p, remaining));
      const modeLabel = { attack: '攻撃', defense: '防御', thruster: 'スラスター' }[mode] || mode;
      alert(`${modeLabel}特化: 該当パーツなし\n\n空きスロット: 近${remaining.close} 中${remaining.mid} 遠${remaining.long} / パーツ枠${8 - currentParts.length}個\n装備可能: ${fittable.length}件\n\n装備可能パーツ:\n${fittable.slice(0, 10).map(p => '  ' + p.name + ' LV' + p.level).join('\n') || '  なし'}`);
      return;
    }

    const newParts = [...this.equippedParts];
    for (const part of result) {
      const emptyIdx = newParts.indexOf(null);
      if (emptyIdx === -1) break;
      newParts[emptyIdx] = part;
    }
    this.equippedParts = newParts;

    this.updateDisplay();
  },

  // === 構成保存・読込・比較 ===

  saveBuild(name) {
    if (!this.selectedMS) {
      alert('機体を選択してください');
      return;
    }
    if (this.savedBuilds.length >= 5) {
      alert('保存上限（5件）です。不要な構成を削除してください。');
      return;
    }
    const trimmed = name.trim() || `構成${this.savedBuilds.length + 1}`;
    const build = {
      id: Date.now(),
      name: trimmed,
      msName: this.selectedMS.name,
      msLevel: this.selectedLevel,
      enhanceLevel: this.enhanceLevel,
      equippedParts: this.equippedParts.filter(Boolean).map(p => ({ name: p.name, level: p.level })),
      activeSkillIndices: Array.from(this.activeSkillIndices),
      expansionSkillLevels: { ...this.expansionSkillLevels },
      timestamp: new Date().toLocaleDateString('ja-JP'),
    };
    this.savedBuilds = [...this.savedBuilds, build];
    this._persistBuilds();
    this.renderSavedBuilds();
    this.updateBuildSelectOptions();
  },

  loadBuild(id) {
    const build = this.savedBuilds.find(b => b.id === id);
    if (!build) return;
    const ms = this.msData.find(m => m.name === build.msName);
    if (!ms) {
      alert(`機体「${build.msName}」が見つかりません（データ更新で削除された可能性があります）`);
      return;
    }
    this.selectedMS = ms;
    this.selectedLevel = build.msLevel;
    this.enhanceLevel = build.enhanceLevel;

    const lvSelect = document.getElementById('ms-level');
    const availableLvs = Object.keys(ms.levels || {}).map(Number).sort((a, b) => a - b);
    lvSelect.innerHTML = availableLvs.map(lv =>
      `<option value="${lv}" ${lv === build.msLevel ? 'selected' : ''}>LV${lv}</option>`
    ).join('');
    document.getElementById('ms-enhance-level').value = String(build.enhanceLevel);
    document.getElementById('ms-search').value = ms.name;

    this.equippedParts = [null, null, null, null, null, null, null, null];
    const missingParts = [];
    build.equippedParts.forEach((sp, idx) => {
      if (idx >= 8) return;
      const part = this.customParts.find(p => p.name === sp.name && p.level === sp.level);
      if (part) {
        this.equippedParts[idx] = part;
      } else {
        missingParts.push(`${sp.name} LV${sp.level}`);
      }
    });
    if (missingParts.length > 0) {
      alert(`以下のパーツが見つかりません（データ更新で変更された可能性があります）:\n${missingParts.join('\n')}`);
    }

    this.expansionSkillLevels = { ...build.expansionSkillLevels };
    this.renderExpansionSkillsUI();
    this.activeSkillIndices = new Set();
    this._skillEffectCache = [];
    this.enableBuildControls();
    this.updateDisplay();
  },

  deleteBuild(id) {
    const build = this.savedBuilds.find(b => b.id === id);
    const name = build ? build.name : '';
    if (!confirm(`「${name}」を削除しますか？`)) return;
    this.savedBuilds = this.savedBuilds.filter(b => b.id !== id);
    this._persistBuilds();
    this.renderSavedBuilds();
    this.updateBuildSelectOptions();
  },

  _persistBuilds() {
    try {
      localStorage.setItem('gbo2_saved_builds', JSON.stringify(this.savedBuilds));
    } catch (e) { /* storage full or private mode */ }
  },

  renderSavedBuilds() {
    const container = document.getElementById('saved-builds-list');
    const counter = document.getElementById('builds-counter');
    if (counter) counter.textContent = `${this.savedBuilds.length} / 5`;
    if (this.savedBuilds.length === 0) {
      container.innerHTML = '<p class="no-builds-msg">保存済み構成はありません</p>';
      return;
    }
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    container.innerHTML = `
      <div class="builds-count">${this.savedBuilds.length} / 5 件</div>
      ${this.savedBuilds.map(b => `
        <div class="saved-build-item">
          <div class="build-item-info">
            <span class="build-item-name">${esc(b.name)}</span>
            <span class="build-item-ms">${esc(b.msName)} LV${b.msLevel}</span>
            <span class="build-item-date">${esc(b.timestamp)}</span>
          </div>
          <div class="build-item-actions">
            <button class="btn-load-build" data-id="${b.id}">読込</button>
            <button class="btn-delete-build" data-id="${b.id}" title="削除">✕</button>
          </div>
        </div>
      `).join('')}
    `;
    container.querySelectorAll('.btn-load-build').forEach(btn =>
      btn.addEventListener('click', () => this.loadBuild(Number(btn.dataset.id)))
    );
    container.querySelectorAll('.btn-delete-build').forEach(btn =>
      btn.addEventListener('click', () => this.deleteBuild(Number(btn.dataset.id)))
    );
  },

  updateBuildSelectOptions() {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    [document.getElementById('compare-build-a'), document.getElementById('compare-build-b')].forEach(sel => {
      if (!sel) return;
      const prev = sel.value;
      sel.innerHTML = `
        <option value="">-- 選択 --</option>
        <option value="current">現在の構成</option>
        ${this.savedBuilds.map(b =>
          `<option value="${b.id}">${esc(b.name)} (${esc(b.msName)} LV${b.msLevel})</option>`
        ).join('')}
      `;
      sel.value = prev;
    });
    const sec = document.getElementById('compare-section');
    if (sec) sec.classList.toggle('hidden', this.savedBuilds.length === 0);
  },

  _computeCalcResult(modified, msName, msLevel) {
    const r = this.getNormalizedDamageRatio();
    const ar = this.getNormalizedAtkRatio();
    const armorBCut  = GBO2Calculator.calcCutRate(modified.ballistic_armor || 0);
    const armorBeCut = GBO2Calculator.calcCutRate(modified.beam_armor || 0);
    const armorMCut  = GBO2Calculator.calcCutRate(modified.melee_armor || 0);
    const partsBCutPct  = modified.ballisticDamageCutPct || 0;
    const partsBeCutPct = modified.beamDamageCutPct || 0;
    const partsMCutPct  = modified.meleeDamageCutPct || 0;
    const bCut  = partsBCutPct  > 0 ? 1 - (1 - armorBCut)  * (1 - partsBCutPct  / 100) : armorBCut;
    const beCut = partsBeCutPct > 0 ? 1 - (1 - armorBeCut) * (1 - partsBeCutPct / 100) : armorBeCut;
    const mCut  = partsMCutPct  > 0 ? 1 - (1 - armorMCut)  * (1 - partsMCutPct  / 100) : armorMCut;
    const avgCut = bCut * r.ballistic + beCut * r.beam + mCut * r.melee;
    const effHP = GBO2Calculator.calcEffectiveHPFromCutRates(
      modified.hp || 0, { ballistic: bCut, beam: beCut, melee: mCut }, r
    );
    const shootMul = GBO2Calculator.calcShootingMultiplier(modified.shooting_correction || 0) * (1 + (modified.shootingDmgPct || 0) / 100);
    const meleeMul = GBO2Calculator.calcMeleeMultiplier(modified.melee_correction || 0) * (1 + (modified.meleeDmgPct || 0) / 100);
    return {
      msName: msName || (this.selectedMS?.name || ''),
      msLevel: msLevel !== undefined ? msLevel : this.selectedLevel,
      hp: modified.hp || 0,
      ballistic_armor: modified.ballistic_armor || 0,
      beam_armor: modified.beam_armor || 0,
      melee_armor: modified.melee_armor || 0,
      shooting_correction: modified.shooting_correction || 0,
      melee_correction: modified.melee_correction || 0,
      speed: modified.speed || 0,
      thruster: modified.thruster || 0,
      bCut, beCut, mCut, avgCut, effectiveHP: effHP,
      shootingMultiplier: shootMul,
      meleeMultiplier: meleeMul,
    };
  },

  calcStatsFromBuild(buildData) {
    if (buildData === 'current') {
      if (!this.selectedMS) return null;
      const base = this.getBaseStats();
      if (!base) return null;
      const expSkills = this.getSelectedExpansionSkills();
      const modified = GBO2Calculator.applyParts(base, this.equippedParts.filter(Boolean), expSkills, this.selectedLevel, this.enhanceLevel);
      return this._computeCalcResult(modified, this.selectedMS.name, this.selectedLevel);
    }
    const ms = this.msData.find(m => m.name === buildData.msName);
    if (!ms) return null;
    const lvData = ms.levels?.[String(buildData.msLevel)];
    if (!lvData) return null;

    const base = GBO2Calculator.applyEnhancements(
      { ...lvData }, ms.enhancements || [], buildData.enhanceLevel, buildData.msLevel
    );
    const parts = (buildData.equippedParts || [])
      .map(sp => this.customParts.find(p => p.name === sp.name && p.level === sp.level))
      .filter(Boolean);
    const expSkills = Object.entries(buildData.expansionSkillLevels || [])
      .filter(([, lv]) => lv > 0)
      .map(([name, lv]) => this.expansionSkillsData.find(s => s.name === name && s.level === lv))
      .filter(Boolean);

    const modified = GBO2Calculator.applyParts(base, parts, expSkills, buildData.msLevel || 1, buildData.enhanceLevel || 0);
    return this._computeCalcResult(modified, buildData.msName, buildData.msLevel);
  },

  runCompareBuild() {
    const valA = document.getElementById('compare-build-a').value;
    const valB = document.getElementById('compare-build-b').value;
    if (!valA || !valB) { alert('比較する構成を2つ選択してください'); return; }
    if (valA === valB) { alert('異なる構成を選択してください'); return; }
    const getItem = v => v === 'current' ? 'current' : this.savedBuilds.find(b => b.id === Number(v));
    const dataA = getItem(valA);
    const dataB = getItem(valB);
    if (!dataA || !dataB) return;
    const resultA = this.calcStatsFromBuild(dataA);
    const resultB = this.calcStatsFromBuild(dataB);
    if (!resultA || !resultB) { alert('ステータス計算に失敗しました（機体データが見つかりません）'); return; }
    const nameA = valA === 'current' ? '現在の構成' : dataA.name;
    const nameB = valB === 'current' ? '現在の構成' : dataB.name;
    this.renderCompareResults(resultA, resultB, nameA, nameB);
  },

  renderCompareResults(a, b, nameA, nameB) {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rows = [
      { label: '機体HP',      va: a.hp,                  vb: b.hp,                  fmt: v => v.toLocaleString() },
      { label: '耐実弾',      va: a.ballistic_armor,     vb: b.ballistic_armor,     fmt: v => String(v) },
      { label: '耐ビーム',    va: a.beam_armor,          vb: b.beam_armor,          fmt: v => String(v) },
      { label: '耐格闘',      va: a.melee_armor,         vb: b.melee_armor,         fmt: v => String(v) },
      { label: '射撃補正',    va: a.shooting_correction, vb: b.shooting_correction, fmt: v => String(v) },
      { label: '格闘補正',    va: a.melee_correction,    vb: b.melee_correction,    fmt: v => String(v) },
      { label: 'スピード',    va: a.speed,               vb: b.speed,               fmt: v => String(v) },
      { label: 'スラスター',  va: a.thruster,            vb: b.thruster,            fmt: v => String(v) },
      { label: '射撃倍率',    va: a.shootingMultiplier,  vb: b.shootingMultiplier,  fmt: v => `×${v.toFixed(2)}` },
      { label: '格闘倍率',    va: a.meleeMultiplier,     vb: b.meleeMultiplier,     fmt: v => `×${v.toFixed(2)}` },
      { label: '加重カット率', va: a.avgCut,             vb: b.avgCut,              fmt: v => `${(v*100).toFixed(1)}%` },
      { label: '有効HP',      va: a.effectiveHP,         vb: b.effectiveHP,         fmt: v => v.toLocaleString() },
    ];
    const tbody = rows.map(row => {
      const aWin = row.va > row.vb, bWin = row.vb > row.va;
      return `<tr>
        <td class="cmp-label">${row.label}</td>
        <td class="cmp-val ${aWin ? 'cmp-better' : bWin ? 'cmp-worse' : ''}">${row.fmt(row.va)}</td>
        <td class="cmp-val ${bWin ? 'cmp-better' : aWin ? 'cmp-worse' : ''}">${row.fmt(row.vb)}</td>
      </tr>`;
    }).join('');
    const container = document.getElementById('compare-results');
    container.innerHTML = `<table class="compare-table">
      <thead><tr>
        <th></th>
        <th class="cmp-header">${esc(nameA)}<br><span class="cmp-ms">${esc(a.msName)} LV${a.msLevel}</span></th>
        <th class="cmp-header">${esc(nameB)}<br><span class="cmp-ms">${esc(b.msName)} LV${b.msLevel}</span></th>
      </tr></thead>
      <tbody>${tbody}</tbody>
    </table>`;
    container.classList.remove('hidden');
  },

  // === パーツ一覧レンダリング ===
  renderPartsList() {
    const container = document.getElementById('parts-list');
    const prevScroll = container.scrollTop;

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

    const equippedList = this.equippedParts.filter(Boolean);
    const equippedKeys = new Set(equippedList.map(p => p.name + '\0' + p.level));
    const isFull = equippedList.length >= 8;

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
      const equippedInstances = equippedList.filter(p => p.name === name);
      const equippedCount = equippedInstances.length;
      const isEquipped = equippedCount > 0;
      const hasMultipleLvs = levels.length > 1;
      const lvCount = (lv) => equippedInstances.filter(p => p.level === lv).length;

      // グループヘッダー用スロット情報（装備中ならそのLV、非装備ならLV範囲）
      const displayPart = equippedInstances[0] || levels[0];
      const slotsHtml = [];
      if (hasMultipleLvs && !isEquipped) {
        const minP = levels[0], maxP = levels[levels.length - 1];
        ['close', 'mid', 'long'].forEach(type => {
          const label = type === 'close' ? '近' : type === 'mid' ? '中' : '遠';
          const mn = minP.slots[type] || 0, mx = maxP.slots[type] || 0;
          if (mx > 0) slotsHtml.push(`<span class="slot-${type}">${label}${mn === mx ? mn : mn + '~' + mx}</span>`);
        });
      } else {
        if (displayPart.slots.close > 0) slotsHtml.push(`<span class="slot-close">近${displayPart.slots.close}</span>`);
        if (displayPart.slots.mid > 0) slotsHtml.push(`<span class="slot-mid">中${displayPart.slots.mid}</span>`);
        if (displayPart.slots.long > 0) slotsHtml.push(`<span class="slot-long">遠${displayPart.slots.long}</span>`);
      }

      // 追加で装備できるか。GBO2は通常パーツを同名でもスタック可能なので、
      // 制限は「○○系の複数装備不可 / スピード旋回排他」とスロット空きのみ。
      const canAdd = (part) => this.selectedMS && !isFull && !isUnowned
        && GBO2Calculator.canEquip(part, remaining)
        && !GBO2Calculator.conflictsWithAny(part, equippedList);

      // 非装備かつ全LVが追加不可（○○系/スピード旋回排他）なら丸ごとブロック表示
      const isBlocked = !isEquipped && this.selectedMS
        && levels.every(part => GBO2Calculator.conflictsWithAny(part, equippedList));

      const groupClasses = ['part-group'];
      if (isUnowned) groupClasses.push('unowned');
      if (isEquipped) groupClasses.push('equipped');
      if (isBlocked) groupClasses.push('group-blocked');

      // 大きめのLVタブ。タップでそのLVを1つ装備（同名スタック可）。装備数は ×N で表示。
      const lvTabsHtml = levels.map(part => {
        const cnt = lvCount(part.level);
        const addable = canAdd(part);
        const slotStr = ['close', 'mid', 'long']
          .filter(t => (part.slots[t] || 0) > 0)
          .map(t => (t === 'close' ? '近' : t === 'mid' ? '中' : '遠') + part.slots[t]).join(' ') || '—';
        const cls = ['lv-tab'];
        if (cnt > 0) cls.push('lv-equipped');
        if (!addable) cls.push('lv-disabled');
        return `<button class="${cls.join(' ')}" data-part-name="${escapeHtml(name)}" data-part-lv="${part.level}" ${addable ? '' : 'disabled'}>
          <span class="lv-tab-num">LV${part.level}${cnt > 1 ? ` ×${cnt}` : ''}</span><span class="lv-tab-slot">${slotStr}</span>
        </button>`;
      }).join('');

      const single = levels[0];
      const unequipBtn = equippedCount > 0
        ? `<button class="btn-part-action btn-unequip" data-part-name="${escapeHtml(name)}">解除${equippedCount > 1 ? ` ×${equippedCount}` : ''}</button>`
        : '';

      // アクション領域（LVタブ or 装着ボタン ＋ 解除ボタン）
      let actionsHtml;
      if (hasMultipleLvs) {
        actionsHtml = `<div class="lv-tabs">${lvTabsHtml}</div>${unequipBtn}`;
      } else {
        actionsHtml = `<button class="btn-part-action btn-equip" data-part-name="${escapeHtml(name)}" data-part-lv="${single.level}" ${canAdd(single) ? '' : 'disabled'}>装着</button>${unequipBtn}`;
      }

      const lvBadge = isEquipped
        ? `<span class="part-equipped-lv">装備中${equippedCount > 1 ? ` ×${equippedCount}` : ''}</span>`
        : `<span class="part-lv-range">${hasMultipleLvs ? `LV1〜${maxLvPart.level}` : `LV${maxLvPart.level}`}</span>`;

      const detailPart = equippedInstances[0] || maxLvPart;

      return `<div class="${groupClasses.join(' ')}" data-part-group="${escapeHtml(name)}">
        <div class="part-group-header">
          <div class="part-group-title">
            <span class="part-item-name">${escapeHtml(name)}</span>
            <button class="btn-own-toggle ${!isUnowned ? 'owned' : ''}" data-part-name="${escapeHtml(name)}" title="所持/未所持の切り替え">★</button>
          </div>
          <div class="part-group-meta">
            ${lvBadge}
            <span class="part-item-category ${maxLvPart.category}">${categoryMap[maxLvPart.category] || maxLvPart.category}</span>
            <div class="part-item-slots">${slotsHtml.join('')}</div>
          </div>
        </div>
        <div class="part-actions">${actionsHtml}</div>
        <div class="part-item-detail">${escapeHtml(detailPart.description)}</div>
      </div>`;
    }).join('');

    container.innerHTML = html || '<p class="no-parts">該当するパーツがありません</p>';

    // LVタブ / 装着ボタン → そのLVを1つ装備（同名スタック可）
    container.querySelectorAll('.lv-tab:not([disabled]), .btn-equip:not([disabled])').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const partName = el.dataset.partName;
        const partLv = parseInt(el.dataset.partLv, 10);
        const part = (groupMap[partName] || []).find(p => p.level === partLv);
        if (part && !this.unownedParts.has(partName)) {
          this.equipPart(part);
        }
      });
    });

    // 解除ボタン
    container.querySelectorAll('.btn-unequip').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removePartByName(el.dataset.partName);
      });
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

    container.scrollTop = prevScroll;
  }
};

// アプリ起動
document.addEventListener('DOMContentLoaded', () => App.init());
