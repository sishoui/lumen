/**
 * 每链灯珠数的领域工具（#25）。
 * 控制页与测试共用：上限解析与提交决策只在这里定义，
 * 避免「1..maxLeds、越界不发送」这条规则散落在页面事件处理里。
 */

import type { DeviceInfo } from "./protocol/types";
import { MAX_LEDS, MIN_LEDS } from "./protocol/constants";

/** 设备允许的单链灯珠数上限；deviceInfo 缺失时回退协议常量。 */
export function ledCountLimit(deviceInfo: DeviceInfo | null): number {
  return deviceInfo?.maxLeds ?? MAX_LEDS;
}

/**
 * 灯珠数输入框的提交计划（页面唯一决策点）。
 * reject 带含上限的原因，页面据此在发送前拦截；noop 表示与设备当前值相同，不发命令。
 */
export type LedCountPlan =
  | { kind: "send"; value: number }
  | { kind: "noop" }
  | { kind: "reject"; reason: string };

export function planLedCountSet(text: string, current: number, maxLeds: number): LedCountPlan {
  const raw = text.trim() === "" ? NaN : Number(text);
  if (!Number.isInteger(raw) || raw < MIN_LEDS || raw > maxLeds) {
    return { kind: "reject", reason: `灯珠数应为 ${MIN_LEDS}–${maxLeds} 之间的整数` };
  }
  if (raw === current) return { kind: "noop" };
  return { kind: "send", value: raw };
}