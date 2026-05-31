/**
 * GBO2 シミュレーター - 構成の共有（URL/コード）
 *
 * 構成状態を URL-safe な文字列にエンコード/デコードする。
 * 外部ライブラリ不要。マルチバイト(日本語)対応のため UTF-8 → base64url を使用。
 *
 * エンコード対象（短縮キー）:
 *   v  : フォーマットバージョン
 *   m  : 機体名
 *   l  : 機体LV
 *   e  : 強化段階
 *   p  : 装備パーツ [[name, level], ...]
 *   x  : 拡張スキル [[name, level], ...]（LV>0のみ）
 *   s  : ONのスキルトグルindex [i, ...]
 *   dr : 被弾配分 [ballistic, beam, melee]
 *   ar : 攻撃配分 [shooting, melee]
 */
const BuildShare = {
  VERSION: 1,
  HASH_KEY: 'b',

  /** UTF-8 文字列 → base64url */
  _b64urlEncode(str) {
    const b64 = btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },

  /** base64url → UTF-8 文字列 */
  _b64urlDecode(code) {
    let b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return decodeURIComponent(escape(atob(b64)));
  },

  /**
   * 構成状態オブジェクトを共有コード文字列に変換
   * @param {object} state
   * @returns {string}
   */
  encode(state) {
    const payload = {
      v: this.VERSION,
      m: state.msName || '',
      l: state.msLevel || 1,
      e: state.enhanceLevel || 0,
      p: (state.parts || []).map(p => [p.name, p.level]),
      x: Object.entries(state.expansionSkillLevels || {})
        .filter(([, lv]) => lv > 0)
        .map(([name, lv]) => [name, lv]),
      s: state.activeSkillIndices || [],
      dr: state.damageRatio ? [state.damageRatio.ballistic, state.damageRatio.beam, state.damageRatio.melee] : undefined,
      ar: state.atkRatio ? [state.atkRatio.shooting, state.atkRatio.melee] : undefined,
    };
    return this._b64urlEncode(JSON.stringify(payload));
  },

  /**
   * 共有コード文字列を構成状態オブジェクトに復元
   * @param {string} code
   * @returns {object|null} 失敗時 null
   */
  decode(code) {
    try {
      const obj = JSON.parse(this._b64urlDecode(code));
      if (!obj || typeof obj !== 'object' || !obj.m) return null;
      return {
        msName: String(obj.m),
        msLevel: Number(obj.l) || 1,
        enhanceLevel: Number(obj.e) || 0,
        parts: Array.isArray(obj.p)
          ? obj.p.map(pair => ({ name: String(pair[0]), level: Number(pair[1]) }))
          : [],
        expansionSkillLevels: Array.isArray(obj.x)
          ? Object.fromEntries(obj.x.map(pair => [String(pair[0]), Number(pair[1])]))
          : {},
        activeSkillIndices: Array.isArray(obj.s) ? obj.s.map(Number) : null,
        damageRatio: Array.isArray(obj.dr)
          ? { ballistic: Number(obj.dr[0]), beam: Number(obj.dr[1]), melee: Number(obj.dr[2]) }
          : null,
        atkRatio: Array.isArray(obj.ar)
          ? { shooting: Number(obj.ar[0]), melee: Number(obj.ar[1]) }
          : null,
      };
    } catch (e) {
      return null;
    }
  },

  /** 構成状態から共有URL（現在のページ + #b=...）を生成 */
  encodeToUrl(state) {
    const code = this.encode(state);
    const base = location.origin + location.pathname;
    return `${base}#${this.HASH_KEY}=${code}`;
  },

  /** URLハッシュから構成状態を読み取る（無ければ null） */
  readFromUrl() {
    const hash = location.hash.replace(/^#/, '');
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    const code = params.get(this.HASH_KEY);
    if (!code) return null;
    return this.decode(code);
  },

  /** URLハッシュをクリア（履歴を汚さず） */
  clearUrlHash() {
    if (location.hash) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BuildShare;
}
