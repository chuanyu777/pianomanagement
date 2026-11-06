import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAccountRows } from './account-assertions.mjs';

const expected=[
  {course:'隔离测试主课',paid:'500.00',gift:'80.00',total:'580.00',price:'200.00'},
  {course:'隔离测试陪练',paid:'120.00',gift:'20.00',total:'140.00',price:'80.00'},
];
const result={workspace:{blocks:[{type:'data-table',rows:expected}]}};

test('checks every distinct course and all Core monetary fields',()=>{
  assert.doesNotThrow(()=>assertAccountRows(result,expected));
  const wrong=structuredClone(result);
  wrong.workspace.blocks[0].rows[1].paid='500.00';
  assert.throws(()=>assertAccountRows(wrong,expected));
  const missing=structuredClone(result);
  missing.workspace.blocks[0].rows.pop();
  assert.throws(()=>assertAccountRows(missing,expected));
  const repeated=structuredClone(result);
  repeated.workspace.blocks[0].rows[1]=repeated.workspace.blocks[0].rows[0];
  assert.throws(()=>assertAccountRows(repeated,expected));
});
