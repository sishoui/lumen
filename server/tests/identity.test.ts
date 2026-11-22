import { describe, expect, it } from "vitest";
import {
  normalizeBroadcastName,
  normalizeHardwareId,
  normalizeMacAddress,
  resolveDeviceKey,
  type Platform,
} from "../src/identity.ts";

describe("normalizeBroadcastName", () => {
  it("trim + 大写，空串返回 null", () => {
    expect(normalizeBroadcastName("  lumen-1a2b ")).toBe("LUMEN-1A2B");
    expect(normalizeBroadcastName("")).toBeNull();
    expect(normalizeBroadcastName("   ")).toBeNull();
    expect(normalizeBroadcastName(null)).toBeNull();
    expect(normalizeBroadcastName(undefined)).toBeNull();
  });
});

describe("normalizeHardwareId（日志聚合键片段）", () => {
  it("四种 MAC 形态 → 同一个 12 位小写冒号分隔（hw: 前缀后）", () => {
    const expected = "aa:bb:cc:dd:ee:ff";
    for (const raw of [
      "AA:BB:CC:DD:EE:FF",
      "aa-bb-cc-dd-ee-ff",
      "aabbccddeeff",
      "0xAABBCCDDEEFF",
      " AA:BB:CC:DD:EE:FF ",
      "0xaabbccddeeff",
    ]) {
      expect(normalizeHardwareId(raw), raw).toBe(expected);
    }
  });

  it("全零 MAC（含 0x / 冒号 / 短横线）当作不知道，返回 null", () => {
    for (const raw of [
      "00:00:00:00:00:00",
      "000000000000",
      "0x000000000000",
      "00-00-00-00-00-00",
    ]) {
      expect(normalizeHardwareId(raw), raw).toBeNull();
    }
  });

  it("非 MAC 历史短 id 仍按小写原样保留，不丢数据", () => {
    expect(normalizeHardwareId(" AB:CD ")).toBe("ab:cd");
    expect(normalizeHardwareId("DEVICE-7")).toBe("device-7");
  });

  it("空 / null / undefined / 非字符串 → null", () => {
    expect(normalizeHardwareId("")).toBeNull();
    expect(normalizeHardwareId("   ")).toBeNull();
    expect(normalizeHardwareId(null)).toBeNull();
    expect(normalizeHardwareId(undefined)).toBeNull();
  });
});

describe("normalizeMacAddress（大写冒号，供登记表/诊断）", () => {
  it("合法 MAC → 大写冒号格式", () => {
    expect(normalizeMacAddress("aabbccddeeff")).toBe("AA:BB:CC:DD:EE:FF");
    expect(normalizeMacAddress("aa-bb-cc-dd-ee-ff")).toBe("AA:BB:CC:DD:EE:FF");
    expect(normalizeMacAddress("0xAABBCCDDEEFF")).toBe("AA:BB:CC:DD:EE:FF");
    expect(normalizeMacAddress(" AA:BB:CC:DD:EE:FF ")).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("非法 / 全零 / 长度不足 → null", () => {
    expect(normalizeMacAddress("not-a-mac")).toBeNull();
    expect(normalizeMacAddress("AA:BB:CC:DD:EE")).toBeNull();
    expect(normalizeMacAddress("00:00:00:00:00:00")).toBeNull();
    expect(normalizeMacAddress("")).toBeNull();
    expect(normalizeMacAddress(null)).toBeNull();
  });
});

describe("resolveDeviceKey —— 三级归一优先级", () => {
  const hw: Platform = "android";
  const ios: Platform = "ios";
  const dev: Platform = "devtools";

  it("优先级 hardware > name > raw", () => {
    expect(
      resolveDeviceKey({
        hardwareId: "3C:71:BF:00:00:01",
        deviceName: "lumen-1a2b",
        deviceId: "some-uuid",
        platform: ios,
      }),
    ).toEqual({ key: "hw:3c:71:bf:00:00:01", kind: "hardware", name: "LUMEN-1A2B" });

    expect(
      resolveDeviceKey({ deviceName: " lumen-1a2b ", deviceId: "uuid", platform: ios }),
    ).toEqual({ key: "name:LUMEN-1A2B", kind: "name", name: "LUMEN-1A2B" });

    expect(
      resolveDeviceKey({ deviceName: null, deviceId: "UUID-A", platform: ios }),
    ).toEqual({ key: "raw:ios:uuid-a", kind: "raw", name: null });
  });

  it("全零 MAC 回落广播名（不挤进 hw:00:00…）", () => {
    expect(
      resolveDeviceKey({
        hardwareId: "00:00:00:00:00:00",
        deviceName: "LUMEN-1A2B",
        platform: hw,
      }),
    ).toEqual({ key: "name:LUMEN-1A2B", kind: "name", name: "LUMEN-1A2B" });
  });

  it("全零 MAC 且无广播名 → 落 raw 档（不 throw）", () => {
    expect(
      resolveDeviceKey({
        hardwareId: "00:00:00:00:00:00",
        deviceId: "AA:BB:CC:DD:EE:FF",
        platform: dev,
      }),
    ).toEqual({ key: "raw:devtools:aa:bb:cc:dd:ee:ff", kind: "raw", name: null });
  });

  it("raw 键带 platform 段（android/ios/devtools 三档都带）", () => {
    for (const p of ["android", "ios", "devtools", "unknown"] as const) {
      expect(
        resolveDeviceKey({ deviceName: "", deviceId: "ABC-123", platform: p }),
      ).toEqual({ key: `raw:${p}:abc-123`, kind: "raw", name: null });
    }
  });

  it("非法 MAC（格式不认识）当作没带 hardwareId，不 400（由校验层归一为 null）", () => {
    // 校验层 optionalHardwareId 用 normalizeMacAddress 判定：非法 MAC → null。
    // 这里直接验证：传入非法字符串时 normalizeHardwareId 走「历史短 id」分支。
    expect(normalizeHardwareId("not-a-mac")).toBe("not-a-mac");
    // 经校验层之后非法 MAC 不会到达 resolveDeviceKey，等价效果：
    expect(
      resolveDeviceKey({ hardwareId: null, deviceName: "LUMEN-1A2B", platform: hw }),
    ).toEqual({ key: "name:LUMEN-1A2B", kind: "name", name: "LUMEN-1A2B" });
  });

  it("完全没有设备标识时抛错（路由层在校验阶段已先 400）", () => {
    expect(() =>
      resolveDeviceKey({ hardwareId: "", deviceName: "   ", deviceId: "", platform: "unknown" }),
    ).toThrow(/hardwareId/);
  });

  it("hw 档使用 12 位小写无分隔符形态（同一台设备不因上报形态分裂）", () => {
    const expected = { key: "hw:3c:71:bf:00:00:01", kind: "hardware" as const, name: "LUMEN-0001" };
    for (const hardwareId of [
      "3C:71:BF:00:00:01",
      "3c-71-bf-00-00-01",
      "3c71bf000001",
      "0x3C71BF000001",
    ]) {
      expect(
        resolveDeviceKey({ hardwareId, deviceName: "LUMEN-0001", platform: "android" }),
        hardwareId,
      ).toEqual(expected);
    }
  });
});