/**
 * 错误码分诊（工单 #6 决策 4）。
 *
 * triage 把 wx 错误码映射成会话层可执行的动作；errorText 把任意错误
 * 压成一句人话。iOS fail state 0-4 映射成可读文案。
 */

export type TriageAction =
  | "reconnect"
  | "retry-after-gap"
  | "wait-adapter"
  | "reinit"
  | "fatal";

const ERROR_TEXT: Record<number, string> = {
  [-1]: "设备已连接",
  [10000]: "蓝牙模块未初始化",
  [10001]: "请打开蓝牙",
  [10002]: "没有找到设备，请重新扫描",
  [10003]: "连接失败，设备可能已被其他手机连接",
  [10004]: "没有找到服务，请检查固件",
  [10005]: "没有找到特征值，请检查固件",
  [10006]: "连接已断开",
  [10007]: "特征值不支持该操作",
  [10008]: "系统蓝牙异常，正在重试",
  [10009]: "当前系统不支持 BLE",
  [10012]: "操作超时",
  [10013]: "设备标识无效，请重新扫描",
};

export class WxCallError extends Error {
  readonly errCode?: number;
  readonly raw: unknown;
  constructor(api: string, raw: unknown) {
    const err = raw as { errCode?: number; errno?: number; errMsg?: string; message?: string } | null;
    const code = err?.errCode ?? err?.errno;
    const msg = err?.errMsg ?? err?.message ?? String(raw);
    super(code === undefined ? `${api}: ${msg}` : `${api}: errCode=${code} ${msg}`);
    this.name = "WxCallError";
    this.errCode = code;
    this.raw = raw;
  }
}

export class WxCallTimeoutError extends Error {
  readonly api: string;
  readonly timeoutMs: number;
  constructor(api: string, timeoutMs: number) {
    super(`${api}: 超时 ${timeoutMs}ms`);
    this.name = "WxCallTimeoutError";
    this.api = api;
    this.timeoutMs = timeoutMs;
  }
}

export function triage(err: unknown): TriageAction {
  if (err instanceof WxCallTimeoutError) return "reconnect";
  const code = err instanceof WxCallError ? err.errCode : undefined;
  switch (code) {
    case 10006:
      return "reconnect";
    case 10008:
      return "retry-after-gap";
    case 10001:
      return "wait-adapter";
    case 10000:
    case 10004:
    case 10005:
      return "reinit";
    default:
      return "fatal";
  }
}

export function iosStateText(state: number | undefined): string {
  switch (state) {
    case 0:
      return "蓝牙状态未知，请稍后重试";
    case 1:
      return "蓝牙正在重置，请稍后重试";
    case 2:
      return "当前系统不支持 BLE";
    case 3:
      return "未授权蓝牙，请在系统设置中允许";
    case 4:
      return "请打开蓝牙";
    default:
      return "蓝牙不可用";
  }
}

export function errorText(err: unknown): string {
  if (err == null) return "未知错误";
  if (err instanceof WxCallError || err instanceof WxCallTimeoutError) {
    if (err instanceof WxCallError && err.errCode !== undefined) {
      const known = ERROR_TEXT[err.errCode];
      if (known) return known;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function resultText(code: number): string {
  const map: Record<number, string> = {
    0: "OK", 1: "InvalidParam", 2: "UnknownCommand", 3: "BadChecksum",
    4: "BadLength", 5: "Busy", 6: "StorageFailed", 7: "UnsupportedVersion",
    8: "BadMagic", 9: "InternalError",
  };
  return map[code] ?? `0x${code.toString(16)}`;
}