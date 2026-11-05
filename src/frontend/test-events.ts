import { packHeader, type Pack, type Scope, type Topic, type TopicEvent } from '../shared/communication';

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  closed = false;
  sent: Record<string, any>[] = [];
  subscriptions = new Map<string, { topic: Topic; scope: Scope }>();
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string | URL) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => { if (!this.closed) { this.readyState = 1; this.onopen?.(); } });
  }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  send(raw: string) {
    const value = JSON.parse(raw); this.sent.push(value);
    queueMicrotask(() => {
      if (this.closed) return;
      if (value.type === 'hello') this.receive({ type: 'ready', version: 1 });
      if (value.type === 'subscribe') {
        this.subscriptions.set(value.subscriptionId, value);
        this.receive({ type: 'subscribed', subscriptionId: value.subscriptionId });
      }
      if (value.type === 'unsubscribe') { this.subscriptions.delete(value.subscriptionId); this.receive({ type: 'unsubscribed', subscriptionId: value.subscriptionId }); }
    });
  }
  close() { this.closed = true; this.readyState = 3; this.subscriptions.clear(); this.onclose?.(); }
  change(topic: Topic = 'chat', taskId?: string) {
    this.event(topic, topic === 'chat' ? { name: 'chat.changed', data: {} } : { name: 'documents.changed', data: {} }, taskId);
  }
  event(topic: Topic, event: TopicEvent, taskId?: string) {
    for (const [id, sub] of this.subscriptions) if (sub.topic === topic && (taskId === undefined || sub.scope.taskId === taskId)) this.receive({ type: 'event', subscriptionId: id, ...event });
  }
}

export function testPack(content: string, overrides: Partial<Pack> = {}): Pack {
  return { packId: 'pack-1', sequence: 1, messageId: 'message-1', sendId: 'send-1', role: 'assistant', kind: 'text', content, tool: null, model: 'test', createdAt: '2026-01-01T00:00:00Z', status: 'completed', state: 'closed', ...overrides };
}
export { packHeader };

// Existing draft/navigation tests use message fixtures; expose their authoritative pack API.
export function packResponse(path: string, messages: { id: string | number; role: string; content: string; status?: string }[]): Response | undefined {
  if (!path.startsWith('/api/chat/packs')) return undefined;
  const packs = messages.map((message, index) => testPack(message.content, { packId: `pack-${message.id}`, messageId: String(message.id), sequence: index + 1, role: message.role === 'user' ? 'user' : 'assistant' }));
  const url = new URL(path, 'http://localhost');
  const id = url.pathname.split('/')[4];
  const value = id ? { pack: packs.find(pack => pack.packId === id) } : { packs: packs.slice(url.searchParams.has('afterPackId') ? packs.findIndex(pack => pack.packId === url.searchParams.get('afterPackId')) + 1 : 0).map(pack => ({ packId: pack.packId, state: pack.state })) };
  return { ok: true, json: async () => value } as Response;
}
