/**
 * 引脚分区（Part/Layout）领域工具。
 * 供部位编辑器、场景编辑器、测试共同使用，避免业务逻辑散落页面。
 */

import type { DeviceInfo, LayoutPart, LayoutReadback } from "./protocol/types";
import { MAX_PARTS, MAX_PART_SEGS } from "./protocol/constants";
import { validateNameBytes } from "./name-bytes";
import { describeCommandFailure } from "./feedback";
import type { EditResult } from "./session/session";

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
    const nameCheck = validateNameBytes(p.name);
    if (!nameCheck.ok) return `部位 ${p.partId}：${nameCheck.message}`;
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

/** 设备允许的部位槽位数；deviceInfo 缺失时回退协议常量。 */
export function partLimit(deviceInfo: DeviceInfo | null): number {
  return deviceInfo?.maxParts ?? MAX_PARTS;
}

/** 当前布局是否还能追加部位槽位。 */
export function canAddPart(parts: LayoutPart[], maxParts: number): boolean {
  return parts.length < maxParts;
}

/** 新增槽位的结果：added 带新数组与新槽位编号；rejected 表示已达设备上限。 */
export type AddPartResult =
  | { kind: "added"; parts: LayoutPart[]; partId: number }
  | { kind: "rejected"; reason: string };

/** 追加一个空槽位到末尾；partId 取末尾编号，提交时由 planLayoutCommit 连续重编号。 */
export function addPartSlot(parts: LayoutPart[], stripId: number, maxParts: number): AddPartResult {
  if (!canAddPart(parts, maxParts)) {
    return { kind: "rejected", reason: `部位槽位已达设备上限 ${maxParts} 个` };
  }
  const partId = parts.length;
  return {
    kind: "added",
    partId,
    parts: [
      ...parts,
      { stripId, partId, nameLen: 0, name: "", segCount: 0, phase: 0, segs: [] as Array<[number, number]> },
    ],
  };
}

/** 删除槽位的结果：removed 带新数组与新选中槽位；confirm 表示有段需确认；rejected 表示不能删。 */
export type RemovePartResult =
  | { kind: "removed"; parts: LayoutPart[]; activePartId: number }
  | { kind: "confirm"; prompt: string }
  | { kind: "rejected"; reason: string };

/**
 * 删除槽位：空槽位直接删，有段槽位需 confirmed=true；删除后 partId 连续重编号。
 * activePartId 随删除调整，始终落在 0..n−1。
 */
export function removePartSlot(
  parts: LayoutPart[],
  partId: number,
  activePartId: number,
  opts: { confirmed?: boolean } = {},
): RemovePartResult {
  const part = parts[partId];
  if (!part) return { kind: "rejected", reason: `部位槽位 ${partId} 不存在` };
  if (parts.length <= 1) return { kind: "rejected", reason: "至少保留 1 个部位槽位" };
  if (part.segs.length > 0 && !opts.confirmed) {
    const label = part.name || `部位 ${part.partId}`;
    return {
      kind: "confirm",
      prompt: `部位「${label}」已有 ${part.segs.length} 个段，删除后这些段会一并移除，确定删除吗？`,
    };
  }
  const remaining = parts
    .filter((_p, index) => index !== partId)
    .map((p, index) => ({ ...p, partId: index }));
  const nextActive = activePartId > partId
    ? activePartId - 1
    : Math.min(activePartId, remaining.length - 1);
  return { kind: "removed", parts: remaining, activePartId: nextActive };
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

/**
 * 提交结果 → 页面提示。
 *
 * 提交成功但读回失败必须与「布局已提交」区分：设备已接受，页面显示的却是旧值，
 * 用户需要重连才能看到真实状态。失败原因统一走 feedback.describeCommandFailure
 * （结果码中文来自 protocol.constants.resultName，不再本地维护第二份表）。
 */
export function layoutCommitFeedback(result: EditResult, readbackOk: boolean): string {
  if (result.kind === "ok") {
    return readbackOk ? "布局已提交" : "已提交但读回失败，请重连查看设备实际状态";
  }
  return describeCommandFailure(result, "提交");
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