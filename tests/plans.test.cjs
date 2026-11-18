'use strict';

// Integration tests execute the real classic scripts with fictional, memory-only storage.
// This small DOM adapter covers event handlers and rendered text, not browser layout,
// focus/blur ordering, or resize behavior; those belong to the browser checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const E = require('../engine.js');

const KEY = 'cowallet.current.v1';
const NOW = Date.UTC(2026, 10, 18, 4);
let identity = 0;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function income() {
  const state = E.defaultState();
  state.year = 2026;
  state.people.forEach((person, index) => { person.name = index ? '虚构乙' : '虚构甲'; });
  return state;
}
function snapshot(id, state = income(), extras = {}) {
  return { id, name: '虚构方案 ' + id, date: '2026/11/18', state: clone(state), ...extras };
}
function backup(extras = {}) {
  return { app: 'CoWallet', version: 2, state: income(), plans: [], ...extras };
}

class EventTargetStub {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, run) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(run);
  }
  dispatch(type, event) {
    let result;
    for (const run of this.listeners.get(type) || []) result = run(event);
    return result;
  }
}
class ElementStub extends EventTargetStub {
  constructor() {
    super();
    this.innerHTML = '';
    this.textContent = '';
    this.dataset = {};
    this.style = { setProperty() {} };
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.open = false;
  }
  querySelectorAll() { return []; }
  hasAttribute() { return false; }
  getAttribute() { return null; }
  focus() {}
  close() { this.open = false; }
  showModal() { this.open = true; }
  insertAdjacentHTML(_position, html) { this.innerHTML += html; }
}

function boot({ record, storage } = {}) {
  const memory = storage ? new Map(storage) : new Map([[KEY, JSON.stringify({
    state: income(), demo: false, plans: [], activePlanId: null, ...record
  })]]);
  const nodes = new Map();
  function element(selector) {
    if (!nodes.has(selector)) nodes.set(selector, new ElementStub());
    return nodes.get(selector);
  }
  const document = Object.assign(new EventTargetStub(), {
    documentElement: element('html'), body: element('body'), activeElement: null,
    querySelector: selector => selector.startsWith('meta[') ? null : element(selector),
    querySelectorAll: () => []
  });
  const window = Object.assign(new EventTargetStub(), {
    innerWidth: 1440, scrollY: 0, scrollTo() {},
    crypto: { randomUUID: () => 'synthetic-plan-' + (++identity) }
  });
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const context = vm.createContext({
    window, document, Date: FixedDate, crypto: window.crypto, console,
    localStorage: {
      getItem: key => memory.get(key) ?? null,
      setItem: (key, value) => memory.set(key, value)
    },
    FormData: class {
      constructor(fields) { this.fields = fields; }
      get(key) { return this.fields[key] ?? null; }
    },
    requestAnimationFrame: run => run(), setTimeout: () => 1, clearTimeout() {},
    scrollY: 0, scrollTo() {}
  });
  // Do not rewrite app.js or expose its closure: assertions observe saved records,
  // rendered UI, and events that the actual application handles.
  for (const name of ['engine.js', 'mortgage.js', 'preferences.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context, { filename: name });
  }
  const api = {
    read: () => JSON.parse(memory.get(KEY)),
    storage: () => new Map(memory),
    shell: () => element('#app').innerHTML,
    page: () => element('#main').innerHTML,
    toast: () => element('#toast').textContent,
    modalOpen: () => element('#modal').open,
    click(dataset) {
      document.dispatch('click', { target: { closest: () => ({ dataset }) }, preventDefault() {} });
    },
    submit(fields = {}) {
      assert.equal(element('#modal').open, true, '操作应先打开确认弹窗');
      element('#modal-form').onsubmit({ preventDefault() {}, target: fields });
    },
    editPerson(field, value, person = 0) {
      document.dispatch('change', { target: {
        dataset: { person: String(person), field },
        type: typeof value === 'number' ? 'number' : 'select-one', value: String(value),
        validity: { valid: true }, hasAttribute: () => false
      } });
    },
    async import(raw) {
      const text = JSON.stringify(raw);
      await element('#import-file').dispatch('change', { target: {
        files: [{ size: Buffer.byteLength(text), text: async () => text }], value: 'synthetic.json'
      } });
    }
  };
  api.saveAs = name => { api.click({ action: 'save-plan' }); api.submit({ name }); return api.read().activePlanId; };
  api.load = id => { api.click({ action: 'load-plan', id }); api.submit(); };
  api.remove = id => { api.click({ action: 'remove-plan', id }); api.submit(); };
  return api;
}

test('保存方案关联当前ID，重新启动后仍显示同一当前方案', () => {
  const app = boot();
  const id = app.saveAs('虚构 A');
  assert.equal(app.read().plans[0].id, id);
  assert.match(app.shell(), /<strong>虚构 A<\/strong>/);
  const restarted = boot({ storage: app.storage() });
  assert.equal(restarted.read().activePlanId, id);
  assert.match(restarted.shell(), /与方案内容一致/);
  assert.match(restarted.shell(), /<strong>虚构 A<\/strong>/);
});

test('旧记录没有关联ID时不按名字或相同内容猜测当前方案', () => {
  const app = boot({ record: { plans: [snapshot('old')], activePlanId: undefined } });
  app.click({ action: 'save-current' });
  assert.equal(app.read().activePlanId, null);
  assert.match(app.shell(), /未关联方案 · 当前草稿/);
});

test('编辑自动保存草稿并标记修改，保留快照；重载仍可识别修改', () => {
  const app = boot();
  const id = app.saveAs('保留原值');
  const before = clone(app.read().plans[0]);
  app.editPerson('salary', 31000);
  const data = app.read();
  assert.equal(data.activePlanId, id);
  assert.equal(data.state.people[0].salary, 31000);
  assert.deepEqual(data.plans[0], before);
  assert.match(app.shell(), /有修改 · 待更新方案/);
  assert.match(boot({ storage: app.storage() }).shell(), /有修改 · 待更新方案/);
});

test('更新覆盖当前快照并清除修改状态，奖金发放安排一并保留', () => {
  const app = boot();
  const id = app.saveAs('待更新');
  app.editPerson('salary', 32000);
  app.editPerson('fixedBonusPayout', 'monthly');
  app.editPerson('bonusMonth', 6);
  app.click({ action: 'update-plan' });
  const data = app.read();
  assert.equal(data.plans.length, 1);
  assert.equal(data.activePlanId, id);
  assert.equal(data.plans[0].id, id);
  assert.deepEqual(data.plans[0].state, data.state);
  assert.equal(data.plans[0].state.people[0].fixedBonusPayout, 'monthly');
  assert.equal(data.plans[0].state.people[0].bonusMonth, 6);
  assert.match(app.shell(), /与方案内容一致/);
});

test('另存切换当前关联并保留原方案及其输入', () => {
  const app = boot();
  const original = app.saveAs('原方案');
  app.editPerson('salary', 33000);
  const copy = app.saveAs('新方案');
  const data = app.read();
  assert.notEqual(copy, original);
  assert.equal(data.plans.length, 2);
  assert.equal(data.activePlanId, copy);
  assert.equal(data.plans.find(p => p.id === original).state.people[0].salary, 25000);
  assert.equal(data.plans.find(p => p.id === copy).state.people[0].salary, 33000);
  assert.match(app.shell(), /与方案内容一致/);
});

test('重命名仅改变名称，保留未更新的草稿和快照', () => {
  const app = boot();
  const id = app.saveAs('原名字');
  const originalState = clone(app.read().plans[0].state);
  app.editPerson('salary', 34000);
  app.click({ action: 'rename-plan', id });
  app.submit({ name: ' 新名字 ' });
  const data = app.read();
  assert.equal(data.activePlanId, id);
  assert.equal(data.plans[0].name, '新名字');
  assert.equal(data.state.people[0].salary, 34000);
  assert.deepEqual(data.plans[0].state, originalState);
  assert.match(app.shell(), /有修改 · 待更新方案/);
});

test('删除非当前方案保留当前关联及草稿', () => {
  const app = boot();
  const first = app.saveAs('第一份');
  app.editPerson('salary', 35000);
  const second = app.saveAs('第二份');
  app.remove(first);
  assert.equal(app.read().activePlanId, second);
  assert.equal(app.read().plans.length, 1);
  assert.equal(app.read().state.people[0].salary, 35000);
});

test('删除当前方案只解除关联，草稿和重启后的输入均保留', () => {
  const app = boot();
  const id = app.saveAs('将移除');
  app.editPerson('salary', 36000);
  app.remove(id);
  assert.equal(app.read().activePlanId, null);
  assert.deepEqual(app.read().plans, []);
  assert.equal(app.read().state.people[0].salary, 36000);
  const restarted = boot({ storage: app.storage() });
  assert.match(restarted.shell(), /未关联方案 · 当前草稿/);
  assert.equal(restarted.read().state.people[0].salary, 36000);
});

test('加载已存版本恢复快照，并清除当前草稿的修改标记', () => {
  const app = boot();
  const id = app.saveAs('可恢复');
  app.editPerson('salary', 37000);
  app.load(id);
  assert.equal(app.read().state.people[0].salary, 25000);
  assert.equal(app.read().activePlanId, id);
  assert.match(app.shell(), /与方案内容一致/);
});

test('导入合法当前ID及逐方案缓存，保存后重启保持关联', async () => {
  const app = boot();
  const choices = { a: { full: 'salary', custom: 'linked', customTouched: true, actualEmployerFundRate: 6 } };
  await app.import(backup({ plans: [snapshot('imported', income(), { uiChoices: choices })], activePlanId: 'imported', uiChoices: choices }));
  app.submit();
  assert.equal(app.read().activePlanId, 'imported');
  assert.equal(app.read().uiChoices.a.actualEmployerFundRate, 6);
  assert.equal(app.read().plans[0].uiChoices.a.actualEmployerFundRate, 6);
  assert.match(boot({ storage: app.storage() }).shell(), /与方案内容一致/);
});

test('导入不存在或非字符串的当前ID时安全解除关联，不猜测方案', async () => {
  for (const activePlanId of ['missing', '', 123, null]) {
    const app = boot();
    app.saveAs('原当前方案');
    await app.import(backup({ plans: [snapshot('valid')], activePlanId }));
    app.submit();
    assert.equal(app.read().activePlanId, null);
    assert.equal(app.read().plans[0].id, 'valid');
    assert.match(app.shell(), /未关联方案 · 当前草稿/);
  }
});

test('拒绝重复、空、超长和非字符串方案ID，保留原记录', async () => {
  for (const plans of [
    [snapshot('duplicate'), snapshot('duplicate')], [snapshot('')],
    [snapshot('x'.repeat(101))], [snapshot(123)]
  ]) {
    const app = boot();
    app.saveAs('不可被损坏导入替换');
    const before = app.read();
    await app.import(backup({ plans }));
    assert.equal(app.modalOpen(), false);
    assert.match(app.toast(), /导入失败/);
    assert.deepEqual(app.read(), before);
  }
});

test('旧备份没有当前ID和缓存时仍可导入且不继承当前会话缓存', async () => {
  const app = boot({ record: {
    uiChoices: { a: { full: 'salary', custom: 'linked', customTouched: true, actualEmployerFundRate: 5 } }
  } });
  await app.import(backup({ version: 1, plans: [snapshot('legacy')] }));
  app.submit();
  assert.equal(app.read().activePlanId, null);
  app.editPerson('baseMode', 'actual');
  assert.equal(app.read().state.people[0].employerFundRate, 7);
  assert.notEqual(app.read().uiChoices.a.actualEmployerFundRate, 5);
});

test('跨方案加载分别恢复单位实际比例缓存，互不污染', () => {
  const state = income();
  const choices = rate => ({ a: { full: 'salary', custom: 'linked', customTouched: true, actualEmployerFundRate: rate } });
  const app = boot({ record: {
    state, activePlanId: 'A', uiChoices: choices(5),
    plans: [snapshot('A', state, { uiChoices: choices(5) }), snapshot('B', state, { uiChoices: choices(6) })]
  } });
  app.load('B');
  app.editPerson('baseMode', 'actual');
  assert.equal(app.read().state.people[0].employerFundRate, 6);
  app.load('A');
  app.editPerson('baseMode', 'actual');
  assert.equal(app.read().state.people[0].employerFundRate, 5);
});

test('旧方案无缓存时不继承另一方案的比例和customTouched', () => {
  const state = income();
  const app = boot({ record: {
    uiChoices: { a: { full: 'annualized', custom: 'separate', customTouched: true, actualEmployerFundRate: 5 } },
    plans: [snapshot('legacy', state)]
  } });
  app.load('legacy');
  app.editPerson('baseMode', 'actual');
  assert.equal(app.read().state.people[0].employerFundRate, 7);
  app.editPerson('salary', 32000);
  app.click({ contributionSource: 'custom' });
  const person = app.read().state.people[0];
  assert.equal(person.contributionMode, 'linked');
  assert.equal(person.contributionBase, 32000);
  assert.equal(person.socialBase, 32000);
  assert.equal(person.fundBase, 32000);
});

test('切换到同年方案清除上一方案的历史参考收入核对标记', () => {
  const app = boot({ record: { referenceReviewYear: 2020, plans: [snapshot('current-year')] } });
  app.load('current-year');
  assert.equal(app.read().referenceReviewYear, null);
  assert.doesNotMatch(app.page(), /历史收入来自 2020 年方案/);
});

test('加载往年方案按被加载年份重建核对提醒，保留真实参考收入', () => {
  const state = income();
  state.year = 2025;
  state.people[0].referenceAnnualIncome = 360000;
  const app = boot({ record: { referenceReviewYear: 2020, plans: [snapshot('previous-year', state)] } });
  app.load('previous-year');
  const data = app.read();
  assert.equal(data.referenceReviewYear, 2025);
  assert.equal(data.state.year, 2026);
  assert.equal(data.state.people[0].referenceAnnualIncome, 360000);
  assert.match(app.page(), /历史收入来自 2025 年方案/);
});
