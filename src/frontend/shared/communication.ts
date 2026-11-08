import { eventTopics, validServerMessage, type ClientMessage, type Scope, type Topic, type TopicEvent, type TerminalAction } from '../../shared/communication';

type Listener = { subscribed(): void; event(event: TopicEvent): void; error(message: string): void };
type Subscription = { id: string; topic: Topic; scope: Scope; listeners: Set<Listener>; ready: boolean; timer?: ReturnType<typeof setTimeout> };
const MAX_FRAME = 65_536, MAX_BUFFER = 1_048_576, TIMEOUT = 10_000;

// One connection and one subscription per topic/scope, shared by this browser tab.
export class Communication {
  private subscriptions = new Map<string, Subscription>();
  private socket?: WebSocket;
  private generation = 0;
  private nextId = 0;
  private ready = false;
  private stopped = false;
  private failures = 0;
  private healthyAt?: number;
  private delay = 1_000;
  private retry?: ReturnType<typeof setTimeout>;
  private handshake?: ReturnType<typeof setTimeout>;

  subscribe(topic: Topic, scope: Scope, listener: Listener) {
    const key = JSON.stringify([topic, scope.projectId, scope.taskId, scope.terminalId ?? null, scope.phase ?? null]);
    let subscription = this.subscriptions.get(key);
    if (!subscription) {
      if (this.subscriptions.size >= 32) { listener.error('購読数が上限に達しました'); return () => {}; }
      subscription = { id: `s${++this.nextId}`, topic, scope, listeners: new Set(), ready: false };
      this.subscriptions.set(key, subscription);
      if (this.ready) this.start(subscription);
    }
    subscription.listeners.add(listener);
    if (subscription.ready) listener.subscribed();
    if (this.stopped) listener.error('通信プロトコルを確認して画面を再読み込みしてください');
    else this.connect();
    let released = false;
    return () => {
      if (released) return; released = true;
      subscription!.listeners.delete(listener);
      if (subscription!.listeners.size) return;
      clearTimeout(subscription!.timer);
      this.subscriptions.delete(key);
      if (this.ready) this.send({ type: 'unsubscribe', subscriptionId: subscription!.id });
      if (!this.subscriptions.size) { clearTimeout(this.retry); this.retry = undefined; this.disconnect(); }
    };
  }

  terminal(scope: Scope, action: TerminalAction): boolean {
    const sub = this.subscriptions.get(JSON.stringify(['terminal', scope.projectId, scope.taskId, scope.terminalId ?? null, scope.phase ?? null]));
    if (!this.ready || !sub?.ready) return false;
    return this.send({ ...action, subscriptionId: sub.id });
  }

  private notify(message: string) { for (const sub of this.subscriptions.values()) for (const listener of sub.listeners) listener.error(message); }
  private disconnect() {
    this.generation++;
    clearTimeout(this.handshake);
    for (const sub of this.subscriptions.values()) { clearTimeout(sub.timer); sub.ready = false; }
    this.ready = false; this.healthyAt = undefined;
    const socket = this.socket; this.socket = undefined; socket?.close();
  }
  private reconnect(message: string, permanent = false) {
    this.notify(message);
    this.disconnect();
    if (permanent) this.stopped = true;
    if (!this.stopped && this.subscriptions.size && !this.retry) {
      this.retry = setTimeout(() => { this.retry = undefined; this.connect(); }, this.delay);
      this.delay = Math.min(this.delay * 2, 30_000);
    }
  }
  private failureLimit() {
    if (this.healthyAt !== undefined && Date.now() - this.healthyAt >= 30_000) this.failures = 0;
    return ++this.failures >= 3;
  }
  private protocolError() {
    const stop = this.failureLimit();
    this.reconnect(stop ? '更新接続で不正な応答を受信しました。画面を再読み込みしてください' : '更新接続で不正な応答を受信しました', stop);
  }
  private send(message: ClientMessage) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    if (this.socket.bufferedAmount > MAX_BUFFER) { this.reconnect('更新接続が混雑しています'); return false; }
    try { this.socket.send(JSON.stringify(message)); return true; }
    catch { this.reconnect('更新接続を再試行しています'); return false; }
  }
  private start(sub: Subscription) {
    if (!this.ready) return;
    const generation = this.generation;
    this.send({ type: 'subscribe', subscriptionId: sub.id, topic: sub.topic, scope: sub.scope });
    if (generation !== this.generation) return;
    sub.timer = setTimeout(() => { if (generation === this.generation) this.reconnect('購読の応答を確認できませんでした'); }, TIMEOUT);
  }
  private connect() {
    if (this.socket || this.retry || this.stopped || !this.subscriptions.size || typeof WebSocket === 'undefined') return;
    const generation = ++this.generation;
    let socket: WebSocket;
    try {
      const url = new URL('/api/ws', window.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url); this.socket = socket;
    } catch { this.reconnect('更新接続を再試行しています'); return; }
    const current = () => this.socket === socket && this.generation === generation;
    this.handshake = setTimeout(() => { if (current()) this.reconnect('更新接続の応答を確認できませんでした'); }, TIMEOUT);
    socket.onopen = () => { if (current()) this.send({ type: 'hello', version: 1 }); };
    socket.onmessage = event => {
      if (!current()) return;
      if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > MAX_FRAME) { this.protocolError(); return; }
      let value: unknown;
      try { value = JSON.parse(event.data); } catch { this.protocolError(); return; }
      if (!validServerMessage(value)) { this.protocolError(); return; }
      if (value.type === 'error') {
        if (value.code === 'UNSUPPORTED_VERSION') { this.reconnect('通信のバージョンに対応していません。画面を再読み込みしてください', true); return; }
        if (value.code === 'INTERNAL_ERROR') {
          const stop = this.failureLimit();
          this.reconnect(stop ? '更新接続を復旧できませんでした。画面を再読み込みしてください' : '更新接続を再試行しています', stop); return;
        }
        const sub = [...this.subscriptions.values()].find(sub => sub.id === value.subscriptionId);
        if (sub) { clearTimeout(sub.timer); if (sub.topic !== 'terminal' || !sub.ready) sub.ready = false; for (const listener of sub.listeners) listener.error(value.message); }
        else this.protocolError();
        return;
      }
      if (value.type === 'ready') {
        if (this.ready) { this.protocolError(); return; }
        clearTimeout(this.handshake); this.ready = true; this.delay = 1_000;
        for (const sub of this.subscriptions.values()) this.start(sub);
        return;
      }
      if (!this.ready) { this.protocolError(); return; }
      const sub = [...this.subscriptions.values()].find(sub => sub.id === value.subscriptionId);
      if (!sub) return; // A released scope must never be revived by late callbacks.
      if (value.type === 'subscribed') {
        if (sub.ready) { this.protocolError(); return; }
        clearTimeout(sub.timer); sub.ready = true; this.healthyAt ??= Date.now();
        for (const listener of sub.listeners) listener.subscribed();
      } else if (value.type === 'event') {
        if (!sub.ready || eventTopics[value.name] !== sub.topic) { this.protocolError(); return; }
        for (const listener of sub.listeners) listener.event(value);
      }
    };
    socket.onerror = () => { if (current()) this.reconnect('更新接続を再試行しています'); };
    socket.onclose = () => { if (current()) this.reconnect('更新接続を再試行しています'); };
  }
}
export const communication = new Communication();
