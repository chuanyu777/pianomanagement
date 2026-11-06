import assert from 'node:assert/strict';

/** A denied teacher finance query must not expose account details or a preview. */
export function assertFinancialQueryDenied(result, forbiddenValues) {
  const text=`${result?.answer ?? ''}\n${JSON.stringify(result?.workspace ?? {})}`;
  assert.match(result?.answer ?? '',/无权|没有权限|权限不足/u);
  assert.ok(!(result?.workspace?.blocks ?? []).some(block=>block.type==='action-preview'));
  for (const value of forbiddenValues) assert.ok(!text.includes(value));
}
