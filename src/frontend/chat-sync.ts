import { api } from './api';
import { object, packHash, validId, validPack, type Pack, type PackEntry, type PackHeader, type Scope, type TopicEvent } from '../shared/communication';

const histories = new Map<string, Pack[]>();
const conversationIds = new Map<string, string>();
export const scopeQuery = (scope: Scope) => `projectId=${scope.projectId}${scope.taskId === null ? '' : `&taskId=${scope.taskId}&phase=${scope.phase}`}`;

// Confirmed packs survive tab switches; unconfirmed deltas belong to a subscription generation.
export class ChatSync {
  private confirmed: Pack[];
  private provisional = new Map<string, Pack>();
  private order: PackEntry[] = [];
  private closed = new Map<string, PackHeader>();
  private generation = 0;
  private active = true;
  private running = false;
  private dirty = false;
  private key: string;
  private requests = new Set<AbortController>();
  constructor(private scope: Scope, private update: (packs: Pack[]) => void, private error: (message: string) => void) {
    this.key = scopeQuery(scope);
    this.confirmed = histories.get(this.key) ?? [];
    this.publish();
  }
  conversation(id: string) {
    const previous = conversationIds.get(this.key);
    conversationIds.set(this.key, id);
    if (previous === undefined || previous === id) return;
    this.generation++;
    for (const request of this.requests) request.abort();
    this.confirmed = []; histories.delete(this.key);
    this.provisional.clear(); this.closed.clear(); this.order = [];
    this.publish(); this.refresh();
  }
  dispose() { this.active = false; this.generation++; for (const request of this.requests) request.abort(); }
  subscribed() {
    this.generation++;
    for (const request of this.requests) request.abort();
    this.provisional.clear(); this.closed.clear(); this.order = [];
    this.publish(); this.refresh();
  }
  event(event: TopicEvent) {
    if (event.name === 'chat.pack.delta') {
      const { packId, delta, header } = event.data;
      if (this.confirmed.some(pack => pack.packId === packId) || this.closed.has(packId)) return;
      this.provisional.set(packId, { ...header, content: (this.provisional.get(packId)?.content ?? '') + delta, tool: null });
      if (!this.order.some(pack => pack.packId === packId)) this.order.push({ packId, state: 'streaming' });
      this.publish();
    } else if (event.name === 'chat.pack.closed') {
      if (this.confirmed.some(pack => pack.packId === event.data.packId)) return;
      this.closed.set(event.data.packId, event.data.header); this.refresh();
    } else if (event.name === 'chat.changed') this.refresh();
  }
  refresh() { this.dirty = true; if (!this.running) void this.sync(); }
  private publish() {
    const pending = this.order.filter(entry => !this.confirmed.some(pack => pack.packId === entry.packId));
    this.update([...this.confirmed, ...pending.flatMap(entry => {
      const pack = this.provisional.get(entry.packId);
      return pack ? [pack] : [];
    })]);
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController(); this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try { return await api<unknown>(path, body, controller.signal); }
    finally { clearTimeout(timeout); this.requests.delete(controller); }
  }
  private async fetchPack(packId: string): Promise<Pack> {
    const value = await this.request(`/api/chat/packs/${encodeURIComponent(packId)}?${this.key}`);
    if (!object(value) || !validPack(value.pack) || value.pack.packId !== packId || value.pack.state !== 'closed') throw new Error('Invalid pack');
    return value.pack;
  }
  private async sync() {
    this.running = true;
    try {
      while (this.active && this.dirty) {
        this.dirty = false;
        const generation = this.generation, current = () => this.active && generation === this.generation;
        try {
          const last = this.confirmed.at(-1);
          const value = await this.request(`/api/chat/packs?${this.key}${last ? `&afterPackId=${encodeURIComponent(last.packId)}` : ''}`);
          if (!current()) continue;
          if (!object(value) || !Array.isArray(value.packs)) throw new Error('Invalid list');
          const seen = new Set(this.confirmed.map(pack => pack.packId));
          const entries: PackEntry[] = [];
          for (const entry of value.packs) {
            if (!object(entry) || !validId(entry.packId) || (entry.state !== 'closed' && entry.state !== 'streaming') || seen.has(entry.packId)) throw new Error('Invalid list');
            seen.add(entry.packId); entries.push({ packId: entry.packId, state: entry.state });
          }
          // Preserve deltas that arrived after the HTTP snapshot was captured.
          this.order = [...entries, ...this.order.filter(entry => !seen.has(entry.packId))];
          this.publish();
          for (const entry of entries) {
            if (!current()) break;
            if (entry.state !== 'closed' && !this.closed.has(entry.packId)) break;
            const provisional = this.provisional.get(entry.packId);
            const header = this.closed.get(entry.packId);
            let pack: Pack;
            if (provisional && header?.kind === 'text') {
              const candidate: Pack = { ...header, content: provisional.content, tool: null };
              const hash = await packHash(candidate);
              if (!current()) break;
              const result = await this.request(`/api/chat/packs/${encodeURIComponent(entry.packId)}/ack`, { ...this.scope, hash });
              if (!current()) break;
              if (!object(result) || typeof result.matched !== 'boolean') throw new Error('Invalid ack');
              if (result.matched) pack = candidate;
              else {
                if (!validPack(result.pack) || result.pack.packId !== entry.packId || result.pack.state !== 'closed') throw new Error('Invalid ack pack');
                pack = result.pack;
              }
            } else pack = await this.fetchPack(entry.packId);
            if (!current()) break;
            if (pack.sequence <= (this.confirmed.at(-1)?.sequence ?? 0)) throw new Error('Invalid order');
            this.confirmed = [...this.confirmed, pack]; histories.set(this.key, this.confirmed);
            this.provisional.delete(pack.packId); this.closed.delete(pack.packId);
            this.publish();
          }
          if (current()) this.error('');
        } catch { if (current()) this.error('チャットのパックを同期できませんでした。更新してください。'); }
      }
    } finally { this.running = false; }
  }
}
