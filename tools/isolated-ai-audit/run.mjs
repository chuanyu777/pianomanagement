import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { validateDatabaseContainer } from './guard.mjs';
const mode=process.argv[2];
if (!['guard','live','probe'].includes(mode) || process.argv.length!==3) throw new Error('USAGE: node tools/isolated-ai-audit/run.mjs guard|live');
if (mode==='live' && (!process.env.AI_API_KEY || !['deepseek-chat','deepseek-reasoner'].includes(process.env.AI_MODEL))) throw new Error('LIVE_MODEL_CONFIGURATION_REQUIRED');
const project=`piano-isolated-${randomBytes(6).toString('hex')}`;
const env={PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_HOST:process.env.DOCKER_HOST,DOCKER_CONTEXT:process.env.DOCKER_CONTEXT,AI_MODEL:mode==='live'?process.env.AI_MODEL:'deepseek-chat',AI_API_KEY:mode==='live'?process.env.AI_API_KEY:'guard-only'};
function docker(args, input) {
  const result=spawnSync('docker',args,{encoding:'utf8',env,input,stdio:['pipe','pipe','pipe'],maxBuffer:16*1024*1024,timeout:300000});
  if(result.error || result.status!==0) {
    const detail=String(result.stderr ?? '');
    const hint=/not found|no such image/i.test(detail)?'IMAGE_OR_RESOURCE_NOT_FOUND':/unhealthy/i.test(detail)?'SERVICE_UNHEALTHY':/timed out|timeout/i.test(detail)?'TIMEOUT':/invalid|unsupported/i.test(detail)?'CONFIG_INVALID':/not a directory/i.test(detail)?'MOUNT_NOT_DIRECTORY':/is a directory/i.test(detail)?'MOUNT_IS_DIRECTORY':/mounts denied/i.test(detail)?'MOUNT_DENIED':/mount/i.test(detail)?'MOUNT_FAILURE':/exit code|exited/i.test(detail)?'CONTAINER_EXITED':/denied|permission/i.test(detail)?'PERMISSION_DENIED':/network/i.test(detail)?'NETWORK_FAILURE':/no such|unable to find/i.test(detail)?'MISSING_RESOURCE':'UNCLASSIFIED';
    console.error(`DOCKER_FAILURE_CATEGORY:${hint}`);
    if(mode==='probe') {
      for (const word of ['bind source path does not exist','Mounts denied','permission denied','read-only file system','failed to mount','mkdir','is a directory','not a directory','no such file or directory','invalid mount config','path not shared','error while creating mount source path']) if(detail.toLowerCase().includes(word.toLowerCase())) console.error(`PROBE_FAILURE_HINT:${word}`);
    }
    throw new Error(`DOCKER_OPERATION_FAILED:${args[0]}:${args[1] ?? ''}`);
  }
  return result.stdout;
}
const composeArgs=['compose','--project-name',project,'--file','compose.isolated-ai-audit.yml',...(mode==='probe'?['--file','compose.isolated-ai-audit-probe.yml']:[])];
const compose=(args,input)=>docker([...composeArgs,...args],input);
let owned=false, failed=false;
const interrupt=()=>{throw new Error('INTERRUPTED');};
process.on('SIGINT',interrupt);
process.on('SIGTERM',interrupt);
try {
  for (const kind of ['container','network','volume']) {
    const ids=docker([kind,'ls',...(kind==='container'?['-a']:[]),'--filter',`label=com.docker.compose.project=${project}`,'-q']).trim();
    if(ids) throw new Error('PROJECT_ALREADY_EXISTS');
  }
  owned=true;
  console.log(`project=${project}`);
  compose(['up','-d','--wait','core-db','agent-db']);
  const network=JSON.parse(docker(['network','inspect',`${project}_private`]))[0];
  if(!network.Internal || network.Labels?.['com.docker.compose.project']!==project) throw new Error('UNSAFE_PRIVATE_NETWORK');
  for (const service of ['core-db','agent-db']) {
    const id=compose(['ps','-q',service]).trim();
    if(!/^[a-f0-9]{64}$/.test(id)) throw new Error('MISSING_DATABASE_CONTAINER');
    validateDatabaseContainer(JSON.parse(docker(['inspect',id]))[0],project,service);
    const user=service==='core-db'?'piano_core':'piano_agent';
    const db=service==='core-db'?'piano_core_ai_audit':'piano_agent_ai_audit';
    const count=compose(['exec','-T',service,'psql','-U',user,'-d',db,'-Atc',"SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')"]).trim();
    if(count!=='0') throw new Error('DATABASE_NOT_EMPTY');
    console.log(`${service}: isolated container, tmpfs, no published port, empty schema`);
  }
  if(mode==='guard') console.log('Guard passed; no migrations or application writes were run.');
  else {
    console.log(mode==='probe'?'Starting installed audit images for failure-path probe...':'Building isolated application images and starting services...');
    try {
      compose(mode==='probe'?['up','--no-build','--pull','never','-d','--wait','core','agent']:['up','--build','-d','--wait','core','agent']);
    } catch (error) {
      for (const service of ['core','agent']) {
        const ids=spawnSync('docker',[...composeArgs,'ps','-a','-q',service],{encoding:'utf8',env}).stdout?.trim() ?? '';
        if (!/^[a-f0-9]{64}$/.test(ids)) continue;
        const inspect=spawnSync('docker',['inspect',ids],{encoding:'utf8',env});
        try {
          const state=JSON.parse(inspect.stdout)[0].State;
          console.error(`ISOLATED_${service.toUpperCase()}_STATE:${state?.Status ?? 'unknown'}:EXIT_${Number(state?.ExitCode ?? -1)}:OOM_${state?.OOMKilled === true}`);
        } catch { console.error(`ISOLATED_${service.toUpperCase()}_STATE:unavailable`); }
      }
      throw error;
    }
    if(mode==='probe') {
      const coreId=compose(['ps','-q','core']).trim();
      if(!/^[a-f0-9]{64}$/.test(coreId)) throw new Error('MISSING_CORE_CONTAINER');
      const core=JSON.parse(docker(['inspect',coreId]))[0];
      if(core.Config?.Labels?.['com.docker.compose.project']!==project || core.Config?.Labels?.['com.docker.compose.service']!=='core') throw new Error('UNSAFE_CORE_CONTAINER');
      docker(['cp','apps/core-api/dist/.',`${coreId}:/workspace/apps/core-api/dist`]);
      docker(['cp','packages/assistant-protocol/dist/.',`${coreId}:/workspace/packages/assistant-protocol/dist`]);
      docker(['cp','apps/core-api/prisma/migrations/.',`${coreId}:/workspace/apps/core-api/prisma/migrations`]);
      docker(['cp','apps/core-api/test/ai-audit-server.mjs',`${coreId}:/workspace/apps/core-api/test/ai-audit-server.mjs`]);
      docker(['restart',coreId]);
      const deadline=Date.now()+90000;
      while(Date.now()<deadline) {
        const state=JSON.parse(docker(['inspect',coreId]))[0].State;
        if(state?.Health?.Status==='healthy') break;
        if(!state?.Running) {
          const logResult=spawnSync('docker',['logs',coreId],{encoding:'utf8',env});
          const logs=(logResult.stdout ?? '')+(logResult.stderr ?? '');
          for(const marker of ['Cannot find module','ERR_MODULE_NOT_FOUND','PrismaClientInitializationError','P3009','P3018','P3015','Migration failed','Environment variable not found','Cannot find package','SyntaxError','was not found']) if(logs.includes(marker)) console.error(`PROBE_CORE_HINT:${marker}`);
          throw new Error('PROBE_CORE_STOPPED');
        }
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      if(JSON.parse(docker(['inspect',coreId]))[0].State?.Health?.Status!=='healthy') throw new Error('PROBE_CORE_NOT_HEALTHY');
      docker(['cp','tools/isolated-ai-audit/smoke.mjs',`${coreId}:/workspace/isolated-ai-smoke.mjs`]);
    }
    console.log('Running isolated smoke checks...');
    const result=spawnSync('docker',[...composeArgs,'exec','-T','core','node',mode==='probe'?'isolated-ai-smoke.mjs':'tools/isolated-ai-audit/smoke.mjs'],{encoding:'utf8',env,input:randomBytes(24).toString('base64url'),stdio:['pipe','pipe','pipe'],timeout:300000,maxBuffer:1024*1024});
    const output=result.stdout ?? '';
    if(output.split(/\r?\n/).includes('ISOLATED_SMOKE_STARTED')) console.log('Smoke process started.');
    for(const stage of ['ISOLATED_BOOTSTRAP_PASSED','ISOLATED_LOGIN_PASSED','ISOLATED_STUDENT_PASSED','ISOLATED_COURSE_PASSED','ISOLATED_ACCOUNT_PASSED','ISOLATED_PAYMENT_PASSED','ISOLATED_FIXTURE_PASSED','ISOLATED_DIRECT_PREVIEW_CREATED',...Array.from({length:100},(_,i)=>`ISOLATED_HTTP_${400+i}`)]) if(output.split(/\r?\n/).includes(stage)) console.log(stage);
    if(output.split(/\r?\n/).includes('ISOLATED_CORE_PREVIEW_PASSED')) console.log('Core authoritative preview and unchanged ledger passed.');
    for(const stage of ['ISOLATED_RUN_STARTED','ISOLATED_RUN_CREATED','ISOLATED_RUN_COMPLETED','ISOLATED_RUN_FAILED','ISOLATED_RUN_NO_TERMINAL','ISOLATED_COMBINED_NO_ACTION','ISOLATED_COMBINED_HAS_ANSWER','ISOLATED_COMBINED_EMPTY_ANSWER','ISOLATED_COMBINED_HAS_WORKSPACE','ISOLATED_COMBINED_NO_WORKSPACE','ISOLATED_COMBINED_CLARIFICATION','ISOLATED_COMBINED_ERROR','ISOLATED_COMBINED_WRONG_ACTION','ISOLATED_COMBINED_PLAN_REJECTED','ISOLATED_COMBINED_INTENT_UNCLEAR','ISOLATED_COMBINED_AMOUNT_REQUESTED','ISOLATED_COMBINED_CHANNEL_REQUESTED']) if(output.split(/\r?\n/).includes(stage)) console.log(stage);
    if(output.split(/\r?\n/).includes('ISOLATED_COMBINED_AI_PREVIEW_PASSED')) console.log('Real model combined payment preview passed without opening an account.');
    for(const hint of ['STUDENT','COURSE','CONFIRM','AMBIGUOUS','UNAVAILABLE']) if(output.split(/\r?\n/).includes(`ISOLATED_COMBINED_HINT_${hint}`)) console.log(`ISOLATED_COMBINED_HINT_${hint}`);
    for(const stage of ['ISOLATED_COMBINED_ACTION_PASSED','ISOLATED_COMBINED_STATUS_PASSED','ISOLATED_COMBINED_STUDENT_PASSED','ISOLATED_COMBINED_COURSE_PASSED','ISOLATED_COMBINED_AMOUNT_PASSED','ISOLATED_COMBINED_PRICE_PASSED','ISOLATED_COMBINED_CHANNEL_PASSED']) if(output.split(/\r?\n/).includes(stage)) console.log(stage);
    for(const stage of ['ISOLATED_PRONOUN_CREATE_START','ISOLATED_CREATE_NO_ACTION','ISOLATED_CREATE_CLARIFICATION','ISOLATED_CREATE_PLAN_REJECTED','ISOLATED_CREATE_INTENT_UNCLEAR','ISOLATED_CREATE_NAME_REQUESTED','ISOLATED_CREATE_WRONG_ACTION','ISOLATED_PRONOUN_CREATE_PREVIEW','ISOLATED_PRONOUN_CREATE_CONFIRMED','ISOLATED_PRONOUN_NO_ACTION','ISOLATED_PRONOUN_CLARIFICATION','ISOLATED_PRONOUN_PLAN_REJECTED','ISOLATED_PRONOUN_NAME_REQUESTED','ISOLATED_PRONOUN_COURSE_REQUESTED','ISOLATED_PRONOUN_WRONG_ACTION','ISOLATED_PRONOUN_PAYMENT_PREVIEW']) if(output.split(/\r?\n/).includes(stage)) console.log(stage);
    for(const hint of ['STUDENT','COURSE','CONFIRM','AMBIGUOUS','UNAVAILABLE']) if(output.split(/\r?\n/).includes(`ISOLATED_PRONOUN_HINT_${hint}`)) console.log(`ISOLATED_PRONOUN_HINT_${hint}`);
    if(output.split(/\r?\n/).includes('ISOLATED_CONFIRMED_STUDENT_PRONOUN_PASSED')) console.log('Confirmed new student resolved from a pronoun in a later payment request.');
    for (const stage of ['ISOLATED_PENDING_CREATE_PASSED','ISOLATED_PENDING_REQUEST_CLARIFICATION','ISOLATED_PENDING_REQUEST_ERROR','ISOLATED_PENDING_REQUEST_STUDENT','ISOLATED_PENDING_REQUEST_CHANNEL','ISOLATED_PENDING_REQUEST_PASSED','ISOLATED_PENDING_CONFIRM_PASSED','ISOLATED_PENDING_RESUME_CLARIFICATION','ISOLATED_PENDING_RESUME_ERROR','ISOLATED_PENDING_RESUME_STUDENT','ISOLATED_PENDING_RESUME_CHANNEL','ISOLATED_PENDING_RESUME_AMOUNT','ISOLATED_PENDING_RESUME_EXECUTED','ISOLATED_PENDING_RESUME_PLAN_REJECTED','ISOLATED_PENDING_RESUME_UNCLEAR','ISOLATED_PENDING_RESUME_NEW_PLAN','ISOLATED_PENDING_RESUME_WAITING','ISOLATED_PENDING_RESUME_UNAVAILABLE']) if(output.split(/\r?\n/).includes(stage)) console.log(stage);
    if(output.split(/\r?\n/).includes('ISOLATED_PENDING_PAYMENT_NATURAL_CONTINUE_PASSED')) console.log('Natural continuation resumed the pending payment after student confirmation.');
    if(output.split(/\r?\n/).includes('ISOLATED_PENDING_PAYMENT_CANCEL_PASSED')) console.log('Pending payment cancelled without undoing confirmed student creation.');
    if(output.split(/\r?\n/).includes('ISOLATED_PENDING_PAYMENT_CORRECT_PASSED')) console.log('Pending payment correction produced the revised unconfirmed preview.');
    if(output.split(/\r?\n/).includes('ISOLATED_FOUR_QUERIES_AND_NEXT_REQUEST_PASSED')) console.log('Four queries and the next independent request passed.');
    for(const stage of ['ISOLATED_CONTEXT_INTERVENING_QUERY_PASSED','ISOLATED_FOLLOWUP_NO_CHANNEL_QUESTION','ISOLATED_FOLLOWUP_CLARIFICATION','ISOLATED_FOLLOWUP_PLAN_REJECTED','ISOLATED_FOLLOWUP_STUDENT_REQUESTED','ISOLATED_FOLLOWUP_AMOUNT_REQUESTED','ISOLATED_PRONOUN_CHANNEL_REQUESTED','ISOLATED_PRONOUN_CHANNEL_PASSED']) if(output.split(/\r?\n/).includes(stage)) console.log(stage);
    if(output.split(/\r?\n/).includes('ISOLATED_MULTI_ACCOUNT_PASSED')) console.log('Per-course account balances matched independent Core records.');
    if(output.split(/\r?\n/).includes('ISOLATED_MODEL_PREVIEW_PASSED')) console.log('Real model query and unconfirmed payment preview passed.');
    if(output.split(/\r?\n/).includes('ISOLATED_SAME_NAME_PASSED')) console.log('Same-name selection and isolated account lookup passed.');
    if(output.split(/\r?\n/).includes('ISOLATED_TEACHER_DENIAL_PASSED')) console.log('Teacher finance query denied without leaking account data.');
    if(result.error || result.status!==0) throw new Error('SMOKE_EXECUTION_FAILED');
    // The smoke runner emits only fixed status codes, never model output or secrets.
    if(!output.split(/\r?\n/).includes('ISOLATED_SMOKE_PASSED')) throw new Error('SMOKE_FAILED');
    console.log('PASS: real model query and payment preview; no unconfirmed balance change');
  }
} catch(error) {
  failed=true;
  const safe=String(error?.message ?? 'UNKNOWN_FAILURE');
  console.error(/^([A-Z_]+)(:[a-z-]+){0,2}$/.test(safe)?safe:'ISOLATED_AUDIT_FAILED');
} finally {
  process.removeListener('SIGINT',interrupt);
  process.removeListener('SIGTERM',interrupt);
  if(owned) {
    try {
      const ids=docker(['container','ls','-a','--filter',`label=com.docker.compose.project=${project}`,'-q']).trim().split(/\s+/).filter(Boolean);
      for(const id of ids) {
        const c=JSON.parse(docker(['inspect',id]))[0];
        if(c.Config?.Labels?.['com.docker.compose.project']!==project || !['core-db','agent-db','core','agent'].includes(c.Config?.Labels?.['com.docker.compose.service'])) throw new Error('UNEXPECTED_PROJECT_CONTAINER');
        docker(['rm','-f',id]);
      }
      const networks=docker(['network','ls','--filter',`label=com.docker.compose.project=${project}`,'-q']).trim().split(/\s+/).filter(Boolean);
      for(const id of networks) {
        const network=JSON.parse(docker(['network','inspect',id]))[0];
        if(network.Labels?.['com.docker.compose.project']!==project || ![`${project}_private`,`${project}_egress`].includes(network.Name)) throw new Error('UNEXPECTED_PROJECT_NETWORK');
        docker(['network','rm',id]);
      }
      console.log('Removed this run’s project containers and networks.');
    } catch { failed=true; console.error(`CLEANUP_FAILED project=${project}`); }
  }
}
if(failed) process.exitCode=1;
