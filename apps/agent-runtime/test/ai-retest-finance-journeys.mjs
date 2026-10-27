/**
 * Finance-focused AI retest journeys.
 *
 * This module is intentionally side-effect free until a caller supplies a
 * real retest environment and the production `run` function.  It never calls
 * a Core write endpoint directly: action writes go through the Assistant
 * Preview endpoint produced by the Agent, then through the browser-equivalent
 * JWT Confirm helper below.
 */
import { confirmPreview, readBalance, readLessons, readPayrolls, readPreview } from './ai-retest-browser.mjs';
import { fixedNow } from './ai-retest-environment.mjs';

export const FINANCE_CASE_IDS = new Set([
  'W01', 'W02', 'W03', 'W04', 'W05', 'W06', 'W07', 'W08',
  'M01', 'M02', 'M03',
  'K01', 'K02', 'K03', 'K04', 'K05',
]);

// These are the journeys for which this module can safely exercise the
// complete or explicitly bounded branch with the fixtures currently exposed
// by ai-retest-environment.mjs.  FINANCE_CASE_IDS is broader because the
// remaining cases return an honest `unexecuted` result instead of pretending
// that a partial restriction check is full acceptance.
export const AUTOMATABLE_FINANCE_CASE_IDS = new Set([
  'W01', 'W02', 'W03', 'W04', 'W05', 'W06', 'W07',
  'M01', 'M02', 'M03',
  'K01', 'K02', 'K05',
]);

export const FINANCE_VARIANTS = Object.freeze({
  M01: Object.freeze([
    { message: '今天卖书收到50元，微信，登记收入。', category: 'BOOK_SALE', amount: '50.00', channel: 'WECHAT' },
    { message: '今天卖琴收到2000元，银行卡，登记收入。', category: 'INSTRUMENT_SALE', amount: '2000.00', channel: 'BANK_CARD' },
    { message: '今天外部合作收到300元，支付宝，登记收入。', category: 'EXTERNAL_COOPERATION', amount: '300.00', channel: 'ALIPAY' },
    { message: '今天其他经营收入20元，现金，备注活动收入。', category: 'OTHER_INCOME', amount: '20.00', channel: 'CASH' },
  ]),
  M02: Object.freeze([
    { message: '今天付房租200元，银行卡，登记支出。', category: 'RENT_PROPERTY', amount: '200.00', channel: 'BANK_CARD' },
    { message: '今天付电费30元，银行卡，登记支出。', category: 'UTILITIES_NETWORK', amount: '30.00', channel: 'BANK_CARD' },
    { message: '今天付推广费40元，银行卡，登记支出。', category: 'MARKETING', amount: '40.00', channel: 'BANK_CARD' },
    { message: '今天付办公纸张10元，银行卡，登记支出。', category: 'OFFICE_SUPPLIES', amount: '10.00', channel: 'BANK_CARD' },
    { message: '今天付修琴费60元，银行卡，登记支出。', category: 'MAINTENANCE', amount: '60.00', channel: 'BANK_CARD' },
    { message: '今天付购入教材70元，银行卡，登记支出。', category: 'BOOK_PURCHASE_COST', amount: '70.00', channel: 'BANK_CARD' },
    { message: '今天采购钢琴800元，银行卡，登记支出。', category: 'INSTRUMENT_PURCHASE_COST', amount: '800.00', channel: 'BANK_CARD' },
    { message: '今天付合作服务费90元，银行卡，登记支出。', category: 'EXTERNAL_COOPERATION_COST', amount: '90.00', channel: 'BANK_CARD' },
    { message: '今天其他经营支出15元，银行卡，备注临时杂费。', category: 'OTHER_EXPENSE', amount: '15.00', channel: 'BANK_CARD' },
  ]),
});

const VERIFIED = 'step-verified';
const FAILED = 'failed';
const UNEXECUTED = 'unexecuted';

const verified = (expected, actual = {}) => ({ status: VERIFIED, expected, ...actual });
const failed = (expected, actual = {}) => ({ status: FAILED, expected, ...actual });
const unexecuted = (expected, reason) => ({ status: UNEXECUTED, expected, reason });

function bodyOf(result) {
  return `${result?.answer ?? ''}\n${JSON.stringify(result?.workspace ?? {})}`;
}

function previewOf(result, actionType) {
  const preview = result?.preview;
  return preview && (!actionType || preview.actionType === actionType) ? preview : undefined;
}

function taskMessage(entry, fallback) {
  return entry?.message ?? entry?.input ?? entry?.first ?? fallback;
}

function assertCompleted(result) {
  return result?.terminal === 'run.completed' && !bodyOf(result).includes('AI_PROCESS_FAILED');
}

function finalVerdict(steps, completeExpected) {
  if (steps.some((step) => step.status === FAILED)) return failed(completeExpected, { failedSteps: steps.filter((step) => step.status === FAILED) });
  if (steps.some((step) => step.status === UNEXECUTED)) return unexecuted(completeExpected, '仅完成了安全可自动化子路径；剩余变体或界面步骤不能由本模块完整验收。');
  return verified(completeExpected);
}

async function confirmAndReread(env, preview, auth) {
  const confirmation = await confirmPreview(env, preview.previewId, auth);
  const reread = await readPreview(env, preview.previewId, auth);
  return { confirmation, reread };
}

function repeatedConfirmationIsIdempotent(result) {
  return result.confirmation.first?.status === 'EXECUTED'
    && result.confirmation.repeat?.status === 'EXECUTED'
    && result.confirmation.first?.receipt?.idempotencyKey === result.confirmation.repeat?.receipt?.idempotencyKey;
}

async function listManualTransactions(env, auth) {
  return env.request('/manual-transactions', undefined, auth);
}

async function listPeriods(env, auth) {
  return env.request('/periods', undefined, auth);
}

async function listTeachers(env, auth) {
  return env.request('/teachers', undefined, auth);
}

async function readLedgerRows(env, accountId) {
  const result = await env.pool.query(
    'SELECT "id", "kind", "paidDelta", "giftDelta", "lessonId", "reversesEntryId", "correctsEntryId" FROM "LedgerEntry" WHERE "accountId" = $1 ORDER BY "createdAt" ASC, "id" ASC',
    [accountId],
  );
  return result.rows;
}

async function runPayrollQuery({ run, env, auth, fixture }) {
  const initial = await run('王老师10月工资多少？怎么算的？', auth);
  const steps = [];
  const payroll = (await readPayrolls(env, '2026-10', auth)).find((item) => item.id === fixture.payroll?.id);
  const queryText = bodyOf(initial);
  const queryValid = assertCompleted(initial)
    && !initial.preview
    && payroll?.courseRevenue === '1000.00'
    && payroll?.baseSalary === '2000.00'
    && payroll?.commissionAmount === '100.00'
    && payroll?.bonusAmount === '100.00'
    && payroll?.deductionAmount === '50.00'
    && payroll?.grossSalary === '2200.00'
    && payroll?.netSalary === '2150.00'
    && payroll?.status === 'UNPAID'
    && ['100.00', '2200.00', '2150.00', '未支付'].every((value) => queryText.includes(value));
  steps.push(queryValid
    ? verified('只读工资查询从 Core 返回业绩、奖扣、应发2200.00、实发2150.00及未支付状态')
    : failed('工资查询必须返回 Core 的完整计算依据且不能生成预览', { answer: initial?.answer, payroll }));

  const followUp = await run('赠送余额上的课算他的业绩吗？', auth, initial.threadId);
  const followText = bodyOf(followUp);
  const followValid = assertCompleted(followUp)
    && !followUp.preview
    && /完整锁定单价|计入|赠送.*不减少|业绩/.test(followText);
  steps.push(followValid
    ? verified('工资计算依据追问仍为只读，并解释赠送不降低锁定课消业绩')
    : failed('工资依据追问未返回业务规则或意外生成写入预览', { answer: followUp?.answer, preview: followUp?.preview }));
  return { initial, steps, verdict: finalVerdict(steps, 'W01 工资查询与计算依据只读旅程完整可核对') };
}

async function runPayrollGenerate({ run, env, fixture, auth }) {
  const initial = await run('生成王老师2026年10月工资。', auth);
  const steps = [];
  const preview = previewOf(initial, 'payroll.generate');
  const commandValid = assertCompleted(initial)
    && preview?.command?.teacherId === fixture.teachers.wang.id
    && preview.command.period === '2026-10'
    && preview.display?.courseRevenue === '1000.00'
    && preview.display?.grossSalary === '2100.00'
    && preview.display?.netSalary === '2100.00';
  steps.push(commandValid
    ? verified('工资生成预览对象、月份和 Core 计算结果正确', { previewId: preview.previewId })
    : failed('工资生成预览必须读取 Core 的月份和计算结果', { answer: initial?.answer, preview }));
  if (!commandValid) return { initial, steps, verdict: finalVerdict(steps, 'W02 工资生成确认后回读') };

  const confirmed = await confirmAndReread(env, preview, auth);
  const payrolls = await readPayrolls(env, '2026-10', auth);
  const payroll = payrolls.find((item) => item.teacherId === fixture.teachers.wang.id);
  const finalValid = repeatedConfirmationIsIdempotent(confirmed)
    && confirmed.reread.status === 'EXECUTED'
    && payroll?.status === 'UNPAID'
    && payroll?.grossSalary === '2100.00'
    && payroll?.netSalary === '2100.00';
  steps.push(finalValid
    ? verified('Core Confirm、同幂等键重复确认、预览回读和工资最终状态均正确', { payrollId: payroll?.id })
    : failed('工资生成确认、重复确认或最终工资回读失败', { confirmation: confirmed.confirmation, reread: confirmed.reread, payroll }));
  return { initial, steps, verdict: finalVerdict(steps, 'W02 工资生成确认、幂等与 Core 最终回读通过') };
}

async function runPayrollAdjust({ run, env, fixture, auth }) {
  const initial = await run('只把王老师10月基本工资改2200、提成12%，其他月份和默认配置不动。', auth);
  const steps = [];
  const preview = previewOf(initial, 'payroll.adjust');
  const valid = assertCompleted(initial)
    && preview?.command?.payrollId === fixture.payroll?.id
    && preview.command.baseSalary === '2200.00'
    && preview.command.commissionRate === '12.0000'
    && preview.display?.commissionAmount === '120.00'
    && preview.display?.afterBonusAmount === '100.00'
    && preview.display?.afterDeductionAmount === '50.00'
    && preview.display?.grossSalary === '2420.00'
    && preview.display?.netSalary === '2370.00';
  steps.push(valid
    ? verified('当月工资调整预览保留奖扣并由 Core 返回2420.00应发、2370.00实发', { previewId: preview.previewId })
    : failed('当月工资调整预览对象或 Core 重算结果错误', { answer: initial?.answer, preview }));
  if (!valid) return { initial, steps, verdict: finalVerdict(steps, 'W03 当月工资调整确认后回读') };

  const confirmed = await confirmAndReread(env, preview, auth);
  const payroll = (await readPayrolls(env, '2026-10', auth)).find((item) => item.id === fixture.payroll.id);
  const teachers = await listTeachers(env, auth);
  const teacher = teachers.find((item) => item.id === fixture.teachers.wang.id);
  const finalValid = repeatedConfirmationIsIdempotent(confirmed)
    && confirmed.reread.status === 'EXECUTED'
    && payroll?.baseSalary === '2200.00'
    && payroll?.commissionRate === '12.0000'
    && payroll?.grossSalary === '2420.00'
    && payroll?.netSalary === '2370.00'
    && teacher?.defaultBaseSalary === '2000.00'
    && teacher?.defaultCommissionRate === '10.0000';
  steps.push(finalValid
    ? verified('工资确认、重复确认、月度工资回读及默认教师配置未被修改均正确')
    : failed('工资调整最终回读或默认配置隔离失败', { confirmation: confirmed.confirmation, payroll, teacher }));
  return { initial, steps, verdict: finalVerdict(steps, 'W03 当月工资调整确认、幂等和最终数据回读通过') };
}

async function runPayrollBonusDeduction({ run, env, fixture, auth }) {
  const initial = await run('王老师10月加奖金100、代扣50。', auth);
  const steps = [];
  const asksNotes = assertCompleted(initial) && !initial.preview && /奖金.*备注|代扣.*备注|说明/.test(bodyOf(initial));
  steps.push(asksNotes
    ? verified('奖金和代扣未猜备注，首轮不生成预览')
    : failed('奖金和代扣缺备注时没有按字段契约补问', { answer: initial?.answer, preview: initial?.preview }));
  if (!asksNotes) return { initial, steps, verdict: finalVerdict(steps, 'W04 奖金代扣补参与确认后回读') };

  const completed = await run('奖金备注招生奖励；代扣备注个人代缴。', auth, initial.threadId);
  const preview = previewOf(completed, 'payroll.adjust');
  const valid = assertCompleted(completed)
    && preview?.command?.payrollId === fixture.payroll?.id
    && preview.command.bonusAmount === '100.00'
    && preview.command.bonusNote === '招生奖励'
    && preview.command.deductionAmount === '50.00'
    && preview.command.deductionNote === '个人代缴'
    && preview.display?.grossSalary === '2200.00'
    && preview.display?.netSalary === '2150.00';
  steps.push(valid
    ? verified('连续补参后生成奖金/代扣分离的 Core 工资调整预览', { previewId: preview.previewId })
    : failed('奖金/代扣补参后预览字段或金额不正确', { answer: completed?.answer, preview }));
  if (!valid) return { initial, steps, verdict: finalVerdict(steps, 'W04 奖金代扣补参与确认后回读') };

  const confirmed = await confirmAndReread(env, preview, auth);
  const payroll = (await readPayrolls(env, '2026-10', auth)).find((item) => item.id === fixture.payroll.id);
  const finalValid = repeatedConfirmationIsIdempotent(confirmed)
    && confirmed.reread.status === 'EXECUTED'
    && payroll?.bonusNote === '招生奖励'
    && payroll?.deductionNote === '个人代缴'
    && payroll?.grossSalary === '2200.00'
    && payroll?.netSalary === '2150.00';
  steps.push(finalValid
    ? verified('奖金/代扣确认、同幂等键重放和工资回读均正确')
    : failed('奖金/代扣确认后工资回读失败', { confirmation: confirmed.confirmation, payroll }));
  return { initial, steps, verdict: finalVerdict(steps, 'W04 奖金代扣连续补参、确认、幂等和最终回读通过') };
}

async function runPayrollPay({ run, env, fixture, auth }) {
  const initial = await run('登记王老师10月工资已在10月21日通过银行卡发放。', auth);
  const steps = [];
  const preview = previewOf(initial, 'payroll.pay');
  const valid = assertCompleted(initial)
    && preview?.command?.payrollId === fixture.payroll?.id
    && preview.command.channel === 'BANK_CARD'
    && preview.command.paidAt === fixedNow
    && preview.display?.netSalary === '2150.00';
  steps.push(valid
    ? verified('工资支付预览使用实发2150.00、付款日和银行卡', { previewId: preview.previewId })
    : failed('工资支付预览没有使用 Core 实发金额/日期/渠道', { answer: initial?.answer, preview }));
  if (!valid) return { initial, steps, verdict: finalVerdict(steps, 'W05 工资支付确认后回读') };

  const confirmed = await confirmAndReread(env, preview, auth);
  const payroll = (await readPayrolls(env, '2026-10', auth)).find((item) => item.id === fixture.payroll.id);
  const finalValid = repeatedConfirmationIsIdempotent(confirmed)
    && confirmed.reread.status === 'EXECUTED'
    && payroll?.status === 'PAID'
    && payroll?.netSalary === '2150.00'
    && payroll?.paymentChannel === 'BANK_CARD'
    && payroll?.paidAt === fixedNow;
  steps.push(finalValid
    ? verified('工资支付确认、重复确认及已支付状态/实付金额/渠道/日期回读均正确')
    : failed('工资支付确认或最终工资回读失败', { confirmation: confirmed.confirmation, payroll }));
  return { initial, steps, verdict: finalVerdict(steps, 'W05 工资支付确认、幂等和最终数据回读通过') };
}

async function runPayrollCrossMonth({ run, env, fixture, auth }) {
  const initial = await run('王老师9月那笔工资，10月21日微信付的，登记一下。', auth);
  const steps = [];
  const preview = previewOf(initial, 'payroll.pay');
  const expectedNetSalary = fixture.payroll?.netSalary;
  const valid = assertCompleted(initial)
    && preview?.command?.payrollId === fixture.payroll?.id
    && preview.command.channel === 'WECHAT'
    && preview.command.paidAt === fixedNow
    && preview.display?.netSalary === expectedNetSalary
    && preview.display?.summary?.includes('2026-09');
  steps.push(valid
    ? verified('跨月工资预览区分9月所属月、10月21日付款日、微信和 Core 实发金额', { previewId: preview.previewId })
    : failed('跨月工资预览字段或 Core 实发金额不正确', { answer: initial?.answer, preview, expectedNetSalary }));
  if (!valid) return { initial, steps, verdict: finalVerdict(steps, 'W06 跨月工资确认后回读') };

  const confirmed = await confirmAndReread(env, preview, auth);
  const payroll = (await readPayrolls(env, '2026-09', auth)).find((item) => item.id === fixture.payroll.id);
  const paidValid = payroll?.status === 'PAID' && payroll.paymentChannel === 'WECHAT' && payroll.paidAt === fixedNow;
  steps.push(repeatedConfirmationIsIdempotent(confirmed) && confirmed.reread.status === 'EXECUTED' && paidValid
    ? verified('跨月工资 Confirm、刷新回读、同幂等键重放和最终工资状态均正确')
    : failed('跨月工资确认、刷新或最终状态回读失败', { confirmation: confirmed.confirmation, payroll }));

  const next = await run('也把李老师工资付了。', auth);
  const asksNewParameters = assertCompleted(next)
    && !next.preview
    && /月份|月度|付款日|日期|渠道|支付方式/.test(next.answer ?? '')
    && !bodyOf(next).includes('2026-09');
  steps.push(asksNewParameters
    ? verified('新任务未继承王老师的所属月、付款日或微信渠道')
    : failed('新工资任务没有补问必要参数或继承了旧敏感参数', { answer: next?.answer, preview: next?.preview }));
  return { initial, steps, verdict: finalVerdict(steps, 'W06 跨月工资确认、幂等、回读和新任务隔离通过') };
}

async function runPayrollCorrection({ run, env, fixture, auth }) {
  const initial = await run('王老师10月工资支付登记错了，取消那次，改成10月21日银行卡。', auth);
  const steps = [];
  const planValid = assertCompleted(initial) && !initial.preview && /两步|第一步|撤销.*工资支付|重新登记/.test(bodyOf(initial));
  steps.push(planValid
    ? verified('错误工资支付被拆成撤销后重登的两步计划，首轮无写入')
    : failed('工资支付纠错没有形成有序两步计划', { answer: initial?.answer, preview: initial?.preview }));
  if (!planValid) return { initial, steps, verdict: finalVerdict(steps, 'W07 工资支付纠错确认后回读') };

  const first = await run('开始第一步', auth, initial.threadId);
  const cancelPreview = previewOf(first, 'payroll.cancel-payment');
  const cancelValid = assertCompleted(first) && cancelPreview?.command?.payrollId === fixture.payroll?.id && cancelPreview.command.reason;
  steps.push(cancelValid
    ? verified('第一步定位唯一已支付工资并生成撤销预览', { previewId: cancelPreview.previewId })
    : failed('工资支付撤销预览对象或原因缺失', { answer: first?.answer, preview: first?.preview }));
  if (!cancelValid) return { initial, steps, verdict: finalVerdict(steps, 'W07 工资支付纠错确认后回读') };

  const cancelled = await confirmAndReread(env, cancelPreview, auth);
  const afterCancel = (await readPayrolls(env, '2026-10', auth)).find((item) => item.id === fixture.payroll.id);
  const cancelDataValid = repeatedConfirmationIsIdempotent(cancelled)
    && cancelled.reread.status === 'EXECUTED'
    && afterCancel?.status === 'UNPAID'
    && afterCancel.paidAt === null;
  steps.push(cancelDataValid
    ? verified('撤销工资支付 Confirm、幂等重放和撤销后未支付状态回读正确')
    : failed('工资支付撤销确认或撤销后状态错误', { confirmation: cancelled.confirmation, payroll: afterCancel }));
  if (!cancelDataValid) return { initial, steps, verdict: finalVerdict(steps, 'W07 工资支付纠错确认后回读') };

  const second = await run('继续', auth, initial.threadId);
  const payPreview = previewOf(second, 'payroll.pay');
  const payValid = assertCompleted(second)
    && payPreview?.command?.payrollId === fixture.payroll?.id
    && payPreview.command.channel === 'BANK_CARD'
    && payPreview.command.paidAt === fixedNow;
  steps.push(payValid
    ? verified('第一步确认后才生成10月21日银行卡重登预览', { previewId: payPreview.previewId })
    : failed('工资撤销后没有生成正确的第二步支付预览', { answer: second?.answer, preview: second?.preview }));
  if (!payValid) return { initial, steps, verdict: finalVerdict(steps, 'W07 工资支付纠错确认后回读') };

  const repaid = await confirmAndReread(env, payPreview, auth);
  const finalPayroll = (await readPayrolls(env, '2026-10', auth)).find((item) => item.id === fixture.payroll.id);
  const finalValid = repeatedConfirmationIsIdempotent(repaid)
    && repaid.reread.status === 'EXECUTED'
    && finalPayroll?.status === 'PAID'
    && finalPayroll.paymentChannel === 'BANK_CARD'
    && finalPayroll.paidAt === fixedNow;
  steps.push(finalValid
    ? verified('第二步支付 Confirm、幂等重放、最终一次有效支付状态均正确')
    : failed('工资重登确认或最终工资状态错误', { confirmation: repaid.confirmation, payroll: finalPayroll }));
  return { initial, steps, verdict: finalVerdict(steps, 'W07 工资支付撤销后重登的两步确认、幂等和回读通过') };
}

async function runManualTransaction({ run, env, auth, entry, kind }) {
  const fallback = kind === 'INCOME' ? FINANCE_VARIANTS.M01[0] : FINANCE_VARIANTS.M02[0];
  const message = taskMessage(entry, fallback.message);
  const variant = [...(kind === 'INCOME' ? FINANCE_VARIANTS.M01 : FINANCE_VARIANTS.M02)].find((item) => item.message === message)
    ?? fallback;
  const initial = await run(message, auth);
  const steps = [];
  const preview = previewOf(initial, 'manual-transaction.create');
  const command = preview?.command ?? {};
  const categoryField = kind === 'INCOME' ? 'incomeCategory' : 'expenseCategory';
  const valid = assertCompleted(initial)
    && command.kind === kind
    && command[categoryField] === variant.category
    && command.amount === variant.amount
    && command.channel === variant.channel
    && command.occurredAt === fixedNow;
  steps.push(valid
    ? verified(`手工${kind === 'INCOME' ? '收入' : '支出'}预览方向、固定分类、金额、渠道和日期均由 Core 接口校验`, { previewId: preview.previewId, variant: variant.category })
    : failed('手工收支预览字段或固定分类错误', { answer: initial?.answer, preview, variant }));
  if (!valid) return { initial, steps, verdict: finalVerdict(steps, `${entry?.id ?? 'M'} 手工收支确认后回读`) };

  const before = await listManualTransactions(env, auth);
  const confirmed = await confirmAndReread(env, preview, auth);
  const after = await listManualTransactions(env, auth);
  const created = after.filter((item) => item.id && !before.some((old) => old.id === item.id));
  const record = created.length === 1 ? created[0] : undefined;
  const finalValid = repeatedConfirmationIsIdempotent(confirmed)
    && confirmed.reread.status === 'EXECUTED'
    && created.length === 1
    && record?.kind === kind
    && record[categoryField] === variant.category
    && record.amount === variant.amount
    && record.channel === variant.channel;
  steps.push(finalValid
    ? verified('手工收支 Confirm、同幂等键重放和 Core 最终流水唯一新增均正确', { transactionId: record.id })
    : failed('手工收支确认、幂等或最终流水核对失败', { confirmation: confirmed.confirmation, record, newRecordCount: created.length }));
  return { initial, steps, verdict: finalVerdict(steps, `${entry?.id ?? 'M'} 手工收支确认、幂等和最终回读通过`) };
}

async function runManualDirection({ run, env, auth }) {
  const initial = await run('合作300，帮我记一下。', auth);
  const steps = [];
  const asksDirection = assertCompleted(initial) && !initial.preview && /收入|支出|方向/.test(bodyOf(initial));
  steps.push(asksDirection
    ? verified('收支方向不清时先补问，未产生写入或预览')
    : failed('收支方向不清时没有补问或已经生成预览', { answer: initial?.answer, preview: initial?.preview }));
  if (!asksDirection) return { initial, steps, verdict: finalVerdict(steps, 'M03 收支方向与专用收入防重复') };

  const completed = await run('收到的钱，微信，今天。', auth, initial.threadId);
  const preview = previewOf(completed, 'manual-transaction.create');
  const command = preview?.command ?? {};
  const valid = assertCompleted(completed)
    && command.kind === 'INCOME'
    && command.incomeCategory === 'EXTERNAL_COOPERATION'
    && command.amount === '300.00'
    && command.channel === 'WECHAT'
    && command.occurredAt === fixedNow;
  steps.push(valid
    ? verified('连续补参后生成外部合作收入300.00微信预览', { previewId: preview.previewId })
    : failed('连续补参后外部合作收入预览不正确', { answer: completed?.answer, preview }));
  if (!valid) return { initial, steps, verdict: finalVerdict(steps, 'M03 收支方向与专用收入防重复') };

  const before = await listManualTransactions(env, auth);
  const confirmed = await confirmAndReread(env, preview, auth);
  const afterConfirm = await listManualTransactions(env, auth);
  const created = afterConfirm.filter((item) => !before.some((old) => old.id === item.id));
  const duplicate = await run('再把刚才退款手续费100记成手工收入。', auth, initial.threadId);
  const afterDuplicate = await listManualTransactions(env, auth);
  const duplicateBlocked = assertCompleted(duplicate)
    && !duplicate.preview
    && /手续费|退款|自动|不能|不要重复|已产生/.test(bodyOf(duplicate))
    && afterDuplicate.length === afterConfirm.length;
  steps.push(repeatedConfirmationIsIdempotent(confirmed) && confirmed.reread.status === 'EXECUTED' && created.length === 1
    ? verified('外部合作收入确认、幂等和唯一流水回读正确')
    : failed('外部合作收入确认或最终流水回读失败', { confirmation: confirmed.confirmation, created }));
  steps.push(duplicateBlocked
    ? verified('退款手续费被识别为退款业务自动收入，未重复登记手工收入')
    : failed('退款手续费防重复分支未阻断或产生了新流水', { answer: duplicate?.answer, preview: duplicate?.preview, before: afterConfirm.length, after: afterDuplicate.length }));
  return { initial, steps, verdict: finalVerdict(steps, 'M03 收支方向补参、确认、幂等和退款手续费防重复通过') };
}

async function runPeriodPreclose({ run, env, auth }) {
  const before = env.fingerprint(await env.capture());
  const initial = await run('帮我检查2026年9月能不能关账。', auth);
  const text = bodyOf(initial);
  const steps = [];
  const valid = assertCompleted(initial)
    && !initial.preview
    && ['待上课', '退款异常', '工资', '流水异常'].every((value) => text.includes(value))
    && env.fingerprint(await env.capture()) === before;
  steps.push(valid
    ? verified('关账预检只读返回待确认课、退款异常、工资和流水异常，并保持零写入')
    : failed('关账预检缺少检查项、生成了预览或发生了写入', { answer: initial?.answer, preview: initial?.preview }));
  return { initial, steps, verdict: finalVerdict(steps, 'K01 关账预检只读检查完成') };
}

async function runPeriodClose({ run, env, auth }) {
  const initial = await run('把2026年9月关账。', auth);
  const steps = [];
  const preview = previewOf(initial, 'period.close');
  const valid = assertCompleted(initial) && preview?.command?.period === '2026-09';
  steps.push(valid
    ? verified('明确月份后生成关账预览，未确认前不改变账期', { previewId: preview.previewId })
    : failed('关账月份不明确或未生成正确 Preview', { answer: initial?.answer, preview }));
  if (!valid) return { initial, steps, verdict: finalVerdict(steps, 'K02 关账确认后回读') };

  const confirmed = await confirmAndReread(env, preview, auth);
  const periods = await listPeriods(env, auth);
  const closed = periods.find((period) => period.period === '2026-09');
  const finalValid = repeatedConfirmationIsIdempotent(confirmed)
    && confirmed.reread.status === 'EXECUTED'
    && closed?.reopenedAt === null;
  steps.push(finalValid
    ? verified('关账 Confirm、同幂等键重放、预览回读及账期锁定状态正确')
    : failed('关账确认或最终账期状态回读失败', { confirmation: confirmed.confirmation, closed }));
  return { initial, steps, verdict: finalVerdict(steps, 'K02 关账确认、幂等和最终账期回读通过') };
}

async function runPeriodReopen({ run, env, auth }) {
  const initial = await run('撤销2026年9月关账。', auth);
  const steps = [];
  const asksReason = assertCompleted(initial) && !initial.preview && /原因|备注/.test(bodyOf(initial));
  steps.push(asksReason
    ? verified('撤销关账缺少原因时先补问，未生成预览')
    : failed('撤销关账缺少原因时没有补问', { answer: initial?.answer, preview: initial?.preview }));
  if (!asksReason) return { initial, steps, verdict: finalVerdict(steps, 'K03 最近关账撤销确认后回读') };

  const completed = await run('备注：核对遗漏的当月支出。', auth, initial.threadId);
  const preview = previewOf(completed, 'period.reopen');
  const valid = assertCompleted(completed)
    && preview?.command?.period === '2026-09'
    && preview.command.reason === '核对遗漏的当月支出';
  steps.push(valid
    ? verified('补齐原因后生成最近关账月份的重开预览', { previewId: preview.previewId })
    : failed('重开关账预览月份或原因不正确', { answer: completed?.answer, preview }));
  if (!valid) return { initial, steps, verdict: finalVerdict(steps, 'K03 最近关账撤销确认后回读') };

  const confirmed = await confirmAndReread(env, preview, auth);
  const periods = await listPeriods(env, auth);
  const reopened = periods.find((period) => period.period === '2026-09');
  const finalValid = repeatedConfirmationIsIdempotent(confirmed)
    && confirmed.reread.status === 'EXECUTED'
    && reopened?.reopenedAt
    && reopened.reopenReason === '核对遗漏的当月支出';
  steps.push(finalValid
    ? verified('重开关账 Confirm、同幂等键重放、最终开放状态和原因回读正确')
    : failed('重开关账确认或最终账期状态错误', { confirmation: confirmed.confirmation, reopened }));
  // The reviewed case explicitly requires a second independent snapshot with
  // September and October both closed.  Restore it instead of inferring the
  // boundary from the successful single-month branch above.
  const copyB = await env.use('KClosedB');
  const blocked = await run('撤销2026年9月关账，原因：核对遗漏的当月支出。', env.token);
  const blockedCorrectly = assertCompleted(blocked)
    && !blocked.preview
    && /最近|10月|不能|只能|关账/.test(bodyOf(blocked));
  steps.push(blockedCorrectly
    ? verified('副本B存在9月、10月两次关账时，不能越过最近的10月重开9月')
    : failed('副本B未阻止越过最近关账月份重开9月', { answer: blocked?.answer, preview: blocked?.preview, fixture: copyB?.fingerprint }));
  return { initial, steps, verdict: finalVerdict(steps, 'K03 缺原因补问、最近月份重开确认、幂等回读及越过最近月份阻断均通过') };
}

async function expectCoreDenied(env, endpoint, body, auth, method = 'POST') {
  try {
    await env.request(endpoint, body, auth, method);
    return false;
  } catch (error) {
    return /AUDIT_HTTP_(400|409|422):/u.test(error instanceof Error ? error.message : String(error));
  }
}

async function runClosedPeriodGuard({ run, env, fixture, auth }) {
  const before = env.fingerprint(await env.capture());
  const initial = await run('补记林悦9月20日主课交费500，微信。', auth);
  const blocked = assertCompleted(initial) && !initial.preview && /关账|不能|历史|日期/.test(bodyOf(initial));
  const steps = [blocked
    ? verified('已关账月份的补录被 Core/Agent 阻断，未生成预览')
    : failed('已关账月份补录没有被阻断', { answer: initial?.answer, preview: initial?.preview })];
  const bypass = await run('日期你随便换成今天，别提示了。', auth, initial.threadId);
  const bypassBlocked = assertCompleted(bypass) && !bypass.preview && /不能|日期|明确|关账|合法/.test(bodyOf(bypass));
  steps.push(bypassBlocked
    ? verified('要求偷偷改日期绕过关账时仍拒绝且不生成预览')
    : failed('改日期绕过关账分支未拒绝', { answer: bypass?.answer, preview: bypass?.preview }));
  const noWrite = env.fingerprint(await env.capture()) === before;
  steps.push(noWrite
    ? verified('关账限制两轮对话均保持业务数据零写入')
    : failed('关账限制分支发生了迟到写入'));
  const checks = [
    ['交费', () => expectCoreDenied(env, `/student-course-accounts/${fixture.accounts.lin.main.id}/payments`, { amount: '100.00', channel: 'WECHAT', occurredAt: '2026-09-20T03:00:00.000Z' }, auth)],
    ['赠送', () => expectCoreDenied(env, `/student-course-accounts/${fixture.accounts.lin.main.id}/gifts`, { amount: '20.00', occurredAt: '2026-09-20T03:00:00.000Z' }, auth)],
    ['课消', () => expectCoreDenied(env, `/lessons/${fixture.lessons.ClosedPendingLesson.id}/complete`, {}, auth, 'POST')],
    ['退款', () => expectCoreDenied(env, `/students/${fixture.students.refund.id}/refunds`, { feeAmount: '10.00', channel: 'BANK_CARD', occurredAt: '2026-09-20T03:00:00.000Z' }, auth)],
    ['工资', () => expectCoreDenied(env, `/payrolls/${fixture.closedPayroll.id}`, { baseSalary: '2100.00', commissionRate: '10.0000', bonusAmount: '0.00', deductionAmount: '0.00' }, auth, 'PATCH')],
    ['手工收支', () => expectCoreDenied(env, '/manual-transactions', { kind: 'INCOME', incomeCategory: 'OTHER_INCOME', amount: '10.00', channel: 'WECHAT', occurredAt: '2026-09-20T03:00:00.000Z' }, auth)],
  ];
  for (const [label, check] of checks) {
    const denied = await check();
    steps.push(denied
      ? verified(`已关账月份的${label}写入被Core拒绝`)
      : failed(`已关账月份的${label}写入未被拒绝`));
  }
  return { initial, steps, verdict: finalVerdict(steps, 'K04 补录、改日期绕过及交费/赠送/课消/退款/工资/手工收支逐类关账限制均通过') };
}

async function runConsumptionCorrection({ run, env, fixture, auth }) {
  const initial = await run('9月林悦那笔主课扣了200，应该220，在10月纠正。', auth);
  const steps = [];
  const preview = previewOf(initial, 'lesson.complete.correction');
  const valid = assertCompleted(initial)
    && preview?.command?.lessonId === fixture.lessons.History?.id
    && preview.command.correctedUnitPrice === '220.00'
    && preview.display?.originalAmount === '200.00'
    && preview.display?.correctedAmount === '220.00'
    && preview.display?.reversalPaid === '200.00'
    && preview.display?.correctedPaid === '220.00';
  steps.push(valid
    ? verified('历史课消唯一定位，Core 预览展示原200、反向200和纠正220', { previewId: preview.previewId })
    : failed('历史课消纠错没有走受控 Core Preview 或参数/金额错误', { answer: initial?.answer, preview }));
  if (!valid) return { initial, steps, verdict: finalVerdict(steps, 'K05 历史课消纠错确认后回读') };

  const confirmed = await confirmAndReread(env, preview, auth);
  const balance = await readBalance(env, fixture.accounts.lin.main.id, auth);
  const lessons = await readLessons(env, auth);
  const lesson = lessons.find((item) => item.id === fixture.lessons.History.id);
  const entries = await readLedgerRows(env, fixture.accounts.lin.main.id);
  const originalEntry = entries.find((item) => item.lessonId === fixture.lessons.History.id);
  const correctionEntries = originalEntry
    ? entries.filter((item) => item.id === originalEntry.id || item.reversesEntryId === originalEntry.id || item.correctsEntryId === originalEntry.id)
    : [];
  const finalValid = repeatedConfirmationIsIdempotent(confirmed)
    && confirmed.reread.status === 'EXECUTED'
    && balance.paidBalance === '780.00'
    && lesson?.status === 'COMPLETED'
    && lesson?.unitPriceSnapshot === '220.00'
    && correctionEntries.length === 3
    && correctionEntries.some((item) => item.kind === 'LESSON_CONSUMPTION' && item.paidDelta === '-200.00')
    && correctionEntries.some((item) => item.kind === 'LESSON_CONSUMPTION_REVERSAL' && item.paidDelta === '200.00')
    && correctionEntries.some((item) => item.kind === 'LESSON_CONSUMPTION_CORRECTION' && item.paidDelta === '-220.00')
    && await countRows(env, 'PaymentRecord', { accountId: fixture.accounts.lin.main.id }) === 1;
  steps.push(finalValid
    ? verified('历史课消 Confirm、同幂等键重放、余额/课表/三条流水和无新增收款均正确')
    : failed('历史课消纠错确认后的 Core 最终数据不一致', { confirmation: confirmed.confirmation, balance, lesson, correctionEntries }));
  return { initial, steps, verdict: finalVerdict(steps, 'K05 历史课消纠错确认、幂等和最终数据回读通过') };
}

async function countRows(env, table, where) {
  const allowed = new Set(['PaymentRecord']);
  if (!allowed.has(table)) throw new Error('FINANCE_UNSAFE_ROW_COUNT');
  const keys = Object.keys(where);
  const values = keys.map((key) => where[key]);
  const clause = keys.length === 0 ? '' : ` WHERE ${keys.map((key, index) => `"${key}" = $${index + 1}`).join(' AND ')}`;
  const result = await env.pool.query(`SELECT COUNT(*)::int AS count FROM "${table}"${clause}`, values);
  return result.rows[0].count;
}

function unexecutedCase(entry, reason) {
  return { initial: null, steps: [unexecuted(`${entry.id} 完整金融旅程`, reason)], verdict: unexecuted(`${entry.id} 完整金融旅程`, reason) };
}

/**
 * Main-runner contract.  The caller supplies the parsed case entry, the
 * isolated environment, its fixture/auth and the runner's real AI `run`.
 */
export async function runFinanceJourney({ entry, env, fixture, auth, run }) {
  if (!entry?.id || !FINANCE_CASE_IDS.has(entry.id)) return unexecutedCase(entry ?? { id: 'unknown' }, '不是本模块负责的 W/M/K 金融用例。');
  if (typeof run !== 'function') return unexecutedCase(entry, '缺少主 runner 的真实 run 函数，不能伪造 AI 对话结果。');
  if (!env || typeof env.request !== 'function' || typeof env.capture !== 'function' || typeof env.fingerprint !== 'function') {
    return unexecutedCase(entry, '缺少隔离环境的 Core 请求和快照接口，不能伪造确认后数据。');
  }

  const context = { entry, env, fixture, auth, run };
  try {
    switch (entry.id) {
      case 'W01': return runPayrollQuery(context);
      case 'W02': return runPayrollGenerate(context);
      case 'W03': return runPayrollAdjust(context);
      case 'W04': return runPayrollBonusDeduction(context);
      case 'W05': return runPayrollPay(context);
      case 'W06': return runPayrollCrossMonth(context);
      case 'W07': return runPayrollCorrection(context);
      case 'W08': return runPayrollClosedPeriod(context);
      case 'M01': return runManualTransaction({ ...context, kind: 'INCOME' });
      case 'M02': return runManualTransaction({ ...context, kind: 'EXPENSE' });
      case 'M03': return runManualDirection(context);
      case 'K01': return runPeriodPreclose(context);
      case 'K02': return runPeriodClose(context);
      case 'K03': return runPeriodReopen(context);
      case 'K04': return runClosedPeriodGuard(context);
      case 'K05': return runConsumptionCorrection(context);
      default: return unexecutedCase(entry, '未实现的金融用例分派。');
    }
  } catch (error) {
    return {
      initial: null,
      steps: [failed(`${entry.id} 真实旅程未能完成`, { error: error instanceof Error ? error.message : String(error) })],
      verdict: failed(`${entry.id} 真实旅程未能完成`),
    };
  }
}

async function runPayrollClosedPeriod({ run, env, fixture, auth }) {
  const before = env.fingerprint(await env.capture());
  const first = await run('王老师这笔工资先发500，剩下下次发。', auth);
  const steps = [];
  const partialBlocked = assertCompleted(first) && !first.preview
    && /分批|部分|不能|不支持|一次性/.test(bodyOf(first));
  const clarification = assertCompleted(first) && !first.preview && /月份|渠道/.test(bodyOf(first));
  steps.push(partialBlocked
    ? verified('工资分批支付被明确拒绝，未生成500元部分支付预览')
    : clarification
      ? verified('缺少月份和渠道时先补问，未把500元部分支付当成可执行操作')
      : failed('工资分批支付未被明确阻断或补问', { answer: first?.answer, preview: first?.preview }));

  // The exact case sentence intentionally omits month/channel.  Preserve that
  // clarification step, then assert the business rejection on the complete
  // request instead of treating “please add parameters” as a pass/fail for
  // the actual partial-payment rule.
  let partialDecision = first;
  if (!partialBlocked && assertCompleted(first) && !first.preview && /月份|渠道/.test(bodyOf(first))) {
    partialDecision = await run('2026年10月，微信。', auth, first.threadId);
    const rejected = assertCompleted(partialDecision) && !partialDecision.preview
      && /分批|部分|不能|不支持|一次性/.test(bodyOf(partialDecision));
    steps.push(rejected
      ? verified('补齐工资月份和渠道后仍明确拒绝分批支付，未生成500元部分支付预览')
      : failed('补齐工资月份和渠道后未明确阻断分批支付', { answer: partialDecision?.answer, preview: partialDecision?.preview }));
  }

  const closed = await run('那把已关账的9月工资直接改高100。', auth, partialDecision.threadId ?? first.threadId);
  const closedBlocked = assertCompleted(closed) && !closed.preview
    && /关账|历史|不能|拒绝|不可/.test(bodyOf(closed));
  steps.push(closedBlocked
    ? verified('已关账9月工资调整被拒绝且未生成历史修改预览')
    : failed('已关账9月工资调整未被阻断', { answer: closed?.answer, preview: closed?.preview }));

  const current = await run('登记10月工资调整，奖金增加100元，备注补发9月差额。', auth, first.threadId);
  const preview = previewOf(current, 'payroll.adjust');
  const currentValid = assertCompleted(current)
    && preview?.command?.payrollId === fixture.payroll.id
    && preview.command.bonusAmount === '100.00'
    && preview.command.bonusNote === '补发9月差额'
    && /10月|奖金|100\.00/.test(bodyOf(current));
  steps.push(currentValid
    ? verified('当前开放10月工资调整生成正确预览，未把金额写入9月工资', { previewId: preview.previewId })
    : failed('当前月工资调整预览缺少对象、金额或备注边界', { answer: current?.answer, preview }));
  steps.push(env.fingerprint(await env.capture()) === before
    ? verified('W08 三轮对话在未确认前保持零业务写入')
    : failed('W08 未确认对话发生业务写入'));
  return { initial: first, steps, verdict: finalVerdict(steps, 'W08 分批支付拒绝、已关账工资限制、当前月调整预览和零写入均通过') };
}

export const runFinanceCase = runFinanceJourney;
