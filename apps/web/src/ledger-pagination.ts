const PAGE_SIZE = 5;

export function ledgerPageForEntry<T extends { entryId: string }>(entries: T[], entryId: string): number | null {
  const index = entries.findIndex((entry) => entry.entryId === entryId);
  return index < 0 ? null : Math.floor(index / PAGE_SIZE) + 1;
}

export function paginateLedger<T>(entries: T[], requestedPage: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const page = Math.max(1, Math.min(pages, requestedPage));
  return { items: entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), page, pages };
}
