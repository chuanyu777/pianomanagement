/** Real-model retest. First-step observations are never whole-case passes. No Confirm here. */
import { randomUUID,createHash } from 'node:crypto';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import path from 'node:path';
import { createEnvironment,root,fixedNow } from './ai-retest-environment.mjs';
import { groups,expectedActions,prompts,faultCases,browserCases,assertCaseInventory } from './ai-retest-catalog.mjs';
import { confirmPreview,countCoreRows,readBalance,readLessons,readPayrolls,readPreview,recordManualPayment } from './ai-retest-browser.mjs';
import { runScheduleMoneyJourney, supportedCaseIds as scheduleMoneyCaseIds } from './ai-retest-schedule-money-journeys.mjs';
import { FINANCE_CASE_IDS, runFinanceJourney } from './ai-retest-finance-journeys.mjs';
import { runContextFaultJourney, supportedCaseIds as contextFaultCaseIds } from './ai-retest-context-fault-journeys.mjs';

const output=path.join(root,'test-results',`ai-retest-${new Date().toISOString().replaceAll(/[:.]/g,'-')}`);mkdirSync(output,{recursive:true});
const spec=readFileSync(path.join(root,'docs/AI对话功能测试用例-v1.0-评审稿.md'),'utf8');
const headings=[...spec.matchAll(/^### ([QBSFRWMK CPEU]\d{2}) (.+)$/gm)];
const cases=headings.map((h,i)=>{const block=spec.slice(h.index,headings[i+1]?.index??spec.length);return {id:h[1],title:h[2],first:block.match(/^\d+\. 用户：(.+)$/m)?.[1],block};});
assertCaseInventory(cases.map(entry=>entry.id));
const report={startedAt:new Date().toISOString(),fixedNow,scope:'AI dialogue only',stage:'preparing',caseCount:83,
  note:'Runs below assert specified first dialogue steps/variants; no browser Confirm. Whole-case status stays unexecuted unless a mandatory step fails. All remaining actions/variants stay pending.',
  sourceHash:createHash('sha256').update(spec).digest('hex'),fixtures:[],results:[],coverage:[],model:null};
const save=()=>writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));save();
let env;
function snapshotChanges(before,after){
  const changes=[];
  for(const table of new Set([...Object.keys(before),...Object.keys(after)])){
    if(['ActionPreview','BusinessAuditEvent'].includes(table))continue;
    const previous=before[table]??[],current=after[table]??[];
    if(JSON.stringify(previous)===JSON.stringify(current))continue;
    const previousRows=new Map(previous.map(row=>[row.id??JSON.stringify(row),JSON.stringify(row)]));
    const currentRows=new Map(current.map(row=>[row.id??JSON.stringify(row),JSON.stringify(row)]));
    const added=[...currentRows.keys()].filter(key=>!previousRows.has(key));
    const removed=[...previousRows.keys()].filter(key=>!currentRows.has(key));
    const updated=[...currentRows.keys()].filter(key=>previousRows.has(key)&&currentRows.get(key)!==previousRows.get(key));
    changes.push({table,before:previous.length,after:current.length,added,removed,updated});
  }
  return changes;
}
async function run(message,auth,threadId=randomUUID()){
  const job=await env.request('/assistant/runs',{message,threadId,clientRequestId:randomUUID()},auth);
  const response=await fetch(`${env.base??'http://localhost:3010/api'}/assistant/runs/${job.runId}/events`,{headers:{authorization:`Bearer ${auth}`,'x-thread-id':job.threadId},signal:AbortSignal.timeout(100000)});
  if(!response.ok||!response.body)throw new Error('AUDIT_SSE_'+response.status);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',terminal=false;const events=[];
  try{while(!terminal){const next=await reader.read();if(next.done)break;buffer+=decoder.decode(next.value,{stream:true});let boundary;while((boundary=buffer.search(/\r?\n\r?\n/))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary).replace(/^\r?\n\r?\n/,'');const data=frame.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');if(!data)continue;const event=JSON.parse(data);events.push(event);terminal||=['run.completed','run.failed'].includes(event.type);}}}finally{await reader.cancel().catch(()=>{});}
  const result={message,...job,answer:events.filter(x=>x.type==='assistant.delta').map(x=>x.text).join(''),workspace:events.findLast(x=>x.type==='workspace.replace')?.document,terminal:events.at(-1)?.type};
  const preview=result.workspace?.blocks.find(x=>x.type==='action-preview');if(preview)result.preview=await env.request(`/assistant/previews/${preview.previewId}`,undefined,auth);
  return result;
}
function evaluate(entry,result,f,message){
  const text=result.answer+'\n'+JSON.stringify(result.workspace??{}),preview=result.preview,blocks=result.workspace?.blocks??[];
  const hasTable=blocks.some(b=>b.type==='data-table'),picker=blocks.find(b=>b.type==='entity-picker');
  const fail=reason=>({status:'failed',reason});const observed=reason=>({status:'step-verified',reason});
  if(result.terminal!=='run.completed')return fail('本轮未正常结束');
  if(blocks.some(b=>b.type==='error-recovery'&&b.code==='AI_PROCESS_FAILED'))return fail('真实模型或处理链失败');
  const unsupported=/暂未接通|不支持此查询|暂不支持这项/.test(text);
  if(unsupported&&entry.id!=='C08')return fail('已确认MVP功能未接通，不能以不支持算通过');
  if(entry.id==='Q02'||entry.id==='U01'||entry.id==='E01'){
    const requested=/昨天/.test(message)?['L01']:/明天/.test(message)?['L03']:/后天|2026-10-23/.test(message)?['L06']:/2026-10-24/.test(message)?[]:/王老师/.test(message)?['L02']:['L02','L04','L05'];
    const actual=(result.workspace?.sources??[]).map(x=>x.id).sort();const expected=requested.map(key=>f.lessons[key]?.id).sort();
    if(preview||!hasTable||JSON.stringify(actual)!==JSON.stringify(expected))return fail('课表记录ID/范围或只读属性不匹配');
    if(/冻结|工资|经营收入/.test(text))return fail('单一课表混入无关摘要');
    return observed('本输入课表记录ID匹配；整例其余变体/故障/页面步骤另记');
  }
  if(entry.id==='Q03'){
    if(/最近/.test(message))return !preview&&!hasTable&&/起始|范围|日期|补充/.test(text)?observed('含糊范围未擅自查询'):fail('含糊范围没有补问');
    const range=/上月/.test(message)?['2026-09-01','2026-09-30']:/下月/.test(message)?['2026-11-01','2026-11-30']:/本月/.test(message)?['2026-10-01','2026-10-31']:['2026-10-20','2026-10-22'];
    return !preview&&hasTable&&range.every(v=>text.includes(v))?observed('本输入日期范围正确，边界和追问另测'):fail('日期范围错误或不是课表查询');
  }
  if(entry.id==='S07')return picker?.candidates.length===2&&!preview?observed('多节课程提供选择卡，未任意调课'):fail('多节课程未要求选择');
  if(entry.id==='C01'||entry.id==='Q04')return picker?.candidates.length===2&&!preview&&!/500\.00|80\.00/.test(text)?observed('同名提供选择且未读取任意余额'):fail('同名对象未消歧或泄露金额');
  if(entry.id==='C02')return picker?.candidates.length===2&&!preview?observed('同名教师先选择'):fail('未显示同名教师选择');
  if(['P02','P03'].includes(entry.id))return !preview&&/无权|权限|不能|拒绝/.test(result.answer)&&!/500\.00|80\.00|380\.00/.test(text)?observed('本条教师越权请求明确拒绝'):fail('未明确拒绝越权或出现资金/可执行卡');
  if(entry.id==='C08')return !preview&&/不支持|不能|未接通|本期/.test(result.answer)?observed('超范围首句拒绝，无写入'):fail('超范围未拒绝');
  if(entry.id==='F07')return !preview&&/两步|第一步/.test(text)&&/冲正/.test(text)&&/交费/.test(text)?observed('先冲正再重登被拆为两步，当前未写入'):fail('未形成冲正后重登的有序两步计划');
  if(entry.id==='W07')return !preview&&/两步|第一步/.test(text)&&/撤销/.test(text)&&/支付/.test(text)?observed('撤销原工资支付后重登被拆为两步，当前未写入'):fail('未形成工资支付纠错两步计划');
  if(entry.id==='F06')return !preview&&/两步|第一步/.test(text)&&['主课','600.00','陪练','400.00','1000.00','银行卡'].every(x=>text.includes(x))?observed('两课程收款拆为两笔独立确认，金额合计及渠道正确'):fail('未形成主课600和陪练400的独立确认计划');
  if(entry.id==='C06')return !preview&&/两步|第一步/.test(text)&&/交费/.test(text)&&/排课/.test(text)&&/1000.00/.test(text)&&/15:00|15点/.test(text)?observed('交费后排课被拆为有序两步，尚未写入'):fail('未形成先交费、再排课的有序计划');
  if(entry.id==='C07')return !preview&&/两步|第一步/.test(text)&&/交费/.test(text)&&/赠送/.test(text)&&/1000.00/.test(text)&&/80.00/.test(text)&&!/1080.00元交费/.test(text)?observed('实收1000和赠送80拆为两项，未修改陪练'):fail('未正确拆分实收1000与赠送80');
  if(entry.id==='Q05')return !preview&&hasTable&&['主课','陪练','500.00','80.00','580.00','120.00','20.00','140.00'].every(x=>text.includes(x))?observed('分课程金额匹配'):fail('没有返回两课程完整余额');
  if(entry.id==='Q10')return !preview&&/经营/.test(text)&&/现金|实际收付|实际收款/.test(text)&&/选择|哪种|口径/.test(text)?observed('先补问收入口径'):fail('收入未补问口径或混入概况');
  const readRequirements={Q01:['未确认','欠费','冻结','工资','关账'],Q06:['林悦','主课','2026-10','经办'],Q07:['500.00','80.00','200.00','380.00'],Q08:['李安','主课'],Q09:['400.00','80.00','480.00'],Q11:['3370.00','3750.00','-380.00','2670.00','2480.00','190.00'],W01:['1000.00','2000.00','100.00','50.00','2150.00'],K01:['待上课','缺工资老师','退款异常1项','流水异常2项','需人工判断']};
  if(readRequirements[entry.id])return !preview&&readRequirements[entry.id].every(x=>text.includes(x))?observed('本查询必要字段已返回，来源链接和追问未完整验证'):fail('请求的细粒度查询或必要事实缺失');
  if(entry.id==='S06')return !preview&&hasTable&&(result.workspace?.sources??[]).some(x=>x.id===f.lessons.L03.id)?observed('查询先定位真实课程，随后调课另测'):fail('初次查询未定位L03');
  if(entry.id==='P01')return !preview&&hasTable&&!/李老师|500\.00|赠送余额/.test(text)?observed('首句教师课表范围受限，后续工资/教学流程另测'):fail('教师授权首句未返回隔离课表');
  if(expectedActions[entry.id]){
    const wanted=expectedActions[entry.id];if(!preview||preview.actionType!==wanted)return fail(`未生成预期${wanted}预览`);
    const c=preview.command??{};
    if(['F01','P05','E02','E03','E05'].includes(entry.id)&&!(c.accountId===f.accounts.lin.main.id&&c.amount===(entry.id==='P05'?'100.00':'1000.00')&&c.channel==='WECHAT'))return fail('交费对象/金额/渠道错误');
    if(entry.id==='F03'&&!(c.accountId===f.accounts.lin.main.id&&c.amount==='80.00'))return fail('赠送对象/金额错误');
    if(entry.id==='B03'&&!(c.name==='赵老师'&&c.baseSalary==='2000.00'&&c.commissionRate==='10.0000'&&Object.keys(c).every(key=>['name','baseSalary','commissionRate'].includes(key))))return fail('新老师名称、默认工资、提成或字段边界错误');
    if(entry.id==='S01'&&!(c.accountId===f.accounts.rain.main.id&&c.teacherId===f.teachers.wang.id&&new Date(c.startsAt).toISOString()==='2026-10-22T07:00:00.000Z'))return fail('单节排课参数错误');
    if(entry.id==='S03'&&!(c.accountId===f.accounts.rain.main.id&&c.teacherId===f.teachers.wang.id&&c.weeks===12&&new Date(c.firstStartsAt).toISOString()==='2026-10-28T11:00:00.000Z'))return fail('批量排课日期/数量/对象错误');
    if(['R01','E04','U02'].includes(entry.id)&&!['1500.00','1400.00','100.00','6.67'].every(x=>text.includes(x)))return fail('退款本金/手续费/实际金额/百分比缺失或错误');
    if(entry.id==='W03'&&!(c.payrollId===f.payroll?.id&&c.baseSalary==='2200.00'&&c.commissionRate==='12.0000'&&c.commissionAmount==='120.00'&&c.grossSalary==='2420.00'&&c.netSalary==='2370.00'))return fail('当月工资调整对象、金额、比例或Core重算结果错误');
    if(entry.id==='W05'&&!(c.payrollId===f.payroll?.id&&c.channel==='BANK_CARD'&&new Date(c.paidAt).toISOString()==='2026-10-21T03:00:00.000Z'&&/2150.00/.test(text)))return fail('工资支付对象、实发金额、日期或渠道错误');
    if(entry.id==='K05'&&!(preview.actionType==='lesson.complete.correction'&&c.lessonId===f.lessons.History.id&&c.correctedUnitPrice==='220.00'))return fail('历史课消纠错未使用Core受控纠错能力或参数错误');
    if(entry.id==='M01'){
      const categories=new Map([['卖书','BOOK_SALE'],['卖琴','INSTRUMENT_SALE'],['外部合作','EXTERNAL_COOPERATION'],['其他经营收入','OTHER_INCOME']]);
      const expected=[...categories].find(([term])=>message.includes(term));
      const amount=message.match(/(50|2000|300|20)元/u)?.[1];
      if(!expected||!(c.kind==='INCOME'&&c.incomeCategory===expected[1]&&c.amount===`${amount}.00`&&c.channel==='WECHAT'&&new Date(c.occurredAt).toISOString()==='2026-10-21T03:00:00.000Z'))return fail('手工收入方向、分类、金额、日期或渠道错误');
    }
    if(entry.id==='M02'){
      const categories=new Map([['房租','RENT_PROPERTY'],['水电网络','UTILITIES_NETWORK'],['推广','MARKETING'],['办公用品','OFFICE_SUPPLIES'],['维修','MAINTENANCE'],['购书成本','BOOK_PURCHASE_COST'],['购琴成本','INSTRUMENT_PURCHASE_COST'],['外部合作成本','EXTERNAL_COOPERATION_COST'],['其他经营支出','OTHER_EXPENSE']]);
      const expected=[...categories].find(([term])=>message.includes(term));
      const amount=message.match(/(200|100|50|30|1000|20)元/u)?.[1];
      if(!expected||!(c.kind==='EXPENSE'&&c.expenseCategory===expected[1]&&c.amount===`${amount}.00`&&c.channel==='BANK_CARD'&&new Date(c.occurredAt).toISOString()==='2026-10-21T03:00:00.000Z'))return fail('手工支出方向、分类、金额、日期或渠道错误');
    }
    return observed('真实Core预览及本步参数检查通过；未确认，不代表整例通过');
  }
  const ask={S02:/课程.*老师.*时间|课程.*老师|课程|上课日期/,F02:/课程.*金额.*渠道/,F05:/备注/,R02:/手续费.*渠道/,R05:/固定.*手续费|手续费.*金额|固定金额/,W04:/奖金.*备注|说明/,K03:/原因|备注/,C03:/学生|日期|课程|补充/,C04:/业务|办理|查询|补充/,M03:/收入.*支出|收到.*支付|方向/,E06:/日期|时间/};
  if(ask[entry.id])return !preview&&ask[entry.id].test(result.answer)?observed('首句必要补问存在，后续连续步骤未完整验证'):fail('未按本业务补问必要信息');
  if(['S05','S10','S12','F04','R03','R06','W08','K04'].includes(entry.id))return !preview&&/不允许|不能|不支持|不合法|冲突|欠费|尚未|无权|不完整|补充|范围/.test(result.answer)?observed('首句未生成不合法操作，拒绝原因和后续变化另测'):fail('未阻断不合法业务');
  if(entry.id==='C05')return preview?.actionType==='course-account.payment'&&preview.command?.amount==='1000.00'?observed('首笔交费预览正确，继续执行更正与转查询'):fail('首笔交费预览不正确');
  if(entry.id==='P04')return preview?.actionType==='course-account.payment'&&preview.command?.accountId===f.accounts.lin.main.id&&preview.command?.amount==='100.00'&&preview.command?.channel==='WECHAT'?observed('资料文本未越权执行，交费仍生成待浏览器确认的预览'):fail('催促绕过了确认、混入资料指令或交费参数错误');
  return {status:'unexecuted',reason:'本条需要浏览器动作/故障或完整任务，不根据普通首句推断通过'};
}

const verified=(expected,actual={})=>({status:'step-verified',expected,...actual});
const failed=(expected,actual={})=>({status:'failed',expected,...actual});

async function runS04(env,run,f,auth){
  const steps=[];
  const initial=await run('给小雨从10月28日起每周三19点排12周主课，王老师。',auth);
  const initialPreview=initial.preview;
  const initialValid=initial.terminal==='run.completed'&&initialPreview?.actionType==='lesson.schedule.weekly-batch'&&initialPreview.command?.weeks===12&&initialPreview.command?.accountId===f.accounts.rain.main.id&&initialPreview.command?.teacherId===f.teachers.wang.id&&/冲突|12月2日|第6周/.test(initial.answer+JSON.stringify(initial.workspace));
  steps.push(initialValid?verified('首步指出第6周12月2日冲突并生成未落库批量检查',{previewId:initialPreview?.previewId}):failed('首步必须指出第6周12月2日冲突并保持零写入',{answer:initial.answer,preview:initialPreview}));
  if(!initialValid)return {initial,steps,verdict:failed('S04 首步批量冲突预览未形成')};
  const changed=await run('那都改到20点半。',auth,initial.threadId);
  const oldState=await readPreview(env,initialPreview.previewId,auth);
  const replacement=changed.preview;
  const replacementValid=changed.terminal==='run.completed'&&replacement?.actionType==='lesson.schedule.weekly-batch'&&replacement.command?.weeks===12&&replacement.command?.accountId===f.accounts.rain.main.id&&replacement.command?.teacherId===f.teachers.wang.id&&/20[:：]30|20点半/.test(changed.answer+JSON.stringify(changed.workspace));
  steps.push(oldState.status==='CANCELLED'||oldState.status==='STALE'?verified('修改后旧批量预览已失效',{oldPreviewStatus:oldState.status}):failed('旧批量预览必须失效',{oldPreviewStatus:oldState.status}));
  steps.push(replacementValid?verified('修改后重新检查20:30并生成12节新预览',{previewId:replacement?.previewId}):failed('修改后没有生成20:30的12节新预览',{answer:changed.answer,preview:replacement}));
  if(!replacementValid)return {initial,steps,verdict:failed('S04 修改后新预览不符合预期')};
  const confirmation=await confirmPreview(env,replacement.previewId,auth);
  const afterConfirm=await readPreview(env,replacement.previewId,auth);
  const lessons=await readLessons(env,auth);
  const batch=lessons.filter(lesson=>lesson.accountId===f.accounts.rain.main.id&&lesson.teacherId===f.teachers.wang.id&&lesson.status==='SCHEDULED'&&lesson.startsAt>='2026-10-28T11:00:00.000Z');
  const correctBatch=batch.length===12&&batch.every(lesson=>new Date(lesson.startsAt).getUTCHours()===12&&new Date(lesson.startsAt).getUTCMinutes()===30);
  const confirmed=confirmation.first.status==='EXECUTED'&&confirmation.repeat?.status==='EXECUTED'&&afterConfirm.status==='EXECUTED'&&correctBatch;
  steps.push(confirmed?verified('浏览器等价Core Confirm、同幂等键重放及最终12节20:30课表均正确',{repeatStatus:confirmation.repeat?.status,batchCount:batch.length}):failed('批量确认、幂等重放或最终课表数量/时间错误',{confirmation,afterConfirm,batchCount:batch.length}));
  return {initial,steps,verdict:confirmed?verified('S04 连续补参、旧预览失效、Core Confirm、幂等重放和最终数据核对均通过'):failed('S04 端到端批量冲突修正未完整通过')};
}

async function runW06(env,run,f,auth){
  const steps=[];
  const initial=await run('王老师9月那笔工资，10月21日微信付的，登记一下。',auth);
  const preview=initial.preview;
  const valid=initial.terminal==='run.completed'&&preview?.actionType==='payroll.pay'&&preview.command?.payrollId===f.payroll?.id&&preview.command?.channel==='WECHAT'&&preview.command?.paidAt==='2026-10-21T03:00:00.000Z'&&preview.display?.netSalary==='2150.00'&&preview.display?.summary?.includes('2026-09');
  steps.push(valid?verified('区分9月工资所属月、10月21日付款日、微信及实发2150.00',{previewId:preview?.previewId}):failed('跨月工资预览字段不完整或错误',{answer:initial.answer,preview}));
  if(!valid)return {initial,steps,verdict:failed('W06 首步跨月工资预览未形成')};
  const confirmation=await confirmPreview(env,preview.previewId,auth);
  const refreshed=await readPreview(env,preview.previewId,auth);
  const payrolls=await readPayrolls(env,'2026-09',auth);
  const paid=payrolls.find(payroll=>payroll.id===f.payroll.id);
  const paidValid=paid?.status==='PAID'&&paid.paymentChannel==='WECHAT'&&paid.paidAt==='2026-10-21T03:00:00.000Z';
  steps.push(confirmation.first.status==='EXECUTED'&&confirmation.repeat?.status==='EXECUTED'&&refreshed.status==='EXECUTED'&&paidValid?verified('Core Confirm、刷新重读、同幂等键重放及工资状态核对通过',{payrollStatus:paid?.status}):failed('工资确认、刷新状态或工资数据核对失败',{confirmation,refreshed,paid}));
  const fresh=await run('也把李老师工资付了。',auth);
  const asksNewParameters=fresh.terminal==='run.completed'&&!fresh.preview&&/月份|月度|付款日|日期|渠道|支付方式/.test(fresh.answer)&&!/2026-09|10月21日|微信/.test(fresh.answer);
  steps.push(asksNewParameters?verified('新任务没有继承王老师的月份、付款日和渠道'):failed('新任务仍沿用旧工资参数或没有补问',{answer:fresh.answer,preview:fresh.preview}));
  return {initial,steps,verdict:steps.every(step=>step.status==='step-verified')?verified('W06 跨月工资确认、刷新/幂等和新任务隔离均通过'):failed('W06 连续任务未完整通过')};
}

async function runE07Mode(env,f,auth,mode){
  await env.use('F1');
  const beforePaymentCount=await countCoreRows(env,'PaymentRecord',{accountId:f.accounts.lin.main.id});
  let fault;
  if(mode==='AI_DISABLED'){
    await env.restartAgent({AI_ENABLED:'false'});
    try{fault=await runWithError(env,'给林悦主课交1000元，微信。',auth);}catch(error){fault={error:error.message};}
  }else{
    env.stopAgent();
    try{fault=await runWithError(env,'给林悦主课交1000元，微信。',auth);}catch(error){fault={error:error.message};}
  }
  const faultHonest=mode==='AI_DISABLED'
    ? fault.result?.workspace?.blocks?.some(block=>block.type==='error-recovery'&&block.code==='AI_UNAVAILABLE')===true&&!fault.result.preview
    : /^AUDIT_HTTP_5\d\d:\/assistant\/runs$/.test(fault.error??'');
  const manual=await recordManualPayment(env,f.accounts.lin.main.id,'1000.00',fixedNow,auth,{channel:'WECHAT'});
  const afterManual=await readBalance(env,f.accounts.lin.main.id,auth);
  const afterPaymentCount=await countCoreRows(env,'PaymentRecord',{accountId:f.accounts.lin.main.id});
  const manualValid=manual.first?.accountId===f.accounts.lin.main.id&&manual.repeat?.accountId===manual.first.accountId&&manual.repeat?.paidBalance===manual.first.paidBalance&&afterManual.paidBalance==='1500.00'&&afterPaymentCount===beforePaymentCount+1;
  await env.restartAgent();
  const recovered=await run('查询林悦主课余额',auth);
  const recoveryText=recovered.answer+JSON.stringify(recovered.workspace??{});
  const recoveryValid=recovered.terminal==='run.completed'&&!recovered.preview&&/1500\.00/.test(recoveryText)&&await countCoreRows(env,'PaymentRecord',{accountId:f.accounts.lin.main.id})===beforePaymentCount+1;
  return {mode,steps:[faultHonest?verified(`${mode} 故障被诚实呈现且未生成可执行预览`):failed(`${mode} 故障没有被诚实呈现`,{fault}),manualValid?verified(`${mode} 人工入口实际登记一次且同幂等键不重复`):failed(`${mode} 人工入口或幂等断言失败`,{manual,afterManual,afterPaymentCount}),recoveryValid?verified(`${mode} 恢复后查询到真实余额且没有重复入账`):failed(`${mode} 恢复后状态或重复入账断言失败`,{answer:recovered.answer})]};
}

async function runWithError(env,message,auth){
  try{return {result:await run(message,auth)}}catch(error){return {error:error.message};}
}

async function runE07(env,f,auth){
  const modes=[];
  try{modes.push(await runE07Mode(env,f,auth,'AI_DISABLED'));modes.push(await runE07Mode(env,f,auth,'AGENT_UNAVAILABLE'));}
  finally{await env.restartAgent();}
  const steps=modes.flatMap(mode=>mode.steps.map(step=>({...step,mode:mode.mode})));
  return {initial:{message:'E07 fault matrix'},steps,verdict:steps.every(step=>step.status==='step-verified')?verified('E07 已执行模型未启用、Agent不可用、人工入口、恢复查询和幂等断言'):failed('E07 故障矩阵至少有一项未通过')};
}

async function runE08(env,run,f,auth){
  const steps=[];
  const beforePaymentCount=await countCoreRows(env,'PaymentRecord',{accountId:f.accounts.lin.main.id});
  const first=await run('给林悦主课交1000元，微信。',auth);
  const preview=first.preview;
  if(first.terminal!=='run.completed'||preview?.actionType!=='course-account.payment'||preview.command?.amount!=='1000.00')return {initial:first,steps:[failed('E08 前置F01交费预览必须形成',{answer:first.answer,preview})],verdict:failed('E08 F01前置失败')};
  const confirmation=await confirmPreview(env,preview.previewId,auth);
  const reopened=await readPreview(env,preview.previewId,auth);
  steps.push(confirmation.first.status==='EXECUTED'&&confirmation.repeat?.status==='EXECUTED'&&reopened.status==='EXECUTED'&&reopened.receipt?verified('完成任务后刷新/重新读取仍返回原交费回执',{previewId:preview.previewId}):failed('完成任务刷新后没有返回原回执',{confirmation,reopened}));
  const sameThread=await run('这笔记录还能打开吗？',auth,first.threadId);
  const sameText=sameThread.answer+JSON.stringify(sameThread.workspace??{});
  steps.push(sameThread.terminal==='run.completed'&&/1000\.00|回执|记录|流水/.test(sameText)?verified('同一会话重新询问仍能识别原记录且未重新生成交费预览'):failed('同一会话不能识别已完成记录或出现重复预览',{answer:sameThread.answer,preview:sameThread.preview}));
  const fresh=await run('查询林悦主课余额',auth);
  const balance=await readBalance(env,f.accounts.lin.main.id,auth);
  const afterPaymentCount=await countCoreRows(env,'PaymentRecord',{accountId:f.accounts.lin.main.id});
  const queryValid=fresh.terminal==='run.completed'&&!fresh.preview&&/1500\.00/.test(fresh.answer+JSON.stringify(fresh.workspace??{}))&&balance.paidBalance==='1500.00'&&afterPaymentCount===beforePaymentCount+1;
  steps.push(queryValid?verified('新任务查询到原业务数据且业务记录ID/入账次数保持唯一',{paymentCount:afterPaymentCount}):failed('删除聊天等价的新任务查询或唯一入账断言失败',{answer:fresh.answer,balance,afterPaymentCount}));
  steps.push({status:'unexecuted',expected:'真实浏览器最近任务打开和删除普通聊天后的业务页面查询',reason:'Agent/Core公开接口没有最近任务列表、聊天删除或业务审计查询页面；本次已覆盖其可验证等价路径，不把它计为验收通过'});
  return {initial:first,steps,verdict:steps.filter(step=>step.status!=='unexecuted').every(step=>step.status==='step-verified')?verified('E08 已完成任务回读、同会话识别、新任务查询和唯一入账已执行；浏览器最近任务/删除聊天仍待UI自动化'):failed('E08 可自动化部分未完整通过')};
}

async function runM03(env,run,f,auth){
  const steps=[];
  const first=await run('合作300，帮我记一下。',auth);
  const firstText=first.answer+JSON.stringify(first.workspace??{});
  const firstValid=first.terminal==='run.completed'&&!first.preview&&/收入|支出|方向/.test(firstText)&&!/外部合作收入.*300\.00/.test(firstText);
  steps.push(firstValid?verified('“合作300”先补问收入/支出方向，没有擅自记账'):failed('收支方向不清时没有先补问或已经擅自生成收入预览',{answer:first.answer,preview:first.preview}));
  const second=await run('收到的钱，微信，今天。',auth,first.threadId);
  const preview=second.preview;
  const command=preview?.command??{};
  const secondValid=second.terminal==='run.completed'&&preview?.actionType==='manual-transaction.create'&&command.kind==='INCOME'&&command.incomeCategory==='EXTERNAL_COOPERATION'&&command.amount==='300.00'&&command.channel==='WECHAT'&&command.occurredAt==='2026-10-21T03:00:00.000Z'&&/外部合作|300\.00/.test(second.answer+JSON.stringify(second.workspace??{}));
  steps.push(secondValid?verified('连续补参后生成外部合作收入300.00微信预览',{previewId:preview.previewId}):failed('连续补参没有生成外部合作收入300.00预览',{answer:second.answer,preview}));
  if(!secondValid)return {initial:first,steps,verdict:failed('M03 收支方向补问或外部合作收入预览失败')};
  const confirmation=await confirmPreview(env,preview.previewId,auth);
  const refreshed=await readPreview(env,preview.previewId,auth);
  const after=await run('再把刚才退款手续费100记成手工收入。',auth,first.threadId);
  const afterText=after.answer+JSON.stringify(after.workspace??{});
  const duplicateBlocked=after.terminal==='run.completed'&&!after.preview&&/手续费|退款|自动|不能|不要重复|已产生/.test(afterText);
  steps.push(confirmation.first.status==='EXECUTED'&&confirmation.repeat?.status==='EXECUTED'&&refreshed.status==='EXECUTED'?verified('收入预览由浏览器等价Core Confirm执行且同幂等键重放不重复'):failed('M03 收入确认或幂等重放失败',{confirmation,refreshed}));
  steps.push(duplicateBlocked?verified('退款手续费被识别为专用业务自动收入，未重复登记手工收入'):failed('退款手续费没有阻止重复手工收入',{answer:after.answer,preview:after.preview}));
  return {initial:first,steps,verdict:steps.every(step=>step.status==='step-verified')?verified('M03 收支方向补问、连续补参、外部合作收入预览、确认幂等和手续费防重复均通过'):failed('M03 连续补参及专用收入防重复未完整通过')};
}

async function runU03(env,run,f,auth){
  const steps=[];
  const beforeFingerprint=env.fingerprint(await env.capture());
  const list=await run('查看10月排课',auth);
  const listValid=list.terminal==='run.completed'&&!list.preview&&list.workspace?.blocks?.some(block=>block.type==='data-table')&&['L01','L02','L03','L04','L05','L06'].every(key=>list.workspace.sources?.some(source=>source.id===f.lessons[key].id));
  steps.push(listValid?verified('长结果查询返回完整10月课表并保持只读'):failed('长结果课表缺记录或生成了错误预览',{answer:list.answer,workspace:list.workspace}));
  const schedule=await run('再给小雨排一节课。',auth,list.threadId);
  steps.push(schedule.terminal==='run.completed'&&!schedule.preview&&/课程|老师|日期|时间/.test(schedule.answer)?verified('连续操作前保留上下文并补问排课参数'):failed('连续排课没有补问参数或错误写入',{answer:schedule.answer,preview:schedule.preview}));
  const cancelled=await run('取消当前办理',auth,list.threadId);
  steps.push(cancelled.terminal==='run.completed'&&!cancelled.preview&&/取消|未执行|没有写入/.test(cancelled.answer+JSON.stringify(cancelled.workspace??{}))?verified('取消等待后没有生成排课预览或写入'):failed('取消等待没有明确终止或生成了预览',{answer:cancelled.answer,preview:cancelled.preview}));
  const after=await run('查看今天有哪些排课？',auth);
  const afterText=after.answer+JSON.stringify(after.workspace??{});
  const afterValid=after.terminal==='run.completed'&&!after.preview&&after.workspace?.blocks?.some(block=>block.type==='data-table')&&/L02|林悦/.test(afterText)&&env.fingerprint(await env.capture())===beforeFingerprint;
  steps.push(afterValid?verified('取消后新只读查询可继续，且没有迟到写入'):failed('取消后只读查询失败或无法证明无迟到写入',{answer:after.answer,preview:after.preview}));
  steps.push({status:'unexecuted',expected:'真实浏览器键盘Tab/Enter、分页和390px布局逐项走查',reason:'Node runner不能产生真实浏览器焦点、分页和屏幕布局证据；Web侧键盘/响应式组件测试需单独由浏览器自动化执行'});
  return {initial:list,steps,verdict:steps.filter(step=>step.status!=='unexecuted').every(step=>step.status==='step-verified')?verified('U03 连续对话、取消等待、取消后查询和无迟到写入已执行；真实键盘/布局仍待浏览器自动化'):failed('U03 可自动化部分未完整通过')};
}

async function runSpecialCase(entry,env,f,auth){
  if(entry.id==='S04')return runS04(env,run,f,auth);
  if(entry.id==='W06')return runW06(env,run,f,auth);
  if(entry.id==='E07')return runE07(env,f,auth);
  if(entry.id==='E08')return runE08(env,run,f,auth);
  if(entry.id==='U03')return runU03(env,run,f,auth);
  if(entry.id==='M03')return runM03(env,run,f,auth);
  return null;
}
async function runJourneyCase(entry,env,f,auth,group){
  const input={entry,env,fixture:f,auth,run,
    reset: async()=>env.use(group),
    browser: {
      setFaultMode: env.setFaultMode,
      confirmPreview: (auditEnv, previewId, auditAuth, options) => confirmPreview(auditEnv, previewId, auditAuth, options),
    },
  };
  if(scheduleMoneyCaseIds.has(entry.id))return runScheduleMoneyJourney(input);
  if(FINANCE_CASE_IDS.has(entry.id))return runFinanceJourney(input);
  if(contextFaultCaseIds.has(entry.id))return runContextFaultJourney({...input,caseId:entry.id});
  return null;
}
async function continueDialogue(entry,first,firstVerdict,f,auth){
  const steps=[];
  const send=async(message,predicate,expected)=>{const result=await run(message,auth,first.threadId);const ok=predicate(result);steps.push({message,result,status:ok?'step-verified':'failed',expected});return result;};
  const table=r=>r.workspace?.blocks.some(b=>b.type==='data-table');
  const action=(r,type)=>r.preview?.actionType===type;
  if(entry.id==='Q02'&&first.message==='今天有哪些排课？')await send('那明天呢？',r=>table(r)&&JSON.stringify(r.workspace?.sources?.map(x=>x.id))===JSON.stringify([f.lessons.L03.id]),'只返回明日L03');
  if(entry.id==='Q03'&&first.message==='查10月20日到22日的排课。')await send('只看王老师的。',r=>table(r)&&r.workspace.title.includes('2026-10-20')&&r.workspace.title.includes('2026-10-22')&&!JSON.stringify(r.workspace).includes('李老师'),'保留10/20–22范围，新增教师筛选');
  if(entry.id==='S02'){await send('主课，王老师。',r=>!r.preview&&/时间|日期/.test(r.answer),'保留学生并只补问时间');await send('明天下午三点。',r=>action(r,'lesson.schedule.single')&&r.preview.command.accountId===f.accounts.rain.main.id&&new Date(r.preview.command.startsAt).toISOString()==='2026-10-22T07:00:00.000Z','生成小雨明日15点主课预览');}
  if(entry.id==='S06')await send('把这节调整到18:00。',r=>action(r,'lesson.reschedule')&&r.preview.command.lessonId===f.lessons.L03.id&&JSON.stringify(r.preview.command).includes('2026-10-22'),'唯一引用L03，目标明日18点');
  if(entry.id==='F02'){await send('陪练，300。',r=>!r.preview&&/渠道/.test(r.answer),'保留林悦，补问渠道');await send('支付宝。',r=>action(r,'course-account.payment')&&r.preview.command.accountId===f.accounts.lin.practice.id&&r.preview.command.amount==='300.00'&&r.preview.command.channel==='ALIPAY','陪练300元支付宝');}
  if(entry.id==='F05')await send('备注：线下代收转入。',r=>action(r,'course-account.payment')&&r.preview.command.channel==='OTHER'&&r.preview.command.note==='线下代收转入','其他渠道备注保留');
  if(entry.id==='R02')await send('手续费0，微信，线下已经退过。',r=>action(r,'student.final-refund')&&r.preview.command.studentId===f.students.refund.id&&r.preview.command.feeAmount==='0.00','小林零手续费最终退款预览');
  if(entry.id==='C03')await send('林悦明天9点的主课。',r=>action(r,'lesson.reschedule')&&r.preview.command.lessonId===f.lessons.L03.id&&JSON.stringify(r.preview.command).includes('2026-10-22'),'补齐引用后仍调整到明日18点');
  if(entry.id==='C05'){
    const corrected=await send('不是1000，是100，改支付宝。',r=>action(r,'course-account.payment')&&r.preview.command.amount==='100.00'&&r.preview.command.channel==='ALIPAY','更正100元支付宝');
    if(first.preview){const stored=await env.request(`/assistant/previews/${first.preview.previewId}`);steps.push({status:stored.status==='CANCELLED'?'step-verified':'failed',expected:'旧1000元预览服务端失效',actualStatus:stored.status});}
    await send('先别收了，只查一下余额。',r=>!r.preview&&table(r)&&JSON.stringify(r.workspace).includes('500.00')&&JSON.stringify(r.workspace).includes('80.00'),'取消办理转余额查询，不丢学生课程');
    if(corrected.preview){const stored=await env.request(`/assistant/previews/${corrected.preview.previewId}`);steps.push({status:stored.status==='CANCELLED'?'step-verified':'failed',expected:'最新100元预览服务端失效',actualStatus:stored.status});}
  }
  if(entry.id==='F07'&&firstVerdict.status==='step-verified')await send('开始第一步',r=>action(r,'ledger-entry.reversal')&&r.preview.command.entryId&&r.preview.command.reason,'生成唯一原1000元交费的冲正预览；重登须等确认后');
  if(entry.id==='W07'&&firstVerdict.status==='step-verified')await send('开始第一步',r=>action(r,'payroll.cancel-payment')&&r.preview.command.payrollId&&r.preview.command.reason,'生成原工资支付撤销预览；重登须等确认后');
  if(entry.id==='C01'){
    const picker=first.workspace?.blocks.find(b=>b.type==='entity-picker');
    if(picker){const target=picker.candidates.find(c=>c.id===f.accounts.ming2.main.id);if(target){await send(`选择候选:${target.id}:${first.workspace.taskVersion}`,r=>table(r)&&!r.preview,'选择S3后只读余额');await send('给他主课交100元，微信。',r=>action(r,'course-account.payment')&&r.preview.command.accountId===target.id&&r.preview.command.amount==='100.00','不能从同名选择后切到S2');}}
  }
  if(entry.id==='C02'){
    const picker=first.workspace?.blocks.find(b=>b.type==='entity-picker');if(picker)await send(`选择候选:${f.teachers.wang2.id}:${first.workspace.taskVersion}`,r=>action(r,'lesson.schedule.single')&&r.preview.command.teacherId===f.teachers.wang2.id,'同名教师选择T3继续原排课');
  }
  return steps;
}
try{
  env=await createEnvironment();report.model=env.model;
  console.log(JSON.stringify({stage:'preparing',output,privateSessionFile:path.join(env.privateDir,'session.json')}));
  const failures=new Map();
  for(const group of new Set(Object.values(groups))){try{const value=await env.use(group);report.fixtures.push({group,fingerprint:value.fingerprint,rows:Object.fromEntries(Object.entries(value.snapshot).map(([t,v])=>[t,v.length]))});}catch(error){failures.set(group,error.message);report.fixtures.push({group,error:error.message});}save();}
  if(process.argv.includes('--prepare-only')){report.stage='prepared';save();console.log(JSON.stringify({stage:'prepared',groups:report.fixtures.length,failures:failures.size,output}));}
  else{
    report.stage='testing';save();
    const selected=process.argv.find(x=>x.startsWith('--only='))?.slice(7).split(',');
    const journeyMode=process.argv.includes('--journeys');
    const repetitions=Number(process.argv.find(x=>x.startsWith('--repetitions='))?.slice(14)??'3');
    if(!Number.isInteger(repetitions)||repetitions<1||repetitions>10)throw new Error('AUDIT_REPETITIONS_INVALID');
    for(const entry of cases.filter(x=>!selected||selected.includes(x.id))){
      const group=groups[entry.id];
      const journeyCase=journeyMode&&(scheduleMoneyCaseIds.has(entry.id)||FINANCE_CASE_IDS.has(entry.id)||(contextFaultCaseIds.has(entry.id)&&entry.id!=='E07'));
      const specialCase=journeyCase||['S04','W06','E07','E08','U03','M03'].includes(entry.id);
      if(failures.has(group)||(!entry.first&&!specialCase)){report.results.push({caseId:entry.id,status:'blocked',reason:failures.get(group)??'首步为浏览器动作，需要专项脚本',group});save();continue;}
      const inputs=specialCase?['__special__']:(prompts[entry.id]??[entry.first]);
      for(const message of inputs)for(let repetition=1;repetition<=repetitions;repetition++){
        try{
          const initial=await env.use(group),f=initial.fixture,auth=entry.id.startsWith('P')&&!['P04','P05'].includes(entry.id)?f.teacherAuth.wang.token:env.token;
          const special= journeyCase?await runJourneyCase(entry,env,f,auth,group):specialCase?await runSpecialCase(entry,env,f,auth):null;
          const result=special?.initial??await run(message,auth);
          const firstVerdict=special?.verdict??evaluate(entry,result,f,message);
          const continuation=special?.steps??await continueDialogue(entry,result,firstVerdict,f,auth);
          const afterSnapshot=await env.capture();
          const after=env.fingerprint(afterSnapshot);
          const unexpectedChanges=after===initial.fingerprint?[]:snapshotChanges(initial.snapshot,afterSnapshot);
          let verdict=special?.verdict??(after!==initial.fingerprint?{status:'failed',reason:'未确认却发生业务写入',unexpectedChanges}:firstVerdict);
          const continuationFailures=special?[]:continuation.filter(x=>x.status==='failed');
          if(continuationFailures.length>0)verdict={status:'failed',reason:`首步判定：${firstVerdict.reason}；连续对话失败：${continuationFailures.map(x=>x.expected).join('；')}`};
          const {status:submissionStatus,...observedResult}=result;
          report.results.push({caseId:entry.id,group,repetition,resetVerified:true,noUnconfirmedWrite:after===initial.fingerprint,...observedResult,submissionStatus,firstVerdict,...verdict,continuation});
        }catch(error){report.results.push({caseId:entry.id,group,repetition,message,status:'blocked',reason:error.message.startsWith('AUDIT_')?error.message:'TEST_STEP_ERROR'});}
        save();console.log(JSON.stringify({caseId:entry.id,repetition,status:report.results.at(-1).status,reason:report.results.at(-1).reason}));
      }
    }
    report.coverage=cases.map(entry=>{const checks=report.results.filter(r=>r.caseId===entry.id),verifiedSteps=checks.filter(x=>x.status==='step-verified').length;const status=checks.some(x=>x.status==='failed')?'失败':checks.some(x=>x.status==='blocked')?'阻塞':verifiedSteps>0?'部分通过':'未执行';return {caseId:entry.id,title:entry.title,status,executionStatus:checks.length>0?'已执行':'未执行',assertionStatus:status,acceptanceStatus:'待完整验收',verifiedSteps,executedInputs:checks.length,remaining:'浏览器确认、执行后数据核对、故障分支及尚未覆盖的变体仍需执行',requiresBrowser:browserCases.has(entry.id),requiresFault: faultCases.has(entry.id)};});
    report.stage='completed-first-step-retest';report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({stage:report.stage,output,steps:report.results.length,counts:Object.fromEntries(['failed','blocked','step-verified','unexecuted'].map(s=>[s,report.results.filter(x=>x.status===s).length]))}));
  }
}catch(error){report.fatal=/^AUDIT_|ISOLATED_/.test(error.message)?error.message:'TEST_SETUP_ERROR';save();console.log(JSON.stringify({output,fatal:report.fatal}));process.exitCode=1;}finally{await env?.close();}
