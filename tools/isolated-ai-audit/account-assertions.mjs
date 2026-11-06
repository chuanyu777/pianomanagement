import assert from 'node:assert/strict';

/** Compare complete displayed account rows with independent Core balances. */
export function assertAccountRows(result, expected) {
  const blocks=result?.workspace?.blocks ?? [];
  assert.ok(!blocks.some(block=>block.type==='action-preview'));
  const tables=blocks.filter(block=>block.type==='data-table');
  assert.equal(tables.length,1);
  const rows=tables[0].rows;
  assert.equal(rows.length,expected.length);
  assert.equal(new Set(rows.map(row=>row.course)).size,rows.length);
  for (const wanted of expected) {
    const matches=rows.filter(row=>row.course===wanted.course);
    assert.equal(matches.length,1);
    for (const key of ['course','paid','gift','total','price']) assert.equal(matches[0][key],wanted[key]);
  }
}
