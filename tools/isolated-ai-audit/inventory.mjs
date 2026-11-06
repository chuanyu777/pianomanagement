import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { groups } from '../../apps/agent-runtime/test/ai-retest-catalog.mjs';

/** A case remains unverified until a separate, complete journey records evidence. */
export function createInventory(spec, expectedIds) {
  const entries=[...spec.matchAll(/^### ([A-Z]\d{2}) (.+)$/gm)].map(match=>({id:match[1],title:match[2].trim(),status:'unverified'}));
  const actual=entries.map(entry=>entry.id);
  const expected=[...expectedIds];
  const sortedExpected=[...expected].sort();
  if (new Set(actual).size!==actual.length || new Set(expected).size!==expected.length || actual.length!==expected.length || [...actual].sort().some((id,index)=>id!==sortedExpected[index])) {
    throw new Error('INDEPENDENT_CASE_INVENTORY_MISMATCH');
  }
  return entries;
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const spec=readFileSync(new URL('../../docs/AI对话功能测试用例-v1.0-评审稿.md',import.meta.url),'utf8');
  const entries=createInventory(spec,Object.keys(groups));
  process.stdout.write(`${JSON.stringify({total:entries.length,entries},null,2)}\n`);
}
