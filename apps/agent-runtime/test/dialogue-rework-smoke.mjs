/** Explicit opt-in local live-model dialogue smoke. Never calls Confirm. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const privateFile = process.argv[2];
const session = JSON.parse(readFileSync(privateFile, 'utf8'));
if (!/^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/api$/.test(session.base)) throw new Error('LOCAL_ONLY');
const root = path.resolve(import.meta.dirname, '../../..');
const output = path.join(root, 'test-results', `dialogue-rework-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`); mkdirSync(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), turns: [], checks: [] };
const save = () => writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
let token;
async function api(endpoint, body, auth = token, method = body ? 'POST' : 'GET') {
  const response = await fetch(session.base + endpoint, { method, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body ? { 'content-type':'application/json', 'Idempotency-Key':randomUUID() } : {}) }, ...(body ? { body:JSON.stringify(body) } : {}), signal:AbortSignal.timeout(20000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP_${response.status}:${endpoint}`);
  return data;
}
async function run(name, message, threadId = randomUUID(), auth = token) {
  const job = await api('/assistant/runs', { message, threadId, clientRequestId:randomUUID() }, auth);
  const response = await fetch(`${session.base}/assistant/runs/${job.runId}/events`, { headers:{ authorization:`Bearer ${auth}`, 'x-thread-id':job.threadId }, signal:AbortSignal.timeout(80000) });
  if (!response.ok || !response.body) throw new Error(`SSE_${response.status}`);
  const reader=response.body.getReader(); const decoder=new TextDecoder(); let text=''; const events=[]; let ended=false;
  try { while (!ended) { const {done,value}=await reader.read(); if(done)break; text+=decoder.decode(value,{stream:true}); let index; while((index=text.search(/\r?\n\r?\n/))!==-1){const frame=text.slice(0,index);text=text.slice(index).replace(/^\r?\n\r?\n/,'');const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(!data)continue;const event=JSON.parse(data);events.push(event);ended ||= ['run.completed','run.failed'].includes(event.type);}}}finally{await reader.cancel().catch(()=>{});}
  const turn={name,message,...job,workspace:events.findLast(e=>e.type==='workspace.replace')?.document,answer:events.filter(e=>e.type==='assistant.delta').map(e=>e.text).join(''),terminal:events.at(-1)?.type}; report.turns.push(turn);save();console.log(JSON.stringify({name,title:turn.workspace?.title,answer:turn.answer}));return turn;
}
const check=(name,passed)=>{report.checks.push({name,passed});save();};
const preview=turn=>turn.workspace?.blocks?.find(b=>b.type==='action-preview');
const day=offset=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+offset*86400000));
try {
  token=(await api('/auth/login',{username:session.username,password:session.password},undefined)).accessToken;
  const privateData={...session,accessToken:token,reworkResultsDir:output};writeFileSync(privateFile,JSON.stringify(privateData),{mode:0o600});
  const before=await api(`/student-course-accounts/${session.accountId}/balance`);report.beforeBalance=before;
  for(const [name,message,offset] of [['yesterday','查看昨天排课',-1],['today','今天有哪些排课',0],['tomorrow','明天有哪些课',1]]){
    const turn=await run(name,message);check(`${name}日期正确`,turn.workspace?.title?.includes(day(offset))===true&&turn.workspace?.blocks?.some(b=>b.type==='data-table')===true);
  }
  const start=await run('followup-first','今天有哪些排课？');
  const next=await run('followup-tomorrow','那明天呢？',start.threadId);check('连续追问保留课表意图',next.workspace?.title?.includes(day(1))===true);
  const student=`${session.tag}林悦`;
  const pay=await run('payment-missing-channel',`给${student}主课交费1000元`);check('缺渠道补问',/渠道/.test(pay.answer)&&!preview(pay));
  if(process.argv.includes('--restart-agent')) {
    execFileSync('docker',['compose','restart','agent'],{cwd:root,stdio:'ignore'});
    const deadline=Date.now()+30000; let healthy=false;
    while(Date.now()<deadline&&!healthy){healthy=await fetch('http://localhost:3100/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.ok).catch(()=>false);if(!healthy)await new Promise(resolve=>setTimeout(resolve,500));}
    if(!healthy)throw new Error('RESTART_HEALTH_FAILED');
    check('Agent真实重启后恢复健康',healthy);
  }
  const supplemented=await run('payment-supplement','支付宝',pay.threadId);check('渠道补充后生成真实预览',preview(supplemented)?.actionType==='course-account.payment');
  const original=preview(supplemented);
  const corrected=await run('payment-correct','不是1000，是100，改微信',pay.threadId);check('更正金额生成新预览',!!preview(corrected)&&preview(corrected)?.previewId!==original?.previewId&&JSON.stringify(corrected.workspace).includes('100.00'));
  if(original){const stored=await api(`/assistant/previews/${original.previewId}`);check('旧预览服务端失效',stored.status==='CANCELLED');}
  await run('payment-cancel','取消当前办理',pay.threadId);
  if(preview(corrected)){const stored=await api(`/assistant/previews/${preview(corrected).previewId}`);check('取消后最新预览服务端失效',stored.status==='CANCELLED');}
  const same=await run('same-name',`查${session.tag}小明主课余额`);const picker=same.workspace?.blocks?.find(b=>b.type==='entity-picker');check('同名提供选择卡',picker?.candidates?.length===2);
  if(picker){const chosen=await run('same-name-select',`选择候选:${picker.candidates[1].id}:${same.workspace.taskVersion}`,same.threadId);check('选择后查询正确账户',chosen.workspace?.blocks?.some(b=>b.type==='data-table')===true&&!preview(chosen));}
  const teacherCredentials=session.reworkTeacherCredentials??{username:`dialogue_rework_${Date.now()}`,password:randomBytes(24).toString('base64url'),name:`重构测${Date.now()}老师`};
  const teacher=session.reworkTeacherId?{id:session.reworkTeacherId}:await api('/teachers',teacherCredentials);
  Object.assign(privateData,{reworkTeacherCredentials:teacherCredentials,reworkTeacherId:teacher.id});writeFileSync(privateFile,JSON.stringify(privateData),{mode:0o600});
  const teacherToken=(await api('/auth/login',{username:teacherCredentials.username,password:teacherCredentials.password},undefined)).accessToken;
  const lesson=session.reworkLessonId?{id:session.reworkLessonId}:await api('/lessons',{accountId:session.accountId,teacherId:teacher.id,startsAt:`${day(-1)}T13:00:00+08:00`});
  privateData.reworkLessonId=lesson.id;writeFileSync(privateFile,JSON.stringify(privateData),{mode:0o600});
  const ended=await run('teacher-ended-preview',`确认${student}昨天13点的主课上完了`,randomUUID(),teacherToken);
  check('教师确认上课为L2',preview(ended)?.riskLevel==='L2');check('教师响应无学生资金字段',!!preview(ended)&&!/实收|赠送|余额|扣减|200\.00|500\.00/.test(JSON.stringify(ended.workspace)));
  const forbidden=await run('teacher-payment-denied',`给${student}主课交费100元微信`,randomUUID(),teacherToken);check('教师交费明确拒绝',/无权/.test(forbidden.answer)&&!preview(forbidden));
  const cross=await fetch(`${session.base}/assistant/runs/${pay.runId}/events`,{headers:{authorization:`Bearer ${teacherToken}`,'x-thread-id':pay.threadId},signal:AbortSignal.timeout(10000)});await cross.body?.cancel();check('跨身份不能回放店主任务',cross.status===403);
  report.fixture={teacherId:teacher.id,lessonId:lesson.id};report.afterBalance=await api(`/student-course-accounts/${session.accountId}/balance`);check('未确认没有资金写入',JSON.stringify(before)===JSON.stringify(report.afterBalance));
  report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({output,checks:report.checks.length,passed:report.checks.filter(c=>c.passed).length,failed:report.checks.filter(c=>!c.passed).length}));if(report.checks.some(c=>!c.passed))process.exitCode=1;
}catch(error){report.fatal={type:error.name,code:/^(HTTP_|SSE_)/.test(error.message)?error.message:'SMOKE_FAILED'};save();console.log(JSON.stringify({output,fatal:report.fatal}));process.exitCode=1;}
