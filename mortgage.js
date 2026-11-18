(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CoWalletMortgage = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var PLAN_KEYS = ['version', 'housePrice', 'downPaymentPercent', 'loanType', 'repayment', 'years',
    'commercialRate', 'fundRate', 'fundLoanRequested', 'initialCash', 'reserveCash', 'purchaseCosts',
    'monthlyRentToReplace', 'otherMonthlyHousingCost', 'postPurchaseExpenseAdjustment',
    'currentBasicBalanceA', 'currentBasicBalanceB', 'currentSupplementBalanceA', 'currentSupplementBalanceB',
    'borrowerMode', 'firstHome', 'continuousContributions', 'supplementEligibleA', 'supplementEligibleB', 'manualCaps'];
  var LINK_KEYS = ['rent', 'fundAllocation', 'supplementEligibility', 'balanceSource'];
  var CAP_KEYS = ['basicMultiplier', 'supplementMultiplier', 'basicLoanCap', 'supplementLoanCap',
    'maxLoanToValuePercent', 'repaymentCapacityPercent', 'monthlyIncomeBase', 'commercialMinDownPaymentPercent'];
  var SOURCES = [
    { label: '上海公积金个人购房贷款办事指南', url: 'https://www.shzfgjj.cn/html/newxxgk/ywzn/sydk/dksq/209124.html' },
    { label: '2026 年上海公积金贷款额度调整', url: 'https://www.shzfgjj.cn/html/newxxgk/zcwj/gfxwj/228288.html' },
    { label: '上海公积金贷款现行利率', url: 'https://www.shzfgjj.cn/html/newxxgk/zcwj/gjjgwh/albpl/dk/227927.html' },
    { label: '2026 年上海商业住房贷款首付政策', url: 'https://zjw.sh.gov.cn/gzdt/20260820/f9fe8de695fa466cb6540c8e3dda5f7b.html' }
  ];

  function cents(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function fail(message) { throw new Error(message); }
  function own(o, key) { return Object.prototype.hasOwnProperty.call(o, key); }
  function plain(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(label + '必须是普通对象。');
  }
  function whitelist(value, allowed, label, optional) {
    plain(value, label);
    Object.keys(value).forEach(function (key) { if (allowed.indexOf(key) < 0) fail(label + '包含未知字段：' + key); });
    allowed.forEach(function (key) { if (!own(value, key) && (!optional || optional.indexOf(key) < 0)) fail(label + '缺少字段：' + key); });
  }
  function num(value, label, min, max, integer) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      fail(label + '必须是 ' + min + '–' + max + ' 范围内的' + (integer ? '整数' : '数值') + '。');
    }
    return value;
  }
  function maybeNumber(value, label, min, max) { return value === null ? null : num(value, label, min, max); }
  function choice(value, allowed, label) {
    if (allowed.indexOf(value) < 0) fail(label + '取值无效。');
    return value;
  }

  // Illustrative purchase budget. Commercial interest is an editable assumption,
  // not a bank quotation. Null manual caps select the documented ordinary case.
  function defaultPlan() {
    return {
      version: 2, housePrice: 3000000, downPaymentPercent: 30, loanType: 'mixed',
      repayment: 'annuity', years: 30, commercialRate: 3, fundRate: 2.6,
      fundLoanRequested: 0, initialCash: 0, reserveCash: 0, purchaseCosts: 0,
      monthlyRentToReplace: 0, otherMonthlyHousingCost: 0, postPurchaseExpenseAdjustment: 0,
      currentBasicBalanceA: 0, currentBasicBalanceB: 0, currentSupplementBalanceA: 0, currentSupplementBalanceB: 0,
      borrowerMode: 'single', firstHome: true, continuousContributions: null,
      supplementEligibleA: false, supplementEligibleB: false,
      linkages: { rent: 'budget', fundAllocation: 'auto', supplementEligibility: 'linked', balanceSource: 'zero' },
      manualCaps: {
        basicMultiplier: 30, supplementMultiplier: 10, basicLoanCap: null, supplementLoanCap: null,
        maxLoanToValuePercent: null, repaymentCapacityPercent: 40, monthlyIncomeBase: null,
        commercialMinDownPaymentPercent: null
      }
    };
  }
  function normalizePlan(raw) {
    plain(raw, '购房计划');
    if (raw.version !== 1 && raw.version !== 2) fail('购房计划版本不受支持。');
    whitelist(raw, raw.version === 2 ? PLAN_KEYS.concat(['linkages']) : PLAN_KEYS, '购房计划', ['supplementEligibleA', 'supplementEligibleB']);
    var p = { version: 2 };
    ['housePrice', 'fundLoanRequested', 'initialCash', 'reserveCash', 'purchaseCosts', 'monthlyRentToReplace',
      'otherMonthlyHousingCost', 'currentBasicBalanceA', 'currentBasicBalanceB', 'currentSupplementBalanceA', 'currentSupplementBalanceB'].forEach(function (key) {
      p[key] = num(raw[key], key, 0, 1e10);
    });
    if (p.housePrice <= 0) fail('房价必须大于 0。');
    p.downPaymentPercent = num(raw.downPaymentPercent, '首付比例', 0, 100);
    p.loanType = choice(raw.loanType, ['commercial', 'fund', 'mixed'], '贷款类型');
    p.repayment = choice(raw.repayment, ['annuity', 'principal'], '还款方式');
    p.years = num(raw.years, '贷款年限', 1, 30, true);
    if (p.loanType !== 'commercial' && p.years < 2) fail('含公积金贷款的分期还款预算请选 2–30 年；一年期适用到期一次还本付息，本工具暂未支持。');
    p.commercialRate = num(raw.commercialRate, '商贷年利率', 0, 30);
    p.fundRate = num(raw.fundRate, '公积金年利率', 0, 30);
    p.postPurchaseExpenseAdjustment = num(raw.postPurchaseExpenseAdjustment, '购房后其他支出调整', -1e9, 1e9);
    p.borrowerMode = choice(raw.borrowerMode, ['single', 'joint'], '公积金借款人模式');
    if (typeof raw.firstHome !== 'boolean') fail('首套房标识必须是布尔值。');
    if (raw.continuousContributions !== null && typeof raw.continuousContributions !== 'boolean') fail('连续缴存资格必须是真、假或未知。');
    p.firstHome = raw.firstHome;
    p.continuousContributions = raw.continuousContributions;
    ['supplementEligibleA', 'supplementEligibleB'].forEach(function (key) {
      if (own(raw, key) && typeof raw[key] !== 'boolean') fail('补充公积金贷款资格必须是布尔值。');
      p[key] = own(raw, key) ? raw[key] : false;
    });
    whitelist(raw.manualCaps, CAP_KEYS, '公积金估算参数', ['commercialMinDownPaymentPercent']);
    p.manualCaps = {
      basicMultiplier: num(raw.manualCaps.basicMultiplier, '基本公积金余额倍数', 0, 100),
      supplementMultiplier: num(raw.manualCaps.supplementMultiplier, '补充公积金余额倍数', 0, 100),
      basicLoanCap: maybeNumber(raw.manualCaps.basicLoanCap, '基本公积金贷款上限', 0, 1e10),
      supplementLoanCap: maybeNumber(raw.manualCaps.supplementLoanCap, '补充公积金增额上限', 0, 1e10),
      maxLoanToValuePercent: maybeNumber(raw.manualCaps.maxLoanToValuePercent, '公积金最高贷款成数', 0, 100),
      repaymentCapacityPercent: num(raw.manualCaps.repaymentCapacityPercent, '还本能力比例', 0, 100),
      monthlyIncomeBase: maybeNumber(raw.manualCaps.monthlyIncomeBase, '借款人月缴存工资基数合计', 0, 1e9),
      commercialMinDownPaymentPercent: !own(raw.manualCaps, 'commercialMinDownPaymentPercent') ? null :
        maybeNumber(raw.manualCaps.commercialMinDownPaymentPercent, '商贷最低首付比例', 0, 100)
    };
    if (raw.version === 1) {
      p.linkages = { rent: 'manual', fundAllocation: 'manual', supplementEligibility: 'manual', balanceSource: 'manual' };
    } else {
      whitelist(raw.linkages, LINK_KEYS, '购房联动设置');
      p.linkages = {
        rent: choice(raw.linkages.rent, ['budget', 'manual'], '房租联动'),
        fundAllocation: choice(raw.linkages.fundAllocation, ['auto', 'manual'], '贷款分配联动'),
        supplementEligibility: choice(raw.linkages.supplementEligibility, ['linked', 'manual'], '补充公积金联动'),
        balanceSource: choice(raw.linkages.balanceSource, ['zero', 'manual'], '公积金期初余额来源')
      };
    }
    return p;
  }

  function normalizeContext(raw) {
    plain(raw, '收支测算结果');
    if (!Array.isArray(raw.months) || raw.months.length !== 12) fail('收支测算结果必须提供完整 12 个月明细。');
    var seen = [];
    var months = raw.months.map(function (m) {
      plain(m, '月收支');
      var month = num(m.month, '月份', 1, 12, true);
      if (seen.indexOf(month) >= 0) fail('月收支月份不能重复。');
      seen.push(month);
      var net = num(m.net, '月税后到手', -1e10, 1e10);
      var expenses = num(m.expenses, '月生活开支', 0, 1e10);
      var savings = own(m, 'savings') ? num(m.savings, '月现金结余', -1e10, 1e10) : cents(net - expenses);
      if (Math.abs(cents(net - expenses) - savings) > 0.02) fail('月现金结余与到手减开支不一致。');
      return { month: month, net: cents(net), expenses: cents(expenses), savings: cents(savings),
        gross: own(m, 'gross') ? num(m.gross, '月税前收入', 0, 1e10) : null,
        fundAdded: own(m, 'fundAdded') ? num(m.fundAdded, '月公积金入账', 0, 1e10) : 0 };
    }).sort(function (a, b) { return a.month - b.month; });
    var today = new Date();
    var currentYear = own(raw, 'currentYear') ? num(raw.currentYear, '当前年份', 2019, 9999, true) : today.getFullYear();
    var currentMonth = own(raw, 'currentMonth') ? num(raw.currentMonth, '当前月份', 1, 12, true) : today.getMonth() + 1;
    var people = [];
    if (own(raw, 'people')) {
      if (!Array.isArray(raw.people) || raw.people.length > 2) fail('借款人收支资料必须是最多两人的数组。');
      raw.people.forEach(function (person) {
        plain(person, '个人公积金资料');
        var id = choice(person.id, ['a', 'b'], '人员标识');
        if (people.some(function (p) { return p.id === id; })) fail('人员标识重复。');
        var annual = person.annual || {};
        plain(annual, '个人年度公积金资料');
        function readAnnual(key) { return own(annual, key) ? num(annual[key], key, 0, 1e10) : 0; }
        var basicAnnual = cents(readAnnual('fundPersonal') + readAnnual('fundEmployer'));
        var supplementAnnual = cents(readAnnual('supplementPersonal') + readAnnual('supplementEmployer'));
        var individualMonths = null;
        if (Array.isArray(person.months) && person.months.length === 12) {
          individualMonths = person.months.map(function (m) {
            plain(m, '个人月公积金资料');
            function read(key) { return own(m, key) ? num(m[key], key, 0, 1e10) : 0; }
            return { month: num(m.month, '个人公积金月份', 1, 12, true),
              basic: cents(read('fundPersonal') + read('fundEmployer')),
              supplement: cents(read('supplementPersonal') + read('supplementEmployer')),
              incomeBase: own(m, 'fundBase') ? read('fundBase') : null };
          }).sort(function (a, b) { return a.month - b.month; });
          for (var i = 0; i < 12; i++) if (individualMonths[i].month !== i + 1) fail('个人公积金月份必须完整且不重复。');
        }
        people.push({ id: id, basicAnnual: basicAnnual, supplementAnnual: supplementAnnual, months: individualMonths });
      });
    }
    var rentByMonth = null;
    if (own(raw, 'rentByMonth')) {
      if (!Array.isArray(raw.rentByMonth) || raw.rentByMonth.length !== 12) fail('逐月房租必须是完整 12 项金额数组。');
      rentByMonth = raw.rentByMonth.map(function (amount) { return cents(num(amount, '预算房租', 0, 1e10)); });
    } else if (raw.state && Array.isArray(raw.state.expenses)) {
      rentByMonth = Array(12).fill(0);
      raw.state.expenses.forEach(function (expense) {
        plain(expense, '预算开支');
        if (expense.category !== 'rent' || (expense.owner === 'b' && !people.some(function (person) { return person.id === 'b'; }))) return;
        var amount = num(expense.amount, '房租预算金额', 0, 1e10);
        choice(expense.frequency, ['monthly', 'annual'], '房租预算频率');
        var month = num(expense.month, '房租预算月份', 1, 12, true);
        for (var i = 0; i < 12; i++) if (expense.frequency === 'monthly' || month === i + 1) rentByMonth[i] = cents(rentByMonth[i] + amount);
      });
    }
    return { months: months, people: people, rentByMonth: rentByMonth, currentYear: currentYear, currentMonth: currentMonth,
      annualSavings: cents(months.reduce(function (sum, m) { return sum + m.savings; }, 0)) };
  }

  function calendar(context, offset) {
    var serial = context.currentYear * 12 + context.currentMonth - 1 + offset;
    var year = Math.floor(serial / 12);
    var month = serial % 12 + 1;
    var label = year + '-' + String(month).padStart(2, '0');
    return { year: year, month: month, label: label, date: label + '-01' };
  }
  function projectionDate(context, elapsed) {
    var value = calendar(context, elapsed);
    var today = new Date();
    var day = elapsed === 0 ? (today.getFullYear() === value.year && today.getMonth() + 1 === value.month ? today.getDate() : 1) :
      new Date(value.year, value.month, 0).getDate();
    return value.label + '-' + String(day).padStart(2, '0');
  }
  function selectedPeople(p, context) {
    return context.people.filter(function (person) { return person.id === 'a' || p.borrowerMode === 'joint'; });
  }
  function personAtMonth(person, month) {
    return person.months ? person.months[month - 1] : {
      basic: cents(person.basicAnnual / 12), supplement: cents(person.supplementAnnual / 12), incomeBase: null
    };
  }
  function balancesAt(p, context, elapsedMonths) {
    var manual = p.linkages.balanceSource === 'manual';
    var accounts = {
      a: { basic: manual ? cents(p.currentBasicBalanceA) : 0, supplement: manual ? cents(p.currentSupplementBalanceA) : 0 },
      b: { basic: manual ? cents(p.currentBasicBalanceB) : 0, supplement: manual ? cents(p.currentSupplementBalanceB) : 0 }
    };
    var people = context.people;
    for (var i = 0; i < elapsedMonths; i++) {
      var month = (context.currentMonth + i) % 12 + 1;
      people.forEach(function (person) {
        var entry = personAtMonth(person, month);
        accounts[person.id].basic = cents(accounts[person.id].basic + entry.basic);
        accounts[person.id].supplement = cents(accounts[person.id].supplement + entry.supplement);
      });
    }
    return accounts;
  }
  function fundEstimate(p, context, elapsedMonths, warnings, accountsOverride) {
    var accounts = accountsOverride || balancesAt(p, context, elapsedMonths);
    var borrowers = p.borrowerMode === 'joint' ? ['a', 'b'] : ['a'];
    var people = selectedPeople(p, context);
    var basicBalance = cents(borrowers.reduce(function (sum, id) { return sum + accounts[id].basic; }, 0));
    var supplementBalance = cents(borrowers.reduce(function (sum, id) { return sum + accounts[id].supplement; }, 0));
    var activeIds = context.people.length ? context.people.map(function (person) { return person.id; }) : ['a'];
    var allBasicBalance = cents(activeIds.reduce(function (sum, id) { return sum + accounts[id].basic; }, 0));
    var allSupplementBalance = cents(activeIds.reduce(function (sum, id) { return sum + accounts[id].supplement; }, 0));
    var supplementalCount = borrowers.filter(function (id) {
      return id === 'a' ? p.supplementEligibleA : p.supplementEligibleB;
    }).length;
    if (supplementBalance > 0 && supplementalCount === 0) warnings.add('补充公积金历史余额不等于当前正常缴存及贷款增额资格；未确认资格，普通政策补充增额上限按 0。');
    var autoBasicCap = (p.firstHome ? 1000000 : 800000) * borrowers.length;
    var autoSupplementCap = 200000 * supplementalCount;
    var caps = p.manualCaps;
    var basicCap = caps.basicLoanCap === null ? autoBasicCap : caps.basicLoanCap;
    var supplementCap = supplementalCount === 0 ? 0 :
      caps.supplementLoanCap === null ? autoSupplementCap : caps.supplementLoanCap;
    var ltv = caps.maxLoanToValuePercent === null ? (p.firstHome ? 80 : 75) : caps.maxLoanToValuePercent;
    var baseMonth = calendar(context, elapsedMonths).month;
    var monthlyIncomeBase = caps.monthlyIncomeBase;
    if (monthlyIncomeBase === null && people.length === borrowers.length && people.every(function (person) { return personAtMonth(person, baseMonth).incomeBase !== null; })) {
      monthlyIncomeBase = cents(people.reduce(function (sum, person) { return sum + personAtMonth(person, baseMonth).incomeBase; }, 0));
    }
    var capacityLimit = monthlyIncomeBase === null ? null : cents(monthlyIncomeBase * caps.repaymentCapacityPercent / 100 * p.years * 12);
    if (capacityLimit === null) warnings.add('未提供完整借款人缴存工资基数，还本能力上限暂未纳入公积金可贷估算；请填写参数后复核。');
    var basicBalanceBased = cents(basicBalance * caps.basicMultiplier);
    var supplementBalanceBased = cents(supplementBalance * caps.supplementMultiplier);
    var cappedBasic = Math.min(basicBalanceBased, basicCap);
    var cappedSupplement = Math.min(supplementBalanceBased, supplementCap);
    var loanToValueLimit = cents(p.housePrice * ltv / 100);
    var afterDownPaymentLimit = cents(p.housePrice * (100 - p.downPaymentPercent) / 100);
    var limits = [cappedBasic + cappedSupplement, basicCap + supplementCap, loanToValueLimit, afterDownPaymentLimit];
    if (capacityLimit !== null) limits.push(capacityLimit);
    var estimate = cents(Math.max(0, Math.min.apply(Math, limits)));
    if (p.continuousContributions === false) estimate = 0;
    return { elapsedMonths: elapsedMonths, accounts: accounts, basicBalance: basicBalance,
      allBasicBalance: allBasicBalance, allSupplementBalance: allSupplementBalance,
      householdFundTotal: cents(allBasicBalance + allSupplementBalance),
      borrowerFundTotal: cents(basicBalance + supplementBalance),
      supplementBalance: supplementBalance, basicBalanceBased: basicBalanceBased,
      supplementEligibleCount: supplementalCount,
      supplementBalanceBased: supplementBalanceBased, balanceBased: cents(basicBalanceBased + supplementBalanceBased),
      basicLoanCap: basicCap, supplementLoanCap: supplementCap, policyCap: basicCap + supplementCap,
      loanToValuePercent: ltv, loanToValueLimit: loanToValueLimit, afterDownPaymentLimit: afterDownPaymentLimit,
      monthlyIncomeBase: monthlyIncomeBase, repaymentCapacityLimit: capacityLimit,
      estimatedLoan: estimate, eligible: p.continuousContributions,
      estimateOnly: true };
  }

  function amortize(principal, rate, count, repayment) {
    principal = cents(principal);
    var monthlyRate = rate / 1200;
    var regularPayment = !principal ? 0 : monthlyRate === 0 ? cents(principal / count) :
      cents(principal * monthlyRate / -Math.expm1(-count * Math.log1p(monthlyRate)));
    var regularPrincipal = cents(principal / count);
    var balance = principal;
    var totalInterest = 0;
    var totalPayment = 0;
    var schedule = [];
    for (var i = 0; i < count; i++) {
      var interest = cents(balance * monthlyRate);
      var paidPrincipal = repayment === 'principal' ? regularPrincipal : cents(regularPayment - interest);
      paidPrincipal = cents(Math.max(0, Math.min(balance, paidPrincipal)));
      if (i === count - 1) paidPrincipal = balance;
      var payment = cents(paidPrincipal + interest);
      balance = cents(Math.max(0, balance - paidPrincipal));
      totalInterest = cents(totalInterest + interest);
      totalPayment = cents(totalPayment + payment);
      schedule.push({ month: i + 1, principal: paidPrincipal, interest: interest, payment: payment, balance: balance });
    }
    return { principal: principal, annualRate: rate, periods: count, repayment: repayment,
      monthlyPayment: schedule[0].payment, firstMonthlyPayment: schedule[0].payment,
      lastMonthlyPayment: schedule[count - 1].payment, totalInterest: totalInterest,
      totalPayment: totalPayment, schedule: schedule };
  }
  function firstPayment(principal, rate, count, repayment) {
    if (!principal) return 0;
    var monthlyRate = rate / 1200;
    if (repayment === 'principal') return cents(cents(principal / count) + cents(principal * monthlyRate));
    return monthlyRate === 0 ? cents(principal / count) : cents(principal * monthlyRate / -Math.expm1(-count * Math.log1p(monthlyRate)));
  }
  function buildLoans(p, estimate, warnings, summaryOnly) {
    var downPayment = cents(p.housePrice * p.downPaymentPercent / 100);
    var required = cents(p.housePrice - downPayment);
    var fund = 0;
    var commercial = 0;
    if (p.loanType === 'commercial') commercial = required;
    else if (p.loanType === 'fund') fund = Math.min(required, estimate.estimatedLoan);
    else {
      var requested = p.linkages.fundAllocation === 'auto' ? required : p.fundLoanRequested;
      if (requested > required) warnings.add('计划公积金贷款超过实际所需贷款，已限制为首付后的所需金额。');
      fund = Math.min(requested, required, estimate.estimatedLoan);
      commercial = cents(required - fund);
      if (p.linkages.fundAllocation === 'manual' && fund < Math.min(requested, required)) warnings.add('公积金可贷预算低于计划金额，组合贷差额暂按商业贷款测算；仍需银行审批。');
    }
    fund = cents(fund);
    commercial = cents(commercial);
    var total = cents(fund + commercial);
    var financingGap = cents(Math.max(0, required - total));
    var commercialMinimum = p.manualCaps.commercialMinDownPaymentPercent === null ?
      (p.firstHome ? 15 : 25) : p.manualCaps.commercialMinDownPaymentPercent;
    var minimumDownPayment = p.loanType === 'commercial' ? commercialMinimum :
      p.loanType === 'mixed' ? Math.max(commercialMinimum, 100 - estimate.loanToValuePercent) : 100 - estimate.loanToValuePercent;
    var downPaymentPolicyGap = cents(Math.max(0, p.housePrice * minimumDownPayment / 100 - downPayment));
    if (downPaymentPolicyGap > 0) warnings.add('当前首付比例低于本计划采用的政策参考下限；贷款还款表仅作数学预算，需增加首付并核对适用地区规则。');
    if (summaryOnly) return { commercialPrincipal: commercial, fundPrincipal: fund, totalPrincipal: total,
      financingGap: financingGap, downPaymentPolicyGap: downPaymentPolicyGap,
      fundingComplete: financingGap === 0 && downPaymentPolicyGap === 0,
      firstMonthlyPayment: cents(firstPayment(commercial, p.commercialRate, p.years * 12, p.repayment) +
        firstPayment(fund, p.fundRate, p.years * 12, p.repayment)) };
    var commercialLoan = amortize(commercial, p.commercialRate, p.years * 12, p.repayment);
    var fundLoan = amortize(fund, p.fundRate, p.years * 12, p.repayment);
    var schedule = commercialLoan.schedule.map(function (c, i) {
      var f = fundLoan.schedule[i];
      return { month: i + 1, payment: cents(c.payment + f.payment), principal: cents(c.principal + f.principal),
        interest: cents(c.interest + f.interest), balance: cents(c.balance + f.balance),
        commercialPayment: c.payment, fundPayment: f.payment, commercialPrincipal: c.principal,
        fundPrincipal: f.principal, commercialInterest: c.interest, fundInterest: f.interest,
        commercialBalance: c.balance, fundBalance: f.balance };
    });
    var annual = [];
    for (var y = 0; y < p.years; y++) {
      var rows = schedule.slice(y * 12, (y + 1) * 12);
      annual.push({ year: y + 1, payment: cents(rows.reduce(function (sum, row) { return sum + row.payment; }, 0)),
        principal: cents(rows.reduce(function (sum, row) { return sum + row.principal; }, 0)),
        interest: cents(rows.reduce(function (sum, row) { return sum + row.interest; }, 0)),
        balance: rows[11].balance });
    }
    return { requiredPrincipal: required, commercialPrincipal: commercial, fundPrincipal: fund, totalPrincipal: total,
      financingGap: financingGap, downPaymentPolicyGap: downPaymentPolicyGap,
      minimumDownPaymentPercent: minimumDownPayment,
      policyCompatible: downPaymentPolicyGap === 0, fundingComplete: financingGap === 0 && downPaymentPolicyGap === 0,
      commercial: commercialLoan, fund: fundLoan, schedule: schedule, annual: annual,
      monthlyPayment: schedule[0].payment, firstMonthlyPayment: schedule[0].payment,
      lastMonthlyPayment: schedule[schedule.length - 1].payment,
      totalInterest: cents(commercialLoan.totalInterest + fundLoan.totalInterest),
      totalPayment: cents(commercialLoan.totalPayment + fundLoan.totalPayment) };
  }

  function calculate(rawPlan, financialContext) {
    var p = normalizePlan(rawPlan);
    var context = normalizeContext(financialContext);
    var warnings = new Set();
    // Effective linked values never overwrite advanced values saved in the plan.
    if (p.borrowerMode === 'joint' && !context.people.some(function (person) { return person.id === 'b'; })) {
      p.borrowerMode = 'single';
      warnings.add('当前为单人收支预算，贷款按本人估算，双人设置仍保留。');
    }
    if (p.linkages.supplementEligibility === 'linked') {
      ['a', 'b'].forEach(function (id) {
        p[id === 'a' ? 'supplementEligibleA' : 'supplementEligibleB'] = context.people.some(function (person) {
          return person.id === id && (person.supplementAnnual > 0 ||
            (person.months && person.months.some(function (month) { return month.supplement > 0; })));
        });
      });
      warnings.add('补充公积金额度按收入设置中的持续缴存作条件预算；正常缴存及贷款资格仍需核实，不自动代表审批通过。');
    }
    var rentByMonth = p.linkages.rent === 'budget' ? (context.rentByMonth || Array(12).fill(0)) : Array(12).fill(p.monthlyRentToReplace);
    if (p.linkages.rent === 'budget' && context.rentByMonth === null) warnings.add('未提供预算的房租分类，自动替代房租暂按 0；没有从总生活开支推测房租。');
    warnings.add('房贷、公积金可贷额均为预算估算，资格、征信、房龄、贷款记录及审批结果需另行核实；不构成贷款承诺。');
    warnings.add('公积金额度按基本和补充余额倍数分别受上限约束后合计，再受房价成数及还本能力约束，属于保守预算，未完整复制审批算法。');
    warnings.add('首付资金仅计现金，未将公积金余额计入首付，也未模拟提取或冲还贷；上海新建房既提又贷政策不自动适用于二手房。');
    warnings.add('现金与公积金从下一个完整月份起，按对应奖金及预算月份重复当前 12 个月收支；不计涨薪、投资收益、房价变化及未来政策调整，商贷利率是自填预算。');
    if (p.borrowerMode === 'joint') warnings.add('家庭共同申请仅适用于符合条件的配偶、父母或子女等申请人；未婚情侣不能自动享受双人公积金额度。');
    if (p.continuousContributions === null) warnings.add('连续足额缴存及其他资格尚未确认，仍按满足条件做额度预算；通常需账户设立且连续足额缴存满 6 个月，特殊人员规则另核。');
    if (p.continuousContributions === false) warnings.add('当前不满足连续缴存条件，公积金可贷额按 0；未自动推测未来资格转为满足。');
    if (!p.firstHome) warnings.add('二套房公积金按普通地区首付至少 25%估算；部分指定地区可为 20%，商贷外环外政策不同，请按具体房屋修改参数。');
    var selected = selectedPeople(p, context);
    if (selected.length < (p.borrowerMode === 'joint' ? 2 : 1)) warnings.add('个人公积金入账资料不完整，未提供人员的未来新增余额按 0 计算。');
    var housingCost = cents(p.otherMonthlyHousingCost + p.postPurchaseExpenseAdjustment);
    var postLivingExpenses = context.months.map(function (month, index) { return cents(month.expenses - rentByMonth[index] + housingCost); });
    var postError = postLivingExpenses.some(function (amount) { return amount < 0; }) ?
      '替代房租或减少开支超过当前生活预算，请调整买后开支。' : null;
    if (postError) warnings.add(postError + '储蓄进度仍显示，买后结余暂停计算。');
    var lowestGross = context.months.every(function (month) { return month.gross !== null; }) ?
      Math.min.apply(Math, context.months.map(function (month) { return month.gross; })) : null;
    var ordinaryMonths = context.months.filter(function (month) { return lowestGross === null || month.gross <= lowestGross + 0.01; });
    var ordinaryNet = Math.min.apply(Math, ordinaryMonths.map(function (month) { return month.net; }));
    // The minimum recurring living budget excludes isolated annual travel/payment peaks.
    // Actual first-year monthly cash flows below still retain those annual expenses.
    var regularLivingExpenses = postError ? null : Math.min.apply(Math, postLivingExpenses);
    var downPayment = cents(p.housePrice * p.downPaymentPercent / 100);
    var cashNeeded = cents(downPayment + p.purchaseCosts + p.reserveCash);
    var cash = cents(p.initialCash);
    var monthsToReady = null;
    var cashAtPurchase = null;
    var currentFund = null;
    var futureFund = null;
    var considerationMonth = null;
    var considerationRow = null;
    var considerationFund = null;
    var accounts = balancesAt(p, context, 0);
    var timeline = [];
    for (var elapsed = 0; elapsed <= 600; elapsed++) {
      if (elapsed > 0) {
        var flowMonth = (context.currentMonth + elapsed - 1) % 12 + 1;
        cash = cents(cash + context.months[flowMonth - 1].savings);
        var nextAccounts = { a: { basic: accounts.a.basic, supplement: accounts.a.supplement },
          b: { basic: accounts.b.basic, supplement: accounts.b.supplement } };
        context.people.forEach(function (person) {
          var entry = personAtMonth(person, flowMonth);
          nextAccounts[person.id].basic = cents(nextAccounts[person.id].basic + entry.basic);
          nextAccounts[person.id].supplement = cents(nextAccounts[person.id].supplement + entry.supplement);
        });
        accounts = nextAccounts;
      }
      var estimated = fundEstimate(p, context, elapsed, warnings, accounts);
      if (elapsed === 0) currentFund = estimated;
      var loanBudget = buildLoans(p, estimated, warnings, true);
      var regularSavings = postError ? null : cents(ordinaryNet - regularLivingExpenses - loanBudget.firstMonthlyPayment);
      var cashReady = cash >= cashNeeded;
      var row = { elapsedMonth: elapsed, elapsedMonths: elapsed, yearMonth: calendar(context, elapsed).label,
        cash: cash, cashGap: cents(Math.max(0, cashNeeded - cash)), basicFund: estimated.allBasicBalance,
        supplementFund: estimated.allSupplementBalance, fundTotal: estimated.householdFundTotal,
        householdFundTotal: estimated.householdFundTotal, borrowerBasicFund: estimated.basicBalance,
        borrowerSupplementFund: estimated.supplementBalance, borrowerFundTotal: estimated.borrowerFundTotal,
        estimatedFundLoan: estimated.estimatedLoan, cashReady: cashReady, financingReady: loanBudget.fundingComplete,
        payment: loanBudget.firstMonthlyPayment, postRegularSavings: regularSavings,
        canConsider: cashReady && loanBudget.fundingComplete && regularSavings !== null && regularSavings >= 0 };
      timeline.push(row);
      if (monthsToReady === null && cashReady) {
        monthsToReady = elapsed;
        cashAtPurchase = cash;
        futureFund = estimated;
      }
      if (considerationMonth === null && row.canConsider) {
        considerationMonth = elapsed;
        considerationRow = row;
        considerationFund = estimated;
      }
      if (elapsed >= 12 && monthsToReady !== null && considerationMonth !== null) break;
    }
    var reachable = monthsToReady !== null;
    var ready = reachable ? calendar(context, monthsToReady) : null;
    var plannedElapsed = considerationMonth !== null ? considerationMonth : monthsToReady;
    var plannedDate = plannedElapsed === null ? null : calendar(context, plannedElapsed);
    var firstPayment = plannedElapsed === null ? calendar(context, 1) : calendar(context, plannedElapsed + 1);
    var loans = buildLoans(p, considerationFund || futureFund || currentFund, warnings);
    loans.estimateAtMonth = plannedDate ? plannedDate.label : calendar(context, 0).label;
    loans.estimateElapsedMonths = plannedElapsed;
    if (futureFund && ready.year > 2026) warnings.add('购房时点晚于当前核验政策年度；未来余额按当前入账重复推算，贷款上限、利率及资格未预测调整。');
    if (!reachable) warnings.add('按当前收支和初始现金，50 年内无法达到所填首付现金目标；贷款与买后预算暂按当前可贷估算展示。');
    if (loans.financingGap > 0) warnings.add('纯公积金可贷预算不足以覆盖首付后的房款，仍有融资缺口；达到现金首付目标不等于已能完成购房。');
    var postMonths = postError ? [] : loans.schedule.map(function (loanMonth, index) {
      var month = (firstPayment.month - 1 + index) % 12 + 1;
      var source = context.months[month - 1];
      var expenses = postLivingExpenses[month - 1];
      var savings = cents(source.net - expenses - loanMonth.payment);
      var date = calendar(context, (firstPayment.year - context.currentYear) * 12 + firstPayment.month - context.currentMonth + index);
      return { month: index + 1, calendarMonth: month, yearMonth: date.label, net: source.net,
        baselineExpenses: source.expenses, rentReplaced: rentByMonth[month - 1],
        otherHousingCost: p.otherMonthlyHousingCost, expenseAdjustment: p.postPurchaseExpenseAdjustment,
        expenses: expenses, mortgagePayment: loanMonth.payment, savings: savings,
        fundAdded: source.fundAdded };
    });
    var firstYearPost = postMonths.slice(0, 12);
    var annualSavings = postError ? null : cents(firstYearPost.reduce(function (sum, m) { return sum + m.savings; }, 0));
    var regularMonthlySavings = postError ? null : cents(ordinaryNet - regularLivingExpenses - loans.firstMonthlyPayment);
    var worstMonthlySavings = postError ? null : Math.min.apply(Math, firstYearPost.map(function (month) { return month.savings; }));
    if (worstMonthlySavings !== null && worstMonthlySavings < 0) warnings.add('买后首年存在现金结余为负的月份，请为年度一次性开支和最紧张月份保留缓冲；不会仅因旅行等一次性支出否决常规月供预算。');
    var considerDate = considerationMonth === null ? null : calendar(context, considerationMonth);
    return {
      purchase: { downPayment: downPayment, purchaseCosts: p.purchaseCosts, reserveCash: p.reserveCash,
        cashNeeded: cashNeeded, availableCash: cents(p.initialCash), cashGap: cents(Math.max(0, cashNeeded - p.initialCash)),
        monthsToReady: monthsToReady, reachable: reachable, readyMonth: ready ? ready.label : null,
        readyDate: ready ? projectionDate(context, monthsToReady) : null, firstPaymentMonth: plannedDate ? firstPayment.label : null,
        plannedPurchaseMonth: plannedDate ? plannedDate.label : null,
        cashAtPurchase: cashAtPurchase, annualCashSavings: context.annualSavings,
        reason: reachable ? null : '当前现金流在 600 个月内无法达到目标。',
        financingReady: reachable && loans.fundingComplete, timeline: timeline },
      projectedTimeline: timeline,
      consideration: { reachable: considerationMonth !== null, monthsToReady: considerationMonth,
        yearMonth: considerDate ? considerDate.label : null, readyMonth: considerDate ? considerDate.label : null,
        readyDate: considerDate ? projectionDate(context, considerationMonth) : null, payment: considerationRow ? considerationRow.payment : null,
        postRegularSavings: considerationRow ? considerationRow.postRegularSavings : null,
        reason: considerationMonth !== null ? null : postError || '600 个月内未同时满足现金、融资及常规月供结余条件。',
        criteria: '现金达到首付、费用及备用金目标，预算贷款覆盖剩余房款且满足所选首付条件，排除奖金的常规税后收入可承担月供及正常月生活预算；不是贷款审批或购房承诺。' },
      fundEstimate: { current: currentFund, atPurchase: futureFund, atConsideration: considerationFund, policySources: SOURCES },
      effective: { borrowerMode: p.borrowerMode, borrowerCount: p.borrowerMode === 'joint' ? 2 : 1,
        householdMembers: context.people.map(function (person) { return person.id; }),
        rentByMonth: rentByMonth.slice(), monthlyRentToReplace: cents(rentByMonth.reduce(function (sum, rent) { return sum + rent; }, 0) / 12),
        fundAllocation: p.linkages.fundAllocation, balanceSource: p.linkages.balanceSource,
        supplementEligibility: p.linkages.supplementEligibility, supplementEligibleA: p.supplementEligibleA,
        supplementEligibleB: p.supplementEligibleB, continuousContributions: p.continuousContributions },
      loans: loans,
      postPurchase: { error: postError, months: postMonths, firstYearMonths: firstYearPost, annualSavings: annualSavings,
        firstYearNet: postError ? null : cents(firstYearPost.reduce(function (sum, m) { return sum + m.net; }, 0)),
        firstYearMortgage: postError ? null : cents(firstYearPost.reduce(function (sum, m) { return sum + m.mortgagePayment; }, 0)),
        regularMonthlySavings: regularMonthlySavings,
        worstMonthlySavings: worstMonthlySavings },
      warnings: Array.from(warnings)
    };
  }

  return { defaultPlan: defaultPlan, normalizePlan: normalizePlan, calculate: calculate };
});
