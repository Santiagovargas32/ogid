// Cada sección conserva el último valor válido; la finalización global sólo programa el siguiente ciclo.
export class SectionRefresh {
  constructor({ onStatus = () => {} } = {}) {
    this.onStatus = onStatus;
    this.values = new Map();
    this.inFlight = null;
    this.controller = null;
    this.stopped = false;
  }
  refresh(sections) {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.inFlight = Promise.all(sections.map(async ({ key, load, render }) => {
      this.onStatus(key, 'loading', null, this.values.has(key));
      try {
        const value = await load(signal);
        if (signal.aborted) return;
        this.values.set(key, value);
        render(value, this.values);
        this.onStatus(key, value?.meta?.availability === 'not-collected' ? 'empty' : 'received', null, true, value?.generatedAt || value?.updatedAt || null);
        return {ok:true};
      } catch (error) {
        if (!signal.aborted) this.onStatus(key, this.values.has(key) ? 'stale' : 'error', error, this.values.has(key));
        return {ok:false,error};
      }
    })).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  stop() { this.stopped = true; this.controller?.abort(); }
}
