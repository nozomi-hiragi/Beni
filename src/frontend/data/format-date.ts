const formatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function formatDataDate(value: string | null) {
  const timestamp = value === null ? NaN : Date.parse(value);
  return Number.isFinite(timestamp) ? formatter.format(timestamp) : undefined;
}
