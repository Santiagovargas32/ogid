export class BoundedCache {
  constructor({ maxEntries = 100, defaultTtlMs = 60_000 } = {}) {
    this.maxEntries = Math.max(1, Number.parseInt(String(maxEntries ?? 100), 10) || 100);
    this.defaultTtlMs = Math.max(0, Number.parseInt(String(defaultTtlMs ?? 60_000), 10) || 60_000);
    this.items = new Map();
  }

  purgeExpired(nowMs = Date.now()) {
    for (const [key, entry] of this.items.entries()) {
      if (entry.expiresAt > 0 && entry.expiresAt <= nowMs) {
        this.items.delete(key);
      }
    }
  }

  get(key, nowMs = Date.now()) {
    this.purgeExpired(nowMs);
    const entry = this.items.get(key);
    if (!entry) {
      return null;
    }

    return {
      value: entry.value,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      ageMs: Math.max(0, nowMs - entry.createdAt)
    };
  }

  set(key, value, ttlMs = this.defaultTtlMs, nowMs = Date.now()) {
    this.purgeExpired(nowMs);
    if (this.items.has(key)) {
      this.items.delete(key);
    }

    this.items.set(key, {
      value,
      createdAt: nowMs,
      expiresAt: ttlMs > 0 ? nowMs + ttlMs : 0
    });

    while (this.items.size > this.maxEntries) {
      const oldestKey = this.items.keys().next().value;
      this.items.delete(oldestKey);
    }

    return this.get(key, nowMs);
  }

  clear() {
    this.items.clear();
  }

  entries(nowMs = Date.now()) {
    this.purgeExpired(nowMs);
    return [...this.items.entries()].map(([key, entry]) => ({
      key,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt
    }));
  }
}
