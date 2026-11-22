export const PLATFORMS = ["android", "ios", "devtools", "unknown"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type DeviceKeyKind = "hardware" | "name" | "raw";

export interface DeviceIdentityInput {
  readonly hardwareId?: string | null;
  readonly deviceName?: string | null;
  readonly deviceId?: string | null;
  readonly platform: Platform;
}

export interface ResolvedDeviceKey {
  readonly key: string;
  readonly kind: DeviceKeyKind;
  readonly name: string | null;
}

export function normalizeBroadcastName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeMacAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const compressed = raw.trim().toLowerCase().replace(/^0x/, "").replace(/[:\-\s]/g, "");
  if (!/^[0-9a-f]{12}$/.test(compressed)) return null;
  if (compressed === "000000000000") return null;
  const pairs = compressed.match(/.{2}/g);
  if (pairs === null) return null;
  return pairs.join(":").toUpperCase();
}

/**
 * 日志聚合键里的 hardwareId 片段。
 *
 * #50：小程序上报的是 hw_id（6 字节 BT MAC），所以这里**先按 MAC 归一化**
 * （`AA:BB:CC:DD:EE:FF` → `aa:bb:cc:dd:ee:ff`），再落到 `hw:` 前缀上。
 * 这一步不能省：同一个 MAC 可能以 `aabbccddeeff` / `AA-BB-...` / `aa:bb:...`
 * 三种形态到达，不归一就会把同一台设备拆成三行。
 *
 * 不是合法 MAC 的字符串（历史客户端 / 测试夹具里的短 id）仍按原样小写处理：
 * 聚合是日志口径，不因为格式不认识就丢数据。
 *
 * **但全零 MAC 是例外**：它是「读到 MAC 但值是坏的」这一确定事实，不是历史短 id。
 * 放行会让所有读 MAC 失败的设备挤进同一行（`hw:00:00:00:00:00:00`），
 * 与「格式不认识就保留」的初衷相反。所以它按「不知道」处理，退化为广播名聚合。
 */
export function normalizeHardwareId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const compressed = trimmed.toLowerCase().replace(/^0x/, "").replace(/[:\-\s]/g, "");
  if (compressed === "000000000000") return null;

  // 合法 MAC → 统一小写冒号形态（与 normalizeMacAddress 同一口径，只是小写）。
  if (/^[0-9a-f]{12}$/.test(compressed)) {
    const pairs = compressed.match(/.{2}/g);
    if (pairs === null) return null;
    return pairs.join(":");
  }

  // 非 MAC 历史短 id：原样小写，不丢数据。
  return trimmed.toLowerCase();
}

export function resolveDeviceKey(input: DeviceIdentityInput): ResolvedDeviceKey {
  const name = normalizeBroadcastName(input.deviceName);
  const hardwareId = normalizeHardwareId(input.hardwareId);
  if (hardwareId !== null) {
    return { key: `hw:${hardwareId}`, kind: "hardware", name };
  }
  if (name !== null) {
    return { key: `name:${name}`, kind: "name", name };
  }
  const raw = (input.deviceId ?? "").trim().toLowerCase();
  if (raw.length > 0) {
    return { key: `raw:${input.platform}:${raw}`, kind: "raw", name };
  }
  throw new Error("resolveDeviceKey 需要 hardwareId / deviceName / deviceId 之一");
}