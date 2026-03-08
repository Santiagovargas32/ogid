export class SmartPollLoop {
  constructor({
    task,
    onData = null,
    onError = null,
    intervalMs = 60_000,
    hiddenIntervalMs = null,
    immediate = true
  } = {}) {
    this.task = task;
    this.onData = onData;
    this.onError = onError;
    this.intervalMs = Math.max(2_000, Number(intervalMs || 60_000));
    this.hiddenIntervalMs = Math.max(this.intervalMs, Number(hiddenIntervalMs || intervalMs || 60_000));
    this.immediate = immediate;
    this.timer = null;
    this.inFlight = false;
    this.stopped = true;
    this.handleVisibilityChange = () => {
      if (!this.stopped) {
        this.schedule();
      }
    };
  }

  getDelayMs() {
    return document.hidden ? this.hiddenIntervalMs : this.intervalMs;
  }

  async tick() {
    if (this.inFlight || this.stopped || typeof this.task !== "function") {
      return;
    }

    this.inFlight = true;
    try {
      const payload = await this.task();
      if (typeof this.onData === "function") {
        this.onData(payload);
      }
    } catch (error) {
      if (typeof this.onError === "function") {
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

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
  }
}
