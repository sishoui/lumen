/**
 * 假计时器：Throttle / 退避共用。node 环境里 setTimeout 会被 vitest 接管，
 * 这里提供一个可控版本，测试里用 fake timers 通过 vi.useFakeTimers 更方便。
 * 本 helper 仅作为 ThrottleOptions.timer 的默认替代，供需要手控的测试用。
 */

export interface FakeTimerApi {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  /** 推进时间（毫秒），触发所有到期的定时器。 */
  advance(ms: number): void;
  /** 当前虚拟时间。 */
  now(): number;
}

export function createFakeTimer(): FakeTimerApi {
  let now = 0;
  const queue: Array<{ id: number; at: number; fn: () => void }> = [];
  let nextId = 1;
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      queue.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      const idx = queue.findIndex((q) => q.id === handle);
      if (idx >= 0) queue.splice(idx, 1);
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        queue.sort((a, b) => a.at - b.at);
        if (queue.length === 0 || queue[0].at > target) break;
        const next = queue.shift()!;
        now = next.at;
        next.fn();
      }
      now = target;
    },
    now() { return now; },
  };
}