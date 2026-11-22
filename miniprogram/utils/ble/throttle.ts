/**
 * 单通道 20Hz latest-wins 节流（工单 #6 决策 5）。
 *
 * 语义：
 *  - 任意 50ms 窗口内最多调用一次 sink；
 *  - sink 未完成时新值只覆盖 pending，完成后再按最小间隔发最新值；
 *  - 永不排队中间值（连续量不重传旧值）。
 *
 * 计时器可注入，便于测试里替换。
 */

import { CONTINUOUS_INTERVAL_MS } from "../protocol/constants";

export interface TimerApi {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

const defaultTimer: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface ThrottleOptions {
  intervalMs?: number;
  timer?: TimerApi;
  now?: () => number;
}

export class LatestWinsThrottle<T> {
  private readonly sink: (value: T) => void | Promise<void>;
  private readonly intervalMs: number;
  private readonly timer: TimerApi;
  private readonly now: () => number;
  private pending: T | undefined;
  private hasPending = false;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = 0;
  private sending = false;

  constructor(sink: (value: T) => void | Promise<void>, opts: ThrottleOptions = {}) {
    this.sink = sink;
    this.intervalMs = opts.intervalMs ?? CONTINUOUS_INTERVAL_MS;
    this.timer = opts.timer ?? defaultTimer;
    this.now = opts.now ?? (() => Date.now());
  }

  push(value: T): void {
    this.pending = value;
    this.hasPending = true;
    this.schedule();
  }

  /** 松手时尽快发，但仍遵守最小间隔。 */
  flush(): void {
    this.schedule();
  }

  cancel(): void {
    this.hasPending = false;
    this.pending = undefined;
    if (this.timerHandle !== null) {
      this.timer.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  get pendingValue(): T | undefined {
    return this.hasPending ? this.pending : undefined;
  }

  private schedule(): void {
    if (!this.hasPending || this.timerHandle !== null || this.sending) {
      return;
    }
    const now = this.now();
    const wait = Math.max(0, this.lastSentAt + this.intervalMs - now);
    this.timerHandle = this.timer.setTimeout(() => {
      this.timerHandle = null;
      this.emit();
    }, wait);
  }

  private emit(): void {
    if (!this.hasPending) {
      return;
    }
    const value = this.pending as T;
    this.hasPending = false;
    this.pending = undefined;
    this.sending = true;
    this.lastSentAt = this.now();

    const done = () => {
      this.sending = false;
      this.schedule();
    };

    let result: void | Promise<void>;
    try {
      result = this.sink(value);
    } catch {
      done();
      return;
    }
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).then(done, done);
    } else {
      done();
    }
  }
}