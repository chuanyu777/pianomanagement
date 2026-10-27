// Keep raw observations immutable; explicitly exclude invalid test preconditions.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const file=path.resolve(process.argv[2]??'');
const allowed=path.resolve(import.meta.dirname,'../../../test-results')+path.sep;
if(!file.startsWith(allowed)||path.basename(file)!=='results.json')throw new Error('LOCAL_RETEST_RESULTS_REQUIRED');
const report=JSON.parse(readFileSync(file,'utf8'));
report.review={at:new Date().toISOString(),rawSource:'results.json',exclusions:[{caseId:'E08',reason:'已完成F01并从最近任务打开的前置未建立；3个后续首句不能作为本例失败证据'}]};
for(const result of report.results){
  if(result.caseId!=='E08')continue;
  result.rawObservedStatus=result.status;
  result.status='unexecuted';
  result.reason='前置已执行任务和最近任务打开动作未建立；保留原观测但不能判本例成败';
}
for(const entry of report.coverage){
  const checks=report.results.filter(r=>r.caseId===entry.caseId);
  entry.status=checks.some(x=>x.status==='failed')?'失败':checks.some(x=>x.status==='blocked')?'阻塞':'未执行';
}
const output=path.join(path.dirname(file),'reviewed-results.json');
writeFileSync(output,JSON.stringify(report,null,2));
console.log(JSON.stringify({output,counts:Object.fromEntries(['failed','blocked','step-verified','unexecuted'].map(s=>[s,report.results.filter(x=>x.status===s).length])),wholeCases:Object.fromEntries(['失败','阻塞','未执行'].map(s=>[s,report.coverage.filter(x=>x.status===s).length]))}));
