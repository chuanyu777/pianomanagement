/** Opt-in AI dialogue audit. Uses public Core HTTP + real Agent/SSE, never Agent Confirm. */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const base = process.env.AI_DIALOGUE_CORE_URL ?? 'http://localhost:3000/api';
if (!/^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/api$/.test(base)) throw new Error('LOCAL_TEST_TARGET_REQUIRED');
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
const outDir = path.join(root, 'test-results', `ai-dialogue-${stamp}`);
mkdirSync(outDir, { recursive: true });
const privateDir = mkdtempSync('/private/tmp/piano-ai-dialogue-');
const tag = `对话测${Date.now().toString(36).slice(-5)}`;
const credentials = { username: `ai_dialogue_${Date.now()}`, password: randomBytes(24).toString('base64url') };
const privateSessionFile = path.join(privateDir, 'session.json');
const report = { startedAt: new Date().toISOString(), scope: 'AI dialogue only', tag, layer: 'real Core HTTP -> Agent -> PostgreSQL -> SSE; first-turn reachability, not full-case passes', environment: {}, fixtures: {}, results: [], controls: [] };
let ownerToken;
function docker(args, env = process.env) {
  const r = spawnSync('docker', ['compose', ...args], { cwd: root, env, encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024 });
  if (r.status !== 0) throw new Error(`DOCKER_STEP_FAILED:${r.status}:${(r.stderr ?? '').slice(-700)}`);
  return r.stdout;
}
async function request(endpoint, options = {}, token = ownerToken) {
  const response = await fetch(`${base}${endpoint}`, { ...options, headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers }, signal: AbortSignal.timeout(20000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP_${response.status}:${endpoint}:${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
const post = (endpoint, body, token = ownerToken) => request(endpoint, { method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': randomUUID() } }, token);
const day = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * 86400000));
const saveReport = () => writeFileSync(path.join(outDir, 'http-results.json'), JSON.stringify(report, null, 2));

async function run(message, { threadId, token = ownerToken, clientRequestId = randomUUID() } = {}) {
  const startedAt = Date.now();
  const job = await post('/assistant/runs', { message, ...(threadId ? { threadId } : {}), clientRequestId }, token);
  const response = await fetch(`${base}/assistant/runs/${job.runId}/events`, { headers: { authorization: `Bearer ${token}`, 'x-thread-id': job.threadId }, signal: AbortSignal.timeout(70000) });
  if (!response.ok || !response.body) throw new Error(`SSE_HTTP_${response.status}`);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; const events = []; let terminal = false;
  try {
    while (!terminal) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, split); const delimiter = /^\r?\n\r?\n/.exec(buffer.slice(split))[0]; buffer = buffer.slice(split + delimiter.length);
        const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data); events.push(event);
        if (event.type === 'run.completed' || event.type === 'run.failed') terminal = true;
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
  const workspace = events.findLast(e => e.type === 'workspace.replace')?.document;
  const answer = events.filter(e => e.type === 'assistant.delta').map(e => e.text).join('');
  return { message, runId: job.runId, threadId: job.threadId, elapsedMs: Date.now() - startedAt, terminal: events.findLast(e => e.type === 'run.completed' || e.type === 'run.failed')?.type ?? 'missing', answer, workspace, eventTypes: events.map(e => e.type) };
}

function firstTurnVerdict(id, result) {
  const text = `${result.workspace?.title ?? ''}\n${result.answer}`;
  const preview = result.workspace?.blocks?.find(b => b.type === 'action-preview');
  if (result.terminal === 'run.failed') return { status: 'failed', reason: 'real Agent run failed before completing this dialogue step' };
  if (/暂不支持|当前无法查询|助手暂不支持/.test(text)) return { status: 'failed', reason: 'frozen MVP dialogue rejected as unsupported' };
  if (/请按[“「]|YYYY-MM-DD HH:mm|请补充能够唯一识别/.test(text)) return { status: 'failed', reason: 'asks for a whole fixed-format command instead of understanding or structured selection' };
  if (id === 'Q02') return result.workspace?.blocks?.some(b => b.type === 'data-table') ? { status: 'first-turn-supported', reason: 'today query only; other date variants and subsequent turns remain separate' } : { status: 'failed', reason: 'no real schedule table' };
  if (id === 'Q10') return /现金|实际收款/.test(text) && /经营/.test(text) ? { status: 'first-turn-supported', reason: 'income scope distinguished; not full report verification' } : { status: 'failed', reason: 'silently chooses operating income for ambiguous income question' };
  if (id === 'K01') return result.workspace?.title === '需要补充信息' || preview
    ? { status: 'failed', reason: 'read-only preclose checklist misclassified as a write operation' }
    : { status: 'first-turn-observed', reason: 'read-only preclose response requires checklist and source-record assertions; not a case pass' };
  if (id.startsWith('Q')) return preview ? { status: 'failed', reason: 'query misrouted to write preview' } : result.workspace?.title === '需要补充信息' ? { status: 'failed', reason: 'read question misclassified as write operation missing parameters' } : { status: 'first-turn-supported', reason: 'read route reached; data-specific full assertions not implied' };
  const asks = new Set(['S02','S04','S05','S07','S10','S12','F02','F04','F05','R02','R03','R05','R06','W04','W08','K03','K04']);
  if (asks.has(id)) return { status: 'first-turn-observed', reason: 'clarification/rejection needs semantic review and subsequent turns; not a case pass' };
  return preview ? { status: 'first-turn-supported', reason: `real Core Preview reached:${preview.actionType}; not yet browser-confirmed` } : { status: 'failed', reason: 'expected actionable business Preview, got neither Preview nor targeted continuation' };
}

try {
  report.environment.coreHealth = await request('/health', {}, undefined);
  report.environment.agent = JSON.parse(docker(['exec','-T','agent','node','--input-type=module','-e', `import fs from 'node:fs';import {createHash} from 'node:crypto';console.log(JSON.stringify({enabled:process.env.AI_ENABLED,provider:process.env.AI_PROVIDER,model:process.env.AI_MODEL,hasKey:!!process.env.AI_API_KEY,graphHash:createHash('sha256').update(fs.readFileSync('apps/agent-runtime/dist/graph/business-query-graph.js')).digest('hex')}));`]));
  report.environment.localGraphHash = createHash('sha256').update(readFileSync(path.join(root, 'apps/agent-runtime/dist/graph/business-query-graph.js'))).digest('hex');
  report.environment.sameAgentBuild = report.environment.localGraphHash === report.environment.agent.graphHash;
  if (!report.environment.sameAgentBuild) throw new Error('DEPLOYED_AGENT_DIFFERS_FROM_CURRENT_BUILD');
  docker(['exec','-T','-e','OWNER_BOOTSTRAP_USERNAME','-e','OWNER_BOOTSTRAP_PASSWORD','core','npm','run','auth:bootstrap:owner','-w','@piano/core-api'], { ...process.env, OWNER_BOOTSTRAP_USERNAME: credentials.username, OWNER_BOOTSTRAP_PASSWORD: credentials.password });
  ownerToken = (await post('/auth/login', credentials, undefined)).accessToken;
  if (!ownerToken) throw new Error('OWNER_LOGIN_FAILED');
  writeFileSync(privateSessionFile, JSON.stringify({ ...credentials, accessToken: ownerToken, base, tag }), { mode: 0o600 });
  const studentNames = ['林悦','小雨','小林','小明','小明','李安'];
  const students = [];
  for (let i = 0; i < studentNames.length; i++) students.push(await post('/students', { name: tag + studentNames[i], notes: `AI对话专项测试 ${i+1}；不是真实学员资料` }));
  const teachers = [];
  for (const surname of ['王','李']) {
    const account = { username: `${credentials.username}_${surname === '王' ? 't1' : 't2'}`, password: randomBytes(24).toString('base64url'), name: `${tag}${surname}老师` };
    const created = await post('/teachers', account);
    const token = (await post('/auth/login', { username: account.username, password: account.password }, undefined)).accessToken;
    teachers.push({ ...created, token });
  }
  const course = await post('/courses', { name: '主课', defaultUnitPrice: '200.00', defaultDurationMinutes: 60 });
  const accompaniment = await post('/courses', { name: '陪练', defaultUnitPrice: '80.00', defaultDurationMinutes: 45 });
  const accounts = [];
  for (const student of students) accounts.push(await post(`/students/${student.id}/course-accounts`, { courseId: course.id }));
  const secondary = await post(`/students/${students[0].id}/course-accounts`, { courseId: accompaniment.id });
  const now = new Date().toISOString();
  for (const [account, amount] of [[accounts[0],'500.00'],[secondary,'120.00'],[accounts[1],'500.00'],[accounts[2],'1000.00']]) await post(`/student-course-accounts/${account.id}/payments`, { amount, channel:'WECHAT', occurredAt:now, note:'AI对话专用初始数据' });
  await post(`/student-course-accounts/${accounts[0].id}/gifts`, { amount:'80.00', occurredAt:now, note:'AI对话专用初始赠送' });
  await post(`/student-course-accounts/${secondary.id}/gifts`, { amount:'20.00', occurredAt:now, note:'AI对话专用初始赠送' });
  const lessons = [];
  for (const offset of [-1,0,1,2]) lessons.push(await post('/lessons', { accountId: accounts[0].id, teacherId:teachers[0].id, startsAt:`${day(offset)}T09:00:00+08:00`, note:'AI对话专项范围标记' }));
  report.fixtures = { students: students.map(s=>({ id:s.id,name:s.name })), teachers:teachers.map(t=>({id:t.id,name:t.name})), accounts:accounts.map(a=>a.id), secondaryAccount:secondary.id, lessons:lessons.map(l=>({id:l.id,startsAt:l.startsAt})), note:'isolated name prefix, current real date; not the full fixed-clock 83-case fixture. API writes above are fixture preparation, not successful AI writes.' };
  writeFileSync(privateSessionFile, JSON.stringify({ ...credentials, accessToken:ownerToken, base, tag, teacherTokens:teachers.map(t=>t.token), accountId:accounts[0].id, resultsDir:outDir }), { mode:0o600 });
  const before = await request(`/student-course-accounts/${accounts[0].id}/balance`);
  report.environment.beforeBalance = before;
  report.environment.assistantStatus = await request('/assistant/status');
  saveReport();
  console.log(JSON.stringify({ stage:'ready', reportDir:outDir, privateSessionFile, tag, sameAgentBuild:true }));
  const spec = readFileSync(path.join(root,'docs/AI对话功能测试用例-v1.0-评审稿.md'),'utf8');
  const heads = [...spec.matchAll(/^### ([QBSFRWMK]\d{2}) .+$/gm)];
  const cases = heads.map((h,i) => { const block=spec.slice(h.index,heads[i+1]?.index??spec.length); return { id:h[1], message:block.match(/^\d+\. 用户：(.+)$/m)?.[1] }; }).filter(c=>c.message);
  const replacements = [['林悦',students[0].name],['小雨',students[1].name],['小林',students[2].name],['小明',students[3].name],['王老师',teachers[0].name],['李老师',teachers[1].name],['小晴',tag+'小晴'],['赵老师',tag+'赵老师']];
  for (const entry of cases) {
    let message=entry.message; for (const [a,b] of replacements) message=message.replaceAll(a,b);
    try { const result=await run(message); report.results.push({ caseId:entry.id, ...firstTurnVerdict(entry.id,result), ...result }); }
    catch(error){ report.results.push({caseId:entry.id,status:'blocked',reason:String(error.message).slice(0,500),message}); }
    saveReport(); console.log(JSON.stringify({ caseId:entry.id,...Object.fromEntries(['status','reason'].map(k=>[k,report.results.at(-1)[k]])),title:report.results.at(-1).workspace?.title }));
  }
  const past=await run('查看昨天排课'); const tomorrow=await run('查看明天排课');
  report.controls.push({name:'yesterday-query',...past},{name:'tomorrow-query',...tomorrow});
  const payment=await run(`给${students[0].name}的主课交费 1000 元，微信`);
  const correction=await run('不是1000，是100，改支付宝',{threadId:payment.threadId});
  const cancellation=await run('先别收了，只查余额',{threadId:payment.threadId});
  report.controls.push({name:'legacy-canonical-payment',...payment},{name:'same-thread-correction',...correction},{name:'same-thread-cancel',...cancellation});
  const teacherOwn=await run('我今天有哪些课？',{token:teachers[0].token});
  const teacherBalance=await run(`查询${students[0].name}主课余额`,{token:teachers[0].token});
  const teacherCompletion=await run(`确认${students[0].name}的上课`,{token:teachers[0].token});
  report.controls.push({name:'teacher-own-query',...teacherOwn},{name:'teacher-financial-query',...teacherBalance},{name:'teacher-completion-preview',...teacherCompletion});
  report.environment.afterBalance = await request(`/student-course-accounts/${accounts[0].id}/balance`);
  report.environment.noUnconfirmedMoneyWrite = JSON.stringify(before) === JSON.stringify(report.environment.afterBalance);
  report.finishedAt = new Date().toISOString();
  saveReport();
  console.log(JSON.stringify({stage:'complete',reportDir:outDir,cases:report.results.length,counts:Object.fromEntries(['failed','blocked','first-turn-supported','first-turn-observed'].map(s=>[s,report.results.filter(r=>r.status===s).length])),noUnconfirmedMoneyWrite:report.environment.noUnconfirmedMoneyWrite,privateSessionFile}));
} catch(error) {
  report.fatal = String(error.message).slice(0,900); saveReport(); console.log(JSON.stringify({stage:'blocked',reason:report.fatal,reportDir:outDir})); process.exitCode=1;
}
