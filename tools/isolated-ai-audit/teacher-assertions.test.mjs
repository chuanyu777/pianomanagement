import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFinancialQueryDenied } from './teacher-assertions.mjs';

test('rejects balances, account identifiers and actionable previews in a teacher response',()=>{
  const safe={answer:'当前账号无权查询学生余额',workspace:{blocks:[{type:'summary',text:'无权限'}]}};
  assert.doesNotThrow(()=>assertFinancialQueryDenied(safe,['500.00','account-secret-id']));
  assert.throws(()=>assertFinancialQueryDenied({...safe,answer:'余额 500.00'},['500.00','account-secret-id']));
  assert.throws(()=>assertFinancialQueryDenied({...safe,workspace:{blocks:[{type:'summary',text:'account-secret-id'}]}},['500.00','account-secret-id']));
  assert.throws(()=>assertFinancialQueryDenied({...safe,workspace:{blocks:[{type:'action-preview'}]}},['500.00','account-secret-id']));
  assert.throws(()=>assertFinancialQueryDenied({...safe,answer:'没有找到数据'},['500.00','account-secret-id']));
});
