/** Opt-in real-model regression. Synthetic input only; no database or writes. */
import { createChatModel } from '../dist/llm/model-factory.js';
import { createModelMultiStepInterpreter } from '../dist/graph/dialogue-multi-step.js';
import { createIntentParser } from '../dist/graph/intent-parser.js';

if (!process.env.AI_API_KEY || !['deepseek-chat', 'deepseek-reasoner'].includes(process.env.AI_MODEL)) throw new Error('LIVE_MODEL_CONFIGURATION_REQUIRED');
const model = createChatModel({ AI_ENABLED: true, AI_PROVIDER: 'deepseek', AI_MODEL: process.env.AI_MODEL, AI_API_KEY: process.env.AI_API_KEY, AI_MAX_OUTPUT_TOKENS: 1600, AI_REQUEST_TIMEOUT_MS: 20000 });
const cases = [
  ['single_price', '给小雨的主课交费100元，微信，每节课180元', 'single'],
  ['single_amount', '给小雨主课微信缴费2000元', 'single'],
  ['student_create', '新建学生张小鱼', 'single'],
  ['query', '查询今天的排课', 'single'],
  ['ordered', '先给小雨主课缴费100元微信，再给他赠送20元', 'multi'],
  ['negated', '不要给小雨交费', 'single'],
];
let failed = false;
for (const [name, message, expected] of cases) {
  try {
    const result = await createModelMultiStepInterpreter(model)({ userMessage: message, task: {} });
    const actual = result ? 'multi' : 'single';
    console.log(`${name}:${actual === expected ? 'PASS' : 'FAIL'}`);
    if (actual !== expected) failed = true;
  } catch {
    console.log(`${name}:REJECTED`);
    failed = true;
  }
}
try {
  const plan = await createModelMultiStepInterpreter(model)({businessDate:'2026-10-21',task:{},userMessage:'先查今天排课，再查本月经营利润，然后查王老师本月工资，最后查欠费学生'});
  const actual = plan?.steps.map(step => step.operation);
  const expected = ['lessons.read','report.monthly','payroll.read','arrears.read'];
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`four_ordered_queries:${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) failed = true;
} catch { console.log('four_ordered_queries:REJECTED'); failed = true; }
try {
  const plan = await createModelMultiStepInterpreter(model)({businessDate:'2026-10-21',task:{},userMessage:'先给小雨的主课微信缴费100元，再安排王老师明天下午三点上主课'});
  const scheduled = plan?.steps.find(step => step.operation === 'lesson.schedule');
  const ok = !!scheduled?.fields.startsAt && Date.parse(scheduled.fields.startsAt) === Date.parse('2026-10-22T15:00:00+08:00');
  console.log(`multistep_relative_time:${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) failed = true;
} catch { console.log('multistep_relative_time:REJECTED'); failed = true; }
try {
  const plan = await createModelMultiStepInterpreter(model)({businessDate:'2026-10-21',task:{},userMessage:'王老师去年十二月工资支付登记错了，先撤销，再登记今年一月五日的微信支付'});
  const cancel = plan?.steps.find(step => step.operation === 'payroll.cancel-payment');
  const pay = plan?.steps.find(step => step.operation === 'payroll.pay');
  const ok = cancel?.fields.period === '2025-12' && pay?.fields.period === '2025-12' && typeof pay?.fields.paidAt === 'string' && pay.fields.paidAt.startsWith('2026-01-05');
  console.log(`payroll_relative_year:${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) failed = true;
} catch { console.log('payroll_relative_year:REJECTED'); failed = true; }
for (const [name, message, expected] of [
  ['refund_fee_duplicate', '把刚才退款手续费100元再记成一笔手工收入', 'unsupported'],
  ['direct_transfer', '直接给家长转账退款', 'unsupported'],
  ['negated_automation', '不要永久自动通知，只查当前经营概况', 'overview.read'],
  ['receipt_request', '把刚办好的给我看看', 'receipt.read'],
]) {
  try {
    const result = await createIntentParser(model)({businessDate:'2026-10-21',task:name==='receipt_request' ? {operation:'payment.preview',alreadyExecuted:true} : {},userMessage:message});
    const ok = result.kind === 'parsed' && result.intent.operation === expected;
    console.log(`${name}:${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) failed = true;
  } catch { console.log(`${name}:REJECTED`); failed = true; }
}
try {
  const result = await createIntentParser(model)({businessDate:'2026-10-21',task:{},userMessage:'不是昨天，查今天的排课'});
  const ok = result.kind === 'parsed' && result.intent.operation === 'lessons.read' && (result.intent.fields.date === '2026-10-21' || (result.intent.fields.dateFrom === '2026-10-21' && result.intent.fields.dateTo === '2026-10-21'));
  console.log(`date_correction:${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) failed = true;
} catch { console.log('date_correction:REJECTED'); failed = true; }
try {
  const result = await createIntentParser(model)({businessDate:'2026-10-21',task:{},userMessage:'给小雨的主课交100元，收现钞'});
  const ok = result.kind === 'parsed' && result.intent.operation === 'payment.preview' && result.intent.fields.channel === '现金';
  console.log(`cash_synonym:${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) failed = true;
} catch {
  console.log('cash_synonym:REJECTED');
  failed = true;
}
try {
  const result = await createIntentParser(model)({businessDate:'2026-10-21',task:{},userMessage:'给小雨主课缴费，微信'});
  const ok = result.kind === 'parsed' && result.intent.operation === 'payment.preview' && result.intent.fields.courseName === '主课' && !result.intent.fields.amount;
  console.log(`missing_amount:${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) failed = true;
} catch { console.log('missing_amount:REJECTED'); failed = true; }
try {
  const result = await createIntentParser(model)({businessDate:'2026-10-21',task:{},userMessage:'给小雨主课交1000元微信，课时按180'});
  const ok = result.kind === 'parsed' && result.intent.operation === 'payment.preview' && result.intent.fields.currentUnitPrice === '180';
  console.log(`price_synonym:${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) failed = true;
} catch {
  console.log('price_synonym:REJECTED');
  failed = true;
}
try {
  const history=[{role:'user',content:'新建学生王小雨'},{role:'assistant',content:'已生成学生建档预览，尚未执行。'},{role:'user',content:'查看今天的排课'},{role:'assistant',content:'今天没有排课。'}];
  const task={operation:'lessons.read',fields:{dateFrom:'2026-10-21',dateTo:'2026-10-21'},references:[],candidates:[]};
  const userMessage='他主课缴费2000元';
  const plan=await createModelMultiStepInterpreter(model)({businessDate:'2026-10-21',task,userMessage,history});
  const result=await createIntentParser(model)({businessDate:'2026-10-21',task,userMessage,history});
  const ok=plan===null && result.kind==='parsed' && result.intent.operation==='payment.preview' && result.intent.fields.studentName==='王小雨' && result.intent.fields.courseName==='主课' && result.intent.fields.amount==='2000' && !result.intent.fields.channel;
  console.log(`after_query_missing_channel:${ok?'PASS':'FAIL'}`);
  if(!ok)failed=true;
} catch { console.log('after_query_missing_channel:REJECTED'); failed=true; }
try {
  const result = await createIntentParser(model)({
    businessDate: '2026-10-21', task: {}, userMessage: '他主课缴费2000元，微信',
    history: [
      { role: 'user', content: '新建学生张小鱼' },
      { role: 'assistant', content: '学生建档已确认。' },
      { role: 'user', content: '查今天的排课' },
      { role: 'assistant', content: '今天没有排课。' },
    ],
  });
  const ok = result.kind === 'parsed' && result.intent.operation === 'payment.preview' && result.intent.fields.studentName === '张小鱼' && result.intent.fields.amount === '2000' && result.intent.fields.channel === '微信';
  console.log(`history_pronoun:${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) failed = true;
} catch {
  console.log('history_pronoun:REJECTED');
  failed = true;
}
try {
  const history = [{role:'user',content:'新建学生张小鱼'},{role:'assistant',content:'已生成学生建档操作预览，尚未执行。'}];
  const task = {operation:'student.create',fields:{name:'张小鱼'},references:[],candidates:[],alreadyExecuted:true};
  const userMessage = '他主课缴费2000元，微信';
  const plan = await createModelMultiStepInterpreter(model)({userMessage,task,history});
  const result = await createIntentParser(model)({businessDate:'2026-10-21',task,userMessage,history});
  const ok = plan === null && result.kind === 'parsed' && result.intent.operation === 'payment.preview' && result.intent.fields.studentName === '张小鱼' && result.intent.fields.courseName === '主课';
  console.log(`history_pronoun_payment:${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) failed = true;
} catch {
  console.log('history_pronoun_payment:REJECTED');
  failed = true;
}
try {
  const result = await createIntentParser(model)({
    businessDate: '2026-10-21', task: {}, userMessage: '他主课缴费200元，微信',
    history: [{ role: 'user', content: '新建两位学生王小雨和李小雨' }, { role: 'assistant', content: '请确认两位学生的信息。' }],
  });
  const ok = result.kind === 'parsed' && !result.intent.fields.studentName;
  console.log(`ambiguous_pronoun:${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) failed = true;
} catch {
  console.log('ambiguous_pronoun:REJECTED');
  failed = true;
}
if (failed) process.exitCode = 1;
