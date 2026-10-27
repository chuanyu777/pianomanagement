import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertAuditDatabase } from './ai-retest-environment.mjs';
import { assertCaseInventory, groups } from './ai-retest-catalog.mjs';
test('fixture reset guard allows only the named isolated local database',()=>{
  assert.doesNotThrow(()=>assertAuditDatabase('postgresql://test@127.0.0.1:5443/piano_core_ai_audit','piano_core_ai_audit'));
  for(const [url,actual] of [
    ['postgresql://test@127.0.0.1:5433/piano_core','piano_core'],
    ['postgresql://test@127.0.0.1:5443/piano_core_ai_audit','piano_core'],
    ['postgresql://test@remote:5443/piano_core_ai_audit','piano_core_ai_audit'],
  ]) assert.throws(()=>assertAuditDatabase(url,actual),/ISOLATED_AUDIT_DATABASE_REQUIRED/);
});

test('reviewed document and manual catalog contain exactly the same 83 unique cases',()=>{
  const document=readFileSync(new URL('../../../docs/AI对话功能测试用例-v1.0-评审稿.md',import.meta.url),'utf8');
  const ids=[...document.matchAll(/^### ([QBSFRWMKCPEU]\d{2}) /gm)].map(match=>match[1]);
  assert.doesNotThrow(()=>assertCaseInventory(ids));
  assert.throws(()=>assertCaseInventory([...ids.slice(1),ids[1]]),/CASE_INVENTORY/);
  const wrong={...groups};delete wrong.Q01;wrong.Q99='G';
  assert.throws(()=>assertCaseInventory(ids,wrong),/CASE_INVENTORY/);
});
