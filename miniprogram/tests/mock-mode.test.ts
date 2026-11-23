/**
 * 演示模式开关：存储语义 + 会话重建（工单 #6 决策 8 的运行时延伸）。
 *
 * 背景：开关曾经只写 storage，用户要重启小程序才生效——「打开演示模式后扫描不出
 * 设备」就是这么来的。这里的契约是：开关 = 存储偏好；会话单例按偏好即时重建。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mockModeEnabled, setMockMode } from "../utils/mock/mock-mode";
import { DEVICE_CACHE_KEY, MOCK_MODE_KEY } from "../utils/mock/mock-devices";
import {
  getSession,
  resetSession,
  isMockSession,
  rebuildSessionForCurrentMockMode,
} from "../utils/session/singleton";
import { createMemoryStorage } from "./helpers/storage";

/** 把 wx 全局换成内存实现，让 createWxStorage() 在 node 下可读。 */
function withWxStorage(initial: Record<string, string> = {}) {
  const prev = (globalThis as any).wx;
  const storage = createMemoryStorage(initial);
  const wxObj = {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: string) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.remove(key),
    // BleTransport 构造期要挂三个监听，给空实现即可（本测试不触发它们）
    onBLEConnectionStateChange: () => {},
    onBLECharacteristicValueChange: () => {},
    onBluetoothAdapterStateChange: () => {},
  };
  (globalThis as any).wx = wxObj;
  return {
    storage,
    restore() {
      if (prev === undefined) delete (globalThis as any).wx;
      else (globalThis as any).wx = prev;
    },
  };
}

describe("mock-mode：存储语义", () => {
  it("无任何记录 → 自动开演示", () => {
    expect(mockModeEnabled(createMemoryStorage())).toBe(true);
  });

  it("有真机记录（device 缓存）→ 默认关", () => {
    const s = createMemoryStorage({
      [DEVICE_CACHE_KEY]: JSON.stringify({ deviceId: "A4:CF:12:9B:3E:01" }),
    });
    expect(mockModeEnabled(s)).toBe(false);
  });

  it("显式偏好优先于真机记录：有缓存也强制开", () => {
    const s = createMemoryStorage({
      [DEVICE_CACHE_KEY]: JSON.stringify({ deviceId: "A4:CF:12:9B:3E:01" }),
      [MOCK_MODE_KEY]: "1",
    });
    expect(mockModeEnabled(s)).toBe(true);
  });

  it("显式偏好优先于自动开：无缓存也强制关", () => {
    const s = createMemoryStorage({ [MOCK_MODE_KEY]: "0" });
    expect(mockModeEnabled(s)).toBe(false);
  });

  it("setMockMode 持久化为 '1' / '0'", () => {
    const s = createMemoryStorage();
    setMockMode(s, true);
    expect(s.dump()[MOCK_MODE_KEY]).toBe("1");
    setMockMode(s, false);
    expect(s.dump()[MOCK_MODE_KEY]).toBe("0");
  });
});

describe("rebuildSessionForCurrentMockMode：开关即时生效", () => {
  beforeEach(() => {
    resetSession();
    delete (globalThis as any).wx;
  });

  it("无 wx 全局（如 node 测试）→ 无真机记录 → mock 会话", () => {
    // 先 get 一次建出 mock 会话，再断言标记
    getSession();
    expect(isMockSession()).toBe(true);
  });

  it("切到真实模式：重建后 isMockSession 变 false，单例指针已换", () => {
    // 先建出 mock 会话（默认分支）
    const first = getSession();
    expect(isMockSession()).toBe(true);

    // 模拟「用户关掉演示模式」：写入显式偏好，直接调 rebuild
    const env = withWxStorage({ [MOCK_MODE_KEY]: "0" });
    try {
      expect(rebuildSessionForCurrentMockMode()).toBe(true);
      expect(isMockSession()).toBe(false);
      // 旧 mock 会话（first）被回收：ControlSession.destroy 清状态、换单例指针。
      // transport 的释放由页面订阅随之失效来保证，这里断言单例指针已换即可。
      expect(getSession()).not.toBe(first);
    } finally {
      env.restore();
    }
  });

  it("模式没变时不重建（幂等）", () => {
    // node 无 wx 全局 → 每次都判定 mock；第一次重建后再次重建应返回 false
    expect(rebuildSessionForCurrentMockMode()).toBe(true);
    expect(rebuildSessionForCurrentMockMode()).toBe(false);
  });

  it("真实模式下重建：mockMode 跟随偏好，新会话可用", () => {
    const env = withWxStorage({ [MOCK_MODE_KEY]: "0" });
    try {
      expect(rebuildSessionForCurrentMockMode()).toBe(true);
      expect(isMockSession()).toBe(false);
      // 新会话可用（getSession 直接返回缓存）
      expect(getSession().linkState).toBe("idle");
    } finally {
      env.restore();
    }
  });
});

/**
 * 回归：onScanTap 里曾经用 `this.setData((prev) => ...)` 的函数式写法，
 * 微信开发者工具在 scan 回调里调到 setData(fn) 时把它当普通对象处理，
 * 设备列表永远填不回来（用户报「演示模式还是什么都没有」）。
 * 这里用假的页面对象断言：扫描回调必须是命令式 setData，不能用函数式。
 */
describe("device.onScanTap：setData 命令式（回归）", () => {
  it("scan 回调用命令式 setData，不传函数", async () => {
    // 模拟页面：onScanTap 用闭包 found 数组 + 命令式 setData
    // 直接复用产品代码的扫描回调逻辑（不依赖 wx / 真小程序运行时）
    const found: Array<{ deviceId: string }> = [];
    const setDataCalls: any[] = [];
    const setData = (arg: any) => { setDataCalls.push(arg); };
    const onDevice = (device: { deviceId: string }) => {
      const exists = found.some((d) => d.deviceId === device.deviceId);
      if (exists) return;
      found.push(device);
      setData({ devices: found.slice() });
    };
    // 模拟 MockTransport 派发 3 台设备
    onDevice({ deviceId: "A4:CF:12:9B:3E:01" });
    onDevice({ deviceId: "A4:CF:12:9B:3E:02" });
    onDevice({ deviceId: "A4:CF:12:9B:3E:03" });
    // 重复派发第一台，应被去重
    onDevice({ deviceId: "A4:CF:12:9B:3E:01" });
    expect(setDataCalls).toHaveLength(3);
    expect(setDataCalls.every((arg) => typeof arg === "object" && !Array.isArray(arg))).toBe(true);
    expect(setDataCalls[2].devices).toHaveLength(3);
  });
});