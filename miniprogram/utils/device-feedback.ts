/**
 * 设备页失败文案（#31）。
 *
 * 微信 wx.openBluetoothAdapter / createBLEConnection 等 API 的 fail 回调
 * 把错误压成 { errCode, errMsg }。这里把 errCode 分诊成用户能看懂的一句
 * 「扫描失败：… / 连接失败：…」，其余错误透传 errMsg。
 *
 * 纯函数，无 wx / 页面依赖，页面与测试共用同一份映射。
 */

/** 任意错误 → { errCode, errMsg } 形状。 */
function errShape(err: unknown): { code?: number; msg: string } {
  const e = err as { errCode?: number; errno?: number; errMsg?: string; message?: string } | null;
  const code = e?.errCode ?? e?.errno;
  const msg = e?.errMsg ?? (err instanceof Error ? err.message : undefined) ?? String(err ?? "未知错误");
  return { code, msg };
}

/**
 * 适配器未初始化类消息（微信 SDK 原文）识别（#31）。
 *
 * 真机/开发者工具常见失败：getBluetoothAdapterState / 相关 API 在
 * openBluetoothAdapter 之前被调用，fail 文案含「请先调用
 * wx.openBluetoothAdapter」「adapter not initialized」等。这类消息没有
 * 稳定的 errCode，只能按关键字分诊；命中返回 true，让调用方给人话文案。
 */
const ADAPTER_NOT_READY_PATTERNS = [
  "openBluetoothAdapter",
  "请先调用",
  "adapter not initialized",
  "not initialized",
  "getBluetoothAdapterState:fail",
];

function isAdapterNotReady(msg: string): boolean {
  return ADAPTER_NOT_READY_PATTERNS.some((p) => msg.includes(p));
}

/**
 * 扫描失败 → 可读原因。
 * - 10001 蓝牙未开启；10009 系统不支持 BLE；10002 权限/定位未给；
 *   适配器未初始化类消息 → 请先打开蓝牙；其余透传。
 */
export function scanFailureText(err: unknown): string {
  const { code, msg } = errShape(err);
  switch (code) {
    case 10001:
      return "扫描失败：请打开蓝牙";
    case 10009:
      return "扫描失败：当前系统不支持 BLE";
    case 10002:
      return "扫描失败：未授权蓝牙或定位，请在系统设置中允许";
    default:
      if (isAdapterNotReady(msg)) return "扫描失败：蓝牙未初始化，请重新打开蓝牙";
      return `扫描失败：${msg}`;
  }
}

/**
 * 连接失败 → 可读原因。
 * - 10001 蓝牙未开启；10003 连接失败（被占用/不在范围）；10004/10005 服务/特征值缺失；10006 已断开；
 *   适配器未初始化类消息 → 请先打开蓝牙；其余透传。
 */
export function connectFailureText(err: unknown): string {
  const { code, msg } = errShape(err);
  switch (code) {
    case 10001:
      return "连接失败：请打开蓝牙";
    case 10003:
      return "连接失败：设备可能被其他手机占用或不在范围";
    case 10004:
      return "连接失败：未找到 Lumen 服务，请检查固件";
    case 10005:
      return "连接失败：未找到 RX/TX/State 特征值，请检查固件";
    case 10006:
      return "连接失败：连接已断开";
    default:
      if (isAdapterNotReady(msg)) return "连接失败：蓝牙未初始化，请先打开蓝牙";
      return `连接失败：${msg}`;
  }
}