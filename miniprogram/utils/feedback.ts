/**
 * 失败反馈助手（#31）。
 *
 * 页面看到的所有「操作失败」文案都从这里产出：
 * - describeCommandFailure：命令结果（EditResult / CommandResult）→ 一句含原因、
 *   含结果码中文名的用户文案。动作前缀由页面传入（「开机」「设置链 0 灯珠数」…）。
 * - FailureNotifier：连续量失败节流器。同一类失败在窗口内只提示一次，
 *   避免亮度拖动时每次 ACK 失败都弹 toast。
 *
 * 这里只做纯文案与时间判断，不碰 wx / 页面 / 会话；页面只负责接线。
 */

import { resultName } from "./protocol/constants";

/** 页面拿到的命令结果的最小形状；EditResult / CommandResult 都满足。 */
export type FailureLike = {
  kind: string;
  message?: string;
  ack?: { seq: number; command: number; resultCode: number; ok: boolean };
};

/** 命令失败的可见文案：ack-error 带结果码中文与十六进制，其余按类别可读化。 */
export function describeCommandFailure(result: FailureLike, action: string): string {
  switch (result.kind) {
    case "ok":
      return `${action}成功`;
    case "ack-error": {
      const code = result.ack?.resultCode ?? -1;
      const hex = (code & 0xff).toString(16).padStart(2, "0").toUpperCase();
      return `${action}失败：${resultName(code)}（0x${hex}）`;
    }
    case "stale":
      return "连接已变化，请重试";
    case "storage":
      return `本地存储失败：${result.message ?? "未知原因"}`;
    case "error":
      return `${action}失败：${result.message ?? "未知错误"}`;
    default:
      return `${action}失败：未知原因`;
  }
}

/**
 * 连续量失败节流器：同一 key 的失败在 windowMs 内只提示一次。
 *
 * 用法（亮度拖动等连续路径）：
 *   const notifier = new FailureNotifier();
 *   if (notifier.allow("brightness")) {
 *     wx.showToast({ title: describeCommandFailure(result, "设置亮度"), icon: "none" });
 *   }
 * 离散命令（开关、自检、激活场景等）不经过这里，永远立即提示。
 */
export class FailureNotifier {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly last = new Map<string, number>();

  constructor(options: { windowMs?: number; now?: () => number } = {}) {
    this.windowMs = options.windowMs ?? 2000;
    this.now = options.now ?? (() => Date.now());
  }

  /** 是否允许为该 key 提示：窗口内首次 true，重复 false，窗口过期再次 true。 */
  allow(key: string): boolean {
    const t = this.now();
    const prev = this.last.get(key);
    if (prev !== undefined && t - prev < this.windowMs) return false;
    this.last.set(key, t);
    return true;
  }

  /** 成功时清除节流窗口：下次失败立即提示。 */
  reset(key?: string): void {
    if (key === undefined) this.last.clear();
    else this.last.delete(key);
  }
}