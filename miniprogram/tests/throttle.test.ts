/** 20Hz latest-wins（vitest 假计时器）。 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LatestWinsThrottle } from "../utils/ble/throttle";

describe("LatestWinsThrottle", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function makeThrottle(sink: any) {
    let fakeNow = 0;
    return {
      throttle: new LatestWinsThrottle<number>(sink, {
        intervalMs: 50,
        now: () => fakeNow,
      }),
      setNow: (t: number) => { fakeNow = t; },
      getNow: () => fakeNow,
    };
  }

  it("50ms 窗口内只发一次", () => {
    const sink = vi.fn();
    const { throttle, setNow } = makeThrottle(sink);
    setNow(0);
    throttle.push(1);
    throttle.push(2);
    throttle.push(3);
    vi.advanceTimersByTime(49);
    expect(sink).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(2);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(3);
  });

  it("sink 未完成时新值只覆盖 pending", async () => {
    let resolveSink: (() => void) | null = null;
    const sink = vi.fn(() => new Promise<void>((resolve) => { resolveSink = resolve; }));
    const { throttle, setNow } = makeThrottle(sink);
    setNow(0);
    throttle.push(1);
    vi.advanceTimersByTime(50);
    expect(sink).toHaveBeenCalledWith(1);
    setNow(50);
    throttle.push(2);
    vi.advanceTimersByTime(50);
    expect(sink).toHaveBeenCalledTimes(1);
    resolveSink?.();
    await Promise.resolve();
    await Promise.resolve();
    setNow(100);
    vi.advanceTimersByTime(50);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenLastCalledWith(2);
  });

  it("cancel 清 pending 与定时器", () => {
    const sink = vi.fn();
    const { throttle } = makeThrottle(sink);
    throttle.push(1);
    throttle.cancel();
    vi.advanceTimersByTime(100);
    expect(sink).not.toHaveBeenCalled();
    expect(throttle.pendingValue).toBeUndefined();
  });

  it("flush 尽快发但仍守最小间隔", () => {
    const sink = vi.fn();
    const { throttle, setNow } = makeThrottle(sink);
    setNow(0);
    throttle.push(1);
    vi.advanceTimersByTime(50);
    expect(sink).toHaveBeenCalledTimes(1);
    setNow(50);
    throttle.push(2);
    throttle.flush();
    vi.advanceTimersByTime(50);
    expect(sink).toHaveBeenCalledTimes(2);
  });
});