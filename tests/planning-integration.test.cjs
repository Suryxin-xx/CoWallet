'use strict';

// Only fictional inputs. Every monthly cash/bonus/fund value comes from the real income engine.
const assert = require('node:assert/strict');
const E = require('../engine.js');
const M = require('../mortgage.js');
let passed = 0;

function test(name, run) {
  try { run(); passed += 1; console.log('✓ ' + name); }
  catch (error) { console.error('✗ ' + name); throw error; }
}
function close(actual, expected, label = '') {
  assert.ok(Number.isFinite(actual), `${label}: result must be finite`);
  assert.ok(Math.abs(actual - expected) < 0.011, `${label}: expected ${expected}, got ${actual}`);
}
function incomeState(mode = 'single') {
  const state = E.defaultState();
  Object.assign(state, { year: 2026, mode, scenario: 'expected',
    factors: { conservative: 0, expected: 1, optimistic: 1.5 },
    expenses: [{ id: 'rent', label: '虚构月租', amount: 4000, frequency: 'monthly',
      month: 12, owner: 'shared', category: 'rent' }] });
  state.people.forEach((person, index) => Object.assign(person, {
    name: index ? '虚构乙' : '虚构甲', salary: index ? 8000 : 10000,
    fixedBonus: 0, fixedBonusMode: 'amount', fixedBonusMonths: 0, fixedBonusPayout: 'annual',
    variableBonus: index ? 6000 : 12000, bonusMonth: index ? 6 : 12,
    bonusMethod: 'separate', qualifiedBonus: true, contributionMode: 'salary', baseMode: 'policy',
    pensionRate: 8, medicalRate: 2, unemploymentRate: 0.5,
    fundRate: 7, employerFundRate: 7, supplementRate: 5, employerSupplementRate: 5,
    deduction: 0, partyMember: false, partyMonthly: 0, partyMode: 'manual'
  }));
  return state;
}
function purchasePlan() {
  return Object.assign(M.defaultPlan(), { housePrice: 1000000, downPaymentPercent: 20 });
}
function calculate(state = incomeState(), plan = purchasePlan(), scenario = state.scenario) {
  const finance = E.calculate(state, scenario);
  // Today is 2025-12; the next full month is 2026-01. This aligns one projected cycle with E's year.
  const context = Object.assign({}, finance, { currentYear: 2025, currentMonth: 12, state });
  const before = JSON.stringify({ state, plan, context });
  const result = M.calculate(plan, context);
  assert.equal(JSON.stringify({ state, plan, context }), before, '联动计算不能改写原方案或收入结果');
  return { finance, result };
}
function at(result, elapsedMonth) {
  const row = result.projectedTimeline.find(item => item.elapsedMonth === elapsedMonth);
  assert.ok(row, `缺少第${elapsedMonth}个月进度`);
  return row;
}

test('新计划默认现金及基本补充公积金均从0，联动来源为自动', () => {
  const plan = M.defaultPlan();
  assert.equal(plan.version, 2);
  for (const field of ['initialCash', 'reserveCash', 'purchaseCosts', 'currentBasicBalanceA',
    'currentBasicBalanceB', 'currentSupplementBalanceA', 'currentSupplementBalanceB']) close(plan[field], 0, field);
  assert.deepEqual(plan.linkages, { rent: 'budget', fundAllocation: 'auto', supplementEligibility: 'linked', balanceSource: 'zero' });
  const { result } = calculate();
  close(at(result, 0).cash, 0);
  close(at(result, 0).basicFund, 0);
  close(at(result, 0).supplementFund, 0);
  close(result.fundEstimate.current.estimatedLoan, 0);
});

test('每月现金、12月奖金、基础补充入账均逐项来自真实E结果，不使用年均替代', () => {
  const { finance, result } = calculate();
  // 工资：月社保1050、个人CPF1200、月税82.5、到手7667.5；12月奖税360。
  close(finance.months[0].net, 7667.5);
  close(finance.months[11].net, 19307.5);
  close(finance.annual.savings, 55650);
  close(finance.annual.fundAdded, 28800);
  close(at(result, 1).cash, 3667.5);
  close(at(result, 1).basicFund, 1400);
  close(at(result, 1).supplementFund, 1000);
  assert.equal(at(result, 1).yearMonth, '2026-01');
  let cash = 0, basic = 0, supplement = 0;
  finance.months.forEach((month, index) => {
    cash += month.savings;
    basic += month.fundPersonal + month.fundEmployer;
    supplement += month.supplementPersonal + month.supplementEmployer;
    const progress = at(result, index + 1);
    close(progress.cash, cash);
    close(progress.basicFund, basic);
    close(progress.supplementFund, supplement);
    close(progress.fundTotal, basic + supplement);
  });
  close(at(result, 12).cash - at(result, 11).cash, 15307.5, '12月保留奖金现金');
  close(at(result, 12).cash, 55650);
  close(at(result, 12).fundTotal, 28800);
});

test('双人进度含B的6月奖金及两侧公积金，借款人账户与家庭总账户区分', () => {
  const { finance, result } = calculate(incomeState('couple'));
  close(finance.annual.savings, 135438);
  close(finance.annual.fundAdded, 51840);
  close(at(result, 1).cash, 9831.5);
  close(at(result, 6).cash - at(result, 5).cash, 15651.5);
  close(at(result, 12).cash - at(result, 11).cash, 21471.5);
  close(at(result, 12).cash, 135438);
  close(at(result, 12).basicFund, 30240);
  close(at(result, 12).supplementFund, 21600);
  close(at(result, 12).householdFundTotal, 51840);
  close(at(result, 12).borrowerFundTotal, 28800, '只选A借款不会丢掉家庭B存款，但不能拿B余额自动贷款');
  assert.deepEqual(result.effective.householdMembers, ['a', 'b']);
});

test('7月缴存基数切换时按E的实际月入账积累，不把年度公积金摊成固定月均', () => {
  const state = incomeState();
  state.people[0].salary = 60000;
  const { finance, result } = calculate(state);
  close(finance.months[0].fundAdded, 8952);
  close(finance.months[6].fundAdded, 9056);
  close(at(result, 1).basicFund, 5222);
  close(at(result, 1).supplementFund, 3730);
  close(at(result, 7).basicFund - at(result, 6).basicFund, 5282);
  close(at(result, 7).supplementFund - at(result, 6).supplementFund, 3774);
  close(at(result, 12).basicFund, 63024);
  close(at(result, 12).supplementFund, 45024);
  close(at(result, 12).fundTotal, 108048);
  close(at(result, 12).fundTotal, finance.annual.fundAdded);
});

test('11月开始规划时首个完整月就是12月，奖金与公积金同时从该月入账', () => {
  const state = incomeState();
  const finance = E.calculate(state);
  const result = M.calculate(purchasePlan(), Object.assign({}, finance, {
    state, currentYear: 2026, currentMonth: 11
  }));
  assert.equal(at(result, 0).yearMonth, '2026-11');
  assert.equal(at(result, 1).yearMonth, '2026-12');
  close(at(result, 1).cash, 15307.5);
  close(at(result, 1).fundTotal, 2400);
  assert.equal(at(result, 2).yearMonth, '2027-01');
  close(at(result, 2).cash, 18975);
  close(at(result, 2).fundTotal, 4800);
});

test('改月薪后真实税款、现金和公积金重算，首付进度同步提前', () => {
  const state = incomeState();
  const original = calculate(state).result;
  state.people[0].salary = 12000;
  const { finance, result } = calculate(state);
  close(finance.annual.savings, 72600);
  close(finance.annual.fundAdded, 34560);
  close(at(result, 1).cash, 5171);
  close(at(result, 12).cash, 72600);
  close(at(result, 12).fundTotal, 34560);
  assert.equal(original.purchase.monthsToReady, 46);
  assert.equal(result.purchase.monthsToReady, 35);
});

test('改生活预算会推迟首付；年度支出仍只在真实发生月扣款', () => {
  const state = incomeState();
  state.expenses[0].amount = 5000;
  const changed = calculate(state);
  close(changed.finance.annual.savings, 43650);
  close(at(changed.result, 12).cash, 43650);
  assert.equal(changed.result.purchase.monthsToReady, 58);
  state.expenses[0].amount = 4000;
  state.expenses.push({ id: 'travel', label: '虚构年度旅行', amount: 6000,
    frequency: 'annual', month: 7, owner: 'shared', category: 'other' });
  const annual = calculate(state);
  close(at(annual.result, 7).cash - at(annual.result, 6).cash, -2332.5);
  close(at(annual.result, 12).cash, 49650);
  assert.ok(annual.result.effective.rentByMonth.every(amount => amount === 4000));
});

test('单双人切换从同一份输入联动，B数据保留且预算只扣一次', () => {
  const state = incomeState('couple');
  const originalB = JSON.stringify(state.people[1]);
  const couple = calculate(state).result;
  assert.equal(couple.purchase.monthsToReady, 18);
  state.mode = 'single';
  const single = calculate(state).result;
  assert.equal(single.purchase.monthsToReady, 46);
  close(at(single, 12).cash, 55650);
  close(at(single, 12).fundTotal, 28800);
  state.mode = 'couple';
  close(at(calculate(state).result, 12).cash, 135438);
  assert.equal(JSON.stringify(state.people[1]), originalB);
});

test('现金为负仍保留，公积金增加不能填补现金首付缺口', () => {
  const state = incomeState();
  state.expenses[0].amount = 9000;
  const { finance, result } = calculate(state);
  close(finance.annual.savings, -4350);
  close(at(result, 1).cash, -1332.5);
  close(at(result, 1).fundTotal, 2400);
  close(at(result, 12).cash, -4350);
  close(at(result, 12).fundTotal, 28800);
  assert.equal(result.purchase.reachable, false);
  assert.equal(result.purchase.monthsToReady, null);
});

test('高级手动房租及贷款额覆盖自动来源，但工资预算进度仍来自E', () => {
  const plan = purchasePlan();
  plan.linkages.rent = 'manual';
  plan.monthlyRentToReplace = 1000;
  plan.linkages.fundAllocation = 'manual';
  plan.fundLoanRequested = 50000;
  const { result } = calculate(incomeState(), plan);
  assert.ok(result.effective.rentByMonth.every(amount => amount === 1000));
  close(result.loans.fundPrincipal, 50000);
  close(result.loans.commercialPrincipal, 750000);
  close(at(result, 12).cash, 55650);
  close(at(result, 12).fundTotal, 28800);
});

test('旧v1自定义现金、公积金余额、贷款请求和房租迁移为手动且原值不丢', () => {
  const old = {
    version: 1, housePrice: 100000, downPaymentPercent: 20, loanType: 'mixed', repayment: 'annuity',
    years: 30, commercialRate: 3, fundRate: 2.6, fundLoanRequested: 50000,
    initialCash: 12345, reserveCash: 0, purchaseCosts: 0, monthlyRentToReplace: 1000,
    otherMonthlyHousingCost: 0, postPurchaseExpenseAdjustment: 0,
    currentBasicBalanceA: 1234.56, currentBasicBalanceB: 2345.67,
    currentSupplementBalanceA: 345.67, currentSupplementBalanceB: 456.78,
    borrowerMode: 'joint', firstHome: true, continuousContributions: null,
    supplementEligibleA: true, supplementEligibleB: false,
    manualCaps: { basicMultiplier: 30, supplementMultiplier: 10, basicLoanCap: null,
      supplementLoanCap: null, maxLoanToValuePercent: null, repaymentCapacityPercent: 40,
      monthlyIncomeBase: 25000, commercialMinDownPaymentPercent: null }
  };
  const before = JSON.stringify(old);
  const migrated = M.normalizePlan(old);
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.linkages, { rent: 'manual', fundAllocation: 'manual', supplementEligibility: 'manual', balanceSource: 'manual' });
  for (const field of ['initialCash', 'fundLoanRequested', 'monthlyRentToReplace', 'currentBasicBalanceA',
    'currentBasicBalanceB', 'currentSupplementBalanceA', 'currentSupplementBalanceB']) close(migrated[field], old[field]);
  const result = calculate(incomeState('couple'), migrated).result;
  close(at(result, 0).cash, 12345);
  close(at(result, 0).basicFund, 3580.23);
  close(at(result, 0).supplementFund, 802.45);
  close(at(result, 0).fundTotal, 4382.68);
  assert.equal(JSON.stringify(old), before);
});

test('足额和可考虑时间仅为预算条件，未知资格保留且明确不是审批承诺', () => {
  const { result } = calculate();
  assert.equal(result.effective.continuousContributions, null);
  assert.equal(result.fundEstimate.current.estimateOnly, true);
  assert.equal(result.consideration.reachable, true);
  assert.ok(result.consideration.monthsToReady >= result.purchase.monthsToReady);
  assert.match(result.consideration.criteria, /不是贷款审批|不代表.*审批/);
  assert.ok(result.warnings.some(message => /资格.*核实|需另行核实/.test(message)));
  const row = at(result, result.consideration.monthsToReady);
  assert.equal(row.cashReady, true);
  assert.equal(row.financingReady, true);
  assert.ok(row.postRegularSavings >= 0);
});

test('现金今天已足额但月供压力需等待，详细贷款与买后预算使用后来的可考虑时点', () => {
  const state = incomeState();
  state.expenses = [
    { id: 'rent', label: '虚构月租', amount: 1000, frequency: 'monthly', month: 12, owner: 'shared', category: 'rent' },
    { id: 'living', label: '虚构其他生活开支', amount: 4367.5, frequency: 'monthly', month: 12, owner: 'shared', category: 'fixed' }
  ];
  const plan = purchasePlan();
  plan.initialCash = 200000;
  const { result } = calculate(state, plan);
  assert.equal(result.purchase.monthsToReady, 0);
  // 常规到手7667.5 - 买后生活4367.5 = 可用月供3300；需先积累7个月CPF改善组合。
  assert.equal(result.consideration.monthsToReady, 7);
  assert.equal(result.purchase.plannedPurchaseMonth, '2026-07');
  assert.equal(result.loans.estimateElapsedMonths, 7);
  assert.equal(result.loans.estimateAtMonth, '2026-07');
  close(result.fundEstimate.atPurchase.borrowerFundTotal, 0);
  close(result.fundEstimate.atConsideration.borrowerFundTotal, 16800);
  close(result.loans.fundPrincipal, 364000);
  close(result.loans.commercialPrincipal, 436000);
  close(result.loans.firstMonthlyPayment, result.consideration.payment);
  close(result.postPurchase.months[0].mortgagePayment, result.consideration.payment);
  assert.equal(result.postPurchase.months[0].yearMonth, '2026-08');
  assert.ok(result.postPurchase.regularMonthlySavings >= 0);
});

test('固定年度奖金按分均摊并补12月尾差，浮动只在共用发奖月入账且进度逐月守恒', () => {
  const state = incomeState();
  Object.assign(state.people[0], { fixedBonus: 10000.01, fixedBonusPayout: 'monthly',
    variableBonus: 36000, bonusMonth: 7, bonusMethod: 'combined' });
  const { finance, result } = calculate(state);
  assert.equal(finance.months.reduce((sum, month) => sum + Math.round(month.fixedBonus * 100), 0), 1000001);
  finance.months.slice(0, 11).forEach(month => close(month.fixedBonus, 833.33));
  close(finance.months[11].fixedBonus, 833.38);
  finance.months.forEach((month, index) => close(month.variableBonus, index === 6 ? 36000 : 0));
  close(finance.months[6].gross, 46833.33);
  close(finance.annual.fixedBonus, 10000.01);
  close(finance.annual.variableBonus, 36000);
  close(finance.annual.gross, 166000.01);
  // 合并税：应税所得79000.01，×10%-2520=5380.00；缴费全年27000。
  close(finance.annual.tax, 5380);
  close(finance.annual.savings, 85620.01);
  let cash = 0;
  finance.months.forEach((month, index) => {
    cash += month.savings;
    close(at(result, index + 1).cash, cash);
  });
  close(at(result, 12).cash, 85620.01);
  close(at(result, 12).fundTotal, 28800);
});

test('A按月固定加9月浮动、B集中在2月，两人设置各自生效并汇总到同一进度', () => {
  const state = incomeState('couple');
  Object.assign(state.people[0], { fixedBonus: 12000, fixedBonusPayout: 'monthly',
    variableBonus: 6000, bonusMonth: 9, bonusMethod: 'combined' });
  Object.assign(state.people[1], { fixedBonus: 8000, fixedBonusPayout: 'annual',
    variableBonus: 12000, bonusMonth: 2, bonusMethod: 'combined' });
  const { finance, result } = calculate(state);
  const [a, b] = finance.people;
  a.months.forEach((month, index) => {
    close(month.fixedBonus, 1000);
    close(month.variableBonus, index === 8 ? 6000 : 0);
  });
  b.months.forEach((month, index) => {
    close(month.fixedBonus, index === 1 ? 8000 : 0);
    close(month.variableBonus, index === 1 ? 12000 : 0);
  });
  close(finance.months[1].gross, 39000);
  close(finance.months[8].gross, 25000);
  close(finance.annual.gross, 254000);
  close(finance.annual.fixedBonus, 20000);
  close(finance.annual.variableBonus, 18000);
  close(a.annual.net, 108420);
  close(b.annual.net, 93368);
  close(finance.annual.savings, 153788);
  close(at(result, 12).cash, 153788);
  close(at(result, 12).fundTotal, 51840);
});

test('只改共用发奖月份可改变首付足额时间，按月固定金额与公积金均不变', () => {
  const state = incomeState();
  Object.assign(state.people[0], { fixedBonus: 12000, fixedBonusPayout: 'monthly',
    variableBonus: 12000, bonusMonth: 1, bonusMethod: 'combined' });
  const plan = Object.assign(purchasePlan(), { housePrice: 100000 });
  const early = calculate(state, plan);
  state.people[0].bonusMonth = 12;
  const late = calculate(state, plan);
  assert.equal(early.result.purchase.monthsToReady, 2);
  assert.equal(late.result.purchase.monthsToReady, 5);
  close(early.finance.annual.savings, 65820);
  close(late.finance.annual.savings, 65820);
  close(at(early.result, 1).cash, 16277.5);
  close(at(late.result, 1).cash, 4637.5);
  for (let month = 1; month <= 12; month += 1) {
    close(early.finance.months[month - 1].fixedBonus, 1000);
    close(late.finance.months[month - 1].fixedBonus, 1000);
    close(at(early.result, month).fundTotal, at(late.result, month).fundTotal);
  }
  close(at(early.result, 12).fundTotal, 28800);
  close(at(late.result, 12).fundTotal, 28800);
});

test('旧v2收入无固定发放方式时仍在原bonusMonth集中发，不改变旧入账语义', () => {
  const state = incomeState();
  delete state.people[0].fixedBonusPayout;
  Object.assign(state.people[0], { fixedBonus: 12000, variableBonus: 6000,
    bonusMonth: 9, bonusMethod: 'combined' });
  const before = JSON.stringify(state);
  assert.equal(E.normalizeState(state).people[0].fixedBonusPayout, 'annual');
  const { finance, result } = calculate(state);
  finance.months.forEach((month, index) => {
    close(month.fixedBonus, index === 8 ? 12000 : 0);
    close(month.variableBonus, index === 8 ? 6000 : 0);
  });
  close(finance.annual.savings, 60420);
  close(at(result, 9).cash - at(result, 8).cash, finance.months[8].savings);
  close(at(result, 12).cash, 60420);
  close(at(result, 12).fundTotal, 28800);
  assert.equal(JSON.stringify(state), before);
});

console.log(`\n${passed} 项收入与存钱进度联动测试全部通过。`);
