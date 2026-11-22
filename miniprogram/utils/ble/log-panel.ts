/**
 * 隐藏日志面板的视图模型（纯逻辑，不依赖 wx.*，可在 node 里单测）。
 * 数据源 FrameLog（200 帧环形缓冲）。
 */

import { commandName } from "../protocol/constants";
import type { FrameLogEntry } from "./log";

/** 连点版本号几次唤出面板。 */
export const LOG_PANEL_TAP_COUNT = 5;
/** 连续两次点击的最大间隔；超过则重新计数。 */
export const LOG_PANEL_TAP_WINDOW_MS = 2000;

/** 连点判定：窗口内容纳到 required 次即触发一次，并自动重置计数。 */
export class TapSequence {
  private readonly required: number;
  private readonly windowMs: number;
  private times: number[] = [];

  constructor(required: number = LOG_PANEL_TAP_COUNT, windowMs: number = LOG_PANEL_TAP_WINDOW_MS) {
    this.required = required;
    this.windowMs = windowMs;
  }

  /** 记录一次点击；返回 true 表示凑满 required 次（已自动重置）。 */
  tap(now: number): boolean {
    this.times = this.times.filter((t) => now - t <= this.windowMs && now - t >= 0);
    this.times.push(now);
    if (this.times.length >= this.required) {
      this.times = [];
      return true;
    }
    return false;
  }

  reset(): void {
    this.times = [];
  }

  get count(): number {
    return this.times.length;
  }
}

/** 面板一行展示字段（时间戳 / 方向 / hex / 解析结果）。 */
export interface LogPanelRow {
  id: number;
  time: string;
  dir: "tx" | "rx";
  arrow: string;
  hex: string;
  name: string;
  seq: string;
  parsed: string;
  ok: boolean;
}

/** 时间戳格式 HH:MM:SS.mmm。 */
export function formatFrameTime(ts: number): string {
  const date = new Date(ts);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** 把 FrameLogEntry 转成面板行。 */
export function toPanelRow(entry: FrameLogEntry): LogPanelRow {
  const name = entry.commandName ?? (entry.command !== undefined ? commandName(entry.command) : "");
  const seqText = entry.seq !== undefined ? `seq=0x${entry.seq.toString(16).padStart(2, "0").toUpperCase()}` : "seq=0x??";
  return {
    id: entry.id,
    time: formatFrameTime(entry.ts),
    dir: entry.dir,
    arrow: entry.dir === "tx" ? "→" : "←",
    hex: entry.hex,
    name,
    seq: seqText,
    parsed: entry.parsed,
    ok: entry.ok ?? true,
  };
}