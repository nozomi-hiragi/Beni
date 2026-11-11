// Beni独自のUUIDv7配置。種別と予約領域を検証する。
const pattern = (kind: '0' | '1' | '2') => new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-7${kind}00-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`);
export function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && pattern('0').test(value);
}
export function validTaskId(value: unknown): value is string {
  return typeof value === 'string' && pattern('1').test(value);
}
export function validChatId(value: unknown): value is string {
  return typeof value === 'string' && pattern('2').test(value);
}
export function generateId(kind: 'project' | 'task' | 'chat'): string {
  const timestamp = Date.now().toString(16).padStart(12, '0');
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  bytes[0] = bytes[0]! & 0x3f | 0x80;
  const random = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-${kind === 'project' ? '7000' : kind === 'task' ? '7100' : '7200'}-${random.slice(0, 4)}-${random.slice(4)}`;
}
