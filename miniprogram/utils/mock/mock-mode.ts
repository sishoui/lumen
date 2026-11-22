/**
 * 演示模式判定（工单 #6 决策 8）。
 *
 * 无真机记录（storage 无 `lumen.device.v1`）→ MockTransport；
 * 有记录 → BleTransport；用户显式开关（`lumen.mockMode.v1`）→ 以用户为准。
 *
 * boundary 测试要求 wx. 只在 utils/ble/ 下出现；本文件通过 SessionStorage 接口
 * 访问存储，不直触全局对象。
 */

import { MOCK_MODE_KEY, DEVICE_CACHE_KEY } from "./mock-devices";

export interface SessionStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** storage 默认实现（node 测试里传内存实现）。 */
export function createWxStorage(): SessionStorage {
  const g: any = (globalThis as any).wx;
  const available =
    g !== undefined &&
    typeof g.getStorageSync === "function" &&
    typeof g.setStorageSync === "function";
  return {
    get(key) {
      if (!available) return null;
      try {
        const value = g.getStorageSync(key);
        return typeof value === "string" && value.length > 0 ? value : null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      if (!available) return;
      try { g.setStorageSync(key, value); } catch { /* ignore */ }
    },
    remove(key) {
      if (!available) return;
      try { g.removeStorageSync(key); } catch { /* ignore */ }
    },
  };
}

/** 是否启动演示模式（mock）。 */
export function mockModeEnabled(storage: SessionStorage): boolean {
  const pref = storage.get(MOCK_MODE_KEY);
  if (pref === "1") return true;
  if (pref === "0") return false;
  // 无真机记录 → 自动开
  return storage.get(DEVICE_CACHE_KEY) === null;
}

/** 用户显式开关。 */
export function setMockMode(storage: SessionStorage, enabled: boolean): void {
  storage.set(MOCK_MODE_KEY, enabled ? "1" : "0");
}