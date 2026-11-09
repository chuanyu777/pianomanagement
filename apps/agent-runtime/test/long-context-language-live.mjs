/** Opt-in real-model check with synthetic conversation only; no database or writes. */
import { createChatModel } from '../dist/llm/model-factory.js';
import { createIntentParser } from '../dist/graph/intent-parser.js';

if (!process.env.AI_API_KEY || !['deepseek-chat', 'deepseek-reasoner'].includes(process.env.AI_MODEL)) throw new Error('LIVE_MODEL_CONFIGURATION_REQUIRED');
const model = createChatModel({ AI_ENABLED:true, AI_PROVIDER:'deepseek', AI_MODEL:process.env.AI_MODEL, AI_API_KEY:process.env.AI_API_KEY, AI_MAX_OUTPUT_TOKENS:1600, AI_REQUEST_TIMEOUT_MS:30000 });
const history = [
  {role:'user',content:'新建学生张小鱼。'},
  {role:'assistant',content:'学生张小鱼的建档已确认。'},
  {role:'user',content:'刚才姓名说错了，学生叫张小雨。'},
  {role:'assistant',content:'学生姓名已更正为张小雨。'},
];
for (let i = 0; i < 22; i++) {
  history.push({role:'user',content:`查看今天的排课。${'请展示上课时间、课程和老师。'.repeat(40)}`});
  history.push({role:'assistant',content:`今天没有安排课程。${'当前没有待展示的排课。'.repeat(25)}`});
}
const result = await createIntentParser(model)({businessDate:'2026-10-21',task:{},history,userMessage:'他主课缴费2000元，微信'});
const ok = result.kind === 'parsed' && result.intent.operation === 'payment.preview' && result.intent.fields.studentName === '张小雨' && result.intent.fields.courseName === '主课' && result.intent.fields.amount === '2000' && result.intent.fields.channel === '微信';
console.log(`long_history_corrected_pronoun:${ok ? 'PASS' : 'FAIL'}`);
if (!ok) process.exitCode = 1;
