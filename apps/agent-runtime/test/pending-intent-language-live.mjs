/** Opt-in real-model checks using synthetic dialogue only. */
import { createChatModel } from '../dist/llm/model-factory.js';
import { createIntentParser } from '../dist/graph/intent-parser.js';
import { createModelMultiStepInterpreter } from '../dist/graph/dialogue-multi-step.js';

if (!process.env.AI_API_KEY || !['deepseek-chat','deepseek-reasoner'].includes(process.env.AI_MODEL)) throw new Error('LIVE_MODEL_CONFIGURATION_REQUIRED');
const model = createChatModel({AI_ENABLED:true,AI_PROVIDER:'deepseek',AI_MODEL:process.env.AI_MODEL,AI_API_KEY:process.env.AI_API_KEY,AI_MAX_OUTPUT_TOKENS:1600,AI_REQUEST_TIMEOUT_MS:30000});
const history = [{role:'user',content:'新建学生林小雨'},{role:'assistant',content:'已生成学生建档预览，尚未执行。'}];
const task = {status:'awaiting_confirmation',operation:'student.create',fields:{name:'林小雨'},candidates:[],references:[],hasPreview:true,alreadyExecuted:false};
const userMessage='他主课缴费100元，微信';
try {
  const plan=await createModelMultiStepInterpreter(model)({businessDate:'2026-10-21',task,history,userMessage});
  const result=await createIntentParser(model)({businessDate:'2026-10-21',task,history,userMessage});
  const ok=!plan && result.kind==='parsed' && result.intent.operation==='payment.preview' && result.intent.fields.studentName==='林小雨' && result.intent.fields.courseName==='主课' && result.intent.fields.amount==='100' && result.intent.fields.channel==='微信';
  console.log(`pending_payment_intent:${ok?'PASS':'FAIL'}`);
  if(!ok)process.exitCode=1;
} catch { console.log('pending_payment_intent:REJECTED'); process.exitCode=1; }
const pendingStudentIntent={mode:'new',operation:'payment.preview',fields:{studentName:'林小雨',courseName:'主课',amount:'100',channel:'微信'},question:null};
const afterConfirmation={...task,status:'completed',hasPreview:false,alreadyExecuted:true,pendingStudentIntent,references:[{values:{studentName:'林小雨',courseName:'主课'}}]};
const pendingHistory=[...history,{role:'user',content:userMessage},{role:'assistant',content:'上一位学生的建档尚未确认，请先确认建档，再继续缴费。'}];
for (const [name,message,mode] of [['continue','好的，接着办','continue'],['cancel','先算了，别收钱','cancel'],['correct','金额改成200再办','correct']]) {
  try {
    const plan=await createModelMultiStepInterpreter(model)({businessDate:'2026-10-21',task:afterConfirmation,history:pendingHistory,userMessage:message});
    const result=await createIntentParser(model)({businessDate:'2026-10-21',task:afterConfirmation,history:pendingHistory,userMessage:message});
    const ok=!plan && result.kind==='parsed' && result.intent.mode===mode && (mode==='cancel' || !result.intent.operation || result.intent.operation==='payment.preview') && (mode!=='correct' || result.intent.fields.amount==='200');
    console.log(`pending_${name}:${ok?'PASS':'FAIL'}`);
    if (!ok) console.log(`pending_${name}_diagnosis:plan_${plan?'present':'none'}:result_${result.kind}${result.kind==='parsed'?`:mode_${result.intent.mode}:operation_${result.intent.operation ?? 'none'}:amount_${result.intent.fields.amount==='200'?'expected':'other'}`:''}`);
    if(!ok)process.exitCode=1;
  } catch { console.log(`pending_${name}:REJECTED`); process.exitCode=1; }
}
