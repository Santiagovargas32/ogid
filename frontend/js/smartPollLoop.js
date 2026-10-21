export class SmartPollLoop {
  constructor({
    task,
    onData = null,
    onError = null,
    intervalMs = 60_000,
    hiddenIntervalMs = null,
    immediate = true,
    delayResolver = null
  } = {}) {
    this.task = task;
    this.onData = onData;
    this.onError = onError;
    this.intervalMs = Math.max(2_000, Number(intervalMs || 60_000));
    this.hiddenIntervalMs = Math.max(this.intervalMs, Number(hiddenIntervalMs || intervalMs || 60_000));
    this.immediate = immediate;
    this.delayResolver = typeof delayResolver === "function" ? delayResolver : null;
    this.timer = null;
    this.inFlight = false;
    this.stopped = true;
    this.controller = null;
    this.handlePageHide=()=>{this.resumeAfterPageShow=!this.stopped;this.stop({preserveLifecycle:true});};
    this.handlePageShow=event=>{if(event.persisted && this.resumeAfterPageShow){this.resumeAfterPageShow=false;this.start();}};
    this.handleVisibilityChange = () => {
      if (!this.stopped) {
        this.schedule();
      }
    };
  }

  getDelayMs() {
    if (this.delayResolver) {
      const resolved = this.delayResolver({
        hidden: document.hidden,
        intervalMs: this.intervalMs,
        hiddenIntervalMs: this.hiddenIntervalMs
      });
      const parsed = Number(resolved);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return document.hidden ? this.hiddenIntervalMs : this.intervalMs;
  }

  async tick() {
    if (this.inFlight || this.stopped || typeof this.task !== "function") {
      return;
    }

    this.inFlight = true;
    this.controller = new AbortController();
    const controller = this.controller;
    try {
      const payload = await this.task(controller.signal);
      if (!this.stopped && !controller.signal.aborted && typeof this.onData === "function") {
        this.onData(payload);
      }
    } catch (error) {
      if (!this.stopped && !controller.signal.aborted && typeof this.onError === "function") {
        this.onError(error);
      }
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }

  schedule(delayMs = this.getDelayMs()) {
    clearTimeout(this.timer);
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.tick();
    }, delayMs);
  }

  start() {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    globalThis.window?.addEventListener("pagehide",this.handlePageHide);
    globalThis.window?.addEventListener("pageshow",this.handlePageShow);
    if (this.immediate) {
      this.tick();
      return;
    }
    this.schedule();
  }

  trigger(delayMs = 0) {
    if (this.stopped) {
      return;
    }
    this.schedule(delayMs);
  }

  stop({preserveLifecycle=false}={}) {
    if(!preserveLifecycle){this.resumeAfterPageShow=false;globalThis.window?.removeEventListener("pagehide",this.handlePageHide);globalThis.window?.removeEventListener("pageshow",this.handlePageShow);}
    this.stopped = true;
    this.controller?.abort();
    clearTimeout(this.timer);
    this.timer = null;
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
  }
}
