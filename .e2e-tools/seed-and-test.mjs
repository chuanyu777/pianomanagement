/**
 * 全功能验收测试 + 演示数据生成（数据跨 2026-08 / 09 / 10 三个月）。
 *
 * 用法：node seed-and-test.mjs
 * 前置：后端已启动、数据库已迁移（空库或可重复：账号重复会被识别并跳过引导）。
 * 结束后数据保留在库里，供人工在浏览器里查看。
 */
const API = process.env.API ?? 'http://127.0.0.1:3000/api';

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(`${name} ${detail}`);
    console.log(`  [FAIL] ${name}  ${detail}`);
  }
}

async function call(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

async function expectStatus(name, method, path, body, token, expect) {
  const r = await call(method, path, body, token);
  check(name, r.status === expect, `期望 ${expect} 实际 ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  return r;
}
const eq = (a, b) => String(a) === String(b);

console.log('===== 0. 首次引导与登录 =====');
const ownerPass = 'Zhoucc123456';
let r = await call('POST', '/bootstrap/owner', {
  username: 'zhoucc', password: ownerPass, displayName: '周店长', organizationName: '星海琴行',
});
if (r.status === 409) console.log('  （店主已存在，跳过引导）');
else check('创建店主', r.status === 201, `实际 ${r.status}`);

r = await call('POST', '/auth/login', { username: 'zhoucc', password: ownerPass });
const owner = r.json?.accessToken;
check('店主登录', Boolean(owner));

console.log('===== 1. 机构设置与全局参数（US-BD-07） =====');
await expectStatus('机构信息与参数', 'PATCH', '/organization', {
  name: '星海琴行', city: '西安', reporter: '周店长',
  defaultCommissionRate: 0.1, refundFeeRate: 0.03,
  giftCountsAsBalance: true, consumptionOrder: 'GIFT_FIRST',
  initialCashBalance: 5000, previousMonthProfit: 3000, previousMonthPayroll: 4800,
}, owner, 200);
r = await expectStatus('设置利润分配', 'PUT', '/organization/profit-shares',
  { rules: [{ name: '周店长', ratio: 0.6 }, { name: '王合伙人', ratio: 0.4 }] }, owner, 200);
await expectStatus('利润分配比例不等于 100% 要被拒', 'PUT', '/organization/profit-shares',
  { rules: [{ name: 'A', ratio: 0.5 }, { name: 'B', ratio: 0.4 }] }, owner, 400);
r = await call('GET', '/organization', null, owner);
check('机构参数已保存', Number(r.json?.defaultCommissionRate) === 0.1 && Number(r.json?.initialCashBalance) === 5000);

console.log('===== 2. 基础资料（US-BD-01/03/04/08） =====');
const ct = {};
for (const name of ['钢琴主课', '陪练课', '乐理课']) {
  r = await call('POST', '/course-types', { name, sortOrder: 1 }, owner);
  ct[name] = r.json?.id;
}
await expectStatus('重名课程类型被拒', 'POST', '/course-types', { name: '钢琴主课' }, owner, 409);

const th = {};
for (const t of [
  { name: '张老师', position: '钢琴', commissionRate: 0.12 },
  { name: '李老师', position: '陪练' },
  { name: '王老师', position: '钢琴', isActive: false },
]) {
  r = await call('POST', '/teachers', t, owner);
  th[t.name] = r.json?.id;
}
await expectStatus('老师档案重复建（同名不约束则应成功，这里只验证能建）', 'POST', '/teachers',
  { name: '王老师', position: '钢琴' }, owner, 201);

const stu = {};
for (const s of [
  { name: '小明', gradeLevel: 3 }, { name: '小红', gradeLevel: 5 },
  { name: '小刚', gradeLevel: 1 }, { name: '小丽', gradeLevel: 7 },
  { name: '小军', gradeLevel: 2 }, { name: '小强', gradeLevel: 4 },
]) {
  r = await call('POST', '/students', s, owner);
  stu[s.name] = r.json?.id;
}
await expectStatus('学习级别 11 被拒', 'POST', '/students', { name: '越级', gradeLevel: 11 }, owner, 400);

r = await expectStatus('种默认收支项目', 'POST', '/items/seed-defaults', null, owner, 201);
r = await call('GET', '/items/income', null, owner);
const incomeItems = r.json ?? [];
const itemPiano = incomeItems.find((i) => i.name === '钢琴');
const itemBook = incomeItems.find((i) => i.name === '书');
const itemLessonFee = incomeItems.find((i) => i.name === '课时消费');
const itemRefundFee = incomeItems.find((i) => i.name === '退费手续费');
check('默认收入项齐全（钢琴/书/课时消费/退费手续费）', Boolean(itemPiano && itemBook && itemLessonFee && itemRefundFee));
r = await call('GET', '/items/deduction', null, owner);
const itemShebao = (r.json ?? []).find((i) => i.name === '社保');
check('默认代扣项含社保', Boolean(itemShebao));

console.log('===== 3. 报名与自定义单价（US-BD-05） =====');
const en = {};
const enrollments = [
  ['小明', '张老师', '钢琴主课', 300, 1000],
  ['小红', '张老师', '钢琴主课', 350, 0],
  ['小刚', '李老师', '陪练课', 200, 0],
  ['小丽', '李老师', '乐理课', 150, 800],
  ['小军', '张老师', '钢琴主课', 300, 600],
  ['小强', '张老师', '钢琴主课', 300, 900],
];
for (const [sn, tn, cn, price, init] of enrollments) {
  r = await call('POST', '/enrollments', {
    studentId: stu[sn], teacherId: th[tn], courseTypeId: ct[cn],
    unitPrice: price, effectiveFrom: '2026-08-01T00:00:00.000Z',
    initialPaidBalance: init, initialGiftBalance: 0,
  }, owner);
  en[`${sn}-${cn}`] = r.json?.id;
}
await expectStatus('同一学生+老师+课程重复报名被拒', 'POST', '/enrollments', {
  studentId: stu['小明'], teacherId: th['张老师'], courseTypeId: ct['钢琴主课'],
  unitPrice: 300, effectiveFrom: '2026-08-01T00:00:00.000Z',
}, owner, 409);
await expectStatus('单价为 0 被拒', 'POST', '/enrollments', {
  studentId: stu['小明'], teacherId: th['李老师'], courseTypeId: ct['乐理课'],
  unitPrice: 0, effectiveFrom: '2026-08-01T00:00:00.000Z',
}, owner, 400);
r = await expectStatus('删除被引用的课程类型被阻止', 'DELETE', `/course-types/${ct['钢琴主课']}`, null, owner, 409);

console.log('===== 4. 账号与权限（US-AC-01/02） =====');
await expectStatus('创建关联老师的账号', 'POST', '/users', {
  username: 'zhang01', password: 'Zhang01123456', displayName: '张老师账号',
  role: 'TEACHER', teacherId: th['张老师'],
}, owner, 201);
r = await call('POST', '/auth/login', { username: 'zhang01', password: 'Zhang01123456' });
const teacher = r.json?.accessToken;
check('老师账号能登录', Boolean(teacher));
r = await call('GET', '/users?page=1&pageSize=20', null, teacher);
check('老师看不到账号管理（403）', r.status === 403, `实际 ${r.status}`);

console.log('===== 5. 八月：交费 / 排课 / 确认 / 赠送 / 支出 / 工资 =====');
const Pay = (student, enrollment, amount, date) =>
  call('POST', '/payments', {
    enrollmentId: enrollment, amount, incomeItemId: itemPiano.id,
    occurredAt: `${date}T02:00:00.000Z`,
  }, owner);

r = await expectStatus('8月交费 小明 2000', 'POST', '/payments',
  { enrollmentId: en['小明-钢琴主课'], amount: 2000, incomeItemId: itemPiano.id, occurredAt: '2026-08-05T02:00:00.000Z' }, owner, 201);
await expectStatus('8月交费 小红 700', 'POST', '/payments',
  { enrollmentId: en['小红-钢琴主课'], amount: 700, incomeItemId: itemPiano.id, occurredAt: '2026-08-06T02:00:00.000Z' }, owner, 201);
await expectStatus('交费金额为 0 被拒', 'POST', '/payments',
  { enrollmentId: en['小明-钢琴主课'], amount: 0, incomeItemId: itemPiano.id }, owner, 400);

// 排课 + 补录确认（confirmedAt 让课时落到对应月份）
const Lesson = async (student, teacher, course, scheduledAt, extra = {}) => {
  const created = await call('POST', '/lessons', {
    studentId: stu[student], teacherId: th[teacher], courseTypeId: ct[course],
    scheduledAt, ...extra,
  }, owner);
  return created.json?.id;
};
const Confirm = (lessonId, at, tok = owner) =>
  call('POST', `/lessons/${lessonId}/confirm`, { confirmedAt: `${at}T10:00:00.000Z` }, tok);

let l;
l = await Lesson('小明', '张老师', '钢琴主课', '2026-08-10T02:00:00.000Z');
r = await expectStatus('确认小明 8/10 的课（补录）', 'POST', `/lessons/${l}/confirm`, { confirmedAt: '2026-08-10T10:00:00.000Z' }, owner, 201);
l = await Lesson('小明', '张老师', '钢琴主课', '2026-08-12T02:00:00.000Z');
await expectStatus('确认小明 8/12 的课', 'POST', `/lessons/${l}/confirm`, { confirmedAt: '2026-08-12T10:00:00.000Z' }, owner, 201);
await expectStatus('重复确认同一节课要 409', 'POST', `/lessons/${l}/confirm`, { confirmedAt: '2026-08-12T10:00:00.000Z' }, owner, 409);
l = await Lesson('小军', '张老师', '钢琴主课', '2026-08-10T06:00:00.000Z');
await expectStatus('确认小军 8/10', 'POST', `/lessons/${l}/confirm`, { confirmedAt: '2026-08-10T15:00:00.000Z' }, owner, 201);
l = await Lesson('小红', '张老师', '钢琴主课', '2026-08-20T02:00:00.000Z');
await expectStatus('确认小红 8/20', 'POST', `/lessons/${l}/confirm`, { confirmedAt: '2026-08-20T10:00:00.000Z' }, owner, 201);
l = await Lesson('小明', '张老师', '钢琴主课', '2026-08-12T02:00:00.000Z');
await expectStatus('同一老师同一小时再排课要提示冲突', 'POST', '/lessons', {
  studentId: stu['小红'], teacherId: th['张老师'], courseTypeId: ct['钢琴主课'],
  scheduledAt: '2026-08-12T02:30:00.000Z',
}, owner, 409);

r = await expectStatus('赠送小明 1 节（开业酬宾）', 'POST', '/gifts', {
  enrollmentId: en['小明-钢琴主课'], lessons: 1, activityName: '八月开业酬宾',
  grantedAt: '2026-08-15T02:00:00.000Z',
}, owner, 201);
const giftId = r.json?.id;
check('赠送折算金额 = 节数 × 单价', eq(r.json?.amount, '300.00'), `实际 ${r.json?.amount}`);
l = await Lesson('小明', '张老师', '钢琴主课', '2026-08-16', { isGift: true, giftGrantId: giftId });
await expectStatus('确认赠送课（只扣赠送池）', 'POST', `/lessons/${l}/confirm`, { confirmedAt: '2026-08-16T10:00:00.000Z' }, owner, 201);
r = await call('GET', `/gifts?studentId=${stu['小明']}`, null, owner);
const g = (r.json?.items ?? r.json ?? [])[0];
check('赠送剩余额度用算的（1 赠 1 用 = 0）', eq(g?.remaining, 0), `实际 ${g?.remaining}`);

await expectStatus('8月其它支出：房租 4000', 'POST', '/finance/other-expenses', {
  expenseItemId: (await call('GET', '/items/expense', null, owner)).json.find((i) => i.name === '房租').id,
  period: '2026-08', summary: '8月房租', cashAmount: 4000, occurredAt: '2026-08-01T00:00:00.000Z',
}, owner, 201);
await expectStatus('8月其它支出：水电 250', 'POST', '/finance/other-expenses', {
  expenseItemId: (await call('GET', '/items/expense', null, owner)).json.find((i) => i.name === '水电').id,
  period: '2026-08', summary: '8月水电', cashAmount: 250, occurredAt: '2026-08-30T00:00:00.000Z',
}, owner, 201);
await expectStatus('8月手工收入：书款 500', 'POST', '/finance/manual-incomes', {
  incomeItemId: itemBook.id, period: '2026-08', amount: 500, note: '教材',
}, owner, 201);

await expectStatus('录入张老师 8 月工资基础项', 'PUT', `/payroll/${th['张老师']}`, {
  period: '2026-08', attendanceExpected: 20, attendanceActual: 18, attendanceAbsent: 2, baseSalary: 3000,
}, owner, 200);
await expectStatus('录入李老师 8 月工资基础项', 'PUT', `/payroll/${th['李老师']}`, {
  period: '2026-08', baseSalary: 2000,
}, owner, 200);

r = await call('GET', '/payroll?period=2026-08', null, owner);
const zhang = (r.json?.rows ?? []).find((x) => x.teacherName === '张老师');
check('8月张老师业绩 = 1250（600+300+350）', eq(zhang?.performance, '1250.00'), `实际 ${zhang?.performance}`);
check('8月张老师课消奖 = 150（业绩 × 0.12）', eq(zhang?.commission, '150.00'), `实际 ${zhang?.commission}`);
check('8月张老师应发 = 3150', eq(zhang?.grossSalary, '3150.00'), `实际 ${zhang?.grossSalary}`);
r = await call('GET', '/payroll/totals?period=2026-08', null, owner);
check('8月应发合计（经营支出）= 5150', eq(r.json?.accruedTotal, '5150.00'), `实际 ${r.json?.accruedTotal}`);
check('8月现金工资 = 上月应发 → 首月回落机构设置 4800', eq(r.json?.cashTotal, '4800.00'), `实际 ${r.json?.cashTotal}`);

console.log('===== 6. 九月 =====');
await expectStatus('9月交费 小明 900', 'POST', '/payments',
  { enrollmentId: en['小明-钢琴主课'], amount: 900, incomeItemId: itemPiano.id, occurredAt: '2026-09-03T02:00:00.000Z' }, owner, 201);
await expectStatus('9月交费 小刚 100', 'POST', '/payments',
  { enrollmentId: en['小刚-陪练课'], amount: 100, incomeItemId: itemPiano.id, occurredAt: '2026-09-08T02:00:00.000Z' }, owner, 201);
l = await Lesson('小明', '张老师', '钢琴主课', '2026-09-05T02:00:00.000Z');
await expectStatus('确认小明 9/5', 'POST', `/lessons/${l}/confirm`, { confirmedAt: '2026-09-05T10:00:00.000Z' }, owner, 201);
l = await Lesson('小刚', '李老师', '陪练课', '2026-09-09T02:00:00.000Z');
await expectStatus('确认小刚 9/9（李老师业绩）', 'POST', `/lessons/${l}/confirm`, { confirmedAt: '2026-09-09T10:00:00.000Z' }, owner, 201);
r = await expectStatus('赠送小丽 1 节', 'POST', '/gifts', {
  enrollmentId: en['小丽-乐理课'], lessons: 1, activityName: '九月引流',
  grantedAt: '2026-09-20T02:00:00.000Z',
}, owner, 201);
await expectStatus('撤销小丽的赠送（GL-03）', 'POST', `/gifts/${r.json?.id}/revoke`, null, owner, 201);
await expectStatus('9月其它支出：房租 4000', 'POST', '/finance/other-expenses', {
  expenseItemId: (await call('GET', '/items/expense', null, owner)).json.find((i) => i.name === '房租').id,
  period: '2026-09', summary: '9月房租', cashAmount: 4000, occurredAt: '2026-09-01T00:00:00.000Z',
}, owner, 201);
await expectStatus('录入张老师 9 月工资（含钢琴奖与社保代扣）', 'PUT', `/payroll/${th['张老师']}`, {
  period: '2026-09', baseSalary: 3000, pianoBonus: 200,
  deductions: [{ deductionItemId: itemShebao.id, amount: 400 }],
}, owner, 200);
await expectStatus('录入李老师 9 月工资基础项', 'PUT', `/payroll/${th['李老师']}`, {
  period: '2026-09', baseSalary: 2000,
}, owner, 200);
r = await call('GET', '/payroll?period=2026-09', null, owner);
const z9 = (r.json?.rows ?? []).find((x) => x.teacherName === '张老师');
check('9月张老师业绩 = 300', eq(z9?.performance, '300.00'), `实际 ${z9?.performance}`);
check('9月张老师课消奖 = 36', eq(z9?.commission, '36.00'), `实际 ${z9?.commission}`);
check('9月张老师应发 = 3236（3000+200+36）', eq(z9?.grossSalary, '3236.00'), `实际 ${z9?.grossSalary}`);
check('9月张老师实发 = 2836（扣社保 400）', eq(z9?.netSalary, '2836.00'), `实际 ${z9?.netSalary}`);
const li9 = (r.json?.rows ?? []).find((x) => x.teacherName === '李老师');
check('9月李老师业绩 = 200', eq(li9?.performance, '200.00'), `实际 ${li9?.performance}`);
r = await call('GET', '/payroll/totals?period=2026-10', null, owner);
check('10月现金工资 = 9月应发 5256（两口径相差一个月）', eq(r.json?.cashTotal, '5256.00'), `实际 ${r.json?.cashTotal}`);

console.log('===== 7. 十月：退费 / 学生状态 / 欠费 =====');
await expectStatus('10月交费 小红 350', 'POST', '/payments',
  { enrollmentId: en['小红-钢琴主课'], amount: 350, incomeItemId: itemPiano.id, occurredAt: '2026-10-01T02:00:00.000Z' }, owner, 201);
l = await Lesson('小明', '张老师', '钢琴主课', '2026-10-02T02:00:00.000Z');
await expectStatus('确认小明 10/2', 'POST', `/lessons/${l}/confirm`, { confirmedAt: '2026-10-02T10:00:00.000Z' }, owner, 201);
await expectStatus('小强退费（手续费 3%）', 'POST', '/refunds',
  { studentId: stu['小强'], mode: 'REFUND', occurredAt: '2026-10-03T02:00:00.000Z' }, owner, 201);
r = await call('GET', '/refunds', null, owner);
const refund = (r.json?.items ?? r.json ?? [])[0];
check('退费手续费 = 900 × 3% = 27', eq(refund?.feeAmount, '27.00'), `实际 ${refund?.feeAmount}`);
check('实退 = 873', eq(refund?.refundAmount, '873.00'), `实际 ${refund?.refundAmount}`);
r = await call('GET', `/students/${stu['小强']}`, null, owner);
check('退费后学生状态 = 退学', eq(r.json?.status, 'WITHDRAWN'), `实际 ${r.json?.status}`);
await expectStatus('小丽改停课并标记退费意向', 'PATCH', `/students/${stu['小丽']}`,
  { status: 'PAUSED', wantsRefund: true }, owner, 200);

console.log('===== 8. 台账断言（US-ML-01/02） =====');
r = await call('GET', `/ledger/students/${stu['小明']}`, null, owner);
let row = r.json?.enrollments?.[0];
check('小明实收余额 = 2700', eq(row?.paidBalance, '2700.00'), `实际 ${row?.paidBalance}`);
check('小明赠送余额 = 0（赠 1 用 1）', eq(row?.giftBalance, '0.00'), `实际 ${row?.giftBalance}`);
check('小明预计剩余课时 = 9', Number(row?.remainingLessons) === 9, `实际 ${row?.remainingLessons}`);
r = await call('GET', `/ledger/students/${stu['小刚']}`, null, owner);
row = r.json?.enrollments?.[0];
check('小刚余额 = -100（欠费是合法状态）', eq(row?.totalBalance, '-100.00'), `实际 ${row?.totalBalance}`);
check('小刚被标记为欠费', eq(r.json?.balanceStatus, '欠费'), `实际 ${r.json?.balanceStatus}`);

console.log('===== 9. 风险提醒（US-RA-01/02） =====');
r = await call('GET', '/risks/unpaid', null, owner);
check('欠费名单含小刚', JSON.stringify(r.json ?? []).includes('小刚'));
r = await call('GET', '/risks/sleeping', null, teacher ?? owner);
check('沉睡名单老师也能看（任何角色可见）', r.status === 200, `实际 ${r.status}`);
const sl = r.json ?? {};
check('阈值 40 天由后端下发', sl.thresholdDays === 40, `实际 ${sl.thresholdDays}`);
check('小军属于沉睡（最后确认 8/10，超 40 天）',
  (sl.sleeping ?? []).some((x) => x.studentName === '小军'), JSON.stringify(sl.sleeping ?? []).slice(0, 120));
check('小丽属于「从未上过课」而非沉睡', (sl.never ?? []).some((x) => x.studentName === '小丽'));
check('小明不算沉睡（10/2 刚上过课）', !(sl.sleeping ?? []).some((x) => x.studentName === '小明'));
r = await call('GET', '/refunds/pending-losses', null, owner);
const lossNames = JSON.stringify(r.json ?? []);
check('待处理流失含小丽（退费意向）与小强（退学）', lossNames.includes('小丽') && lossNames.includes('小强'));

console.log('===== 10. 报表断言（US-IE / PR） =====');
r = await call('GET', '/finance/income-statement?period=2026-10', null, owner);
const octIncome = r.json ?? [];
const lessonRow = octIncome.find((x) => x.name === '课时消费');
check('10月课时消费 = 300', eq(lessonRow?.month?.consumption, '300.00'), `实际 ${lessonRow?.month?.consumption}`);
const pianoRow = octIncome.find((x) => x.name === '钢琴');
check('10月钢琴收入（交费）= 350', eq(pianoRow?.month?.cash, '350.00'), `实际 ${pianoRow?.month?.cash}`);
const refundFeeRow = octIncome.find((x) => x.name === '退费手续费');
check('10月退费手续费 = 27', eq(refundFeeRow?.month?.cash, '27.00'), `实际 ${refundFeeRow?.month?.cash}`);

r = await call('GET', '/finance/expense-statement?period=2026-09', null, owner);
const sepExpense = r.json ?? [];
const wageRow = sepExpense.find((x) => x.name === '工资');
check('9月工资经营口径 = 本月应发 5256', eq(wageRow?.month?.operating, '5256.00'), `实际 ${wageRow?.month?.operating}`);
check('9月工资现金口径 = 上月应发 5150', eq(wageRow?.month?.cash, '5150.00'), `实际 ${wageRow?.month?.cash}`);
const rentRow = sepExpense.find((x) => x.name === '房租');
check('9月房租 = 4000（现金=经营）', eq(rentRow?.month?.cash, '4000.00') && eq(rentRow?.month?.operating, '4000.00'));

r = await call('GET', '/finance/expense-statement?period=2026-08', null, owner);
const augGift = (r.json ?? []).find((x) => x.name === '赠课成本');
check('8月赠课成本 = 300（赠送当月一次性计入）', eq(augGift?.month?.operating, '300.00'), `实际 ${augGift?.month?.operating}`);

r = await call('GET', '/analytics/teacher-ranking?period=2026-08', null, owner);
const rank = r.json ?? [];
check('8月教师排行第一名是张老师（服务端排序）', rank[0]?.teacherName === '张老师' && rank[0]?.rank === 1,
  JSON.stringify(rank.slice(0, 2)));

console.log('===== 11. 关账（US-PC-01/02） =====');
await expectStatus('锁定 2026-08', 'POST', '/periods/2026-08/close', null, owner, 201);
await expectStatus('关账后再向 8 月记账要 409', 'POST', '/payments',
  { enrollmentId: en['小明-钢琴主课'], amount: 100, incomeItemId: itemPiano.id, occurredAt: '2026-08-25T02:00:00.000Z' }, owner, 409);
l = await Lesson('小明', '张老师', '钢琴主课', '2026-08-28T02:00:00.000Z');
await expectStatus('补录确认时间落在关账月要 409', 'POST', `/lessons/${l}/confirm`,
  { confirmedAt: '2026-08-28T10:00:00.000Z' }, owner, 409);
r = await call('GET', '/periods/closed', null, owner);
check('已锁月份可查', JSON.stringify(r.json ?? []).includes('2026-08'));

console.log('===== 12. 权限与边界 =====');
r = await call('GET', '/overview?period=2026-10', null, teacher);
check('老师看不到经营总览（403）', r.status === 403, `实际 ${r.status}`);
r = await call('GET', '/payroll/me?period=2026-09', null, teacher);
check('老师看自己的工资（US-PR-07）', r.status === 200 && r.json?.teacherName === '张老师',
  `实际 ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
r = await call('GET', '/payroll?period=2026-09', null, teacher);
check('老师看整张工资表（403）', r.status === 403, `实际 ${r.status}`);

console.log('\n===== 汇总 =====');
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('\n失败清单：');
  for (const f of failures) console.log('  -', f);
}
process.exit(failures.length > 0 ? 1 : 0);
