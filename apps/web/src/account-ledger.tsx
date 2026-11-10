import { useEffect, useState } from 'react';
import { Alert, Button, Empty, Select } from 'antd';
import { BusinessDateField } from './business-date-field.js';
import { filterLedgerEntries } from './ledger-filter.js';
import { ledgerPageForEntry, paginateLedger } from './ledger-pagination.js';

export type AccountLedgerEntry = { entryId: string; occurredAt: string; kind: string; amount: string; paidDelta: string; giftDelta: string; note: string | null; operator: string; accountId?: string };

type Props = {
  accountId: string | undefined;
  accountName: string | undefined;
  accounts: Array<{ id: string; courseName: string }>;
  scope: string;
  onScope: (value: string) => void;
  entries: AccountLedgerEntry[];
  loading: boolean;
  error: string | null;
  linkedEntryId: string;
  kind: string;
  from: string;
  to: string;
  onKind: (value: string) => void;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  onReverse: (entryId: string, accountId: string | undefined) => void;
  kindLabel: (kind: string) => string;
  money: (value: string) => string;
  formatDate: (value: string) => string;
};

export function AccountLedger({ accountId, accountName, accounts, scope, onScope, entries, loading, error, linkedEntryId, kind, from, to, onKind, onFrom, onTo, onReverse, kindLabel, money, formatDate }: Props) {
  const [page, setPage] = useState(1);
  const filtered = filterLedgerEntries(entries, { kind, from, to });
  const linkedPage = linkedEntryId ? ledgerPageForEntry(filtered, linkedEntryId) : null;
  const [visitedLink, setVisitedLink] = useState('');
  const effectivePage = linkedPage && visitedLink !== linkedEntryId ? linkedPage : page;
  const paged = paginateLedger(filtered, effectivePage);
  useEffect(() => { setPage(1); setVisitedLink(''); }, [accountId, scope, kind, from, to]);
  useEffect(() => {
    if (!linkedEntryId || !linkedPage || visitedLink === linkedEntryId) return;
    document.getElementById(`account-ledger-${linkedEntryId}`)?.scrollIntoView?.({ block: 'nearest' });
    setPage(linkedPage); setVisitedLink(linkedEntryId);
  }, [linkedEntryId, linkedPage, visitedLink, entries]);
  return <section className="inline-account-ledger" aria-label="账户流水">
    <div className="inline-ledger-heading"><h3>账户流水</h3><span>{accountName ? `${accountName} · ${filtered.length} 条` : '选择课程后查看'}</span></div>
    {accountId && <div className="ledger-filters">{accounts.length > 1 && <Select aria-label="流水课程筛选" value={scope} onChange={onScope} options={[{ value: 'current', label: accountName ?? '当前课程' }, { value: 'all', label: '全部课程' }]} />}<Select aria-label="流水类型筛选" onChange={(value) => onKind(value ?? 'ALL')} options={[{ value: 'ALL', label: '全部类型' }, ...Array.from(new Set(entries.map((entry) => entry.kind))).map((value) => ({ value, label: kindLabel(value) }))]} value={kind} /><BusinessDateField aria-label="流水起始日期" placeholder="开始日期" mode="date" value={from} onChange={onFrom} /><BusinessDateField aria-label="流水截止日期" placeholder="结束日期" mode="date" value={to} onChange={onTo} /></div>}
    {!accountId ? <Empty description="请先选择课程账户" /> : loading ? <div className="loading-state">正在读取账户流水…</div> : error ? <Alert message="暂时无法读取账户流水" description={error} type="error" showIcon /> : linkedEntryId && !filtered.some((entry) => entry.entryId === linkedEntryId) ? <Alert message="找不到指定流水，请检查链接或筛选条件。" type="warning" showIcon /> : paged.items.length ? <div className="account-ledger">{paged.items.map((entry) => <div className={`account-ledger-row${entry.entryId === linkedEntryId ? ' is-linked' : ''}`} id={`account-ledger-${entry.entryId}`} key={entry.entryId}><div><strong>{kindLabel(entry.kind)}</strong><span>{scope === 'all' ? `${accounts.find((item) => item.id === entry.accountId)?.courseName ?? '课程'} · ` : ''}{formatDate(entry.occurredAt)} · {entry.operator}</span>{entry.note && <small>{entry.note}</small>}</div><div><strong>{money(entry.amount)}</strong><span>实付 {entry.paidDelta} · 赠送 {entry.giftDelta}</span>{(entry.kind === 'PAYMENT' || entry.kind === 'GIFT') && <Button size="small" onClick={() => onReverse(entry.entryId, entry.accountId ?? accountId)}>申请冲正</Button>}</div></div>)}</div> : <Empty description="没有符合条件的流水" />}
    {paged.pages > 1 && <nav className="inline-ledger-pagination" aria-label="账户流水分页"><Button disabled={paged.page <= 1} onClick={() => { setVisitedLink(linkedEntryId); setPage(paged.page - 1); }} size="small">上一页</Button><span>{paged.page} / {paged.pages}</span><Button disabled={paged.page >= paged.pages} onClick={() => { setVisitedLink(linkedEntryId); setPage(paged.page + 1); }} size="small">下一页</Button></nav>}
  </section>;
}
