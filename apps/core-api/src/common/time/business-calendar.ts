const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';

type CalendarParts = {
  year: number;
  month: number;
  day: number;
};

const PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function numericParts(value: Date): CalendarParts {
  const values = Object.fromEntries(
    PARTS_FORMATTER.formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as CalendarParts;
  return values;
}

export function businessMonthStart(value: Date): Date {
  const { year, month } = numericParts(value);
  return new Date(Date.UTC(year, month - 1, 1));
}

export function parseBusinessMonth(value: string): Date | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
}

export function formatBusinessMonth(value: Date): string {
  const { year, month } = numericParts(value);
  return `${year}-${String(month).padStart(2, '0')}`;
}
