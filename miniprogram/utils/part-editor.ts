/**
 * 引脚分区（Part/Layout）领域工具。
 * 供部位编辑器、场景编辑器、测试共同使用，避免业务逻辑散落页面。
 */

import type { LayoutPart, LayoutReadback } from "./protocol/types";
import type { EditResult } from "./session/session";
import { MAX_PARTS, MAX_PART_SEGS, RESULT } from "./protocol/constants";

/** 判断某颗灯珠是否已被任何部位占用。 */
export function isLedOccupied(ledIndex: number, parts: LayoutPart[]): boolean {
  for (const p of parts) {
    for (const [s, e] of p.segs) {
      if (ledIndex >= s && ledIndex <= e) return true;
    }
  }
  return false;
}

/**
 * 找出所有未被任何部位占用的灯珠区间（用于新拖选时校验）。
 */
export function findFreeRanges(
  ledCount: number,
  parts: LayoutPart[],
): Array<[number, number]> {
  const occupied: boolean[] = Array(ledCount).fill(false);
  for (const p of parts) {
    for (const [s, e] of p.segs) {
      for (let i = s; i <= e && i < ledCount; i += 1) occupied[i] = true;
    }
  }
  const ranges: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < ledCount; i += 1) {
    if (!occupied[i] && start === -1) start = i;
    if ((occupied[i] || i === ledCount - 1) && start !== -1) {
      const end = occupied[i] ? i - 1 : i;
      ranges.push([start, end]);
      start = -1;
    }
  }
  return ranges;
}

/**
 * 校验一个段是否与已有部位冲突。
 * 返回 null 表示无冲突；返回字符串表示冲突原因。
 */
export function validateSegment(
  start: number,
  end: number,
  ledCount: number,
  parts: LayoutPart[],
): string | null {
  if (start > end) return `起点 ${start} > 终点 ${end}`;
  if (end >= ledCount) return `终点 ${end} 超出灯珠数 ${ledCount}`;
  if (start < 0) return `起点 ${start} 为负`;
  for (const p of parts) {
    for (const [s, e] of p.segs) {
      if (start <= e && end >= s) return `与部位「${p.name || p.partId}」的段 [${s},${e}] 重叠`;
    }
  }
  return null;
}

/**
 * 校验整份布局是否合法（段互斥 + 数量限制）。
 */
export function validateLayout(
  stripId: number,
  parts: LayoutPart[],
  ledCount: number,
): string | null {
  if (parts.length > MAX_PARTS) return `部位数 ${parts.length} > ${MAX_PARTS}`;
  for (const p of parts) {
    if (p.stripId !== stripId) return `部位 stripId 不一致`;
    if (p.segs.length > MAX_PART_SEGS) return `部位 ${p.partId} 段数 ${p.segs.length} > ${MAX_PART_SEGS}`;
    if (p.name.length > 24) return `部位 ${p.partId} 名字超长`;
    for (const [s, e] of p.segs) {
      if (s > e) return `部位 ${p.partId} 段 [${s},${e}] 起点 > 终点`;
      if (e >= ledCount) return `部位 ${p.partId} 段 [${s},${e}] 终点 ${e} 超出灯珠数 ${ledCount}`;
    }
    // 互斥
    for (let i = 0; i < p.segs.length; i += 1) {
      for (let j = i + 1; j < p.segs.length; j += 1) {
        const [s1, e1] = p.segs[i];
        const [s2, e2] = p.segs[j];
        if (s1 <= e2 && s2 <= e1) return `部位 ${p.partId} 内部段重叠`;
      }
    }
  }
  // 跨部位互斥
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      for (const [s1, e1] of parts[i].segs) {
        for (const [s2, e2] of parts[j].segs) {
          if (s1 <= e2 && s2 <= e1) {
            return `部位 ${parts[i].partId} 与 ${parts[j].partId} 段重叠`;
          }
        }
      }
    }
  }
  return null;
}

/**
 * 从设备状态创建空的 LayoutPart 数组（链上每个槽位一个）。
 */
export function createEmptyLayout(stripId: number, partCount: number): LayoutPart[] {
  const parts: LayoutPart[] = [];
  for (let i = 0; i < partCount; i += 1) {
    parts.push({
      stripId,
      partId: i,
      nameLen: 0,
      name: "",
      segCount: 0,
      phase: 0,
      segs: [],
    });
  }
  return parts;
}

/**
 * 把 LayoutReadback 转成编辑用的 LayoutPart 数组（保留空槽位）。
 */
export function readbackToParts(stripId: number, readback: LayoutReadback | null, partCount: number): LayoutPart[] {
  const parts = createEmptyLayout(stripId, partCount);
  if (!readback) return parts;
  for (const p of readback.parts) {
    if (p.partId < partCount) {
      parts[p.partId] = {
        stripId,
        partId: p.partId,
        nameLen: p.nameLen,
        name: p.name,
        segCount: p.segCount,
        phase: p.phase,
        segs: p.segs.map(([s, e]) => [s, e] as [number, number]),
      };
    }
  }
  return parts;
}

/**
 * 生成可直接提交的布局计划（同一链的部位列表）。
 *
 * 空槽位（segs 为空）不参与提交；partId 连续重编号为 0..n−1，
 * 因为设备按 LayoutWrite 声明的 part_count 校验 part_id，断层会被整条拒绝。
 * segCount 以实际段数为准——设备要求声明的段全部写齐。
 */
export function planLayoutCommit(parts: LayoutPart[]): LayoutPart[] {
  const plan: LayoutPart[] = [];
  for (const p of parts) {
    if (p.segs.length === 0) continue;
    plan.push({
      ...p,
      partId: plan.length,
      segCount: p.segs.length,
      segs: p.segs.map(([s, e]) => [s, e] as [number, number]),
    });
  }
  return plan;
}

const RESULT_LABELS: Record<number, string> = {
  [RESULT.OK]: "成功",
  [RESULT.INVALID_PARAM]: "参数无效",
  [RESULT.UNKNOWN_COMMAND]: "未知命令",
  [RESULT.BAD_CHECKSUM]: "校验和错误",
  [RESULT.BAD_LENGTH]: "长度不符",
  [RESULT.BUSY]: "设备忙",
  [RESULT.STORAGE_FAILED]: "存储失败",
  [RESULT.UNSUPPORTED_VERSION]: "版本不支持",
  [RESULT.BAD_MAGIC]: "magic 不匹配",
  [RESULT.INTERNAL_ERROR]: "设备内部错误",
};

/** 结果码 → 中文原因（含十六进制，便于对照协议文档）。 */
function formatResultCode(code: number): string {
  const hex = `0x${code.toString(16).padStart(2, "0").toUpperCase()}`;
  return `${RESULT_LABELS[code] ?? "未知结果码"}（${hex}）`;
}

/**
 * 提交结果 → 页面提示。
 *
 * 提交成功但读回失败必须与「布局已提交」区分：设备已接受，页面显示的却是旧值，
 * 用户需要重连才能看到真实状态。
 */
export function layoutCommitFeedback(result: EditResult, readbackOk: boolean): string {
  switch (result.kind) {
    case "ok":
      return readbackOk ? "布局已提交" : "已提交但读回失败，请重连查看设备实际状态";
    case "ack-error":
      return `提交失败：${formatResultCode(result.ack.resultCode)}`;
    case "stale":
      return "连接已变化，请重试";
    default:
      return `提交失败：${result.message}`;
  }
}

/**
 * 部位覆盖的灯珠总数（委托 commands.partPixelCount）。
 */
export { partPixelCount } from "./protocol/commands";

/**
 * 格式化灯珠区间为可读字符串。
 */
export function formatRange(start: number, end: number): string {
  return start === end ? `${start}` : `${start}–${end}`;
}

/**
 * 格式化部位段列表。
 */
export function formatSegs(segs: Array<[number, number]>): string {
  if (segs.length === 0) return "（未分配）";
  return segs.map(([s, e]) => formatRange(s, e)).join(", ");
}