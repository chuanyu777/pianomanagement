export function filterLedgerEntries<T extends { kind: string; occurredAt: string }>(entries: T[], filter: { kind: string; from: string; to: string }): T[] {
  return entries.filter((entry) => {
    const date = new Date(entry.occurredAt);
    if (Number.isNaN(date.getTime())) return false;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    return (filter.kind === 'ALL' || entry.kind === filter.kind) && (!filter.from || day >= filter.from) && (!filter.to || day <= filter.to);
  });
}
