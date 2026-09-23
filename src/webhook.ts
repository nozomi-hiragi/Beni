import { createHmac, timingSafeEqual } from "node:crypto";
import { Store } from "./store.ts";

interface Identity { organizationId: string; appUserId: string; clientId: string }
const record = (v: unknown): Record<string, unknown> | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

export function webhookHandler(secret: string, identity: Identity, store: Store, wake: () => void) {
  return async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname !== "/webhooks/linear" || request.method !== "POST") return new Response("Not found", { status: 404 });
    const signature = request.headers.get("Linear-Signature") ?? "";
    if (!/^[a-f0-9]{64}$/i.test(signature)) return new Response("Unauthorized", { status: 401 });
    // Bound both memory use and time spent reading an incomplete request.
    const reader = request.body?.getReader();
    if (!reader) return new Response("Bad request", { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    const timer = setTimeout(() => { void reader.cancel(); }, 3000);
    let raw: Buffer;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1_048_576) { void reader.cancel(); return new Response("Too large", { status: 413 }); }
        chunks.push(value);
      }
      raw = Buffer.concat(chunks);
    } catch { return new Response("Bad request", { status: 400 }); }
    finally { clearTimeout(timer); }
    const expected = createHmac("sha256", secret).update(raw).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return new Response("Unauthorized", { status: 401 });
    let data: Record<string, unknown> | undefined;
    try { data = record(JSON.parse(raw.toString("utf8"))); } catch { /* Invalid signed JSON. */ }
    if (!data || typeof data.webhookTimestamp !== "number" || Math.abs(Date.now() - data.webhookTimestamp) > 60_000) return new Response("Bad request", { status: 400 });
    if (data.organizationId !== identity.organizationId || data.appUserId !== identity.appUserId || data.oauthClientId !== identity.clientId) return new Response("Forbidden", { status: 403 });
    if (data.type !== "AgentSessionEvent" || !["created", "prompted"].includes(String(data.action))) return new Response(null, { status: 204 });
    const session = record(data.agentSession);
    const delivery = request.headers.get("Linear-Delivery");
    if (!delivery || delivery.length > 200 || typeof data.webhookId !== "string" || typeof session?.id !== "string") return new Response("Bad request", { status: 400 });
    try {
      store.enqueueWebhook(`${data.webhookId}:${delivery}`, session.id);
      // ACK only after durable storage; never wait for Linear or Codex here.
      setTimeout(wake, 0);
      return new Response(null, { status: 200 });
    } catch { return new Response("Unavailable", { status: 503 }); }
  };
}
