(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CoWalletPreferences = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var SIDEBAR_KEYS = ['overview', 'income', 'budget', 'monthly', 'housing', 'plans'];
  var DASHBOARD_KEYS = ['kpis', 'combinedAssets', 'basis', 'trend', 'expenseBreakdown', 'goal', 'people', 'scenarios'];
  var THEMES = {
    sage: { bg: '#f5f7f2', card: '#ffffff', ink: '#25352b', muted: '#526653', line: '#dbe4d5',
      green: '#35663f', dark: '#243d2d', 'accent-soft': '#eef4e7', 'accent-ink': '#305831',
      accent: '#678b54', mint: '#d4e7c7', pale: '#f8faf4', 'plot-secondary': '#8fa981' },
    ocean: { bg: '#f2f7fa', card: '#ffffff', ink: '#233541', muted: '#516772', line: '#d6e3e9',
      green: '#24667a', dark: '#1e3e4b', 'accent-soft': '#eaf4f8', 'accent-ink': '#24596b',
      accent: '#438aa1', mint: '#cbe6ef', pale: '#f6fafc', 'plot-secondary': '#78aebf' },
    sand: { bg: '#f9f6ef', card: '#ffffff', ink: '#3c3429', muted: '#6b6052', line: '#e6dccb',
      green: '#86612f', dark: '#4a3929', 'accent-soft': '#f5eedf', 'accent-ink': '#745127',
      accent: '#a9824a', mint: '#eee0c0', pale: '#fcf9f2', 'plot-secondary': '#c1a36a' },
    plum: { bg: '#f8f4fa', card: '#ffffff', ink: '#3b2f40', muted: '#6b5a70', line: '#e4d9e8',
      green: '#765484', dark: '#442e50', 'accent-soft': '#f3ecf7', 'accent-ink': '#6b467a',
      accent: '#9b74ad', mint: '#e4d3ed', pale: '#fbf8fc', 'plot-secondary': '#b49ac5' },
    graphite: { bg: '#f4f6f8', card: '#ffffff', ink: '#2f3539', muted: '#5f6870', line: '#dce1e6',
      green: '#4a5e70', dark: '#2b3844', 'accent-soft': '#edf1f5', 'accent-ink': '#415768',
      accent: '#728a9f', mint: '#d7e2ec', pale: '#f8fafc', 'plot-secondary': '#9cabb8' }
  };
  // Financial meanings stay constant across all brand palettes.
  var SEMANTIC = { positive: '#247044', negative: '#b43e3e', red: '#b43e3e',
    'negative-on-dark': '#ffb6ac', 'warning-ink': '#76501d', 'warning-bg': '#fff9ec',
    'warning-line': '#e9d4a7', 'error-bg': '#fff2ef', 'on-dark': '#ffffff' };

  function fail(message) { throw new Error(message); }
  function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      fail(label + '必须是普通对象。');
    }
  }
  function keys(value, allowed, label) {
    object(value, label);
    Reflect.ownKeys(value).forEach(function (key) {
      if (typeof key !== 'string' || allowed.indexOf(key) < 0) fail(label + '含有不支持的字段。');
    });
    allowed.forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) fail(label + '缺少字段：' + key);
    });
  }
  function flags(names) {
    var result = {};
    names.forEach(function (name) { result[name] = true; });
    return result;
  }
  function defaultPreferences() {
    return { version: 1, theme: 'sage', fontScale: 1, density: 'comfortable',
      sidebar: flags(SIDEBAR_KEYS), dashboard: flags(DASHBOARD_KEYS) };
  }
  function normalizePreferences(raw) {
    keys(raw, ['version', 'theme', 'fontScale', 'density', 'sidebar', 'dashboard'], '外观设置');
    if (raw.version !== 1) fail('外观设置版本不受支持。');
    if (typeof raw.theme !== 'string' || !Object.prototype.hasOwnProperty.call(THEMES, raw.theme)) fail('主题取值无效。');
    if (typeof raw.fontScale !== 'number' || !Number.isFinite(raw.fontScale) || raw.fontScale < 0.875 || raw.fontScale > 1.375) {
      fail('字体缩放必须是 0.875–1.375 范围内的数值（基准字号 14–22 像素）。');
    }
    if (raw.density !== 'comfortable' && raw.density !== 'compact') fail('布局密度取值无效。');
    var result = { version: 1, theme: raw.theme, fontScale: raw.fontScale, density: raw.density, sidebar: {}, dashboard: {} };
    [['sidebar', SIDEBAR_KEYS, '侧栏设置'], ['dashboard', DASHBOARD_KEYS, '总览设置']].forEach(function (group) {
      keys(raw[group[0]], group[1], group[2]);
      group[1].forEach(function (name) {
        if (typeof raw[group[0]][name] !== 'boolean') fail(group[2] + '中的 ' + name + ' 必须是布尔值。');
        result[group[0]][name] = raw[group[0]][name];
      });
    });
    if (!result.sidebar.overview) fail('年度总览是保留入口，不能隐藏。');
    return result;
  }
  function applyPreferences(raw, targetDocument) {
    // Validate before touching the page, so invalid imports never partially apply.
    var result = normalizePreferences(raw);
    var doc = targetDocument === undefined ? (typeof document !== 'undefined' ? document : null) : targetDocument;
    if (doc === null) return result;
    var html = doc && doc.documentElement;
    if (!html || !html.dataset || !html.style || typeof html.style.setProperty !== 'function') {
      fail('无法将外观设置应用到当前页面。');
    }
    html.dataset.theme = result.theme;
    html.dataset.density = result.density;
    html.style.setProperty('--font-scale', String(result.fontScale));
    var palette = THEMES[result.theme];
    Object.keys(palette).forEach(function (name) { html.style.setProperty('--' + name, palette[name]); });
    Object.keys(SEMANTIC).forEach(function (name) { html.style.setProperty('--' + name, SEMANTIC[name]); });
    html.style.setProperty('color-scheme', 'light');
    return result;
  }

  return { defaultPreferences: defaultPreferences, normalizePreferences: normalizePreferences, applyPreferences: applyPreferences };
});
