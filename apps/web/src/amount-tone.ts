/** Presentation only: keep the Core's decimal string intact. */
export function amountTone(value: string | undefined): 'neutral' | 'positive' | 'negative' {
  if (!value || /^-?0(?:\.0+)?$/.test(value)) return 'neutral';
  return value.startsWith('-') ? 'negative' : 'positive';
}
