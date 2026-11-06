import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groups } from '../../apps/agent-runtime/test/ai-retest-catalog.mjs';
import { createInventory } from './inventory.mjs';

test('reviewed case inventory is complete and starts unverified', () => {
  const spec=readFileSync(new URL('../../docs/AI对话功能测试用例-v1.0-评审稿.md',import.meta.url),'utf8');
  const entries=createInventory(spec,Object.keys(groups));
  assert.equal(entries.length,83);
  assert.ok(entries.every(entry=>entry.status==='unverified'));
  assert.ok(entries.some(entry=>entry.id==='C01'));
  assert.ok(entries.some(entry=>entry.id==='E08'));
});

test('missing, duplicated or unexpected case headings fail closed', () => {
  const expected=['Q01','C01'];
  assert.throws(()=>createInventory('### Q01 一\n',['Q01','C01']));
  assert.throws(()=>createInventory('### Q01 一\n### Q01 二\n### C01 三\n',expected));
  assert.throws(()=>createInventory('### Q01 一\n### C02 二\n',expected));
});
