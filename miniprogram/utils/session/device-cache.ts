/**
 * deviceId 身份缓存（工单 #6 决策 8）：只存身份（deviceId / broadcastName / hwId），
 * 绝不存状态（设备是状态权威）。缓存值带版本号，避免读到旧结果。
 *
 * boundary 测试要求 wx. 只在 utils/ble/ 下出现；本文件通过 SessionStorage 接口
 * 访问存储，不直触全局对象。
 */

export interface SessionStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface CachedDevice {
  deviceId: string;
  broadcastName?: string;
  hwId?: string;
}

export const DEVICE_CACHE_KEY = "lumen.device.v1";

export function loadCachedDevice(storage: SessionStorage): CachedDevice | null {
  const raw = storage.get(DEVICE_CACHE_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { deviceId?: unknown; broadcastName?: unknown; hwId?: unknown };
    if (typeof parsed?.deviceId !== "string" || parsed.deviceId.length === 0) return null;
    return {
      deviceId: parsed.deviceId,
      ...(typeof parsed.broadcastName === "string" && parsed.broadcastName.length > 0
        ? { broadcastName: parsed.broadcastName }
        : {}),
      ...(typeof parsed.hwId === "string" && parsed.hwId.length > 0 ? { hwId: parsed.hwId } : {}),
    };
  } catch {
    return null;
  }
}

export function saveCachedDevice(
  storage: SessionStorage,
  deviceId: string,
  broadcastName?: string,
  hwId?: string,
): CachedDevice {
  const cached: CachedDevice = {
    deviceId,
    ...(broadcastName !== undefined && broadcastName.length > 0 ? { broadcastName } : {}),
    ...(hwId !== undefined && hwId.length > 0 ? { hwId } : {}),
  };
  storage.set(DEVICE_CACHE_KEY, JSON.stringify(cached));
  return cached;
}

export function clearCachedDevice(storage: SessionStorage): void {
  storage.remove(DEVICE_CACHE_KEY);
}

/** storage 默认实现（node 测试里传内存实现）。 */
export function createWxStorage(): SessionStorage {
  const g: any = typeof wx !== "undefined" ? wx : null;
  const available =
    g !== null &&
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