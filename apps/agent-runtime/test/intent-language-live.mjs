/** Opt-in live-model evaluation. Synthetic phrases only; no database or business writes. */
import { createChatModel } from '../dist/llm/model-factory.js';
import { parseAgentConfig } from '../dist/config/agent-config.js';
import { createIntentParser } from '../dist/graph/intent-parser.js';

const cases = [
  ['schedule-1', '今天有哪些课？', 'lessons.read'],
  ['schedule-2', '帮我看看今天的课表', 'lessons.read'],
  ['schedule-3', '今天都安排了什么课', 'lessons.read'],
  ['schedule-4', '明天排了哪些课程', 'lessons.read'],
  ['balance-1', '查一下林悦的主课余额', 'accounts.read'],
  ['balance-2', '林悦主课账户还剩多少钱？', 'accounts.read'],
  ['balance-3', '帮我看看林悦主课还有多少余额', 'accounts.read'],
  ['ledger-1', '查看林悦主课的账户流水', 'ledger.read'],
  ['ledger-2', '林悦主课的交费和扣费记录有哪些', 'ledger.read'],
  ['pay-1', '给林悦主课交费100元，微信', 'payment.preview'],
  ['pay-2', '林悦的主课收100块，微信收款', 'payment.preview'],
  ['gift-1', '给林悦主课赠送50元', 'gift.preview'],
  ['gift-2', '林悦主课送50块钱', 'gift.preview'],
  ['report-1', '看看2026年10月的经营利润', 'report.monthly'],
  ['report-2', '2026年10月经营赚了多少钱', 'report.monthly'],
  ['payroll-1', '查询王老师2026年10月工资', 'payroll.read'],
  ['payroll-2', '帮我算王老师2026年10月的工资', 'payroll.generate'],
  ['refund-1', '给林悦办理退学退款', 'refund.preview'],
  ['heldout-schedule', '明天都给学生安排了哪些课？', 'lessons.read'],
  ['heldout-balance', '主课里林悦的余额是多少', 'accounts.read'],
  ['heldout-ledger', '林悦的主课有哪些资金变动记录', 'ledger.read'],
  ['heldout-payment', '林悦主课交100元，收款方式是微信', 'payment.preview'],
  ['payment-with-unit-price', '给林悦主课微信缴费1000元，每节课180元', 'payment.preview'],
  ['heldout-gift', '给林悦主课加赠50元', 'gift.preview'],
  ['heldout-typo', '帮我查查林悦主课余額', 'accounts.read'],
  // 明确排除交费，实际请求是查余额；不能把被否定的动作当成预览。
  ['negated-payment', '不要给林悦主课交费，只查一下余额', 'accounts.read'],
  // 明确排除工资生成，实际请求是查指定月份的工资。
  ['negated-payroll', '不要算工资，查看王老师2026年10月工资', 'payroll.read'],
  // 同义表达与语序变化：账户剩余金额、资金明细、收入登记和月份报表。
  ['synonym-balance', '林悦在主课账户里还余多少款', 'accounts.read'],
  ['reordered-ledger', '主课的资金明细，帮我查林悦的', 'ledger.read'],
  ['reordered-payment', '微信收款100元，记到林悦的主课', 'payment.preview'],
  ['reordered-report', '经营利润查一下，2026年10月的', 'report.monthly'],
  // 动作确定但参数缺失：保留业务类型，缺失金额、渠道不得凭空填写。
  ['missing-payment-details', '给林悦主课交费', 'payment.preview'],
  ['missing-amount-channel-present', '给林悦主课交费，微信支付', 'payment.preview'],
  ['missing-channel-amount-present', '给林悦主课交费一百五十元', 'payment.preview'],
  ['number-in-name-no-amount', '给林悦123的钢琴1班交费，微信支付', 'payment.preview'],
  ['transaction-count-no-amount', '给林悦主课用微信登记一笔交费', 'payment.preview'],
  ['arrears-colloquial', '哪些学生还欠着钱？', 'arrears.read'],
  ['overview-colloquial', '今天店里经营得怎么样', 'overview.read'],
  ['directory-teacher', '查一下王老师的资料', 'directory.read'],
  ['consumption-colloquial', '看看2026年10月各老师的课消情况', 'consumption.read'],
  ['course-open-colloquial', '给林悦开通钢琴课账户', 'course-account.open'],
  ['course-price-colloquial', '林悦钢琴课单价改为200元', 'course-account.price'],
  ['lesson-schedule-colloquial', '给林悦安排钢琴课，王老师明天下午三点上课', 'lesson.schedule'],
  ['lesson-reschedule-colloquial', '把林悦明天的钢琴课挪到下午四点', 'lesson.reschedule'],
  ['lesson-cancel-colloquial', '取消林悦明天的钢琴课', 'lesson.cancel'],
  ['lesson-complete-colloquial', '林悦今天的钢琴课已经上完了，确认课消', 'lesson.complete'],
  ['payroll-pay-colloquial', '给王老师发2026年10月工资', 'payroll.pay'],
  ['payroll-pay-reordered', '2026年10月的工资发给王老师', 'payroll.pay'],
  ['payroll-generate-different', '计算王老师2026年10月工资', 'payroll.generate'],
  ['manual-expense-colloquial', '登记一笔房租支出2000元，现金', 'manual-transaction.create'],
  ['period-close-colloquial', '把2026年10月的账结了', 'period.close'],
  ['period-check-colloquial', '看看2026年10月能不能关账', 'period.preclose.read'],
  ['student-create-colloquial', '新增一个学生叫林悦', 'student.create'],
  ['student-update-colloquial', '把林悦的手机号改成13800138000', 'student.update'],
  ['teacher-create-colloquial', '新增一位王老师', 'teacher.create'],
  ['teacher-compensation-colloquial', '把王老师基本工资调整为3000元', 'teacher.compensation.update'],
  ['course-create-colloquial', '新建一门钢琴课，每节200元', 'course.create'],
  ['course-update-colloquial', '把钢琴课的默认价格改成200元', 'course.update'],
  ['ledger-reversal-colloquial', '把林悦钢琴课的100元交费冲正', 'ledger-entry.reversal'],
  ['complete-reversal-colloquial', '撤销林悦今天钢琴课的上课确认', 'lesson.complete.reversal'],
  ['complete-correction-colloquial', '把林悦今天钢琴课已确认的课消单价纠正为200元', 'lesson.complete.correction'],
  ['payroll-adjust-colloquial', '调整王老师2026年10月工资，奖金加200元', 'payroll.adjust'],
  ['payroll-cancel-colloquial', '撤销王老师2026年10月工资的支付', 'payroll.cancel-payment'],
  ['period-reopen-colloquial', '重新打开2026年10月已关闭的账期', 'period.reopen'],
  // 独立任务没有指代上下文；不能凭空填写学生、课程或金额。
  ['missing-reference', '查这个学生的余额', 'accounts.read'],
  // 业务类型不明或纯否定时应澄清，不能产生被否定的业务动作。
  ['ambiguous-1', '帮我处理一下', null],
  ['ambiguous-reference', '按上次的办', null],
  ['negated-only', '不要给林悦主课交费', null],
];
const expectedFields = {
  'ledger-1': { studentName:'林悦', courseName:'主课' },
  'ledger-2': { studentName:'林悦', courseName:'主课' },
  'heldout-ledger': { studentName:'林悦', courseName:'主课' },
  'payroll-1': { teacherName:'王老师', period:'2026-10' },
  'payroll-2': { teacherName:'王老师', period:'2026-10' },
  'payroll-pay-colloquial': { teacherName:'王老师', period:'2026-10' },
  'payroll-pay-reordered': { teacherName:'王老师', period:'2026-10' },
  'payroll-generate-different': { teacherName:'王老师', period:'2026-10' },
  'refund-1': { studentName:'林悦' },
  'negated-payment': { studentName:'林悦', courseName:'主课' },
  'negated-payroll': { teacherName:'王老师', period:'2026-10' },
  'synonym-balance': { studentName:'林悦', courseName:'主课' },
  'reordered-ledger': { studentName:'林悦', courseName:'主课' },
  'reordered-payment': { studentName:'林悦', courseName:'主课', amount:'100', channel:'微信' },
  'reordered-report': { period:'2026-10' },
  'missing-payment-details': { studentName:'林悦', courseName:'主课' },
  'missing-amount-channel-present': { studentName:'林悦', courseName:'主课', channel:'微信' },
  'missing-channel-amount-present': { studentName:'林悦', courseName:'主课', amount:'150' },
  'number-in-name-no-amount': { studentName:'林悦123', courseName:'钢琴1班', channel:'微信' },
  'transaction-count-no-amount': { studentName:'林悦', courseName:'主课', channel:'微信' },
  'balance-1': { studentName:'林悦', courseName:'主课' },
  'balance-2': { studentName:'林悦', courseName:'主课' },
  'balance-3': { studentName:'林悦', courseName:'主课' },
  'pay-1': { studentName:'林悦', courseName:'主课', amount:'100', channel:'微信' },
  'pay-2': { studentName:'林悦', courseName:'主课', amount:'100', channel:'微信' },
  'gift-1': { studentName:'林悦', courseName:'主课', amount:'50' },
  'gift-2': { studentName:'林悦', courseName:'主课', amount:'50' },
  'report-1': { period:'2026-10' },
  'report-2': { period:'2026-10' },
  'heldout-balance': { studentName:'林悦', courseName:'主课' },
  'heldout-payment': { studentName:'林悦', courseName:'主课', amount:'100', channel:'微信' },
  'payment-with-unit-price': { studentName:'林悦', courseName:'主课', amount:'1000', channel:'微信', currentUnitPrice:'180' },
  'heldout-gift': { studentName:'林悦', courseName:'主课', amount:'50' },
  'heldout-typo': { studentName:'林悦', courseName:'主课' },
};

// 未提供的关键字段只能缺省或为 null，不能由模型猜测。
const absentFields = {
  'missing-payment-details': ['amount', 'channel'],
  'missing-amount-channel-present': ['amount'],
  'missing-channel-amount-present': ['channel'],
  'number-in-name-no-amount': ['amount'],
  'transaction-count-no-amount': ['amount'],
  'missing-reference': ['studentName', 'courseName'],
  'negated-payment': ['amount'],
};

const model = createChatModel(parseAgentConfig(process.env));
if (!model) throw new Error('MODEL_NOT_ENABLED');
const parse = createIntentParser(model);
const selected = process.env.AI_INTENT_CASE_IDS?.split(',').filter(Boolean);
const selectedCases = selected?.length ? cases.filter(([id]) => selected.includes(id)) : cases;
if (!selectedCases.length) throw new Error('NO_MATCHING_CASES');
let passed = 0;
for (const [id, userMessage, expected] of selectedCases) {
  try {
    const result = await parse({ businessDate: '2026-10-21', task: null, userMessage });
    const actual = result.kind === 'parsed' ? result.intent.operation : null;
    const fields = expectedFields[id] ?? {};
    const fieldsMatch = result.kind === 'parsed' && Object.entries(fields).every(([name, value]) => result.intent.fields[name] === value);
    const unexpectedFields = result.kind === 'parsed' ? (absentFields[id] ?? []).filter((name) => result.intent.fields[name] != null) : [];
    const safeMissingReference = id === 'missing-reference' && result.kind === 'parsed' && result.intent.mode === 'clarify' && actual === null && unexpectedFields.length === 0;
    const ok = safeMissingReference || (expected === null
      ? result.kind === 'unparsable' || (result.kind === 'parsed' && result.intent.mode === 'clarify' && actual === null)
      : result.kind === 'parsed' && result.intent.mode === 'new' && actual === expected && fieldsMatch && unexpectedFields.length === 0);
    if (ok) passed++;
    const mismatchedFields = result.kind === 'parsed' ? Object.entries(fields).filter(([name, value]) => result.intent.fields[name] !== value).map(([name]) => name) : [];
    console.log(JSON.stringify({ id, expected, actual, kind: result.kind, mode: result.kind === 'parsed' ? result.intent.mode : null, mismatchedFields, unexpectedFields, ...(process.env.AI_INTENT_DIAGNOSTICS === 'true' && result.kind === 'parsed' ? { fields: result.intent.fields } : {}), passed: ok }));
  } catch { console.log(JSON.stringify({ id, expected, kind: 'error', passed: false })); }
}
console.log(JSON.stringify({ total: selectedCases.length, passed, failed: selectedCases.length - passed, scope: 'intent recognition only; synthetic data' }));
if (passed !== selectedCases.length) process.exitCode = 1;
