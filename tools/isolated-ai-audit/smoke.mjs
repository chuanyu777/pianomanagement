import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { assertAccountRows } from './account-assertions.mjs';
import { assertFinancialQueryDenied } from './teacher-assertions.mjs';
console.log('ISOLATED_SMOKE_STARTED');
const password=readFileSync(0,'utf8');
if(!/^[A-Za-z0-9_-]{32}$/.test(password)) throw new Error('INVALID_TEMPORARY_PASSWORD');
const bootstrap=spawnSync('node',['apps/core-api/dist/modules/auth/bootstrap-owner.js'],{env:{...process.env,OWNER_BOOTSTRAP_USERNAME:'isolated_owner',OWNER_BOOTSTRAP_PASSWORD:password},stdio:'ignore'});
if(bootstrap.status!==0) throw new Error('BOOTSTRAP_FAILED');
console.log('ISOLATED_BOOTSTRAP_PASSED');
const base='http://127.0.0.1:3000/api';
let token;
async function request(path, body, authenticated=true, accessToken=token) {
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{...(authenticated?{authorization:`Bearer ${accessToken}`} : {}),...(body?{'content-type':'application/json','Idempotency-Key':randomUUID()}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  if(!response.ok) { console.log(`ISOLATED_HTTP_${response.status}`); throw new Error('REQUEST_FAILED'); }
  return response.json();
}
token=(await request('/auth/login',{username:'isolated_owner',password:password},false)).accessToken;
console.log('ISOLATED_LOGIN_PASSED');
const student=await request('/students',{name:'林悦',notes:'合成数据'});
console.log('ISOLATED_STUDENT_PASSED');
const course=await request('/courses',{name:'主课',defaultUnitPrice:'200.00',defaultDurationMinutes:60});
console.log('ISOLATED_COURSE_PASSED');
const account=await request(`/students/${student.id}/course-accounts`,{courseId:course.id});
const secondCourse=await request('/courses',{name:'陪练课',defaultUnitPrice:'80.00',defaultDurationMinutes:45});
const secondAccount=await request(`/students/${student.id}/course-accounts`,{courseId:secondCourse.id});
console.log('ISOLATED_ACCOUNT_PASSED');
await request(`/student-course-accounts/${account.id}/payments`,{amount:'500.00',channel:'WECHAT',occurredAt:'2026-10-21T03:00:00.000Z'});
await request(`/student-course-accounts/${account.id}/gifts`,{amount:'80.00',occurredAt:'2026-10-21T03:00:00.000Z'});
await request(`/student-course-accounts/${secondAccount.id}/payments`,{amount:'120.00',channel:'WECHAT',occurredAt:'2026-10-21T03:00:00.000Z'});
await request(`/student-course-accounts/${secondAccount.id}/gifts`,{amount:'20.00',occurredAt:'2026-10-21T03:00:00.000Z'});
console.log('ISOLATED_PAYMENT_PASSED');
const before=await request(`/student-course-accounts/${account.id}/balance`);
const secondBefore=await request(`/student-course-accounts/${secondAccount.id}/balance`);
const databaseUrl=new URL(process.env.CORE_DATABASE_URL);
assert.equal(databaseUrl.hostname,'core-db');
assert.equal(databaseUrl.pathname,'/piano_core_ai_audit');
const pool=new pg.Pool({connectionString:process.env.CORE_DATABASE_URL});
async function records(accountId=account.id){
  const ledger=await pool.query('SELECT to_jsonb(t) AS row FROM "LedgerEntry" t WHERE "accountId"=$1 ORDER BY id',[accountId]);
  const payments=await pool.query('SELECT to_jsonb(t) AS row FROM "PaymentRecord" t WHERE "accountId"=$1 ORDER BY id',[accountId]);
  return {ledger:ledger.rows,payments:payments.rows};
}
const ledgerBefore=await records();
const secondLedgerBefore=await records(secondAccount.id);
console.log('ISOLATED_FIXTURE_PASSED');

const direct=await request('/assistant/previews/course-accounts/payment',{accountId:account.id,amount:'100.00',channel:'WECHAT',occurredAt:'2026-10-21T03:00:00.000Z',idempotencyKey:randomUUID(),requestId:randomUUID()});
console.log('ISOLATED_DIRECT_PREVIEW_CREATED');
const directCurrent=await request(`/assistant/previews/${direct.previewId}`);
assert.equal(directCurrent.status,'PENDING');
assert.equal(directCurrent.command?.accountId,account.id);
assert.equal(directCurrent.command?.amount,'100.00');
assert.equal(directCurrent.resourceVersions?.accountId,account.id);
assert.equal(directCurrent.display?.beforeBalance?.paidBalance,'500.00');
assert.equal(directCurrent.display?.afterBalance?.paidBalance,'600.00');
assert.deepEqual(await request(`/student-course-accounts/${account.id}/balance`),before);
assert.deepEqual(await records(),ledgerBefore);
console.log('ISOLATED_CORE_PREVIEW_PASSED');

async function run(message, threadId, accessToken=token) {
  console.log('ISOLATED_RUN_STARTED');
  const job=await request('/assistant/runs',{message,clientRequestId:randomUUID(),...(threadId ? {threadId} : {})},true,accessToken);
  console.log('ISOLATED_RUN_CREATED');
  const response=await fetch(`${base}/assistant/runs/${job.runId}/events`,{headers:{authorization:`Bearer ${accessToken}`,'x-thread-id':job.threadId},signal:AbortSignal.timeout(100000)});
  if(!response.ok || !response.body)throw new Error(`SSE_HTTP_${response.status}`);
  const reader=response.body.getReader(),decoder=new TextDecoder(),events=[];let buffer='',done=false;
  try { while(!done){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});let split;while((split=buffer.search(/\r?\n\r?\n/))>=0){const frame=buffer.slice(0,split);buffer=buffer.slice(split).replace(/^\r?\n\r?\n/,'');const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(data){const event=JSON.parse(data);events.push(event);if(['run.completed','run.failed'].includes(event.type))done=true;}}} } finally {await reader.cancel().catch(()=>{});}
  const terminal=events.findLast(x=>['run.completed','run.failed'].includes(x.type))?.type;
  if (terminal !== 'run.completed') console.log(terminal === 'run.failed' ? 'ISOLATED_RUN_FAILED' : 'ISOLATED_RUN_NO_TERMINAL');
  assert.equal(terminal,'run.completed');
  console.log('ISOLATED_RUN_COMPLETED');
  return {threadId:job.threadId,answer:events.filter(x=>x.type==='assistant.delta').map(x=>x.text).join(''),workspace:events.findLast(x=>x.type==='workspace.replace')?.document};
}
const newStudent=await request('/students',{name:'陈小雨',notes:'合成数据'});
assert.deepEqual(await request(`/students/${newStudent.id}/course-accounts`),[]);
const combined=await run('给陈小雨的主课交费100元，微信，每节课180元');
const combinedBlock=combined.workspace?.blocks?.find(x=>x.type==='action-preview');
if (!combinedBlock) {
  console.log('ISOLATED_COMBINED_NO_ACTION');
  console.log(combined.answer ? 'ISOLATED_COMBINED_HAS_ANSWER' : 'ISOLATED_COMBINED_EMPTY_ANSWER');
  console.log(combined.workspace ? 'ISOLATED_COMBINED_HAS_WORKSPACE' : 'ISOLATED_COMBINED_NO_WORKSPACE');
  if (combined.workspace?.resultKind === 'clarification') console.log('ISOLATED_COMBINED_CLARIFICATION');
  if (combined.workspace?.resultKind === 'error') console.log('ISOLATED_COMBINED_ERROR');
  if (/安全拆分|办理顺序/u.test(combined.answer)) console.log('ISOLATED_COMBINED_PLAN_REJECTED');
  if (/没太听懂|更具体/u.test(combined.answer)) console.log('ISOLATED_COMBINED_INTENT_UNCLEAR');
  if (/金额/u.test(combined.answer)) console.log('ISOLATED_COMBINED_AMOUNT_REQUESTED');
  if (/渠道|支付方式/u.test(combined.answer)) console.log('ISOLATED_COMBINED_CHANNEL_REQUESTED');
  for (const [label,pattern] of [['STUDENT',/学生/u],['COURSE',/课程|主课/u],['CONFIRM',/确认|尚未/u],['AMBIGUOUS',/选择|多个|同名|澄清/u],['UNAVAILABLE',/失败|不可用|稍后/u]]) if(pattern.test(combined.answer)) console.log(`ISOLATED_COMBINED_HINT_${label}`);
}
if (combinedBlock && combinedBlock.actionType !== 'course-account.payment') console.log('ISOLATED_COMBINED_WRONG_ACTION');
assert.equal(combinedBlock?.actionType,'course-account.payment');
console.log('ISOLATED_COMBINED_ACTION_PASSED');
const combinedCurrent=await request(`/assistant/previews/${combinedBlock.previewId}`);
assert.equal(combinedCurrent.status,'PENDING');
console.log('ISOLATED_COMBINED_STATUS_PASSED');
assert.equal(combinedCurrent.command?.studentId,newStudent.id);
console.log('ISOLATED_COMBINED_STUDENT_PASSED');
assert.equal(combinedCurrent.command?.courseId,course.id);
console.log('ISOLATED_COMBINED_COURSE_PASSED');
assert.equal(combinedCurrent.command?.amount,'100.00');
console.log('ISOLATED_COMBINED_AMOUNT_PASSED');
assert.equal(combinedCurrent.command?.currentUnitPrice,'180.00');
console.log('ISOLATED_COMBINED_PRICE_PASSED');
assert.equal(combinedCurrent.command?.channel,'WECHAT');
console.log('ISOLATED_COMBINED_CHANNEL_PASSED');
assert.equal(combinedCurrent.display?.beforeBalance?.paidBalance,'0.00');
assert.equal(combinedCurrent.display?.afterBalance?.paidBalance,'100.00');
assert.deepEqual(await request(`/students/${newStudent.id}/course-accounts`),[]);
console.log('ISOLATED_COMBINED_AI_PREVIEW_PASSED');
// Exercise the user's original cross-turn case through the real model and the
// public Core confirmation endpoint, using only disposable synthetic records.
console.log('ISOLATED_PRONOUN_CREATE_START');
const createdStudent=await run('新建学生张小鱼');
const studentBlock=createdStudent.workspace?.blocks?.find(x=>x.type==='action-preview');
if (!studentBlock) {
  console.log('ISOLATED_CREATE_NO_ACTION');
  if (createdStudent.workspace?.resultKind === 'clarification') console.log('ISOLATED_CREATE_CLARIFICATION');
  if (/安全拆分|办理顺序/u.test(createdStudent.answer)) console.log('ISOLATED_CREATE_PLAN_REJECTED');
  if (/没太听懂|更具体/u.test(createdStudent.answer)) console.log('ISOLATED_CREATE_INTENT_UNCLEAR');
  if (/姓名/u.test(createdStudent.answer)) console.log('ISOLATED_CREATE_NAME_REQUESTED');
}
if (studentBlock && studentBlock.actionType !== 'student.create') console.log('ISOLATED_CREATE_WRONG_ACTION');
assert.equal(studentBlock?.actionType,'student.create');
console.log('ISOLATED_PRONOUN_CREATE_PREVIEW');
const confirmedStudent=await request(`/assistant/previews/${studentBlock.previewId}/confirm`,{});
assert.equal(confirmedStudent.status,'EXECUTED');
console.log('ISOLATED_PRONOUN_CREATE_CONFIRMED');
const referred=await run('他主课缴费2000元，微信',createdStudent.threadId);
const referredBlock=referred.workspace?.blocks?.find(x=>x.type==='action-preview');
if (!referredBlock) {
  console.log('ISOLATED_PRONOUN_NO_ACTION');
  if (referred.workspace?.resultKind === 'clarification') console.log('ISOLATED_PRONOUN_CLARIFICATION');
  if (/安全拆分|办理顺序/u.test(referred.answer)) console.log('ISOLATED_PRONOUN_PLAN_REJECTED');
  if (/姓名|哪位/u.test(referred.answer)) console.log('ISOLATED_PRONOUN_NAME_REQUESTED');
  if (/课程/u.test(referred.answer)) console.log('ISOLATED_PRONOUN_COURSE_REQUESTED');
  for (const [label,pattern] of [['STUDENT',/学生/u],['COURSE',/课程|主课/u],['CONFIRM',/确认|尚未/u],['AMBIGUOUS',/选择|多个|同名/u],['UNAVAILABLE',/失败|不可用|稍后/u]]) if(pattern.test(referred.answer)) console.log(`ISOLATED_PRONOUN_HINT_${label}`);
}
if (referredBlock && referredBlock.actionType !== 'course-account.payment') console.log('ISOLATED_PRONOUN_WRONG_ACTION');
assert.equal(referredBlock?.actionType,'course-account.payment');
console.log('ISOLATED_PRONOUN_PAYMENT_PREVIEW');
const referredPreview=await request(`/assistant/previews/${referredBlock.previewId}`);
assert.equal(referredPreview.command?.studentId,confirmedStudent.receipt?.studentId);
assert.equal(referredPreview.command?.courseId,course.id);
assert.equal(referredPreview.command?.amount,'2000.00');
assert.equal(referredPreview.command?.channel,'WECHAT');
assert.deepEqual(await request(`/students/${confirmedStudent.receipt.studentId}/course-accounts`),[]);
console.log('ISOLATED_CONFIRMED_STUDENT_PRONOUN_PASSED');
const pendingStudent=await run('新建学生林小雨');
const pendingCreate=pendingStudent.workspace?.blocks?.find(x=>x.type==='action-preview');
assert.equal(pendingCreate?.actionType,'student.create');
console.log('ISOLATED_PENDING_CREATE_PASSED');
const pendingPayment=await run('他主课缴费100元，微信',pendingStudent.threadId);
if (!/建档尚未确认|先确认建档/u.test(pendingPayment.answer)) {
  if (pendingPayment.workspace?.resultKind === 'clarification') console.log('ISOLATED_PENDING_REQUEST_CLARIFICATION');
  if (pendingPayment.workspace?.resultKind === 'error') console.log('ISOLATED_PENDING_REQUEST_ERROR');
  if (/学生|姓名/u.test(pendingPayment.answer)) console.log('ISOLATED_PENDING_REQUEST_STUDENT');
  if (/渠道|方式/u.test(pendingPayment.answer)) console.log('ISOLATED_PENDING_REQUEST_CHANNEL');
}
assert.match(pendingPayment.answer,/建档尚未确认|先确认建档/u);
assert.ok(!pendingPayment.workspace?.blocks?.some(x=>x.type==='action-preview' && x.actionType==='course-account.payment'));
console.log('ISOLATED_PENDING_REQUEST_PASSED');
const pendingReceipt=await request(`/assistant/previews/${pendingCreate.previewId}/confirm`,{});
assert.equal(pendingReceipt.status,'EXECUTED');
console.log('ISOLATED_PENDING_CONFIRM_PASSED');
const resumedPayment=await run('好的，接着办',pendingStudent.threadId);
const resumedBlock=resumedPayment.workspace?.blocks?.find(x=>x.type==='action-preview');
if (!resumedBlock) {
  if (resumedPayment.workspace?.resultKind === 'clarification') console.log('ISOLATED_PENDING_RESUME_CLARIFICATION');
  if (resumedPayment.workspace?.resultKind === 'error') console.log('ISOLATED_PENDING_RESUME_ERROR');
  if (/学生|姓名/u.test(resumedPayment.answer)) console.log('ISOLATED_PENDING_RESUME_STUDENT');
  if (/渠道|方式/u.test(resumedPayment.answer)) console.log('ISOLATED_PENDING_RESUME_CHANNEL');
  if (/金额/u.test(resumedPayment.answer)) console.log('ISOLATED_PENDING_RESUME_AMOUNT');
  if (/已经确认执行|不能通过修改/u.test(resumedPayment.answer)) console.log('ISOLATED_PENDING_RESUME_EXECUTED');
  if (/安全拆分|办理顺序/u.test(resumedPayment.answer)) console.log('ISOLATED_PENDING_RESUME_PLAN_REJECTED');
  if (/无法确定要办理|没太听懂/u.test(resumedPayment.answer)) console.log('ISOLATED_PENDING_RESUME_UNCLEAR');
  if (/已拆为按顺序/u.test(resumedPayment.answer)) console.log('ISOLATED_PENDING_RESUME_NEW_PLAN');
  if (/尚未确认|等待.*确认/u.test(resumedPayment.answer)) console.log('ISOLATED_PENDING_RESUME_WAITING');
  if (/不支持|不可用|失败|稍后重试/u.test(resumedPayment.answer)) console.log('ISOLATED_PENDING_RESUME_UNAVAILABLE');
}
assert.equal(resumedBlock?.actionType,'course-account.payment');
const resumedPreview=await request(`/assistant/previews/${resumedBlock.previewId}`);
assert.equal(resumedPreview.command?.studentId,pendingReceipt.receipt?.studentId);
assert.equal(resumedPreview.command?.courseId,course.id);
assert.equal(resumedPreview.command?.amount,'100.00');
assert.equal(resumedPreview.command?.channel,'WECHAT');
assert.deepEqual(await request(`/students/${pendingReceipt.receipt.studentId}/course-accounts`),[]);
console.log('ISOLATED_PENDING_PAYMENT_NATURAL_CONTINUE_PASSED');
const cancelStudent=await run('新建学生张小宁');
const cancelCreate=cancelStudent.workspace?.blocks?.find(x=>x.type==='action-preview');
assert.equal(cancelCreate?.actionType,'student.create');
const cancelPending=await run('他主课缴费100元，微信',cancelStudent.threadId);
assert.match(cancelPending.answer,/建档尚未确认|先确认建档/u);
const cancelReceipt=await request(`/assistant/previews/${cancelCreate.previewId}/confirm`,{});
assert.equal(cancelReceipt.status,'EXECUTED');
const cancelled=await run('先算了，别收钱',cancelStudent.threadId);
assert.match(cancelled.answer,/已取消/u);
assert.match(cancelled.answer,/建档/u);
assert.ok(!cancelled.workspace?.blocks?.some(x=>x.type==='action-preview'));
assert.deepEqual(await request(`/students/${cancelReceipt.receipt.studentId}/course-accounts`),[]);
console.log('ISOLATED_PENDING_PAYMENT_CANCEL_PASSED');
const correctStudent=await run('新建学生陈小宁');
const correctCreate=correctStudent.workspace?.blocks?.find(x=>x.type==='action-preview');
assert.equal(correctCreate?.actionType,'student.create');
const correctPending=await run('他主课缴费100元，微信',correctStudent.threadId);
assert.match(correctPending.answer,/建档尚未确认|先确认建档/u);
const correctReceipt=await request(`/assistant/previews/${correctCreate.previewId}/confirm`,{});
assert.equal(correctReceipt.status,'EXECUTED');
const corrected=await run('金额改成200再办',correctStudent.threadId);
const correctedBlock=corrected.workspace?.blocks?.find(x=>x.type==='action-preview');
assert.equal(correctedBlock?.actionType,'course-account.payment');
const correctedPreview=await request(`/assistant/previews/${correctedBlock.previewId}`);
assert.equal(correctedPreview.command?.studentId,correctReceipt.receipt?.studentId);
assert.equal(correctedPreview.command?.courseId,course.id);
assert.equal(correctedPreview.command?.amount,'200.00');
assert.equal(correctedPreview.command?.channel,'WECHAT');
assert.deepEqual(await request(`/students/${correctReceipt.receipt.studentId}/course-accounts`),[]);
console.log('ISOLATED_PENDING_PAYMENT_CORRECT_PASSED');
const stagedStudent=await run('新建学生王小雨');
const stagedCreate=stagedStudent.workspace?.blocks?.find(x=>x.type==='action-preview');
assert.equal(stagedCreate?.actionType,'student.create');
const stagedReceipt=await request(`/assistant/previews/${stagedCreate.previewId}/confirm`,{});
const intervening=await run('查看今天的排课',stagedStudent.threadId);
assert.ok(!intervening.workspace?.blocks?.some(x=>x.type==='action-preview'));
console.log('ISOLATED_CONTEXT_INTERVENING_QUERY_PASSED');
const needsChannel=await run('他主课缴费2000元',stagedStudent.threadId);
if (!/渠道|方式|微信|现金/.test(needsChannel.answer)) {
  console.log('ISOLATED_FOLLOWUP_NO_CHANNEL_QUESTION');
  if (needsChannel.workspace?.resultKind === 'clarification') console.log('ISOLATED_FOLLOWUP_CLARIFICATION');
  if (/安全拆分|办理顺序/u.test(needsChannel.answer)) console.log('ISOLATED_FOLLOWUP_PLAN_REJECTED');
  if (/学生|姓名/u.test(needsChannel.answer)) console.log('ISOLATED_FOLLOWUP_STUDENT_REQUESTED');
  if (/金额/u.test(needsChannel.answer)) console.log('ISOLATED_FOLLOWUP_AMOUNT_REQUESTED');
}
assert.match(needsChannel.answer,/渠道|方式|微信|现金/);
assert.ok(!needsChannel.workspace?.blocks?.some(x=>x.type==='action-preview'));
console.log('ISOLATED_PRONOUN_CHANNEL_REQUESTED');
const channelReply=await run('微信',stagedStudent.threadId);
const channelBlock=channelReply.workspace?.blocks?.find(x=>x.type==='action-preview');
assert.equal(channelBlock?.actionType,'course-account.payment');
const channelPreview=await request(`/assistant/previews/${channelBlock.previewId}`);
assert.equal(channelPreview.command?.studentId,stagedReceipt.receipt?.studentId);
assert.equal(channelPreview.command?.courseId,course.id);
assert.equal(channelPreview.command?.amount,'2000.00');
assert.equal(channelPreview.command?.channel,'WECHAT');
assert.deepEqual(await request(`/students/${stagedReceipt.receipt.studentId}/course-accounts`),[]);
console.log('ISOLATED_PRONOUN_CHANNEL_PASSED');
const fourStepPlan=await run('先查看今天排课，再看今天的经营概况，然后查看学生资料，最后查看欠费学生');
assert.match(fourStepPlan.answer,/4步|四步/u);
for (const message of ['开始第一步','继续','继续','继续']) {
  const step=await run(message,fourStepPlan.threadId);
  assert.equal(step.workspace?.resultKind,'query');
  assert.ok(!step.workspace?.blocks?.some(x=>x.type==='action-preview'));
}
const afterPlan=await run('查看今天的排课',fourStepPlan.threadId);
assert.equal(afterPlan.workspace?.resultKind,'query');
assert.ok(!afterPlan.workspace?.blocks?.some(x=>x.type==='action-preview'));
console.log('ISOLATED_FOUR_QUERIES_AND_NEXT_REQUEST_PASSED');
const query=await run('查询林悦的主课余额');
assert.match(query.answer+JSON.stringify(query.workspace),/500\.00/);
assert.ok(!query.workspace?.blocks?.some(x=>x.type==='action-preview'));

const allAccounts=await run('查询林悦所有课程账户的余额');
assertAccountRows(allAccounts,[
  {course:course.name,paid:before.paidBalance,gift:before.giftBalance,total:before.totalBalance,price:account.currentUnitPrice},
  {course:secondCourse.name,paid:secondBefore.paidBalance,gift:secondBefore.giftBalance,total:secondBefore.totalBalance,price:secondAccount.currentUnitPrice},
]);
assert.deepEqual(await records(),ledgerBefore);
assert.deepEqual(await records(secondAccount.id),secondLedgerBefore);
console.log('ISOLATED_MULTI_ACCOUNT_PASSED');

const missingAmount=await run('给林悦的主课交费，微信支付');
assert.match(missingAmount.answer,/金额|多少/);
assert.ok(!missingAmount.workspace?.blocks?.some(x=>x.type==='action-preview'));
const missingChannel=await run('给林悦的主课交费100元');
assert.match(missingChannel.answer,/渠道|方式|微信|现金/);
assert.ok(!missingChannel.workspace?.blocks?.some(x=>x.type==='action-preview'));
assert.deepEqual(await records(),ledgerBefore);
assert.deepEqual(await records(secondAccount.id),secondLedgerBefore);
console.log('ISOLATED_MISSING_PAYMENT_FIELDS_PASSED');

const payment=await run('给林悦的主课交费100元，微信');
const preview=payment.workspace?.blocks?.find(x=>x.type==='action-preview');
assert.equal(preview?.actionType,'course-account.payment');
assert.ok(preview.previewId);
const current=await request(`/assistant/previews/${preview.previewId}`);
assert.equal(current.previewId,preview.previewId);
assert.equal(current.actionType,'course-account.payment');
assert.equal(current.status,'PENDING');
assert.equal(current.receipt,null);
assert.equal(current.command?.amount,'100.00');
assert.equal(current.command?.accountId,account.id);
assert.equal(current.resourceVersions?.accountId,account.id);
assert.equal(current.display?.beforeBalance?.accountId,account.id);
assert.equal(current.display?.beforeBalance?.paidBalance,'500.00');
assert.equal(current.display?.afterBalance?.paidBalance,'600.00');
assert.match(current.display?.summary ?? '',/100\.00/);
const after=await request(`/student-course-accounts/${account.id}/balance`);
assert.deepEqual(after,before);
const ledgerAfter=await records();
assert.deepEqual(ledgerAfter,ledgerBefore);
console.log('ISOLATED_MODEL_PREVIEW_PASSED');

const duplicate=await request('/students',{name:'林悦',notes:'另一位合成学生'});
const ambiguous=await run('查询林悦的主课余额');
const picker=ambiguous.workspace?.blocks?.find(x=>x.type==='entity-picker');
assert.ok(picker);
assert.deepEqual(new Set(picker.candidates.map(x=>x.id)),new Set([student.id,duplicate.id]));
assert.doesNotMatch(ambiguous.answer+JSON.stringify(ambiguous.workspace),/500\.00/);
assert.equal(typeof ambiguous.workspace?.taskVersion,'number');
const selected=await run(`选择候选:${student.id}:${ambiguous.workspace.taskVersion}`,ambiguous.threadId);
assert.match(selected.answer+JSON.stringify(selected.workspace),/500\.00/);
assert.ok(!selected.workspace?.blocks?.some(x=>x.type==='action-preview'));
const ambiguousAgain=await run('查询林悦的主课余额');
const secondPicker=ambiguousAgain.workspace?.blocks?.find(x=>x.type==='entity-picker');
assert.deepEqual(new Set(secondPicker?.candidates.map(x=>x.id)),new Set([student.id,duplicate.id]));
assert.equal(typeof ambiguousAgain.workspace?.taskVersion,'number');
const noAccount=await run(`选择候选:${duplicate.id}:${ambiguousAgain.workspace.taskVersion}`,ambiguousAgain.threadId);
assert.match(noAccount.answer,/没有找到/);
assert.doesNotMatch(noAccount.answer+JSON.stringify(noAccount.workspace),/500\.00/);
assert.ok(!noAccount.workspace?.blocks?.some(x=>x.type==='action-preview'));
assert.deepEqual(await records(),ledgerBefore);
console.log('ISOLATED_SAME_NAME_PASSED');

const teacherPassword=randomBytes(24).toString('base64url');
const teacherUsername='isolated_teacher';
await request('/teachers',{username:teacherUsername,password:teacherPassword,name:'王老师'});
const teacherToken=(await request('/auth/login',{username:teacherUsername,password:teacherPassword},false)).accessToken;
const forbidden=await run('查询林悦的主课余额',undefined,teacherToken);
assertFinancialQueryDenied(forbidden,['500.00','580.00','80.00',account.id,secondAccount.id]);
assert.deepEqual(await records(),ledgerBefore);
assert.deepEqual(await records(secondAccount.id),secondLedgerBefore);
console.log('ISOLATED_TEACHER_DENIAL_PASSED');
await pool.end();
console.log('ISOLATED_SMOKE_PASSED');
