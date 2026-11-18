(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CoWalletEngine = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var TAX_BANDS = [
    [36000, 0.03, 0], [144000, 0.10, 2520], [300000, 0.20, 16920],
    [420000, 0.25, 31920], [660000, 0.30, 52920],
    [960000, 0.35, 85920], [Infinity, 0.45, 181920]
  ];
  var MONTH_FIELDS = ['gross', 'fixedBonus', 'variableBonus', 'social', 'pension', 'medical', 'unemployment',
    'fundPersonal', 'fundEmployer', 'supplementPersonal', 'supplementEmployer',
    'party', 'salaryTax', 'bonusTax', 'tax', 'net', 'expenses', 'savings', 'fundAdded'];
  var TOP_KEYS = ['version', 'year', 'mode', 'scenario', 'goal', 'people', 'factors', 'expenses', 'splitMode', 'splitA'];
  var PERSON_KEYS = ['id', 'name', 'salary', 'fixedBonus', 'fixedBonusMode', 'fixedBonusMonths',
    'variableBonus', 'bonusMonth', 'bonusMethod', 'qualifiedBonus', 'socialBase', 'fundBase',
    'baseMode', 'pensionRate', 'medicalRate', 'unemploymentRate', 'fundRate', 'employerFundRate',
    'supplementRate', 'employerSupplementRate', 'deduction', 'partyMember', 'partyMode', 'partyMonthly'];
  var PERSON_KEYS_V2 = PERSON_KEYS.concat(['contributionMode', 'contributionBase',
    'referenceAnnualIncome', 'referenceFirstHalfAnnualIncome']);
  var BONUS_OPTIONAL_KEYS = ['fixedBonusPayout'];
  var EXPENSE_KEYS = ['id', 'label', 'amount', 'frequency', 'month', 'owner', 'category'];
  var CATEGORIES = ['rent', 'food', 'transport', 'fixed', 'other'];
  var SOURCES = [
    { label: '上海 2025 社保基数（2025 年 7 月起）', url: 'https://rsj.sh.gov.cn/tgsgg_17341/20250918/t0035_1435637.html' },
    { label: '上海 2026 社保基数（2026 年 7 月起）', url: 'https://shanghai.chinatax.gov.cn/tax/bsfw/nszx/hdfk/202609/t481435.html' },
    { label: '上海 2024 年度社保基数', url: 'https://www.shcn.gov.cn/col5865/20241025/1270226.html' },
    { label: '上海 2024 年度公积金问答', url: 'https://www.shzfgjj.cn/html/newxxgk/zcjd/228178.html' },
    { label: '上海 2025 年度公积金政策', url: 'https://www.shzfgjj.cn/html/newxxgk/zcwj/228051.html' },
    { label: '上海 2026 年度公积金政策', url: 'https://www.shanghai.gov.cn/gwk/affairs/content/0064@f3d788ec72e9404ebcbf3d27fda98435' },
    { label: '上海年度社保缴费工资申报口径', url: 'https://shanghai.chinatax.gov.cn/zzzb/zcwj/202604/t480144.html' },
    { label: '工资总额中的奖金统计口径', url: 'https://shanghai.chinatax.gov.cn/tax/zcfw/rdwd/202608/t481376.html' },
    { label: '基础与补充公积金采用同一工资基数', url: 'https://www.shzfgjj.cn/html/jstz/222176.html' },
    { label: '公积金税前扣除限额', url: 'https://shanghai.chinatax.gov.cn/bsfw/nszx/hdfk/201908/t446765.html' },
    { label: '年终奖单独计税政策', url: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5211524/content.html' },
    { label: '年终奖每人每年限一次及其他奖金并工资规定', url: 'https://www.chinatax.gov.cn/n810341/n810765/n812188/n812950/c1201370/content.html' },
    { label: '党费年初核定及每月一般上限', url: 'https://www.12371.cn/2019/10/06/VIDE1570293723579621.shtml' }
  ];

  function cents(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }
  function yuan(value) { return Math.round(value + Number.EPSILON); }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function fail(message) { throw new Error(message); }
  function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
  function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      fail(label + '必须是普通对象。');
    }
  }
  function keys(value, allowed, label, optional) {
    object(value, label);
    Object.keys(value).forEach(function (key) {
      if (allowed.indexOf(key) < 0) fail(label + '含有不支持的字段：' + key);
    });
    allowed.forEach(function (key) {
      if (!own(value, key) && (!optional || optional.indexOf(key) < 0)) fail(label + '缺少字段：' + key);
    });
  }
  function number(value, label, min, max, integer) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      fail(label + '必须是 ' + min + '–' + max + ' 范围内的' + (integer ? '整数' : '数值') + '。');
    }
    return value;
  }
  function choice(value, allowed, label) {
    if (allowed.indexOf(value) < 0) fail(label + '取值无效。');
    return value;
  }
  function boolean(value, label) {
    if (typeof value !== 'boolean') fail(label + '必须是布尔值。');
    return value;
  }
  function string(value, label, max) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) fail(label + '必须是 1–' + max + ' 个字符的文字。');
    return value.trim();
  }
  function person(id, name, salary, variableBonus) {
    return {
      id: id, name: name, salary: salary, fixedBonus: salary, fixedBonusMode: 'amount', fixedBonusMonths: 1,
      fixedBonusPayout: 'annual',
      variableBonus: variableBonus, bonusMonth: 12, bonusMethod: 'auto', qualifiedBonus: true,
      socialBase: salary, fundBase: salary, baseMode: 'policy', pensionRate: 8, medicalRate: 2,
      unemploymentRate: 0.5, fundRate: 7, employerFundRate: 7, supplementRate: 5,
      employerSupplementRate: 5, deduction: 1500, partyMember: false, partyMode: 'manual', partyMonthly: 0,
      contributionMode: 'salary', contributionBase: salary,
      referenceAnnualIncome: null, referenceFirstHalfAnnualIncome: null
    };
  }
  function expense(id, label, amount, category, owner, frequency) {
    return { id: id, label: label, amount: amount, frequency: frequency || 'monthly', month: 12, owner: owner || 'shared', category: category };
  }
  function defaultState() {
    return {
      version: 2, year: new Date().getFullYear(), mode: 'couple', scenario: 'expected', goal: 300000,
      people: [person('a', '我', 25000, 50000), person('b', 'TA', 18000, 30000)],
      factors: { conservative: 0, expected: 1, optimistic: 1.5 },
      expenses: [
        expense('rent', '房租', 6000, 'rent'), expense('food', '三餐', 3000, 'food'),
        expense('transport', '交通', 500, 'transport'), expense('fixed', '水电网及其他固定开支', 800, 'fixed'),
        expense('personal-a', '我的个人开支', 1500, 'other', 'a'),
        expense('personal-b', 'TA 的个人开支', 1000, 'other', 'b'),
        expense('travel', '年度旅行', 20000, 'other', 'shared', 'annual')
      ],
      splitMode: 'equal', splitA: 50
    };
  }

  // Imports use a whitelist and explicit types. No string-to-number coercion or silent defaults.
  function normalizeState(raw) {
    keys(raw, TOP_KEYS, '方案');
    if (raw.version !== 1 && raw.version !== 2) fail('方案版本不受支持。');
    var result = {
      version: 2, year: number(raw.year, '计算年份', 2019, 9999, true),
      mode: choice(raw.mode, ['single', 'couple'], '人数模式'),
      scenario: choice(raw.scenario, ['conservative', 'expected', 'optimistic'], '奖金情景'),
      goal: number(raw.goal, '存款目标', 0, 1e9), people: [], factors: {}, expenses: [],
      splitMode: choice(raw.splitMode, ['equal', 'income', 'custom'], '共享支出分摊方式'),
      splitA: number(raw.splitA, '我的分摊比例', 0, 100)
    };
    keys(raw.factors, ['conservative', 'expected', 'optimistic'], '情景系数');
    Object.keys(raw.factors).forEach(function (key) {
      result.factors[key] = number(raw.factors[key], key + '情景系数', 0, 10);
    });
    if (!Array.isArray(raw.people) || raw.people.length < 1 || raw.people.length > 2) fail('people 必须是含 1–2 人的数组。');
    var ids = [];
    raw.people.forEach(function (rawPerson, index) {
      var label = '第 ' + (index + 1) + ' 人';
      keys(rawPerson, (raw.version === 1 ? PERSON_KEYS : PERSON_KEYS_V2).concat(BONUS_OPTIONAL_KEYS), label,
        BONUS_OPTIONAL_KEYS.concat(raw.version === 2 ? ['referenceFirstHalfAnnualIncome'] : []));
      var p = {};
      p.id = choice(rawPerson.id, ['a', 'b'], label + '标识');
      if (ids.indexOf(p.id) >= 0) fail('人员标识重复。');
      ids.push(p.id);
      p.name = string(rawPerson.name, label + '称呼', 40);
      ['salary', 'fixedBonus', 'variableBonus', 'socialBase', 'fundBase', 'deduction', 'partyMonthly'].forEach(function (key) {
        p[key] = number(rawPerson[key], p.name + '的 ' + key, 0, 1e9);
      });
      p.fixedBonusMonths = number(rawPerson.fixedBonusMonths, p.name + '固定奖金月数', 0, 24);
      p.bonusMonth = number(rawPerson.bonusMonth, p.name + '奖金发放月', 1, 12, true);
      p.fixedBonusMode = choice(rawPerson.fixedBonusMode, ['amount', 'months'], p.name + '固定奖金模式');
      p.fixedBonusPayout = own(rawPerson, 'fixedBonusPayout') ?
        choice(rawPerson.fixedBonusPayout, ['annual', 'monthly'], p.name + '固定奖金发放方式') : 'annual';
      p.bonusMethod = choice(rawPerson.bonusMethod, ['auto', 'combined', 'separate'], p.name + '计税方式');
      p.baseMode = choice(rawPerson.baseMode, ['policy', 'actual'], p.name + '基数模式');
      p.partyMode = choice(rawPerson.partyMode, ['manual', 'estimate'], p.name + '党费模式');
      ['qualifiedBonus', 'partyMember'].forEach(function (key) { p[key] = boolean(rawPerson[key], p.name + '的 ' + key); });
      ['pensionRate', 'medicalRate', 'unemploymentRate', 'fundRate', 'employerFundRate', 'supplementRate', 'employerSupplementRate'].forEach(function (key) {
        p[key] = number(rawPerson[key], p.name + '的 ' + key, 0, 100);
      });
      if (p.pensionRate + p.medicalRate + p.unemploymentRate > 100) fail(p.name + '的个人社保比例合计不能超过 100%。');
      if (raw.version === 1) {
        // Preserve historical independent inputs and their exact calculation behavior.
        p.contributionMode = p.socialBase === p.fundBase ? 'linked' : 'separate';
        p.contributionBase = p.socialBase;
        p.referenceAnnualIncome = null;
        p.referenceFirstHalfAnnualIncome = null;
      } else {
        p.contributionMode = choice(rawPerson.contributionMode, ['linked', 'salary', 'annualized', 'separate'], p.name + '缴存基数来源');
        p.contributionBase = number(rawPerson.contributionBase, p.name + '共用缴存基数', 0, 1e9);
        p.referenceAnnualIncome = rawPerson.referenceAnnualIncome === null ? null :
          number(rawPerson.referenceAnnualIncome, p.name + '上一年度税前总收入', 0, 1e9);
        p.referenceFirstHalfAnnualIncome = !own(rawPerson, 'referenceFirstHalfAnnualIncome') || rawPerson.referenceFirstHalfAnnualIncome === null ? null :
          number(rawPerson.referenceFirstHalfAnnualIncome, p.name + '上上年度税前总收入', 0, 1e9);
      }
      result.people.push(p);
    });
    if (ids.indexOf('a') < 0 || (result.mode === 'couple' && ids.indexOf('b') < 0)) fail('单人模式必须有 a；双人模式必须同时有 a 和 b。');
    result.people.sort(function (a, b) { return a.id.localeCompare(b.id); });
    if (!Array.isArray(raw.expenses) || raw.expenses.length > 100) fail('expenses 必须是最多 100 项的数组。');
    var expenseIds = [];
    raw.expenses.forEach(function (item, index) {
      var label = '第 ' + (index + 1) + ' 项支出';
      keys(item, EXPENSE_KEYS, label);
      var e = {
        id: string(item.id, label + '标识', 80), label: string(item.label, label + '名称', 80),
        amount: number(item.amount, label + '金额', 0, 1e9),
        frequency: choice(item.frequency, ['monthly', 'annual'], label + '频率'),
        month: number(item.month, label + '发生月份', 1, 12, true),
        owner: choice(item.owner, ['shared', 'a', 'b'], label + '归属'),
        category: choice(item.category, CATEGORIES, label + '分类')
      };
      if (expenseIds.indexOf(e.id) >= 0) fail('支出标识重复：' + e.id);
      expenseIds.push(e.id);
      result.expenses.push(e);
    });
    return result;
  }

  function normalizePolicy(raw) {
    if (raw === undefined || raw === null) return null;
    keys(raw, ['socialMin', 'socialMax', 'fundMin', 'fundMax', 'bonusPolicy'], '政策参数');
    var result = {
      socialMin: number(raw.socialMin, '社保基数下限', 0, 1e9),
      socialMax: number(raw.socialMax, '社保基数上限', 0, 1e9),
      fundMin: number(raw.fundMin, '公积金基数下限', 0, 1e9),
      fundMax: number(raw.fundMax, '公积金基数上限', 0, 1e9),
      bonusPolicy: choice(raw.bonusPolicy, ['auto', 'allowed', 'combinedOnly'], '奖金计税政策')
    };
    if (result.socialMin > result.socialMax) fail('社保基数下限不能高于上限。');
    if (result.fundMin > result.fundMax) fail('公积金基数下限不能高于上限。');
    return result;
  }

  function policyFor(year, month) {
    if (year < 2025 || (year === 2025 && month < 7)) return { socialMin: 7384, socialMax: 36921, fundMin: 2690, fundMax: 36921, period: '2024 年度' };
    if ((year === 2025 && month >= 7) || (year === 2026 && month < 7)) {
      return { socialMin: 7460, socialMax: 37302, fundMin: 2690, fundMax: 37302, period: '2025 年度' };
    }
    return { socialMin: 7546, socialMax: 37731, fundMin: 2740, fundMax: 37731, period: '2026 年度' };
  }
  function annualTax(taxable) {
    var income = Math.max(0, taxable);
    var band = TAX_BANDS.find(function (row) { return income <= row[0]; });
    return cents(income * band[1] - band[2]);
  }
  function bonusTax(bonus) {
    if (!bonus) return 0;
    var band = TAX_BANDS.find(function (row) { return bonus <= row[0]; });
    return cents(bonus * band[1] - band[2] / 12);
  }
  function blankMonth(month) {
    var m = { month: month };
    MONTH_FIELDS.forEach(function (key) { m[key] = 0; });
    m.cumulativeSavings = 0;
    m.cumulativeFund = 0;
    return m;
  }
  function summarize(months) {
    var annual = {};
    MONTH_FIELDS.forEach(function (key) {
      annual[key] = cents(months.reduce(function (sum, m) { return sum + m[key]; }, 0));
    });
    annual.savingsRate = annual.net > 0 ? annual.savings / annual.net : 0;
    return annual;
  }
  function addWarning(warnings, message) { warnings.add(message); }
  function contributionBases(p, month, warnings) {
    if (p.contributionMode === 'salary') return { socialBase: p.salary, fundBase: p.salary };
    if (p.contributionMode === 'linked') return { socialBase: p.contributionBase, fundBase: p.contributionBase };
    if (p.contributionMode === 'separate') return { socialBase: p.socialBase, fundBase: p.fundBase };
    if (p.referenceAnnualIncome === null) fail(p.name + '：请填写上一年度税前总收入（含年终奖）。');
    var reference = p.referenceAnnualIncome;
    if (p.referenceFirstHalfAnnualIncome === null) {
      addWarning(warnings, p.name + '：按上一年度税前总收入（含奖金）÷12作为整年固定基数预算；未提供上上年收入，因此未还原自然年上半年沿用旧缴费年度的差异。');
    } else if (month <= 6) {
      reference = p.referenceFirstHalfAnnualIncome;
    }
    return { socialBase: cents(reference / 12), fundBase: cents(reference / 12) };
  }
  function contribution(p, policy, warnings, rawBases) {
    var socialBase = p.baseMode === 'policy' ? clamp(rawBases.socialBase, policy.socialMin, policy.socialMax) : rawBases.socialBase;
    var fundBase = p.baseMode === 'policy' ? clamp(rawBases.fundBase, policy.fundMin, policy.fundMax) : rawBases.fundBase;
    var socialNames = { pensionRate: '养老', medicalRate: '医疗', unemploymentRate: '失业' };
    var statutoryRates = { pensionRate: 8, medicalRate: 2, unemploymentRate: 0.5 };
    var social = {
      pension: cents(socialBase * p.pensionRate / 100),
      medical: cents(socialBase * p.medicalRate / 100),
      unemployment: cents(socialBase * p.unemploymentRate / 100)
    };
    var socialTotal = cents(social.pension + social.medical + social.unemployment);
    var socialDeductible = 0;
    Object.keys(statutoryRates).forEach(function (key) {
      socialDeductible += cents(Math.min(socialBase, policy.socialMax) * Math.min(p[key], statutoryRates[key]) / 100);
      if (p[key] > statutoryRates[key]) addWarning(warnings, p.name + '：' + socialNames[key] + '比例高于上海当前标准，超出标准的部分未作为税前扣除，请核对实际核定口径。');
    });
    var fundPersonal = yuan(fundBase * p.fundRate / 100);
    var fundEmployer = yuan(fundBase * p.employerFundRate / 100);
    var supplementPersonal = yuan(fundBase * p.supplementRate / 100);
    var supplementEmployer = yuan(fundBase * p.employerSupplementRate / 100);
    // Shanghai's legal 7% base + 5% supplemental ceiling reaches 12% per side.
    // Each legal deposit is rounded separately, just like the actual deposits;
    // rounding their combined rate instead would falsely tax ordinary deposits.
    var eligibleBase = Math.min(fundBase, policy.fundMax);
    var personalLimit = yuan(eligibleBase * Math.min(p.fundRate, 7) / 100) +
      yuan(eligibleBase * Math.min(p.supplementRate, 5) / 100);
    var employerLimit = yuan(eligibleBase * Math.min(p.employerFundRate, 7) / 100) +
      yuan(eligibleBase * Math.min(p.employerSupplementRate, 5) / 100);
    var personalPaid = fundPersonal + supplementPersonal;
    var employerPaid = fundEmployer + supplementEmployer;
    var fundDeductible = Math.min(personalPaid, personalLimit);
    var employerExcess = Math.max(0, employerPaid - employerLimit);
    if (p.baseMode === 'policy' && (socialBase !== rawBases.socialBase || fundBase !== rawBases.fundBase)) {
      addWarning(warnings, p.name + '：已按上海对应月份政策，对所填基数限高保低；每月采用值可能不同。');
    }
    if (p.baseMode === 'actual' && (socialBase < policy.socialMin || socialBase > policy.socialMax || fundBase < policy.fundMin || fundBase > policy.fundMax)) {
      addWarning(warnings, p.name + '：实际基数超出上海参考范围，实缴金额按输入保留；税前扣除及单位公积金免税额仍受政策上限约束。');
    }
    if (personalPaid > fundDeductible || employerExcess > 0) {
      addWarning(warnings, p.name + '：公积金存在超出税收限额的部分，个人超额未税前扣除，单位超额已计入工资计税所得，均未增加到手现金。');
    }
    var ratePairs = [[p.fundRate, 5, 7], [p.employerFundRate, 5, 7], [p.supplementRate, 1, 5], [p.employerSupplementRate, 1, 5]];
    if (ratePairs.some(function (r) { return r[0] !== 0 && (r[0] < r[1] || r[0] > r[2] || !Number.isInteger(r[0])); })) {
      addWarning(warnings, p.name + '：所填公积金比例不在上海基本 5%–7%、补充 1%–5% 的整数档内；已作为自定义实缴试算，请核对单位规则。');
    }
    if (socialTotal + personalPaid > p.salary) addWarning(warnings, p.name + '：个人月缴费超过基本月薪，请检查工资、基数及比例。');
    return {
      pension: social.pension, medical: social.medical, unemployment: social.unemployment,
      social: socialTotal, fundPersonal: fundPersonal, fundEmployer: fundEmployer,
      supplementPersonal: supplementPersonal, supplementEmployer: supplementEmployer,
      socialDeductible: cents(socialDeductible), fundDeductible: fundDeductible,
      employerExcess: employerExcess, socialBase: socialBase, fundBase: fundBase,
      rawSocialBase: rawBases.socialBase, rawFundBase: rawBases.fundBase
    };
  }
  function partyAmount(p, firstContribution, warnings) {
    if (!p.partyMember) return 0;
    if (p.partyMode === 'manual') return cents(p.partyMonthly);
    var taxable = p.salary + firstContribution.employerExcess - firstContribution.socialDeductible -
      firstContribution.fundDeductible - 5000 - p.deduction;
    var firstMonthTax = annualTax(taxable);
    var recurringNet = Math.max(0, p.salary - firstContribution.social - firstContribution.fundPersonal -
      firstContribution.supplementPersonal - firstMonthTax);
    var rate = recurringNet <= 3000 ? 0.005 : recurringNet <= 5000 ? 0.01 : recurringNet <= 10000 ? 0.015 : 0.02;
    addWarning(warnings, p.name + '：党费按年初固定经常性税后工资估算，排除年终奖，全年固定且一般不超过每月 1000 元；请优先填写党组织核定金额。');
    return cents(Math.min(1000, recurringNet * rate));
  }
  function bonusSchedule(p, fixed, floating) {
    var totalFixedCents = Math.round(fixed * 100);
    var monthlyCents = Math.floor(totalFixedCents / 12);
    return Array.from({ length: 12 }, function (_, index) {
      var fixedPart = p.fixedBonusPayout === 'monthly' ?
        (index === 11 ? totalFixedCents - monthlyCents * 11 : monthlyCents) / 100 :
        index + 1 === p.bonusMonth ? fixed : 0;
      var variablePart = index + 1 === p.bonusMonth ? floating : 0;
      return { fixedBonus: fixedPart, variableBonus: variablePart,
        oneTimeBonus: cents((p.fixedBonusPayout === 'annual' ? fixedPart : 0) + variablePart) };
    });
  }
  function simulatePerson(p, state, schedule, selected, contributions, party) {
    var paidSalaryTax = 0;
    var cumulativeTaxable = 0;
    var separate = selected === 'separate';
    var totalBonus = cents(schedule.reduce(function (sum, entry) { return sum + entry.fixedBonus + entry.variableBonus; }, 0));
    var months = contributions.map(function (c, index) {
      var m = blankMonth(index + 1);
      var entry = schedule[index];
      var bonus = cents(entry.fixedBonus + entry.variableBonus);
      var separateAmount = separate ? entry.oneTimeBonus : 0;
      m.fixedBonus = entry.fixedBonus;
      m.variableBonus = entry.variableBonus;
      m.gross = cents(p.salary + bonus);
      ['pension', 'medical', 'unemployment', 'social', 'fundPersonal', 'fundEmployer', 'supplementPersonal', 'supplementEmployer'].forEach(function (key) { m[key] = c[key]; });
      m.party = party;
      cumulativeTaxable = cents(cumulativeTaxable + p.salary + bonus - separateAmount + c.employerExcess -
        c.socialDeductible - c.fundDeductible - 5000 - p.deduction);
      m.salaryTax = cents(Math.max(0, annualTax(cumulativeTaxable) - paidSalaryTax));
      paidSalaryTax = cents(paidSalaryTax + m.salaryTax);
      m.bonusTax = separateAmount ? bonusTax(separateAmount) : 0;
      m.tax = cents(m.salaryTax + m.bonusTax);
      m.net = cents(m.gross - m.social - m.fundPersonal - m.supplementPersonal - m.party - m.tax);
      m.fundAdded = cents(m.fundPersonal + m.fundEmployer + m.supplementPersonal + m.supplementEmployer);
      m.savings = m.net;
      // Extra diagnostics are non-cash and never added to gross/net/fundAdded.
      m.socialBase = c.socialBase;
      m.fundBase = c.fundBase;
      m.rawSocialBase = c.rawSocialBase;
      m.rawFundBase = c.rawFundBase;
      m.taxDeductibleSocial = c.socialDeductible;
      m.taxDeductibleFund = c.fundDeductible;
      m.employerFundTaxableExcess = c.employerExcess;
      return m;
    });
    return { id: p.id, name: p.name, months: months, annual: summarize(months), bonus: totalBonus, selected: selected };
  }
  function calculatePerson(p, state, factor, warnings, policyOverride) {
    var fixed = p.fixedBonusMode === 'months' ? cents(p.salary * p.fixedBonusMonths) : cents(p.fixedBonus);
    var floating = cents(p.variableBonus * factor);
    var totalBonus = cents(fixed + floating);
    if (totalBonus > 1e10) fail(p.name + '奖金金额超出估算范围。');
    var contributions = Array.from({ length: 12 }, function (_, i) {
      return contribution(p, policyOverride || policyFor(state.year, i + 1), warnings, contributionBases(p, i + 1, warnings));
    });
    var party = partyAmount(p, contributions[0], warnings);
    var schedule = bonusSchedule(p, fixed, floating);
    var oneTimeAmount = cents(p.fixedBonusPayout === 'annual' ? fixed + floating : floating);
    var combined = simulatePerson(p, state, schedule, 'combined', contributions, party);
    var bonusPolicy = policyOverride ? policyOverride.bonusPolicy : 'auto';
    var bonusAllowed = bonusPolicy === 'allowed' || (bonusPolicy === 'auto' && state.year <= 2027);
    var maySeparate = p.qualifiedBonus && bonusAllowed && oneTimeAmount > 0;
    if (p.bonusMethod === 'separate' && !p.qualifiedBonus) fail(p.name + '：未确认符合全年一次性奖金条件，不能选择单独计税。');
    var separate = maySeparate ? simulatePerson(p, state, schedule, 'separate', contributions, party) : null;
    var delta = separate ? cents(combined.annual.tax - separate.annual.tax) : 0;
    var recommended = !separate ? 'combined' : delta > 0 ? 'separate' : delta < 0 ? 'combined' : 'equal';
    var selected = p.bonusMethod === 'auto' ? (recommended === 'separate' ? 'separate' : 'combined') : p.bonusMethod;
    if (!bonusAllowed && p.qualifiedBonus && p.bonusMethod !== 'combined') {
      addWarning(warnings, p.name + (bonusPolicy === 'combinedOnly' ?
        '：当前政策设置仅按并入综合所得计税，已回退为合并估算。' :
        '：当前年份的年终奖单独计税政策尚未确认，已回退为并入综合所得；可在计算口径中按核实后的政策调整。'));
    }
    if (selected === 'separate' && !maySeparate) selected = 'combined';
    if (p.fixedBonusPayout === 'monthly' && fixed > 0) {
      addWarning(warnings, p.name + '：固定年度奖金按分分摊到 12 个月，12 月补尾差，按当月工资累计计税；只有集中发放且符合条件的浮动奖参与一次单独计税。');
    }
    if (p.bonusMethod === 'separate' && oneTimeAmount === 0) {
      addWarning(warnings, p.name + '：没有正金额的一次性奖金，已按工资综合所得计税，不能对月摊固定奖金使用单独计税。');
    }
    var result = selected === 'separate' ? separate : combined;
    result.comparison = {
      combinedTax: combined.annual.tax, separateTax: separate ? separate.annual.tax : null,
      saving: Math.abs(delta), recommended: recommended, selected: selected,
      separateMonth: separate ? p.bonusMonth : null, selectedMonth: selected === 'separate' ? p.bonusMonth : null,
      separateAmount: separate ? oneTimeAmount : 0, selectedAmount: selected === 'separate' ? oneTimeAmount : 0,
      candidates: separate ? [{ month: p.bonusMonth, amount: oneTimeAmount, tax: separate.annual.tax }] : []
    };
    result.fixedBonus = fixed;
    result.variableBonus = floating;
    result.contributionReference = {
      mode: p.contributionMode,
      referenceAnnualIncome: p.referenceAnnualIncome,
      referenceFirstHalfAnnualIncome: p.referenceFirstHalfAnnualIncome,
      usesFixedAnnualReference: p.contributionMode === 'annualized' && p.referenceFirstHalfAnnualIncome === null,
      rawSocialBase: contributions[0].rawSocialBase,
      rawFundBase: contributions[0].rawFundBase,
      months: contributions.map(function (c, i) {
        return { month: i + 1, rawSocialBase: c.rawSocialBase, rawFundBase: c.rawFundBase,
          socialBase: c.socialBase, fundBase: c.fundBase };
      })
    };
    return result;
  }

  function calculate(raw, scenario, policyOverrides) {
    var state = normalizeState(raw);
    var policy = normalizePolicy(policyOverrides);
    var selectedScenario = scenario === undefined ? state.scenario : choice(scenario, ['conservative', 'expected', 'optimistic'], '奖金情景');
    var warnings = new Set();
    if (policy) addWarning(warnings, '当前使用自定义政策参数，缴费基数上下限全年统一；请确认参数与奖金计税开关符合已核实的政策。');
    else if (state.year >= 2027) addWarning(warnings, state.year + ' 年上海完整缴费政策尚未配置，使用 2026 年下半年参数作参考；请填写实际核定值或调整最新政策参数，不能视为确定政策。');
    else if (state.year < 2025) addWarning(warnings, state.year + ' 年上海缴费参数尚未配置，暂以 2024 年度参数作参考；请按该年的核定值调整政策参数。');
    addWarning(warnings, '按中国大陆居民个人、同一单位完整工作 12 个月估算，不含其他综合所得、年度汇算退补税或公积金利息与提取。');
    var inputs = state.people.filter(function (p) { return state.mode === 'couple' || p.id === 'a'; });
    var people = inputs.map(function (p) { return calculatePerson(p, state, state.factors[selectedScenario], warnings, policy); });
    var incomeTotal = people.reduce(function (sum, p) { return sum + Math.max(0, p.annual.net); }, 0);
    var shareA = 1;
    if (state.mode === 'couple') {
      shareA = state.splitMode === 'equal' ? 0.5 : state.splitMode === 'custom' ? state.splitA / 100 :
        incomeTotal > 0 ? Math.max(0, people[0].annual.net) / incomeTotal : 0.5;
      if (state.splitMode === 'income' && incomeTotal === 0) addWarning(warnings, '两人全年到手均不为正，共享支出暂按各 50% 分摊。');
    }
    var byId = {};
    people.forEach(function (p) { byId[p.id] = p; });
    var months = Array.from({ length: 12 }, function (_, i) { return blankMonth(i + 1); });
    var expenseGroups = { rent: 0, food: 0, transport: 0, fixed: 0, other: 0 };
    var sharedAnnual = 0;
    state.expenses.forEach(function (e) {
      if (state.mode === 'single' && e.owner === 'b') return;
      months.forEach(function (m, index) {
        if (e.frequency === 'annual' && e.month !== m.month) return;
        var amount = cents(e.amount);
        m.expenses = cents(m.expenses + amount);
        expenseGroups[e.category] = cents(expenseGroups[e.category] + amount);
        if (e.owner === 'shared') {
          sharedAnnual = cents(sharedAnnual + amount);
          var aAmount = cents(amount * shareA);
          byId.a.months[index].expenses = cents(byId.a.months[index].expenses + aAmount);
          if (byId.b) byId.b.months[index].expenses = cents(byId.b.months[index].expenses + cents(amount - aAmount));
        } else {
          byId[e.owner].months[index].expenses = cents(byId[e.owner].months[index].expenses + amount);
        }
      });
    });
    people.forEach(function (p) {
      var cumulativeSavings = 0;
      var cumulativeFund = 0;
      p.months.forEach(function (m) {
        m.savings = cents(m.net - m.expenses);
        cumulativeSavings = cents(cumulativeSavings + m.savings);
        cumulativeFund = cents(cumulativeFund + m.fundAdded);
        m.cumulativeSavings = cumulativeSavings;
        m.cumulativeFund = cumulativeFund;
      });
      p.annual = summarize(p.months);
    });
    var cumulativeSavings = 0;
    var cumulativeFund = 0;
    months.forEach(function (m, index) {
      MONTH_FIELDS.forEach(function (key) {
        if (key !== 'expenses') m[key] = cents(people.reduce(function (sum, p) { return sum + p.months[index][key]; }, 0));
      });
      cumulativeSavings = cents(cumulativeSavings + m.savings);
      cumulativeFund = cents(cumulativeFund + m.fundAdded);
      m.cumulativeSavings = cumulativeSavings;
      m.cumulativeFund = cumulativeFund;
    });
    var annual = summarize(months);
    annual.goal = state.goal;
    annual.goalGap = cents(Math.max(0, state.goal - annual.savings));
    annual.goalProgress = state.goal > 0 ? annual.savings / state.goal : 0;
    return {
      people: people, months: months, annual: annual, warnings: Array.from(warnings),
      expenseGroups: expenseGroups,
      allocation: { a: byId.a.annual.expenses, b: byId.b ? byId.b.annual.expenses : 0,
        shared: sharedAnnual, shareA: shareA, shareB: byId.b ? 1 - shareA : 0 },
      selectedScenario: selectedScenario,
      policySources: SOURCES.map(function (source) { return { label: source.label, url: source.url }; })
    };
  }

  return { defaultState: defaultState, normalizeState: normalizeState, normalizePolicy: normalizePolicy, calculate: calculate,
    annualTax: annualTax, bonusTax: bonusTax, policyFor: policyFor };
});
