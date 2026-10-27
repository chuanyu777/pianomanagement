import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export const root=path.resolve(import.meta.dirname,'../../..');
export const fixedNow='2026-10-21T03:00:00.000Z';
export const base='http://localhost:3010/api';
const compose=['compose','-f','compose.ai-audit.yml'];
export function docker(args,options={}) {return execFileSync('docker',[...compose,...args],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024,...options});}
export function assertAuditDatabase(url,actual) {
  const parsed=new URL(url);
  if(parsed.pathname!=='/piano_core_ai_audit'||actual!=='piano_core_ai_audit'||!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.port!=='5443')throw new Error('ISOLATED_AUDIT_DATABASE_REQUIRED');
}
const quote=value=>'"'+value.replaceAll('"','""')+'"';
export async function createEnvironment() {
  const config=JSON.parse(docker(['config','--format','json']));
  const url=new URL(config.services.core.environment.CORE_DATABASE_URL);url.hostname='127.0.0.1';url.port='5443';
  const pool=new pg.Pool({connectionString:url.href});
  const guard=async()=>assertAuditDatabase(url.href,(await pool.query('SELECT current_database() AS db')).rows[0].db);
  await guard();
  const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('_prisma_migrations','InternalRequestNonce') ORDER BY tablename")).rows.map(x=>x.tablename);
  const dependencies=(await pool.query("SELECT c.relname AS child,p.relname AS parent FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_class p ON p.oid=f.confrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE f.contype='f' AND n.nspname='public' AND c.oid<>p.oid")).rows;
  const ordered=[];
  while(ordered.length<tables.length){const ready=tables.filter(t=>!ordered.includes(t)&&dependencies.filter(d=>d.child===t).every(d=>ordered.includes(d.parent)||!tables.includes(d.parent)));if(!ready.length)throw new Error('AUDIT_FK_ORDER_UNSUPPORTED');ordered.push(...ready);}
  async function capture() {
    const snapshot={};
    for(const table of ordered)snapshot[table]=(await pool.query(`SELECT to_jsonb(t) AS row FROM public.${quote(table)} t ORDER BY to_jsonb(t)::text`)).rows.map(x=>x.row);
    return snapshot;
  }
  async function restore(snapshot) {
    await guard();
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query(`TRUNCATE TABLE ${ordered.map(t=>'public.'+quote(t)).join(', ')} RESTART IDENTITY CASCADE`);
      for(const table of ordered){
        const rows=[...(snapshot[table]??[])];
        if(table==='LedgerEntry')rows.sort((a,b)=>Number(Boolean(a.reversesEntryId))-Number(Boolean(b.reversesEntryId)));
        for(const row of rows)await client.query(`INSERT INTO public.${quote(table)} SELECT * FROM json_populate_record(NULL::public.${quote(table)},$1::json)`,[JSON.stringify(row)]);
      }
      await client.query('COMMIT');
    }catch{await client.query('ROLLBACK');throw new Error('AUDIT_SNAPSHOT_RESTORE_FAILED');}finally{client.release();}
  }
  function fingerprint(snapshot){return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(snapshot).filter(([table])=>!['ActionPreview','BusinessAuditEvent'].includes(table))))).digest('hex');}
  let token;
  const credentials={username:'ai_retest_owner',password:randomBytes(24).toString('base64url')};
  const privateDir=mkdtempSync('/private/tmp/piano-ai-retest-');
  async function request(endpoint,body,auth=token,method=body?'POST':'GET',headers={}) {
    const response=await fetch(base+endpoint,{method,headers:{...(auth?{authorization:`Bearer ${auth}`} : {}),'content-type':'application/json','Idempotency-Key':randomUUID(),...headers},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
    const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`AUDIT_HTTP_${response.status}:${endpoint}`);return data;
  }
  await restore({});
  // This command creates only the synthetic owner in the guarded audit database.
  docker(['exec','-T','-e','OWNER_BOOTSTRAP_USERNAME','-e','OWNER_BOOTSTRAP_PASSWORD','core','node','apps/core-api/dist/modules/auth/bootstrap-owner.js'],{env:{...process.env,OWNER_BOOTSTRAP_USERNAME:credentials.username,OWNER_BOOTSTRAP_PASSWORD:credentials.password}});
  token=(await request('/auth/login',credentials,null)).accessToken;
  writeFileSync(path.join(privateDir,'session.json'),JSON.stringify({base,...credentials,accessToken:token}),{mode:0o600});
  const empty=await capture();
  const snapshots=new Map();
  const originalAgentEnvironment={
    AI_ENABLED:config.services.agent.environment.AI_ENABLED,
    AI_PROVIDER:config.services.agent.environment.AI_PROVIDER,
    AI_MODEL:config.services.agent.environment.AI_MODEL,
    AI_API_KEY:config.services.agent.environment.AI_API_KEY,
  };
  async function restartAgent(overrides={}) {
    const environment={...process.env};
    for(const [key,value] of Object.entries({...originalAgentEnvironment,...overrides})) {
      if(value===undefined||value===null) delete environment[key];
      else environment[key]=String(value);
    }
    docker(['up','-d','--force-recreate','--no-deps','agent'],{env:environment});
    const deadline=Date.now()+120000;
    while(Date.now()<deadline){
      try{const response=await fetch('http://127.0.0.1:3110/health',{signal:AbortSignal.timeout(3000)});if(response.ok)return;}catch{}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw new Error('AUDIT_AGENT_RESTART_TIMEOUT');
  }
  function stopAgent() {
    docker(['stop','agent']);
  }
  async function setFaultMode(mode) {
    const response = await fetch(`http://127.0.0.1:3010/api/__audit/fault-mode?mode=${encodeURIComponent(mode)}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`AUDIT_FAULT_MODE_${response.status}`);
    return response.json();
  }
  async function common(group) {
    await restore(empty);
    const students={};
    for(const [key,name] of [['lin','林悦'],['rain','小雨'],['refund','小林'],['ming1','小明'],['ming2','小明'],['other','李安']])students[key]=await request('/students',{name,notes:'AI专项隔离合成数据'});
    const teachers={};const teacherAuth={};
    for(const [key,name] of [['wang','王老师'],['li','李老师']]){
      const auth={username:`ai_retest_${key}`,password:randomBytes(24).toString('base64url')};teachers[key]=await request('/teachers',{...auth,name});teacherAuth[key]={...auth,token:(await request('/auth/login',auth,null)).accessToken};
    }
    const courses={};
    courses.main=await request('/courses',{name:'主课',defaultUnitPrice:'200.00',defaultDurationMinutes:60});courses.practice=await request('/courses',{name:'陪练',defaultUnitPrice:'80.00',defaultDurationMinutes:45});
    const accounts={};for(const [key,student]of Object.entries(students)){accounts[key]={};for(const [courseKey,course]of Object.entries(courses)){if(group==='B6'&&key==='rain'&&courseKey==='main')continue;accounts[key][courseKey]=await request(`/students/${student.id}/course-accounts`,{courseId:course.id});}}
    return {students,teachers,courses,accounts,teacherAuth,lessons:{}};
  }
  const payment=async(account,amount,occurredAt=fixedNow)=>request(`/student-course-accounts/${account.id}/payments`,{amount,channel:'WECHAT',occurredAt});
  const gift=async(account,amount)=>request(`/student-course-accounts/${account.id}/gifts`,{amount,occurredAt:fixedNow,note:'测试来源赠送'});
  const lesson=async(f,key,student,course,teacher,startsAt)=>f.lessons[key]=await request('/lessons',{accountId:f.accounts[student][course].id,teacherId:f.teachers[teacher].id,startsAt});
  async function seed(group) {
    const f=await common(group);
    if(['F1','F1B','G','GM','GSummary','KClosed','KClosedMatrix','B2','F1Error'].includes(group)){
      await payment(f.accounts.lin.main,'500.00');await gift(f.accounts.lin.main,'80.00');await payment(f.accounts.lin.practice,'120.00');await gift(f.accounts.lin.practice,'20.00');
    }
    if(['F1','F1B','B2','F1Error'].includes(group)){
      await lesson(f,'X01','lin','main','wang','2026-10-21T09:00:00+08:00');
      if(group==='F1B'){
        await request(`/lessons/${f.lessons.X01.id}/complete`,{});
        await lesson(f,'Cancelled','lin','main','wang','2026-10-20T11:00:00+08:00');
        await request(`/lessons/${f.lessons.Cancelled.id}/cancel`,{});
        await lesson(f,'Scheduled','lin','main','wang','2026-10-20T13:00:00+08:00');
      }
      if(group==='B2')f.students.qing=await request('/students',{name:'小晴'});
      if(group==='F1Error')await payment(f.accounts.lin.main,'1000.00');
    }
    if(['G','GM','GSummary'].includes(group)){
      for(const [key,date,time,s,c,t]of [['L01','20','09:00','lin','main','wang'],['L02','21','09:00','lin','main','wang'],['L03','22','09:00','lin','main','wang'],['L04','21','13:00','lin','practice','li'],['L05','21','15:00','rain','main','li'],['L06','23','09:00','lin','main','wang']])await lesson(f,key,s,c,t,`2026-10-${date}T${time}:00+08:00`);
      await request(`/lessons/${f.lessons.L01.id}/complete`,{});await request(`/lessons/${f.lessons.L05.id}/cancel`,{});
      if(group==='GM')await lesson(f,'L07','lin','main','wang','2026-10-22T14:00:00+08:00');
    }
    if(['F2','F2Zero','F2Debt'].includes(group)){
      if(group!=='F2Zero'){await payment(f.accounts.refund.main,group==='F2Debt'?'190.00':'1000.00','2026-09-10T03:00:00Z');await payment(f.accounts.refund.practice,'500.00','2026-09-10T03:00:00Z');}
      if(group!=='F2Debt')await gift(f.accounts.refund.main,'200.00');await gift(f.accounts.refund.practice,'100.00');
      if(group==='F2Debt'){await lesson(f,'Debt','refund','main','li','2026-10-20T09:00:00+08:00');await request(`/lessons/${f.lessons.Debt.id}/complete`,{});}
    }
    if(group.startsWith('F3')){
      await request(`/teachers/${f.teachers.wang.id}/compensation`,{defaultBaseSalary:'2000.00',defaultCommissionRate:'10.0000'},token,'PATCH');
      await payment(f.accounts.lin.main,'1000.00');await gift(f.accounts.lin.main,'1000.00');
      for(let day=15;day<=19;day++){await lesson(f,`W${day}`,'lin','main','wang',`2026-10-${day}T09:00:00+08:00`);await request(`/lessons/${f.lessons[`W${day}`].id}/complete`,{});}
      if(group!=='F3New'){
        f.payroll=await request('/payrolls',{teacherId:f.teachers.wang.id,period:'2026-10'});
        if(group!=='F3Base')f.payroll=await request(`/payrolls/${f.payroll.id}`,{baseSalary:'2000.00',commissionRate:'10.0000',bonusAmount:'100.00',bonusNote:'招生奖励',deductionAmount:'50.00',deductionNote:'个人代缴'},token,'PATCH');
        if(group==='F3Paid')await request(`/payrolls/${f.payroll.id}/pay`,{paidAt:'2026-10-20T03:00:00Z',channel:'WECHAT'});
        if(group!=='F3Base'&&f.payroll.grossSalary!=='2200.00')throw new Error('F3_GROSS_EXPECTED_2200.00_ACTUAL_'+f.payroll.grossSalary);
      if(group==='F3Closed'){
        // W08 needs both an open current-month payroll and a separate, already
        // closed historical payroll.  Both are created through Core so the
        // dialogue test exercises the same domain constraints as production.
        const september=await request('/payrolls',{teacherId:f.teachers.wang.id,period:'2026-09'});
        f.closedPayroll=september;
        await request('/periods/close',{period:'2026-09'});
      }
      }
    }
    if(group==='F4'){
      await payment(f.accounts.lin.main,'1000.00');await gift(f.accounts.lin.main,'80.00');await lesson(f,'Report','lin','main','wang','2026-10-20T09:00:00+08:00');await request(`/lessons/${f.lessons.Report.id}/complete`,{});
      await payment(f.accounts.refund.main,'1000.00','2026-09-10T03:00:00Z');await payment(f.accounts.refund.practice,'500.00','2026-09-10T03:00:00Z');await request(`/students/${f.students.refund.id}/refunds`,{feeAmount:'100.00',channel:'BANK_CARD',occurredAt:fixedNow});
      for(const [incomeCategory,amount]of [['BOOK_SALE','50.00'],['INSTRUMENT_SALE','2000.00'],['EXTERNAL_COOPERATION','300.00'],['OTHER_INCOME','20.00']])await request('/manual-transactions',{kind:'INCOME',incomeCategory,amount,channel:'WECHAT',occurredAt:fixedNow});
      await request('/manual-transactions',{kind:'EXPENSE',expenseCategory:'RENT_PROPERTY',amount:'200.00',channel:'BANK_CARD',occurredAt:fixedNow});
      await request(`/teachers/${f.teachers.wang.id}/compensation`,{defaultBaseSalary:'2000.00',defaultCommissionRate:'10.0000'},token,'PATCH');
      let payroll=await request('/payrolls',{teacherId:f.teachers.wang.id,period:'2026-10'});
      payroll=await request(`/payrolls/${payroll.id}`,{baseSalary:'2000.00',commissionRate:'10.0000',bonusAmount:'180.00',bonusNote:'报表样本奖项',deductionAmount:'50.00',deductionNote:'个人代缴'},token,'PATCH');await request(`/payrolls/${payroll.id}/pay`,{paidAt:fixedNow,channel:'BANK_CARD'});
      const report=await request('/reports/monthly?period=2026-10');
      for(const [key,value]of Object.entries({cashIncome:'3370.00',cashExpense:'3750.00',cashNet:'-380.00',operatingProfit:'190.00',lessonIncome:'200.00',refundFeeIncome:'100.00',manualIncome:'2370.00'}))if(report[key]!==value)throw new Error('REPORT_FIXTURE_MISMATCH_'+key);
    }
    if(group==='KClosed')await request('/periods/close',{period:'2026-09'});
    if(group==='KClosedMatrix'){
      // Build all records before closing September.  The matrix then attempts
      // each mutable business category against the same closed period.
      await payment(f.accounts.lin.main,'500.00','2026-09-10T03:00:00Z');
      await gift(f.accounts.lin.main,'80.00');
      await payment(f.accounts.refund.main,'500.00','2026-09-10T03:00:00Z');
      await payment(f.accounts.refund.practice,'100.00','2026-09-10T03:00:00Z');
      await lesson(f,'ClosedPendingLesson','lin','main','wang','2026-09-20T09:00:00+08:00');
      f.closedPayroll=await request('/payrolls',{teacherId:f.teachers.wang.id,period:'2026-09'});
      await request('/periods/close',{period:'2026-09'});
    }
    if(group==='KClosedB'){
      await request('/periods/close',{period:'2026-09'});
      await request('/periods/close',{period:'2026-10'});
    }
    if(group==='BatchConflict')await lesson(f,'Conflict','lin','main','wang','2026-12-02T19:00:00+08:00');
    if(group==='Preclose'){
      await lesson(f,'Unconfirmed','lin','main','wang','2026-09-20T09:00:00+08:00');
      await payment(f.accounts.lin.main,'500.00','2026-09-01T03:00:00Z');
      await lesson(f,'CompletedWithoutPayroll','lin','main','wang','2026-09-18T09:00:00+08:00');
      await request(`/lessons/${f.lessons.CompletedWithoutPayroll.id}/complete`,{},token,'POST',{'x-ai-audit-business-now':'2026-09-18T03:00:00Z'});
      await payment(f.accounts.refund.main,'300.00','2026-09-02T03:00:00Z');
      const refund=await request(`/students/${f.students.refund.id}/refunds`,{feeAmount:'20.00',channel:'BANK_CARD',occurredAt:'2026-09-19T03:00:00Z'});
      // The reviewed case explicitly requires corrupt historical samples. They are introduced only
      // inside the guarded disposable audit database after valid Core writes, never in production data.
      await pool.query('UPDATE "RefundDetail" SET "paidRefundAmount" = "paidRefundAmount" - 1 WHERE "refundId"=$1 AND "paidRefundAmount">0',[refund.id]);
      await pool.query('UPDATE "LedgerEntry" SET "paidDelta" = "paidDelta" + 1 WHERE "lessonId"=$1',[f.lessons.CompletedWithoutPayroll.id]);
    }
    if(group==='PayrollSeptember'){
      await request(`/teachers/${f.teachers.wang.id}/compensation`,{defaultBaseSalary:'2000.00',defaultCommissionRate:'10.0000'},token,'PATCH');
      let p=await request('/payrolls',{teacherId:f.teachers.wang.id,period:'2026-09'});
      f.payroll=await request(`/payrolls/${p.id}`,{baseSalary:'2000.00',commissionRate:'10.0000',bonusAmount:'200.00',bonusNote:'9月补贴',deductionAmount:'50.00',deductionNote:'代缴'},token,'PATCH');
    }
    if(group==='History'){
      await payment(f.accounts.lin.main,'1000.00','2026-09-10T03:00:00Z');await lesson(f,'History','lin','main','wang','2026-09-20T09:00:00+08:00');
      await request(`/lessons/${f.lessons.History.id}/complete`,{},token,'POST',{'x-ai-audit-business-now':'2026-09-20T03:00:00Z'});await request('/periods/close',{period:'2026-09'});
    }
    if(group==='Consumption'){
      await payment(f.accounts.lin.main,'1000.00');await payment(f.accounts.lin.practice,'500.00');
      for(const [key,date,course,teacher]of [['C1','18','main','wang'],['C2','19','main','wang'],['C3','20','practice','li']]){await lesson(f,key,'lin',course,teacher,`2026-10-${date}T09:00:00+08:00`);await request(`/lessons/${f.lessons[key].id}/complete`,{});}
    }
    if(group==='List'||group==='GSummary'){
      async function historical(name,createdAt){
        const id=randomUUID();await pool.query('INSERT INTO "Student" (id,name,"createdAt","updatedAt") VALUES ($1,$2,$3,$3)',[id,name,createdAt]);
        const accountId=randomUUID();await pool.query('INSERT INTO "StudentCourseAccount" (id,"studentId","courseId","currentUnitPrice","createdAt","updatedAt") SELECT $1,$2,id,"defaultUnitPrice",$4,$4 FROM "Course" WHERE id=$3',[accountId,id,f.courses.main.id,createdAt]);
        return {id,account:{id:accountId}};
      }
      f.boundary=await historical('正好31天','2026-09-20T03:00:00Z');f.beyond=await historical('超过31天','2026-09-20T02:59:59Z');
      const zhou=await historical('周宁','2026-09-01T03:00:00Z');await payment(zhou.account,'500.00');
      f.students.zhou={id:zhou.id,name:'周宁'};f.lessons.Zhou=await request('/lessons',{accountId:zhou.account.id,teacherId:f.teachers.li.id,startsAt:'2026-10-21T09:00:00+08:00'});
      await payment(f.accounts.other.main,'190.00');await payment(f.accounts.other.practice,'500.00');await lesson(f,'Debt','other','main','li','2026-10-20T09:00:00+08:00');await request(`/lessons/${f.lessons.Debt.id}/complete`,{});
      if(group==='GSummary')for(const teacher of Object.values(f.teachers))await request('/payrolls',{teacherId:teacher.id,period:'2026-10'});
    }
    if(group==='C2'){
      const auth={username:'ai_retest_wang2',password:randomBytes(24).toString('base64url')};f.teachers.wang2=await request('/teachers',{...auth,name:'王老师'});
    }
    const snapshot=await capture();snapshots.set(group,{snapshot,fixture:f,fingerprint:fingerprint(snapshot)});
    return snapshots.get(group);
  }
  async function refreshFixtureTokens(value) {
    token=(await request('/auth/login',credentials,null)).accessToken;
    for(const teacher of Object.values(value.fixture.teacherAuth??{})){
      teacher.token=(await request('/auth/login',{username:teacher.username,password:teacher.password},null)).accessToken;
    }
  }
  async function use(group){
    const value=snapshots.get(group)??await seed(group);
    await restore(value.snapshot);
    if(fingerprint(await capture())!==value.fingerprint)throw new Error('FIXTURE_RESET_MISMATCH');
    // A full live-model suite can outlive a JWT. Re-authenticate the synthetic actors after
    // every isolated restore so a long audit never turns token age into a product failure.
    await refreshFixtureTokens(value);
    return value;
  }
  return {pool,guard,request,capture,restore,fingerprint,use,privateDir,credentials,snapshots,restartAgent,stopAgent,setFaultMode,get token(){return token;},model:{provider:config.services.agent.environment.AI_PROVIDER,model:config.services.agent.environment.AI_MODEL},close:()=>pool.end()};
}
