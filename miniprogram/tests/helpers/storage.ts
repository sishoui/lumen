/**
 * 内存 storage（SessionStorage 的测试实现）。
 */

import type { SessionStorage } from "../../utils/mock/mock-mode";

export function createMemoryStorage(initial: Record<string, string> = {}): SessionStorage & {
  dump(): Record<string, string>;
} {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get(key) { return map.has(key) ? map.get(key)! : null; },
    set(key, value) { map.set(key, value); },
    remove(key) { map.delete(key); },
    dump() { return Object.fromEntries(map); },
  };
}