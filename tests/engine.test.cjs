'use strict';

// 仅使用 Node 内置模块；期望值依据独立手算，不调用被测引擎的税率辅助函数。
const assert = require('node:assert/strict');
const { defaultState, normalizeState, normalizePolicy, calculate } = require('../engine.js');
let passed = 0;

function test(name, run) {
  try {
    run();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function close(actual, expected, message = '') {
  assert.ok(Number.isFinite(actual), `${message}: 结果必须是有限数字，实际 ${actual}`);
  assert.ok(Math.abs(actual - expected) < 0.011,
    `${message}: 期望 ${expected}，实际 ${actual}`);
}

function emptyState() {
  const state = defaultState();
  state.year = 2026;
  state.mode = 'single';
  state.scenario = 'expected';
  state.expenses = [];
  state.factors = { conservative: 0, expected: 1, optimistic: 2 };
  state.splitMode = 'equal';
  state.splitA = 50;
  for (const person of state.people) {
    Object.assign(person, {
      salary: 0, fixedBonus: 0, fixedBonusMode: 'amount', fixedBonusMonths: 0,
      variableBonus: 0, bonusMonth: 12, bonusMethod: 'combined', qualifiedBonus: true,
      socialBase: 0, fundBase: 0, baseMode: 'actual',
      contributionMode: 'separate', contributionBase: 0,
      referenceAnnualIncome: null, referenceFirstHalfAnnualIncome: null,
      pensionRate: 0, medicalRate: 0, unemploymentRate: 0,
      fundRate: 0, employerFundRate: 0, supplementRate: 0, employerSupplementRate: 0,
      deduction: 0, partyMember: false, partyMode: 'manual', partyMonthly: 0
    });
  }
  return state;
}

function expense(id, amount, owner = 'shared', frequency = 'monthly', month = 12) {
  return { id, label: id, amount, owner, frequency, month, category: 'other' };
}

// 第一版公开示例的固定夹具，不从新版 defaultState 派生，避免迁移测试自证。
function legacyV1State(independentBases = false) {
  const legacyPerson = (id, name, salary, variableBonus) => ({
    id, name, salary, fixedBonus: salary, fixedBonusMode: 'amount', fixedBonusMonths: 1,
    variableBonus, bonusMonth: 12, bonusMethod: 'auto', qualifiedBonus: true,
    socialBase: salary, fundBase: salary, baseMode: 'policy',
    pensionRate: 8, medicalRate: 2, unemploymentRate: 0.5,
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5,
    deduction: 1500, partyMember: false, partyMode: 'manual', partyMonthly: 0
  });
  const state = {
    version: 1, year: 2026, mode: 'couple', scenario: 'expected', goal: 300000,
    people: [legacyPerson('a', '我', 25000, 50000), legacyPerson('b', 'TA', 18000, 30000)],
    factors: { conservative: 0, expected: 1, optimistic: 1.5 },
    expenses: [expense('rent', 6000), expense('food', 3000), expense('transport', 500),
      expense('fixed', 800), expense('personal-a', 1500, 'a'),
      expense('personal-b', 1000, 'b'), expense('travel', 20000, 'shared', 'annual')],
    splitMode: 'equal', splitA: 50
  };
  if (independentBases) {
    Object.assign(state.people[0], { socialBase: 22000, fundBase: 18000 });
    Object.assign(state.people[1], { socialBase: 12000, fundBase: 16000 });
  }
  return state;
}

test('默认配置可以归一化并计算，且不修改输入', () => {
  const state = defaultState();
  assert.equal(state.version, 2);
  assert.equal(state.year, new Date().getFullYear());
  assert.ok(state.people.every(person => person.contributionMode === 'salary'));
  assert.ok(state.people.every(person => person.fixedBonusPayout === 'annual'));
  const before = JSON.stringify(state);
  const normalized = normalizeState(state);
  const result = calculate(normalized);
  assert.equal(result.months.length, 12);
  assert.equal(JSON.stringify(state), before);
  assert.ok(result.people.length >= 1);
});

test('旧v1当前保存迁移为共用核定基数，原有金额不变', () => {
  const current = JSON.parse(JSON.stringify({ state: legacyV1State(), demo: false }));
  const before = JSON.stringify(current);
  const migrated = normalizeState(current.state);
  assert.equal(migrated.version, 2);
  assert.ok(migrated.people.every(person => person.contributionMode === 'linked'));
  close(migrated.people[0].contributionBase, 25000);
  close(migrated.people[1].contributionBase, 18000);
  const result = calculate(migrated);
  close(result.annual.gross, 639000);
  close(result.annual.social, 54180);
  close(result.annual.tax, 32280);
  close(result.annual.net, 490620);
  close(result.annual.expenses, 173600);
  close(result.annual.savings, 317020);
  close(result.annual.fundAdded, 123840);
  assert.equal(JSON.stringify(current), before, '迁移不得直接改写原始保存对象');
});

test('旧v1快照的社保与公积金基数不同时，迁移仍保留两套值', () => {
  const snapshot = { id: 'old-plan', name: '旧独立基数方案', date: '2026-11-16', state: legacyV1State(true) };
  const migrated = normalizeState(snapshot.state);
  assert.ok(migrated.people.every(person => person.contributionMode === 'separate'));
  close(migrated.people[0].socialBase, 22000);
  close(migrated.people[0].fundBase, 18000);
  close(migrated.people[1].socialBase, 12000);
  close(migrated.people[1].fundBase, 16000);
  const result = calculate(migrated);
  close(result.annual.social, 42840);
  close(result.annual.tax, 36096);
  close(result.annual.net, 511104);
  close(result.annual.savings, 337504);
  close(result.annual.fundAdded, 97920);
});

test('旧JSON备份中当前输入与多个快照可分别迁移，原备份不被清空', () => {
  const backup = JSON.parse(JSON.stringify({
    app: 'CoWallet', version: 1, state: legacyV1State(),
    plans: [{ id: 'old-1', name: '相同基数', date: '2026-11-16', state: legacyV1State() },
      { id: 'old-2', name: '不同基数', date: '2026-11-16', state: legacyV1State(true) }]
  }));
  const before = JSON.stringify(backup);
  // 浏览器入口同样对 current.state 与每个 plan.state 调用 normalizeState。
  const states = [backup.state, ...backup.plans.map(plan => plan.state)].map(normalizeState);
  assert.ok(states.every(state => state.version === 2));
  close(calculate(states[0]).annual.net, 490620);
  close(calculate(states[1]).annual.net, 490620);
  close(calculate(states[2]).annual.net, 511104);
  assert.equal(JSON.stringify(backup), before);
  assert.equal(backup.plans.length, 2);
});

test('首年按月薪基数计算，不被遗留核定基数字段干扰', () => {
  const state = emptyState();
  Object.assign(state.people[0], {
    salary: 20000, contributionMode: 'salary', contributionBase: 1,
    socialBase: 50000, fundBase: 50000, baseMode: 'policy',
    pensionRate: 8, medicalRate: 2, unemploymentRate: 0.5,
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5
  });
  const result = calculate(state);
  const month = result.people[0].months[0];
  close(month.socialBase, 20000);
  close(month.fundBase, 20000);
  close(month.social, 2100);
  close(month.fundAdded, 4800);
  // 全年应税所得=240000-25200-28800-60000=126000，税10080。
  close(result.annual.tax, 10080);
  close(result.annual.net, 175920);
  close(result.annual.fundAdded, 57600);
});

test('共用单位核定基数只填一次，独立字段保留但不参与当前模式', () => {
  const state = emptyState();
  Object.assign(state.people[0], {
    salary: 20000, contributionMode: 'linked', contributionBase: 10000,
    socialBase: 8000, fundBase: 12000, baseMode: 'policy',
    pensionRate: 8, medicalRate: 2, unemploymentRate: 0.5,
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5
  });
  const result = calculate(state);
  const month = result.people[0].months[0];
  close(month.socialBase, 10000);
  close(month.fundBase, 10000);
  close(month.social, 1050);
  close(month.fundAdded, 2400);
  // 应税所得153000，税153000×20%-16920=13680。
  close(result.annual.tax, 13680);
  close(result.annual.net, 199320);
  state.people[0].contributionMode = 'separate';
  const separate = calculate(state);
  close(separate.people[0].months[0].socialBase, 8000);
  close(separate.people[0].months[0].fundBase, 12000);
  close(separate.annual.tax, 13608);
  close(separate.annual.net, 199032);
});

test('共用基数3000时社保限低、公积金仍用3000，分别应用各自规则', () => {
  const state = emptyState();
  Object.assign(state.people[0], {
    salary: 10000, contributionMode: 'linked', contributionBase: 3000, baseMode: 'policy',
    pensionRate: 8, medicalRate: 2, unemploymentRate: 0.5,
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5
  });
  const result = calculate(state);
  const months = result.people[0].months;
  close(months[0].socialBase, 7460);
  close(months[6].socialBase, 7546);
  close(months[0].fundBase, 3000);
  close(months[6].fundBase, 3000);
  close(result.annual.social, 9453.78);
  close(result.annual.fundAdded, 8640);
  close(result.annual.tax, 2102.62);
  close(result.annual.net, 104123.6);
});

test('共用高基数也按月份限高，不会因只有一个输入而全年套同一个上限', () => {
  const state = emptyState();
  Object.assign(state.people[0], {
    salary: 60000, contributionMode: 'linked', contributionBase: 50000, baseMode: 'policy',
    pensionRate: 8, medicalRate: 2, unemploymentRate: 0.5,
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5
  });
  const months = calculate(state).people[0].months;
  close(months[0].socialBase, 37302);
  close(months[6].socialBase, 37731);
  close(months[0].fundBase, 37302);
  close(months[6].fundBase, 37731);
  close(months[0].social, 3916.71);
  close(months[6].social, 3961.76);
});

test('上年税前总收入含奖金除以12，不只取当前base月薪', () => {
  const state = emptyState();
  Object.assign(state.people[0], {
    salary: 20000, contributionMode: 'annualized', referenceAnnualIncome: 300000,
    baseMode: 'policy', pensionRate: 8, medicalRate: 2, unemploymentRate: 0.5,
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5
  });
  const result = calculate(state);
  // 上年总收入300000=上年12×20000+已发年终奖60000；月均25000。
  const months = result.people[0].months;
  assert.ok(months.every(month => month.socialBase === 25000 && month.fundBase === 25000));
  close(result.annual.social, 31500);
  close(result.annual.fundAdded, 72000);
  close(result.annual.tax, 8730);
  close(result.annual.net, 163770);
  assert.ok(result.warnings.some(message => /固定基数|上半年|全年沿用/.test(message)), '缺少上上年收入时，应说明固定基数预算');
});

test('历史年度总收入不随当前浮动奖金情景改变，奖金仍各自重新算税', () => {
  const state = emptyState();
  Object.assign(state.people[0], {
    salary: 20000, variableBonus: 36000, bonusMethod: 'separate',
    contributionMode: 'annualized', referenceAnnualIncome: 300000, baseMode: 'policy',
    pensionRate: 8, medicalRate: 2, unemploymentRate: 0.5,
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5
  });
  const low = calculate(state, 'conservative');
  const middle = calculate(state, 'expected');
  const high = calculate(state, 'optimistic');
  for (const result of [low, middle, high]) {
    assert.ok(result.people[0].months.every(month => month.socialBase === 25000 && month.fundBase === 25000));
    close(result.annual.social, 31500);
    close(result.annual.fundAdded, 72000);
  }
  close(low.annual.tax, 8730);
  close(middle.annual.tax, 9810);
  close(high.annual.tax, 15720);
  close(low.annual.net, 163770);
  close(middle.annual.net, 198690);
  close(high.annual.net, 228780);
});

test('上上年与上年总收入明确填写时，1—6月和7—12月分别取对应月均', () => {
  const state = emptyState();
  Object.assign(state.people[0], {
    salary: 40000, contributionMode: 'annualized', referenceAnnualIncome: 360000,
    referenceFirstHalfAnnualIncome: 240000, baseMode: 'policy',
    pensionRate: 8, medicalRate: 2, unemploymentRate: 0.5,
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5
  });
  const result = calculate(state);
  const months = result.people[0].months;
  close(months[0].socialBase, 20000);
  close(months[5].fundBase, 20000);
  close(months[6].socialBase, 30000);
  close(months[11].fundBase, 30000);
  close(months[0].social, 2100);
  close(months[6].social, 3150);
  close(months[0].fundAdded, 4800);
  close(months[6].fundAdded, 7200);
  close(result.annual.social, 31500);
  close(result.annual.fundAdded, 72000);
  close(result.annual.tax, 56205);
  close(result.annual.net, 356295);
});

test('年均基数缺历史总收入时报可纠正错误，切换模式或补填后数据仍在', () => {
  const state = emptyState();
  Object.assign(state.people[0], {
    salary: 10000, fixedBonus: 36000, contributionMode: 'annualized', referenceAnnualIncome: null
  });
  const before = JSON.stringify(state);
  assert.throws(() => calculate(state), /上一年度.*总收入|上年.*总收入/);
  assert.equal(JSON.stringify(state), before);
  state.people[0].referenceAnnualIncome = 120000;
  close(calculate(state).annual.gross, 156000);
  state.people[0].referenceAnnualIncome = null;
  state.people[0].contributionMode = 'salary';
  close(calculate(state).annual.gross, 156000);
});

test('新基数模式严格校验，选填上半年历史额缺省为null且不补造金额', () => {
  const state = emptyState();
  delete state.people[0].referenceFirstHalfAnnualIncome;
  const normalized = normalizeState(state);
  assert.equal(normalized.people[0].referenceFirstHalfAnnualIncome, null);
  assert.equal(normalized.people[0].referenceAnnualIncome, null);
  for (const [field, value] of [
    ['contributionMode', 'unknown'], ['contributionBase', -1],
    ['referenceAnnualIncome', '300000'], ['referenceAnnualIncome', -1],
    ['referenceFirstHalfAnnualIncome', Infinity]
  ]) {
    const invalid = emptyState();
    invalid.people[0][field] = value;
    assert.throws(() => normalizeState(invalid));
  }
});

test('全部输入为零时，收入、扣款、公积金和结余均为零', () => {
  const result = calculate(emptyState());
  for (const field of ['gross', 'social', 'fundPersonal', 'fundEmployer',
    'supplementPersonal', 'supplementEmployer', 'party', 'tax', 'net',
    'expenses', 'savings', 'fundAdded']) {
    close(result.annual[field], 0, field);
  }
});

test('月薪10000、无其他扣除：全年税3480、到手116520', () => {
  const state = emptyState();
  state.people[0].salary = 10000;
  const result = calculate(state);
  // 全年应税所得 120000 - 60000 = 60000；60000×10%-2520 = 3480。
  close(result.annual.gross, 120000);
  close(result.annual.tax, 3480);
  close(result.annual.net, 116520);
  close(result.months[0].salaryTax, 150);
  close(result.months[7].salaryTax, 430);
  close(result.months[11].salaryTax, 500);
});

test('负结余被保留，不会截断成零', () => {
  const state = emptyState();
  state.expenses = [expense('基本生活', 1000)];
  const result = calculate(state);
  close(result.annual.expenses, 12000);
  close(result.annual.savings, -12000);
  close(result.months[11].cumulativeSavings, -12000);
});

test('单人模式排除B的收入与专属支出，共同费用只扣一次', () => {
  const state = emptyState();
  state.people[0].salary = 10000;
  state.people[1].salary = 900000;
  state.expenses = [expense('共同费用', 1000), expense('A费用', 150, 'a'),
    expense('B费用', 250, 'b')];
  const result = calculate(state);
  assert.equal(result.people.length, 1);
  close(result.annual.gross, 120000);
  close(result.annual.expenses, 13800);
  close(result.annual.savings, 102720);
});

test('两人分别算个税后汇总，共享费用没有重复扣除', () => {
  const state = emptyState();
  state.mode = 'couple';
  state.people.forEach(person => { person.salary = 10000; });
  state.expenses = [expense('共同费用', 1000), expense('A费用', 150, 'a'),
    expense('B费用', 250, 'b')];
  const result = calculate(state);
  close(result.people[0].annual.tax, 3480);
  close(result.people[1].annual.tax, 3480);
  close(result.annual.tax, 6960);
  close(result.annual.expenses, 16800);
  close(result.annual.savings, 216240);
});

test('共享费用自定义80/20分摊不会改变家庭总支出', () => {
  const state = emptyState();
  state.mode = 'couple';
  state.people.forEach(person => { person.salary = 10000; });
  state.expenses = [expense('共同费用', 1000), expense('A费用', 150, 'a'),
    expense('B费用', 250, 'b')];
  state.splitMode = 'custom';
  state.splitA = 80;
  const result = calculate(state);
  close(result.people[0].annual.expenses, 11400);
  close(result.people[1].annual.expenses, 5400);
  close(result.annual.expenses, 16800);
});

test('按全年到手收入比例分摊，每月分币后的两人支出仍等于总费用', () => {
  const state = emptyState();
  state.mode = 'couple';
  state.people[0].salary = 10000;
  state.people[1].salary = 5000;
  state.expenses = [expense('共同费用', 1000)];
  state.splitMode = 'income';
  const result = calculate(state);
  // A全年净收入116520，B为60000；A每月分摊1000×116520/176520→660.10。
  close(result.people[0].months[0].expenses, 660.1);
  close(result.people[1].months[0].expenses, 339.9);
  close(result.people[0].annual.expenses, 7921.2);
  close(result.people[1].annual.expenses, 4078.8);
  close(result.annual.expenses, 12000);
});

test('年度一次性支出只在指定月发生一次', () => {
  const state = emptyState();
  state.expenses = [expense('旅行', 8000, 'shared', 'annual', 5)];
  const result = calculate(state);
  close(result.months[4].expenses, 8000);
  close(result.months[3].expenses, 0);
  close(result.months[5].expenses, 0);
  close(result.annual.expenses, 8000);
});

test('基础与补充公积金分别按每侧到元，双边进入账户', () => {
  const state = emptyState();
  Object.assign(state.people[0], {
    salary: 20000, fundBase: 10005, fundRate: 7, employerFundRate: 7,
    supplementRate: 5, employerSupplementRate: 5
  });
  const result = calculate(state);
  // 每侧：10005×7%=700.35→700；10005×5%=500.25→500；合计1200。
  close(result.months[0].fundPersonal, 700);
  close(result.months[0].fundEmployer, 700);
  close(result.months[0].supplementPersonal, 500);
  close(result.months[0].supplementEmployer, 500);
  close(result.months[0].fundAdded, 2400);
  close(result.annual.fundAdded, 28800);
  // 全年税：(240000-14400-60000)×20%-16920 = 16200。
  close(result.annual.tax, 16200);
  close(result.annual.net, 209400);
});

test('2690基数5%加5%分别进位，每侧270元全部允许扣除', () => {
  const state = emptyState();
  Object.assign(state.people[0], {
    salary: 10000, fundBase: 2690, baseMode: 'actual',
    fundRate: 5, employerFundRate: 5, supplementRate: 5, employerSupplementRate: 5
  });
  const result = calculate(state);
  // 134.5元分别进位：基础135+补充135=270，不能合并后只允许269元。
  const month = result.people[0].months[0];
  close(month.fundPersonal, 135);
  close(month.supplementPersonal, 135);
  close(month.fundAdded, 540);
  assert.ok(result.people[0].months.every(row => row.taxDeductibleFund === 270));
  assert.ok(result.people[0].months.every(row => row.employerFundTaxableExcess === 0));
  // 税=(120000-270×12-60000)×10%-2520=3156。
  close(result.annual.tax, 3156);
  close(result.annual.net, 113604);
  assert.ok(!result.warnings.some(message => /超出税收限额/.test(message)));
});

test('10010基数7%加5%分别进位，每侧1202元不产生虚假超额税', () => {
  const state = emptyState();
  Object.assign(state.people[0], {
    salary: 20000, fundBase: 10010, baseMode: 'actual',
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5
  });
  const result = calculate(state);
  const month = result.people[0].months[0];
  close(month.fundPersonal, 701);
  close(month.supplementPersonal, 501);
  close(month.fundAdded, 2404);
  assert.ok(result.people[0].months.every(row => row.taxDeductibleFund === 1202));
  assert.ok(result.people[0].months.every(row => row.employerFundTaxableExcess === 0));
  // 税=(240000-1202×12-60000)×20%-16920=16195.20。
  close(result.annual.tax, 16195.2);
  close(result.annual.net, 209380.8);
  assert.ok(!result.warnings.some(message => /超出税收限额/.test(message)));
});

test('2026年7月切换社保、公积金上限', () => {
  const state = emptyState();
  Object.assign(state.people[0], {
    salary: 60000, socialBase: 50000, fundBase: 50000, baseMode: 'policy',
    pensionRate: 8, medicalRate: 2, unemploymentRate: 0.5,
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5
  });
  const { months } = calculate(state);
  close(months[0].social, 3916.71);
  close(months[5].social, 3916.71);
  close(months[6].social, 3961.76);
  close(months[0].fundPersonal, 2611);
  close(months[6].fundPersonal, 2641);
  close(months[0].supplementPersonal, 1865);
  close(months[6].supplementPersonal, 1887);
  close(months[0].fundAdded, 8952);
  close(months[6].fundAdded, 9056);
});

test('2026年7月下限分别调整，社保和公积金下限不同', () => {
  const state = emptyState();
  Object.assign(state.people[0], {
    salary: 10000, socialBase: 1, fundBase: 1, baseMode: 'policy',
    pensionRate: 8, medicalRate: 2, unemploymentRate: 0.5,
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5
  });
  const { months } = calculate(state);
  close(months[0].social, 783.3);
  close(months[6].social, 792.33);
  close(months[0].fundAdded, 646);
  close(months[6].fundAdded, 658);
});

test('2025年上半年采用2024年度参数，7月再切换到2025年度', () => {
  const state = emptyState();
  state.year = 2025;
  Object.assign(state.people[0], {
    salary: 60000, socialBase: 50000, fundBase: 50000, baseMode: 'policy',
    pensionRate: 8, medicalRate: 2, unemploymentRate: 0.5,
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5
  });
  const { months } = calculate(state);
  close(months[0].social, 3876.71);
  close(months[5].social, 3876.71);
  close(months[6].social, 3916.71);
  close(months[0].fundAdded, 8860);
  close(months[6].fundAdded, 8952);
});

test('超上限实际缴存保留账户金额，个人与单位超额按税收口径处理', () => {
  const state = emptyState();
  Object.assign(state.people[0], {
    salary: 60000, fundBase: 50000, baseMode: 'actual',
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5
  });
  const result = calculate(state);
  // 个人/单位各实缴6000。1—6月每侧允许4476，7—12月允许4528。
  // 应税所得=720000 + 单位超额(6×1524+6×1472=17976)
  //            -个人允许扣除(6×4476+6×4528=54024)-60000=623952。
  // 税=623952×30%-52920=134265.60；现金不加单位缴存。
  close(result.annual.fundAdded, 144000);
  close(result.annual.tax, 134265.6);
  close(result.annual.net, 513734.4);
  assert.ok(result.warnings.some(message => /超出税收限额|超额/.test(message)));
});

test('年终奖36000元临界点单独计税为1080元', () => {
  const state = emptyState();
  Object.assign(state.people[0], { salary: 5000, fixedBonus: 36000, bonusMethod: 'separate' });
  const result = calculate(state);
  close(result.annual.salaryTax, 0);
  close(result.annual.bonusTax, 1080);
  close(result.annual.net, 94920);
});

test('年终奖36001元跨档，单独计税为3390.10元', () => {
  const state = emptyState();
  Object.assign(state.people[0], { salary: 5000, fixedBonus: 36001, bonusMethod: 'separate' });
  const result = calculate(state);
  // 36001÷12>3000，税额=36001×10%-210=3390.10。
  close(result.annual.bonusTax, 3390.1);
  close(result.annual.net, 92610.9);
});

test('自动比较在36001元跨档时选择税更少的并入方式', () => {
  const state = emptyState();
  Object.assign(state.people[0], { salary: 5000, fixedBonus: 36001, bonusMethod: 'auto' });
  const result = calculate(state);
  close(result.annual.tax, 1080.1);
  close(result.annual.bonusTax, 0);
  close(result.people[0].comparison.combinedTax, 1080.1);
  close(result.people[0].comparison.separateTax, 3390.1);
});

test('自动比较在月薪10000、奖金36000时选择单独计税', () => {
  const state = emptyState();
  Object.assign(state.people[0], { salary: 10000, fixedBonus: 36000, bonusMethod: 'auto' });
  const result = calculate(state);
  close(result.annual.tax, 4560);
  close(result.people[0].comparison.combinedTax, 7080);
  close(result.people[0].comparison.separateTax, 4560);
  close(result.people[0].comparison.saving, 2520);
});

test('固定年终奖支持月薪倍数，且在所选月份发放', () => {
  const state = emptyState();
  Object.assign(state.people[0], {
    salary: 5000, fixedBonusMode: 'months', fixedBonusMonths: 2,
    bonusMonth: 3, bonusMethod: 'separate'
  });
  const result = calculate(state);
  close(result.annual.gross, 70000);
  close(result.months[2].gross, 15000);
  close(result.months[1].gross, 5000);
  close(result.annual.bonusTax, 300);
});

test('旧v1/v2缺固定奖发放字段时默认年度一次，仍共享原bonusMonth', () => {
  const v1 = legacyV1State();
  assert.ok(!Object.hasOwn(v1.people[0], 'fixedBonusPayout'));
  assert.ok(normalizeState(v1).people.every(p => p.fixedBonusPayout === 'annual'));
  close(calculate(v1).annual.savings, 317020);
  const v2 = emptyState();
  v2.people.forEach(p => { delete p.fixedBonusPayout; });
  Object.assign(v2.people[0], { salary: 10000, fixedBonus: 12000, variableBonus: 24000,
    bonusMonth: 6, bonusMethod: 'separate' });
  const before = JSON.stringify(v2), r = calculate(v2);
  close(r.annual.gross, 156000);
  close(r.annual.tax, 4560);
  close(r.annual.net, 151440);
  close(r.months[5].fixedBonus, 12000);
  close(r.months[5].variableBonus, 24000);
  close(r.months[5].net, 44770);
  assert.equal(r.people[0].comparison.selectedMonth, 6);
  close(r.people[0].comparison.selectedAmount, 36000);
  assert.equal(JSON.stringify(v2), before);
});

test('固定奖月摊12000与浮动24000同月：固定按工资税4680，单独仅浮动720', () => {
  const state = emptyState();
  Object.assign(state.people[0], { salary: 10000, fixedBonus: 12000, fixedBonusPayout: 'monthly',
    variableBonus: 24000, bonusMonth: 6, bonusMethod: 'auto' });
  const r = calculate(state), p = r.people[0], comparison = p.comparison;
  close(r.annual.fixedBonus, 12000);
  close(r.annual.variableBonus, 24000);
  close(r.annual.gross, 156000);
  // 工资全年应税=120000+12000-60000=72000，税72000×10%-2520=4680。
  // 仅浮动整笔24000单独计税24000×3%=720，不能把月摊固定奖再次单独。
  close(r.annual.salaryTax, 4680);
  close(r.annual.bonusTax, 720);
  close(r.annual.tax, 5400);
  close(r.annual.net, 150600);
  close(comparison.combinedTax, 7080);
  close(comparison.separateTax, 5400);
  close(comparison.saving, 1680);
  assert.equal(comparison.selected, 'separate');
  assert.equal(comparison.separateMonth, 6);
  assert.equal(comparison.selectedMonth, 6);
  close(comparison.separateAmount, 24000);
  close(comparison.selectedAmount, 24000);
  assert.equal(comparison.candidates.length, 1);
  assert.ok(p.months.every(m => m.fixedBonus === 1000));
  assert.equal(p.months.filter(m => m.bonusTax > 0).length, 1);
  close(p.months[0].gross, 11000);
  close(p.months[0].tax, 180);
  close(p.months[5].gross, 35000);
  close(p.months[5].tax, 900);
});

test('只有月摊固定奖时不虚构可用的一次性优惠，显式separate也回退工资计税', () => {
  const state = emptyState();
  Object.assign(state.people[0], { salary: 10000, fixedBonus: 36000,
    fixedBonusPayout: 'monthly', bonusMethod: 'separate', variableBonus: 0 });
  const r = calculate(state), c = r.people[0].comparison;
  close(r.annual.gross, 156000);
  close(r.annual.salaryTax, 7080);
  close(r.annual.bonusTax, 0);
  close(r.annual.net, 148920);
  assert.equal(c.selected, 'combined');
  assert.equal(c.separateTax, null);
  assert.equal(c.separateMonth, null);
  assert.equal(c.selectedMonth, null);
  close(c.selectedAmount, 0);
  assert.deepEqual(c.candidates, []);
  assert.ok(r.warnings.some(w => w.includes('不能对月摊固定奖金使用单独计税')));
});

test('年度一次仍将固定与浮动同月合成整笔，不拆成两次优惠', () => {
  const state = emptyState();
  Object.assign(state.people[0], { salary: 10000, fixedBonus: 12000, variableBonus: 24000,
    fixedBonusPayout: 'annual', bonusMonth: 6, bonusMethod: 'separate' });
  const r = calculate(state), c = r.people[0].comparison;
  close(r.annual.salaryTax, 3480);
  close(r.annual.bonusTax, 1080);
  close(r.annual.net, 151440);
  assert.equal(c.candidates.length, 1);
  close(c.selectedAmount, 36000);
  assert.equal(r.months.filter(m => m.bonusTax > 0).length, 1);
  assert.ok(r.months.every(m => m.month === 6 || (m.fixedBonus === 0 && m.variableBonus === 0)));
});

test('月摊按整数分守恒并由12月补尾差，小于12分钱也不会产生负分摊', () => {
  const state = emptyState();
  Object.assign(state.people[0], { salary: 5000, fixedBonus: 100.01,
    fixedBonusPayout: 'monthly', bonusMethod: 'combined' });
  const r = calculate(state);
  r.months.slice(0, 11).forEach(m => close(m.fixedBonus, 8.33));
  close(r.months[11].fixedBonus, 8.38);
  close(r.months.reduce((sum, m) => sum + m.fixedBonus, 0), 100.01);
  close(r.annual.gross, 60100.01);
  close(r.annual.tax, 3);
  close(r.annual.net, 60097.01);
  state.people[0].fixedBonus = .06;
  const tiny = calculate(state);
  tiny.months.slice(0, 11).forEach(m => close(m.fixedBonus, 0));
  close(tiny.months[11].fixedBonus, .06);
  assert.ok(tiny.months.every(m => m.fixedBonus >= 0));
  close(tiny.annual.fixedBonus, .06);
});

test('按base倍数填写月摊年度总额，情景仅影响浮动，年度固定金额不再乘12', () => {
  const state = emptyState();
  state.factors = { conservative: 0, expected: 1, optimistic: 1.5 };
  Object.assign(state.people[0], { salary: 10000, fixedBonusMode: 'months', fixedBonusMonths: 1.2,
    fixedBonus: 99999, fixedBonusPayout: 'monthly', variableBonus: 12000, bonusMethod: 'separate' });
  const expected = { conservative: [0, 4680, 127320], expected: [12000, 5040, 138960], optimistic: [18000, 5220, 144780] };
  for (const [scenario, [floating, tax, net]] of Object.entries(expected)) {
    const r = calculate(state, scenario);
    close(r.people[0].fixedBonus, 12000);
    close(r.annual.fixedBonus, 12000);
    close(r.annual.variableBonus, floating);
    close(r.annual.tax, tax);
    close(r.annual.net, net);
    r.months.forEach(m => close(m.fixedBonus, 1000));
  }
});

test('共享发奖月份只移动集中浮动，月摊固定不移动，累计工资税依实际月份变化', () => {
  const state = emptyState();
  Object.assign(state.people[0], { salary: 10000, fixedBonus: 12000, fixedBonusPayout: 'monthly',
    variableBonus: 24000, bonusMethod: 'separate', bonusMonth: 3 });
  const march = calculate(state);
  state.people[0].bonusMonth = 10;
  const october = calculate(state);
  close(march.annual.tax, 5400);
  close(october.annual.tax, 5400);
  close(march.months[2].variableBonus, 24000);
  close(october.months[2].variableBonus, 0);
  close(october.months[9].variableBonus, 24000);
  close(march.months[2].tax, 900);
  close(october.months[9].tax, 1320);
  close(march.months[2].net, 34100);
  close(october.months[9].net, 33680);
  for (let i = 0; i < 12; i++) close(march.months[i].fixedBonus, october.months[i].fixedBonus);
});

test('发奖时间影响当年累计预扣现金：低工资早发集中奖与月摊不假设汇算退款', () => {
  const state = emptyState();
  Object.assign(state.people[0], { salary: 1000, fixedBonus: 36000, bonusMonth: 1,
    fixedBonusPayout: 'annual', bonusMethod: 'combined' });
  const annual = calculate(state);
  // 1月应税=1000+36000-5000=32000，先预扣960，后续低工资不模拟退回。
  close(annual.annual.tax, 960);
  close(annual.annual.net, 47040);
  state.people[0].fixedBonusPayout = 'monthly';
  const monthly = calculate(state);
  // 每月工资4000<5000，不预扣；两种年税前总额同为48000。
  close(monthly.annual.gross, 48000);
  close(monthly.annual.tax, 0);
  close(monthly.annual.net, 48000);
});

test('A月摊与B年度一次分开计税，月度诊断和家庭汇总均包含两人奖金', () => {
  const state = emptyState(); state.mode = 'couple';
  Object.assign(state.people[0], { salary: 10000, fixedBonus: 12000, variableBonus: 24000,
    fixedBonusPayout: 'monthly', bonusMonth: 3, bonusMethod: 'separate' });
  Object.assign(state.people[1], { salary: 15000, fixedBonus: 18000, variableBonus: 60000,
    fixedBonusPayout: 'annual', bonusMonth: 12, bonusMethod: 'separate' });
  const r = calculate(state), [a, b] = r.people;
  close(a.annual.net, 150600); close(b.annual.net, 240930);
  close(r.annual.gross, 414000); close(r.annual.tax, 22470); close(r.annual.net, 391530);
  close(r.months[2].fixedBonus, 1000); close(r.months[2].variableBonus, 24000);
  close(r.months[2].gross, 50000); close(r.months[2].net, 48800);
  close(r.months[11].fixedBonus, 19000); close(r.months[11].variableBonus, 60000);
  close(r.months[11].gross, 104000); close(r.months[11].net, 94810);
  close(r.annual.fixedBonus, 30000); close(r.annual.variableBonus, 84000);
  assert.equal(a.comparison.selectedMonth, 3); assert.equal(b.comparison.selectedMonth, 12);
  close(a.comparison.selectedAmount, 24000); close(b.comparison.selectedAmount, 78000);
});

test('月摊不反向改首年或已核历史缴存基数，公积金新增保持一致', () => {
  const state = defaultState(); state.year = 2026;
  const original = calculate(state);
  state.people[0].fixedBonusPayout = 'monthly';
  const monthly = calculate(state);
  close(monthly.annual.social, original.annual.social);
  close(monthly.annual.fundAdded, original.annual.fundAdded);
  assert.ok(monthly.people[0].months.every(m => m.socialBase === 25000 && m.fundBase === 25000));
  state.people[0].contributionMode = 'annualized'; state.people[0].referenceAnnualIncome = 360000;
  const historical = calculate(state);
  assert.ok(historical.people[0].months.every(m => m.socialBase === 30000 && m.fundBase === 30000));
});

test('2035月摊与浮动仍可计算，过期单独优惠回退且发放月份不被改写', () => {
  const state = emptyState(); state.year = 2035;
  Object.assign(state.people[0], { salary: 10000, fixedBonus: 12000, fixedBonusPayout: 'monthly',
    variableBonus: 24000, bonusMonth: 9, bonusMethod: 'separate' });
  const r = calculate(state), c = r.people[0].comparison;
  close(r.annual.tax, 7080); close(r.annual.net, 148920);
  close(r.months[8].variableBonus, 24000);
  close(r.annual.bonusTax, 0);
  assert.equal(c.selected, 'combined'); assert.equal(c.selectedMonth, null); assert.equal(c.separateMonth, null);
  assert.equal(state.people[0].bonusMonth, 9); assert.equal(state.year, 2035);
  const policy = { socialMin: 0, socialMax: 50000, fundMin: 0, fundMax: 50000, bonusPolicy: 'allowed' };
  close(calculate(state, undefined, policy).annual.tax, 5400);
});

test('固定奖发放方式严格校验，不接受未知独立月份或任意字符串', () => {
  for (const value of ['average', 'monthly ', null, undefined, 1, true, {}, []]) {
    const state = emptyState(); state.people[0].fixedBonusPayout = value;
    assert.throws(() => normalizeState(state));
    assert.throws(() => calculate(state));
  }
  for (const key of ['fixedBonusMonth', 'variableBonusMonth']) {
    const state = emptyState(); state.people[0][key] = 3;
    assert.throws(() => normalizeState(state), /不支持的字段/);
  }
});

test('浮动年终奖三种情景分别重新算税，不对税后数字直接乘倍数', () => {
  const state = emptyState();
  Object.assign(state.people[0], { salary: 10000, variableBonus: 36000, bonusMethod: 'separate' });
  const low = calculate(state, 'conservative');
  const middle = calculate(state, 'expected');
  const high = calculate(state, 'optimistic');
  close(low.annual.tax, 3480);
  close(middle.annual.tax, 4560);
  close(high.annual.tax, 10470);
  close(low.annual.net, 116520);
  close(middle.annual.net, 151440);
  close(high.annual.net, 181530);
});

test('A/B不同浮动奖与发奖月：三情景分别入账，年度、月度与合计均包含B奖金', () => {
  const state = emptyState();
  state.mode = 'couple';
  state.factors = { conservative: 0, expected: 1, optimistic: 1.5 };
  Object.assign(state.people[0], {
    salary: 10000, fixedBonus: 12000, variableBonus: 24000,
    bonusMonth: 10, bonusMethod: 'separate'
  });
  Object.assign(state.people[1], {
    salary: 15000, fixedBonus: 18000, variableBonus: 60000,
    bonusMonth: 12, bonusMethod: 'separate'
  });
  // 无五险一金和预算，便于独立手算：A工资全年税3480，B工资全年税9480。
  // 每行：A年gross/net、B年gross/net、合计gross/net/tax、A十月gross/net、B十二月gross/net。
  const expected = {
    conservative: [132000, 128160, 198000, 187980, 330000, 316140, 13860, 22000, 21140, 33000, 31460],
    expected: [156000, 151440, 258000, 240930, 414000, 392370, 21630, 46000, 44420, 93000, 84410],
    optimistic: [168000, 159930, 288000, 267930, 456000, 427860, 28140, 58000, 52910, 123000, 111410]
  };
  for (const [scenario, values] of Object.entries(expected)) {
    const result = calculate(state, scenario);
    const [a, b] = result.people;
    const [aGross, aNet, bGross, bNet, gross, net, tax, aOctGross, aOctNet, bDecGross, bDecNet] = values;
    close(a.annual.gross, aGross, `${scenario} A年税前`);
    close(a.annual.net, aNet, `${scenario} A年到手`);
    close(b.annual.gross, bGross, `${scenario} B年税前`);
    close(b.annual.net, bNet, `${scenario} B年到手`);
    close(result.annual.gross, gross, `${scenario} 合计年税前`);
    close(result.annual.net, net, `${scenario} 合计年到手`);
    close(result.annual.tax, tax, `${scenario} 合计个税`);
    close(a.variableBonus, 24000 * state.factors[scenario]);
    close(b.variableBonus, 60000 * state.factors[scenario]);
    close(a.months[9].gross, aOctGross);
    close(a.months[9].net, aOctNet);
    close(b.months[11].gross, bDecGross);
    close(b.months[11].net, bDecNet);
    close(b.months[9].gross, 15000, 'B奖金不提前在A发奖月入账');
    close(a.months[11].gross, 10000, 'A奖金不在B发奖月重复入账');
    close(result.months[9].gross, aOctGross + 15000);
    close(result.months[9].net, aOctNet + 14000);
    close(result.months[11].gross, bDecGross + 10000);
    close(result.months[11].net, bDecNet + 9500);
    // 总览的“月均”是各视角年度数÷12；它不同于某个具体发奖月份。
    close(result.annual.gross / 12, gross / 12);
    close(result.annual.net / 12, net / 12);
    close(a.months.reduce((sum, month) => sum + month.gross, 0), aGross);
    close(b.months.reduce((sum, month) => sum + month.net, 0), bNet);
    close(result.months.reduce((sum, month) => sum + month.gross, 0), gross);
    close(result.months.reduce((sum, month) => sum + month.net, 0), net);
  }
});

test('手动党费是税后支出，不减少个税应纳税所得', () => {
  const state = emptyState();
  Object.assign(state.people[0], { salary: 10000, partyMember: true, partyMonthly: 80 });
  const result = calculate(state);
  close(result.annual.party, 960);
  close(result.annual.tax, 3480);
  close(result.annual.net, 115560);
});

test('党费年初估算全年固定，高收入估算一般按每月1000元封顶', () => {
  const state = emptyState();
  Object.assign(state.people[0], { salary: 10000, partyMember: true, partyMode: 'estimate' });
  const normal = calculate(state);
  // 参考月税后固定工资10000-150=9850，9850×1.5%=147.75。
  close(normal.annual.party, 1773);
  assert.ok(normal.months.every(month => month.party === 147.75));
  state.people[0].salary = 1000000;
  const high = calculate(state);
  close(high.annual.party, 12000);
  assert.ok(high.months.every(month => month.party === 1000));
});

test('2028年不自动沿用年终奖单独计税政策', () => {
  const state = emptyState();
  state.year = 2028;
  Object.assign(state.people[0], { salary: 5000, fixedBonus: 36001, bonusMethod: 'auto' });
  const result = calculate(state);
  close(result.annual.tax, 1080.1);
  close(result.annual.bonusTax, 0);
  assert.ok(result.warnings.length > 0, '政策到期应给提示');
  state.people[0].bonusMethod = 'separate';
  const explicit = calculate(state);
  close(explicit.annual.tax, 1080.1);
  assert.equal(explicit.people[0].comparison.selected, 'combined');
  assert.ok(explicit.warnings.some(message => /已回退/.test(message)));
});

test('2035年旧方案仍可计算，过期单独计税自动回退，不覆盖已存年份', () => {
  const state = emptyState();
  state.year = 2035;
  Object.assign(state.people[0], { salary: 5000, fixedBonus: 36001, bonusMethod: 'separate' });
  assert.equal(normalizeState(state).year, 2035);
  const result = calculate(state);
  close(result.annual.gross, 96001);
  close(result.annual.tax, 1080.1);
  close(result.annual.net, 94920.9);
  assert.equal(result.people[0].comparison.selected, 'combined');
  assert.ok(result.warnings.some(message => /已回退/.test(message)));
  assert.equal(state.year, 2035);
});

test('自定义上下限全年统一采用，按各自社保与公积金上限计算', () => {
  const state = emptyState();
  state.year = 2035;
  Object.assign(state.people[0], {
    salary: 40000, contributionMode: 'salary', baseMode: 'policy',
    pensionRate: 8, medicalRate: 2, unemploymentRate: 0.5,
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5
  });
  const policy = { socialMin: 6000, socialMax: 20000, fundMin: 2000, fundMax: 15000, bonusPolicy: 'auto' };
  const before = JSON.stringify(policy);
  const result = calculate(state, undefined, policy);
  assert.ok(result.people[0].months.every(month => month.socialBase === 20000 && month.fundBase === 15000));
  close(result.annual.social, 25200);
  close(result.annual.fundAdded, 43200);
  close(result.annual.tax, 61380);
  close(result.annual.net, 371820);
  assert.ok(result.warnings.some(message => /自定义政策参数/.test(message)));
  assert.equal(JSON.stringify(policy), before);
});

test('自定义上限同时约束税前扣除，实际缴存与单位超额不变成现金收入', () => {
  const state = emptyState();
  state.year = 2035;
  Object.assign(state.people[0], {
    salary: 60000, socialBase: 50000, fundBase: 50000, baseMode: 'actual',
    pensionRate: 8, medicalRate: 2, unemploymentRate: 0.5,
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5
  });
  const policy = { socialMin: 6000, socialMax: 20000, fundMin: 2000, fundMax: 15000, bonusPolicy: 'auto' };
  const result = calculate(state, undefined, policy);
  const month = result.people[0].months[0];
  close(month.social, 5250);
  close(month.taxDeductibleSocial, 2100);
  close(month.taxDeductibleFund, 1800);
  close(month.employerFundTaxableExcess, 4200);
  // 应税所得=720000+4200×12-2100×12-1800×12-60000=663600。
  // 税=663600×35%-85920=146340。
  close(result.annual.tax, 146340);
  close(result.annual.net, 438660);
  close(result.annual.fundAdded, 144000);
});

test('用户明确确认allowed政策后，2035年可用单独计税并重新比较', () => {
  const state = emptyState();
  state.year = 2035;
  Object.assign(state.people[0], { salary: 10000, fixedBonus: 36000, bonusMethod: 'auto' });
  const policy = { socialMin: 6000, socialMax: 20000, fundMin: 2000, fundMax: 15000, bonusPolicy: 'allowed' };
  const result = calculate(state, undefined, policy);
  close(result.annual.tax, 4560);
  close(result.annual.net, 151440);
  assert.equal(result.people[0].comparison.selected, 'separate');
  close(calculate(state).annual.tax, 7080);
  state.people[0].qualifiedBonus = false;
  state.people[0].bonusMethod = 'separate';
  assert.throws(() => calculate(state, undefined, policy), /未确认/);
});

test('combinedOnly强制合并，已存单独计税选项不会让应用报错', () => {
  const state = emptyState();
  Object.assign(state.people[0], { salary: 10000, fixedBonus: 36000, bonusMethod: 'separate' });
  const policy = { socialMin: 6000, socialMax: 20000, fundMin: 2000, fundMax: 15000, bonusPolicy: 'combinedOnly' };
  const result = calculate(state, undefined, policy);
  close(result.annual.tax, 7080);
  assert.equal(result.people[0].comparison.selected, 'combined');
  assert.ok(result.warnings.some(message => /已回退/.test(message)));
});

test('政策参数严格校验，上下限反转、缺项、未知键与非法奖金开关均拒绝', () => {
  const policy = { socialMin: 6000, socialMax: 20000, fundMin: 2000, fundMax: 15000, bonusPolicy: 'auto' };
  assert.equal(normalizePolicy(null), null);
  assert.equal(normalizePolicy(undefined), null);
  assert.deepEqual(normalizePolicy(policy), policy);
  for (const mutate of [
    value => { value.socialMin = 30000; },
    value => { value.fundMin = 20000; },
    value => { delete value.fundMax; },
    value => { value.socialMax = Infinity; },
    value => { value.fundMin = -1; },
    value => { value.socialMin = '6000'; },
    value => { value.bonusPolicy = 'forever'; },
    value => { value.unexpected = true; }
  ]) {
    const invalid = { ...policy };
    mutate(invalid);
    assert.throws(() => normalizePolicy(invalid));
    assert.throws(() => calculate(emptyState(), undefined, invalid));
  }
});

test('年度数值等于12个月逐项合计，累计结余与公积金也一致', () => {
  const state = defaultState();
  const result = calculate(state);
  const fields = ['gross', 'fixedBonus', 'variableBonus', 'social', 'pension', 'medical', 'unemployment',
    'fundPersonal', 'fundEmployer', 'supplementPersonal', 'supplementEmployer',
    'party', 'salaryTax', 'bonusTax', 'tax', 'net', 'expenses', 'savings', 'fundAdded'];
  for (const row of [result, ...result.people]) {
    for (const field of fields) {
      close(row.annual[field], row.months.reduce((sum, month) => sum + month[field], 0), field);
    }
    close(row.months[11].cumulativeSavings, row.annual.savings);
    close(row.months[11].cumulativeFund, row.annual.fundAdded);
  }
});

test('非法导入：拒绝缺失结构、未知字段、负数、NaN与非法比例', () => {
  assert.throws(() => normalizeState(null));
  assert.throws(() => normalizeState({}));
  for (const mutate of [
    state => { delete state.people; },
    state => { state.unexpected = true; },
    state => { state.people[0].salary = -1; },
    state => { state.people[0].salary = NaN; },
    state => { state.people[0].pensionRate = 101; },
    state => { state.people[0].pensionRate = 60; state.people[0].medicalRate = 50; },
    state => { state.people[0].supplementRate = -1; },
    state => { state.expenses = [expense('错误', -1)]; },
    state => { state.expenses = [expense('错误', 1, 'unknown')]; },
    state => { state.splitA = 101; },
    state => { state.factors.expected = Infinity; }
  ]) {
    const state = emptyState();
    mutate(state);
    assert.throws(() => normalizeState(state));
    assert.throws(() => calculate(state));
  }
});

console.log(`\n${passed} 项测试全部通过。`);
