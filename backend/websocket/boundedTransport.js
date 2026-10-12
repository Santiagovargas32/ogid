import { WebSocket } from 'ws';
import { performance } from 'node:perf_hooks';

export const TRANSPORT_DEFAULTS = Object.freeze({ maxMessageBytes: 64 * 1024, maxBufferedBytes: 256 * 1024, maxQueueBytes: 256 * 1024, maxQueueItems: 64, slowClientMs: 10_000, closeGraceMs: 5_000 });
export function closeBounded(client, code, reason, graceMs = TRANSPORT_DEFAULTS.closeGraceMs) {
  if (client.runtimeCloseReason) return;
  client.runtimeCloseReason = reason; client.runtimeCloseCode = code;
  client.close(code, reason);
  const timer = setTimeout(() => client.terminate(), graceMs); timer.unref?.();
  client.once('close', () => clearTimeout(timer));
}

export class BoundedTransport {
  constructor(client, { limits = {}, observe = () => {}, onOversize = () => {} } = {}) {
    this.client = client; this.limits = { ...TRANSPORT_DEFAULTS, ...limits }; this.observe = observe; this.onOversize = onOversize;
    for (const [key,value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid WebSocket limit: ${key}`);
    this.queue = []; this.bytes = 0; this.sending = false; this.blockedAt = null;
    this.timer = setInterval(() => this.pump(), 25); this.timer.unref?.();
    client.once('close', () => { clearInterval(this.timer); this.queue = []; this.bytes = 0; });
  }
  enqueue(envelope, { event = 'unknown', revision = null, coalesceKey = null, serializationMs = 0 } = {}) {
    const client = this.client, bytes = Buffer.byteLength(envelope), before = client.bufferedAmount;
    const info = { connectionId: client.connectionId, event, payloadBytes: bytes, bufferedBefore: before, bufferedAfter: before, limitBytes: this.limits.maxMessageBytes, serializationMs, pendingMessages: this.queue.length + Number(this.sending), revision };
    if (client.readyState !== WebSocket.OPEN || client.runtimeCloseReason) return false;
    if (bytes > this.limits.maxMessageBytes) { this.observe({ ...info, outcome: 'payload-too-large' }); this.onOversize(info); return false; }
    if (coalesceKey) {
      const index = this.queue.findIndex(e => e.coalesceKey === coalesceKey);
      if (index >= 0) { this.bytes -= this.queue[index].bytes; this.queue.splice(index, 1); }
    }
    if (this.queue.length >= this.limits.maxQueueItems || this.bytes + bytes > this.limits.maxQueueBytes) {
      this.observe({ ...info, outcome: 'queue-overflow' }); closeBounded(client, 1013, 'resync-required', this.limits.closeGraceMs); return false;
    }
    this.queue.push({ envelope, bytes, coalesceKey, info }); this.bytes += bytes; this.pump(); return true;
  }
  pump() {
    const client = this.client;
    if (client.readyState !== WebSocket.OPEN || client.runtimeCloseReason) return;
    if (client.bufferedAmount > this.limits.maxBufferedBytes || this.sending) {
      this.blockedAt ??= performance.now();
      if (performance.now() - this.blockedAt >= this.limits.slowClientMs) { this.observe({ connectionId: client.connectionId, event: this.queue[0]?.info.event, bufferedBefore: client.bufferedAmount, pendingMessages: this.queue.length, outcome: 'slow-client-timeout' }); closeBounded(client, 1013, 'slow-client', this.limits.closeGraceMs); }
      return;
    }
    this.blockedAt = null;
    const entry = this.queue.shift(); if (!entry) return;
    this.bytes -= entry.bytes; this.sending = true;
    try {
      client.send(entry.envelope, error => {
        this.sending = false;
        if (error) closeBounded(client, 1011, 'send-failed', this.limits.closeGraceMs);
        else { this.observe({ ...entry.info, bufferedAfter: client.bufferedAmount, outcome: 'sent' }); queueMicrotask(() => this.pump()); }
      });
    } catch { this.sending = false; closeBounded(client, 1011, 'send-failed', this.limits.closeGraceMs); }
  }
}

// Kept for callers which send pre-serialized envelopes; a large frame requests HTTP recovery.
export function sendBoundedEnvelope(client, envelope) {
  client.boundedTransport ||= new BoundedTransport(client, { onOversize: () => client.boundedTransport.enqueue(JSON.stringify({ type: 'resync:required:v2', data: { snapshotUrl: '/api/intel/sync', reason: 'payload-too-large' } }), { event: 'resync:required:v2' }) });
  return client.boundedTransport.enqueue(envelope);
}
