'use strict';

// Fixed, independently calculated examples; no dependencies or live policy calls.
const assert = require('node:assert/strict');
const M = require('../mortgage.js');
let passed = 0;
function test(name, run) {
  try { run(); passed++; console.log('✓ ' + name); }
  catch (error) { console.error('✗ ' + name); throw error; }
}
function close(actual, expected, label = '') {
  assert.ok(Number.isFinite(actual), label + ': expected a finite number');
  assert.ok(Math.abs(actual - expected) < .011, label + ': expected ' + expected + ', got ' + actual);
}
function context(net = 10000, expenses = 0) {
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1, net, expenses, savings: net - expenses, fundAdded: 1400
  }));
  return { currentYear: 2026, currentMonth: 1, rentByMonth: Array(12).fill(0), months,
    annual: { net: net * 12, expenses: expenses * 12, savings: (net - expenses) * 12, fundAdded: 16800 },
    people: [{ id: 'a', annual: { fundPersonal: 8400, fundEmployer: 8400, supplementPersonal: 0, supplementEmployer: 0 },
      months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, fundPersonal: 700, fundEmployer: 700,
        supplementPersonal: 0, supplementEmployer: 0, fundBase: 10000 })) }] };
}
function coupleContext() {
  const c = context(20000, 0);
  const b = JSON.parse(JSON.stringify(c.people[0])); b.id = 'b'; c.people.push(b);
  c.months.forEach(m => { m.fundAdded = 2800; });
  return c;
}
function plan() {
  return Object.assign(M.defaultPlan(), {
    housePrice: 1000000, downPaymentPercent: 20, loanType: 'commercial', years: 30,
    commercialRate: 3, fundRate: 2.6, initialCash: 0, reserveCash: 0, purchaseCosts: 0,
    monthlyRentToReplace: 0, otherMonthlyHousingCost: 0, postPurchaseExpenseAdjustment: 0,
    continuousContributions: true,
    linkages: { rent: 'manual', fundAllocation: 'manual', supplementEligibility: 'manual', balanceSource: 'manual' }
  });
}

test('默认计划可严格归一化，计算不修改原计划或收入结果', () => {
  const p = M.defaultPlan(), c = context(20000, 10000);
  const before = JSON.stringify({ p, c });
  const result = M.calculate(M.normalizePlan(p), c);
  assert.equal(JSON.stringify({ p, c }), before);
  assert.equal(result.loans.schedule.length, 360);
  assert.equal(result.loans.annual.length, 30);
});
test('首付现金目标包括首付、一次性费用和保留备用金', () => {
  const p = Object.assign(plan(), { housePrice: 100000, downPaymentPercent: 30,
    purchaseCosts: 5000, reserveCash: 10000, initialCash: 15000 });
  const r = M.calculate(p, context());
  close(r.purchase.downPayment, 30000);
  close(r.purchase.cashNeeded, 45000);
  close(r.purchase.cashGap, 30000);
  assert.equal(r.purchase.monthsToReady, 3);
  assert.equal(r.purchase.readyMonth, '2026-04');
  assert.equal(r.purchase.readyDate, '2026-04-30');
  assert.equal(r.purchase.firstPaymentMonth, '2026-05');
});
test('已备足现金时当下可达，首期还款从购房后下一月开始', () => {
  const p = Object.assign(plan(), { initialCash: 200000 });
  const r = M.calculate(p, context());
  assert.equal(r.purchase.monthsToReady, 0);
  assert.equal(r.purchase.readyMonth, '2026-01');
  assert.equal(r.purchase.firstPaymentMonth, '2026-02');
  assert.equal(r.postPurchase.months[0].yearMonth, '2026-02');
});
test('从下个完整月逐月重复奖金现金流，不把本月收入提前计入', () => {
  const c = context(0, 0);
  c.currentMonth = 11;
  c.months[10].net = c.months[10].savings = 100;
  c.months[11].net = c.months[11].savings = 900;
  const p = Object.assign(plan(), { housePrice: 1000, downPaymentPercent: 100 });
  const r = M.calculate(p, c);
  assert.equal(r.purchase.monthsToReady, 12);
  assert.equal(r.purchase.readyMonth, '2027-11');
  assert.equal(r.purchase.firstPaymentMonth, '2027-12');
  close(r.purchase.timeline[1].cash, 900);
  close(r.purchase.timeline[2].cash, 900);
});
test('负储蓄保留，600个月内不可达时明确返回null和原因', () => {
  const p = Object.assign(plan(), { housePrice: 10000 });
  const r = M.calculate(p, context(0, 100));
  assert.equal(r.purchase.reachable, false);
  assert.equal(r.purchase.monthsToReady, null);
  assert.equal(r.purchase.readyDate, null);
  assert.equal(r.purchase.timeline.length, 601);
  assert.ok(r.purchase.reason.includes('600'));
});
test('公积金余额不加入现金首付，即使账户金额足以覆盖房价', () => {
  const p = Object.assign(plan(), { housePrice: 10000,
    currentBasicBalanceA: 10000000, currentSupplementBalanceA: 10000000 });
  const r = M.calculate(p, context(0, 0));
  assert.equal(r.purchase.reachable, false);
  close(r.purchase.availableCash, 0);
  close(r.purchase.cashNeeded, 2000);
});
test('等额本金1200元12期年利率12%：首112末101、利息78', () => {
  const p = Object.assign(plan(), { housePrice: 1200, downPaymentPercent: 0,
    years: 1, commercialRate: 12, repayment: 'principal' });
  const result = M.calculate(p, context());
  const loan = result.loans;
  close(loan.firstMonthlyPayment, 112);
  close(loan.lastMonthlyPayment, 101);
  close(loan.totalInterest, 78);
  close(loan.totalPayment, 1278);
  close(loan.schedule[11].balance, 0);
  for (let i = 1; i < 12; i++) assert.ok(loan.schedule[i].payment < loan.schedule[i - 1].payment);
});
test('等额本息1200元12期12%首期106.62，本金总额1200且期末清零', () => {
  const p = Object.assign(plan(), { housePrice: 1200, downPaymentPercent: 0,
    years: 1, commercialRate: 12, repayment: 'annuity' });
  const loan = M.calculate(p, context()).loans;
  close(loan.firstMonthlyPayment, 106.62);
  close(loan.schedule.reduce((sum, m) => sum + m.principal, 0), 1200);
  close(loan.schedule[11].balance, 0);
  close(loan.totalPayment, loan.totalPrincipal + loan.totalInterest);
});
test('零利率不除以零，1200元12期每期100元', () => {
  for (const repayment of ['annuity', 'principal']) {
    const p = Object.assign(plan(), { housePrice: 1200, downPaymentPercent: 0,
      years: 1, commercialRate: 0, repayment });
    const loan = M.calculate(p, context()).loans;
    close(loan.totalInterest, 0);
    loan.schedule.forEach(m => close(m.payment, 100));
    close(loan.schedule[11].balance, 0);
  }
});
test('100%首付时贷款为0，所有还款表数值仍有限', () => {
  const p = Object.assign(plan(), { downPaymentPercent: 100, initialCash: 1000000 });
  const loan = M.calculate(p, context()).loans;
  close(loan.totalPrincipal, 0);
  close(loan.totalInterest, 0);
  loan.schedule.forEach(m => close(m.payment + m.interest + m.principal + m.balance, 0));
});
test('组合贷两笔分别计息后相加：960商贷加240公积金本金，两年总利息120', () => {
  const p = Object.assign(plan(), { housePrice: 1500, downPaymentPercent: 20,
    years: 2, repayment: 'principal', loanType: 'mixed', fundLoanRequested: 240,
    commercialRate: 12, fundRate: 0, currentBasicBalanceA: 10000 });
  const loan = M.calculate(p, context()).loans;
  close(loan.fundPrincipal, 240);
  close(loan.commercialPrincipal, 960);
  close(loan.firstMonthlyPayment, 59.6);
  close(loan.lastMonthlyPayment, 50.4);
  close(loan.totalInterest, 120);
  close(loan.totalPayment, 1320);
  loan.schedule.forEach(m => {
    close(m.payment, m.commercialPayment + m.fundPayment);
    close(m.balance, m.commercialBalance + m.fundBalance);
  });
});
test('含公积金的1年期禁止套用月分期，商贷1年数学预算仍可计算', () => {
  for (const loanType of ['fund', 'mixed']) {
    const p = Object.assign(plan(), { years: 1, loanType });
    assert.throws(() => M.normalizePlan(p), /一年期.*到期一次还本付息/);
    p.years = 2;
    assert.equal(M.calculate(p, context()).loans.schedule.length, 24);
  }
  assert.equal(M.calculate(Object.assign(plan(), { years: 1 }), context()).loans.schedule.length, 12);
});
test('基本余额×30加补充余额×10，分别受基础与补充上限约束', () => {
  const p = Object.assign(plan(), { housePrice: 3000000, initialCash: 600000,
    currentBasicBalanceA: 50000, currentSupplementBalanceA: 30000, supplementEligibleA: true });
  const estimate = M.calculate(p, context()).fundEstimate.current;
  close(estimate.basicBalanceBased, 1500000);
  close(estimate.supplementBalanceBased, 300000);
  close(estimate.basicLoanCap, 1000000);
  close(estimate.supplementLoanCap, 200000);
  close(estimate.estimatedLoan, 1200000);
});
test('家庭额度需主动选joint且按基本200万、补充最多40万计算', () => {
  const p = Object.assign(plan(), { housePrice: 5000000, borrowerMode: 'joint',
    initialCash: 1000000, currentBasicBalanceA: 50000, currentBasicBalanceB: 50000,
    currentSupplementBalanceA: 30000, currentSupplementBalanceB: 30000,
    supplementEligibleA: true, supplementEligibleB: true });
  p.manualCaps.monthlyIncomeBase = 50000;
  const r = M.calculate(p, coupleContext());
  close(r.fundEstimate.current.estimatedLoan, 2400000);
  assert.ok(r.warnings.some(x => x.includes('未婚情侣')));
  p.borrowerMode = 'single';
  close(M.calculate(p, coupleContext()).fundEstimate.current.estimatedLoan, 1200000);
});
test('历史补充余额不能自动取得增额资格，确认人数才影响补充上限', () => {
  const p = Object.assign(plan(), { housePrice: 5000000, initialCash: 1000000,
    borrowerMode: 'joint', currentBasicBalanceA: 100000, currentBasicBalanceB: 100000,
    currentSupplementBalanceA: 100000, currentSupplementBalanceB: 100000 });
  p.manualCaps.monthlyIncomeBase = 50000;
  const unknown = M.calculate(p, coupleContext()).fundEstimate.current;
  close(unknown.supplementBalanceBased, 2000000);
  close(unknown.supplementLoanCap, 0);
  close(unknown.estimatedLoan, 2000000);
  p.manualCaps.supplementLoanCap = 400000;
  close(M.calculate(p, coupleContext()).fundEstimate.current.supplementLoanCap, 0);
  p.manualCaps.supplementLoanCap = null;
  p.supplementEligibleA = true;
  const one = M.calculate(p, coupleContext()).fundEstimate.current;
  close(one.supplementLoanCap, 200000);
  close(one.estimatedLoan, 2200000);
});
test('二套外环外等已核地区可独立覆写商贷最低首付15%，不误报普通区25%', () => {
  const p = Object.assign(plan(), { firstHome: false, downPaymentPercent: 15,
    loanType: 'commercial', initialCash: 150000 });
  assert.equal(M.calculate(p, context()).loans.policyCompatible, false);
  p.manualCaps.commercialMinDownPaymentPercent = 15;
  const loan = M.calculate(p, context()).loans;
  assert.equal(loan.policyCompatible, true);
  close(loan.minimumDownPaymentPercent, 15);
  close(loan.downPaymentPolicyGap, 0);
});
test('组合贷同时满足商贷和公积金首付条件，不能仅绕过其中一个', () => {
  const p = Object.assign(plan(), { firstHome: false, downPaymentPercent: 20,
    loanType: 'mixed', initialCash: 200000 });
  p.manualCaps.maxLoanToValuePercent = 80;
  close(M.calculate(p, context()).loans.minimumDownPaymentPercent, 25);
  p.manualCaps.commercialMinDownPaymentPercent = 15;
  close(M.calculate(p, context()).loans.minimumDownPaymentPercent, 20);
});
test('旧草稿缺少新资格及地区参数时保守兼容，不凭空确认资格', () => {
  const old = plan();
  delete old.supplementEligibleA;
  delete old.supplementEligibleB;
  delete old.manualCaps.commercialMinDownPaymentPercent;
  const normalized = M.normalizePlan(old);
  assert.equal(normalized.supplementEligibleA, false);
  assert.equal(normalized.supplementEligibleB, false);
  assert.equal(normalized.manualCaps.commercialMinDownPaymentPercent, null);
});
test('还本能力按工资基数×40%×期数约束本金，不能当作月供40%', () => {
  const p = Object.assign(plan(), { housePrice: 3000000, years: 1,
    initialCash: 600000, currentBasicBalanceA: 100000 });
  p.manualCaps.monthlyIncomeBase = 10000;
  const estimate = M.calculate(p, context()).fundEstimate.current;
  close(estimate.repaymentCapacityLimit, 48000);
  close(estimate.estimatedLoan, 48000);
});
test('房价贷款成数、首付后剩余价款均限制公积金可贷预算', () => {
  const p = Object.assign(plan(), { housePrice: 100000, downPaymentPercent: 0,
    initialCash: 0, currentBasicBalanceA: 100000 });
  close(M.calculate(p, context()).fundEstimate.current.estimatedLoan, 80000);
  p.downPaymentPercent = 50;
  close(M.calculate(p, context()).fundEstimate.current.estimatedLoan, 50000);
});
test('未来账户只增加预计入账，现金收入与公积金增量互相独立', () => {
  const p = Object.assign(plan(), { housePrice: 100000, downPaymentPercent: 20 });
  const r = M.calculate(p, context());
  assert.equal(r.purchase.monthsToReady, 2);
  close(r.fundEstimate.current.basicBalance, 0);
  close(r.fundEstimate.atPurchase.basicBalance, 2800);
  close(r.fundEstimate.atPurchase.estimatedLoan, 80000);
});
test('明确不满足连续缴存时公积金可贷预算0，纯公积金显示缺口', () => {
  const p = Object.assign(plan(), { housePrice: 100000, loanType: 'fund', initialCash: 20000,
    currentBasicBalanceA: 100000, continuousContributions: false });
  const r = M.calculate(p, context());
  close(r.fundEstimate.current.estimatedLoan, 0);
  close(r.loans.financingGap, 80000);
  assert.equal(r.purchase.financingReady, false);
});
test('公积金贷款不足时组合贷差额按商贷，不会超过剩余房款', () => {
  const p = Object.assign(plan(), { housePrice: 100000, loanType: 'mixed',
    initialCash: 20000, currentBasicBalanceA: 1000, fundLoanRequested: 200000 });
  const loan = M.calculate(p, context()).loans;
  close(loan.fundPrincipal, 30000);
  close(loan.commercialPrincipal, 50000);
  close(loan.totalPrincipal, 80000);
  close(loan.financingGap, 0);
});
test('买后现金不重复扣个人公积金，原到手减开支加替代房租再减月供与新费用', () => {
  const p = Object.assign(plan(), { housePrice: 10000, downPaymentPercent: 100,
    initialCash: 10000, monthlyRentToReplace: 1000, otherMonthlyHousingCost: 300,
    postPurchaseExpenseAdjustment: 200 });
  const r = M.calculate(p, context(10000, 2000));
  close(r.postPurchase.months[0].savings, 8500);
  close(r.postPurchase.annualSavings, 102000);
  close(r.postPurchase.months[0].fundAdded, 1400);
});
test('手动替代房租超预算时暂停买后结余，但保留现金和公积金进度', () => {
  const p = Object.assign(plan(), { housePrice: 10000, downPaymentPercent: 100,
    initialCash: 10000, monthlyRentToReplace: 2100 });
  const c = context(10000, 2000);
  const before = JSON.stringify({ p, c });
  const invalid = M.calculate(p, c);
  assert.match(invalid.postPurchase.error, /替代房租或减少开支超过当前生活预算，请调整买后开支/);
  assert.equal(invalid.postPurchase.annualSavings, null);
  assert.ok(invalid.projectedTimeline.length > 0);
  assert.equal(JSON.stringify({ p, c }), before);
  // Only one month is short: checking an average would miss this invalid budget.
  p.monthlyRentToReplace = 1900;
  c.months[6].expenses = 1800;
  c.months[6].savings = 8200;
  assert.match(M.calculate(p, c).postPurchase.error, /替代房租或减少开支超过当前生活预算/);
});
test('负支出调整也不能超预算，恰好降到0元生活开支仍合法', () => {
  const p = Object.assign(plan(), { housePrice: 10000, downPaymentPercent: 100,
    initialCash: 10000, monthlyRentToReplace: 1000, postPurchaseExpenseAdjustment: -1001 });
  assert.match(M.calculate(p, context(10000, 2000)).postPurchase.error, /替代房租或减少开支超过当前生活预算/);
  p.postPurchaseExpenseAdjustment = -1000;
  const r = M.calculate(p, context(10000, 2000));
  close(r.postPurchase.months[0].expenses, 0);
  close(r.postPurchase.months[0].savings, 10000);
});
test('手填核定上限优先于政策参考参数，且计划导入不改数值', () => {
  const p = Object.assign(plan(), { housePrice: 3000000, initialCash: 600000,
    currentBasicBalanceA: 100000 });
  p.manualCaps.basicLoanCap = 123456;
  const normalized = M.normalizePlan(p);
  close(normalized.manualCaps.basicLoanCap, 123456);
  close(M.calculate(p, context()).fundEstimate.current.estimatedLoan, 123456);
});
test('非法计划拒绝NaN、负金额、超过30年的年限、非法利率和未知字段', () => {
  for (const patch of [{ housePrice: 0 }, { initialCash: -1 }, { commercialRate: NaN },
    { commercialRate: -1 }, { fundRate: 31 }, { years: 31 }, { downPaymentPercent: 101 },
    { continuousContributions: 'yes' }, { unknown: 1 }]) {
    assert.throws(() => M.normalizePlan(Object.assign(plan(), patch)));
  }
  const p = plan(); p.manualCaps.unknown = 0;
  assert.throws(() => M.normalizePlan(p));
});
test('非法现金流拒绝缺月份、重复月份、NaN和收支不平', () => {
  const a = context(); a.months.pop();
  assert.throws(() => M.calculate(plan(), a));
  const b = context(); b.months[1].month = 1;
  assert.throws(() => M.calculate(plan(), b));
  const c = context(); c.months[0].net = NaN;
  assert.throws(() => M.calculate(plan(), c));
  const d = context(); d.months[0].savings = 99999;
  assert.throws(() => M.calculate(plan(), d));
});
test('不同还款方式与利率的本金、利息、年表和月表逐项守恒', () => {
  for (const repayment of ['annuity', 'principal']) for (const rate of [0, .01, 2.6, 30]) {
    const p = Object.assign(plan(), { housePrice: 1234567.89, downPaymentPercent: 30,
      initialCash: 1000000, repayment, commercialRate: rate, years: 30 });
    const loan = M.calculate(p, context()).loans;
    close(loan.schedule.reduce((sum, m) => sum + m.principal, 0), loan.totalPrincipal);
    close(loan.schedule.reduce((sum, m) => sum + m.interest, 0), loan.totalInterest);
    close(loan.annual.reduce((sum, y) => sum + y.payment, 0), loan.totalPayment);
    close(loan.totalPayment, loan.totalPrincipal + loan.totalInterest);
    close(loan.schedule.at(-1).balance, 0);
    assert.ok(loan.totalPrincipal <= p.housePrice);
  }
});

test('v2新计划默认仅准备三项主数据，余额、费用和备用金从0且自动联动', () => {
  const p = M.defaultPlan();
  assert.equal(p.version, 2);
  for (const key of ['initialCash', 'reserveCash', 'purchaseCosts', 'otherMonthlyHousingCost',
    'currentBasicBalanceA', 'currentBasicBalanceB', 'currentSupplementBalanceA', 'currentSupplementBalanceB', 'fundLoanRequested']) close(p[key], 0);
  assert.equal(p.borrowerMode, 'single');
  assert.deepEqual(p.linkages, { rent: 'budget', fundAllocation: 'auto', supplementEligibility: 'linked', balanceSource: 'zero' });
});
test('v1已填现金、余额、房租、请求额度及资格迁移到manual，不丢原值', () => {
  const old = Object.assign(plan(), { version: 1, initialCash: 300000, currentBasicBalanceA: 12345,
    currentBasicBalanceB: 6789, currentSupplementBalanceA: 1111, monthlyRentToReplace: 4567,
    fundLoanRequested: 765432, supplementEligibleA: true });
  delete old.linkages;
  const before = JSON.stringify(old), p = M.normalizePlan(old);
  assert.equal(p.version, 2);
  assert.deepEqual(p.linkages, { rent: 'manual', fundAllocation: 'manual', supplementEligibility: 'manual', balanceSource: 'manual' });
  for (const key of ['initialCash', 'currentBasicBalanceA', 'currentBasicBalanceB', 'currentSupplementBalanceA',
    'monthlyRentToReplace', 'fundLoanRequested', 'supplementEligibleA']) assert.equal(p[key], old[key]);
  assert.equal(JSON.stringify(old), before);
});
test('自动模式从0同步积累现金及双边基本补充，自动组合贷不受旧请求金额影响', () => {
  const p = Object.assign(M.defaultPlan(), { housePrice: 100000, downPaymentPercent: 20,
    currentBasicBalanceA: 99999, currentSupplementBalanceA: 99999, fundLoanRequested: 1 });
  const c = context(10000, 2000);
  c.people[0].annual.supplementPersonal = c.people[0].annual.supplementEmployer = 3600;
  c.people[0].months.forEach(m => { m.supplementPersonal = m.supplementEmployer = 300; });
  c.months.forEach(m => { m.fundAdded = 2000; });
  const r = M.calculate(p, c), first = r.projectedTimeline[1];
  close(r.projectedTimeline[0].cash, 0);
  close(r.projectedTimeline[0].fundTotal, 0);
  assert.equal(first.yearMonth, '2026-02');
  close(first.cash, 8000);
  close(first.basicFund, 1400);
  close(first.supplementFund, 600);
  close(first.fundTotal, 2000);
  close(first.estimatedFundLoan, 48000);
  assert.equal(r.purchase.monthsToReady, 3);
  close(r.loans.fundPrincipal, 80000);
  close(r.loans.commercialPrincipal, 0);
  assert.equal(r.effective.supplementEligibleA, true);
  assert.equal(r.effective.continuousContributions, null);
  close(p.currentBasicBalanceA, 99999);
});
test('双人都攒公积金，默认单人借款只用A账户；选合资格joint才合用', () => {
  const p = Object.assign(M.defaultPlan(), { housePrice: 1000000 });
  const c = coupleContext();
  const single = M.calculate(p, c).projectedTimeline[1];
  close(single.householdFundTotal, 2800);
  close(single.fundTotal, 2800);
  close(single.borrowerFundTotal, 1400);
  close(single.estimatedFundLoan, 42000);
  p.borrowerMode = 'joint';
  const joint = M.calculate(p, c).projectedTimeline[1];
  close(joint.householdFundTotal, 2800);
  close(joint.borrowerFundTotal, 2800);
  close(joint.estimatedFundLoan, 84000);
});
test('全局单人时保留旧joint选择但有效按single，不使用B历史余额与双人上限', () => {
  const p = Object.assign(plan(), { borrowerMode: 'joint', currentBasicBalanceA: 1000,
    currentBasicBalanceB: 999999, currentSupplementBalanceB: 999999, supplementEligibleB: true });
  const r = M.calculate(p, context());
  assert.equal(p.borrowerMode, 'joint');
  assert.equal(r.effective.borrowerMode, 'single');
  close(r.fundEstimate.current.basicLoanCap, 1000000);
  close(r.projectedTimeline[0].householdFundTotal, 1000);
  close(r.projectedTimeline[0].borrowerFundTotal, 1000);
  close(r.fundEstimate.current.estimatedLoan, 30000);
  assert.ok(r.warnings.some(w => w.includes('双人设置仍保留')));
});
test('自动房租读取预算逐月值，年度支付不摊平，单人忽略B专属租金', () => {
  const p = Object.assign(M.defaultPlan(), { housePrice: 10000, downPaymentPercent: 100, initialCash: 10000 });
  const c = context(10000, 5000);
  delete c.rentByMonth;
  c.state = { expenses: [
    { category: 'rent', owner: 'shared', amount: 3000, frequency: 'monthly', month: 12 },
    { category: 'rent', owner: 'a', amount: 1000, frequency: 'monthly', month: 12 },
    { category: 'rent', owner: 'b', amount: 9000, frequency: 'monthly', month: 12 },
    { category: 'rent', owner: 'shared', amount: 1200, frequency: 'annual', month: 7 }
  ] };
  c.months[6].expenses = 6200; c.months[6].savings = 3800;
  const r = M.calculate(p, c);
  close(r.effective.rentByMonth[0], 4000);
  close(r.effective.rentByMonth[6], 5200);
  r.postPurchase.months.forEach(m => close(m.expenses, 1000));
  close(r.postPurchase.annualSavings, 108000);
});
test('切回高级余额模式恢复原已填余额，不被从0联动覆盖', () => {
  const p = Object.assign(M.defaultPlan(), { currentBasicBalanceA: 12345, currentSupplementBalanceA: 6789 });
  close(M.calculate(p, context()).projectedTimeline[0].fundTotal, 0);
  p.linkages.balanceSource = 'manual';
  close(M.calculate(p, context()).projectedTimeline[0].fundTotal, 19134);
  close(p.currentBasicBalanceA, 12345);
  close(p.currentSupplementBalanceA, 6789);
});
test('年度一次旅行可产生紧张月份，但不能否决正常月供可承受的考虑时点', () => {
  const p = Object.assign(M.defaultPlan(), { housePrice: 10000, downPaymentPercent: 100, initialCash: 10000 });
  const c = context(10000, 1000);
  c.months[6].expenses = 100000; c.months[6].savings = -90000;
  const r = M.calculate(p, c);
  assert.equal(r.consideration.monthsToReady, 0);
  close(r.consideration.postRegularSavings, 9000);
  close(r.postPurchase.worstMonthlySavings, -90000);
  assert.ok(r.warnings.some(w => w.includes('最紧张月份')));
  assert.match(r.consideration.criteria, /不是贷款审批/);
});
test('CPF继续积累后才可承担月供，详细贷款与买后预算使用较晚考虑时点', () => {
  const p = Object.assign(M.defaultPlan(), { housePrice: 120000, downPaymentPercent: 20, initialCash: 24000,
    years: 2, commercialRate: 12, fundRate: 0 });
  const c = context(4100, 0);
  c.people[0].annual.fundPersonal = c.people[0].annual.fundEmployer = 600;
  c.people[0].months.forEach(m => { m.fundPersonal = m.fundEmployer = 50; });
  c.months.forEach(m => { m.fundAdded = 100; });
  const r = M.calculate(p, c);
  assert.equal(r.purchase.monthsToReady, 0);
  assert.equal(r.consideration.monthsToReady, 26);
  assert.equal(r.consideration.yearMonth, '2028-03');
  assert.equal(r.consideration.readyDate, '2028-03-31');
  close(r.projectedTimeline[25].postRegularSavings, -13.54);
  close(r.consideration.payment, 4097.32);
  close(r.consideration.postRegularSavings, 2.68);
  close(r.fundEstimate.atPurchase.estimatedLoan, 0);
  close(r.fundEstimate.atConsideration.estimatedLoan, 78000);
  close(r.loans.fundPrincipal, 78000);
  close(r.loans.commercialPrincipal, 18000);
  close(r.loans.firstMonthlyPayment, r.consideration.payment);
  assert.equal(r.loans.estimateAtMonth, '2028-03');
  assert.equal(r.purchase.plannedPurchaseMonth, '2028-03');
  assert.equal(r.purchase.firstPaymentMonth, '2028-04');
  assert.equal(r.postPurchase.months[0].yearMonth, '2028-04');
});
test('v2联动字段严格校验，逐月房租拒绝缺项和非数值', () => {
  const p = M.defaultPlan();
  delete p.linkages;
  assert.throws(() => M.normalizePlan(p));
  const bad = M.defaultPlan(); bad.linkages.rent = 'guess';
  assert.throws(() => M.normalizePlan(bad));
  const c = context(); c.rentByMonth = [0];
  assert.throws(() => M.calculate(M.defaultPlan(), c));
  c.rentByMonth = Array(12).fill(0); c.rentByMonth[0] = NaN;
  assert.throws(() => M.calculate(M.defaultPlan(), c));
});

console.log('\n' + passed + ' 项房贷测试全部通过。');
