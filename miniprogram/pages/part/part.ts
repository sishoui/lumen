/** 部位编辑器（引脚分区）：灯珠方格 + 段拖选 + 相位模式 + LayoutCommit。 */

import { getSession } from "../../utils/session/singleton";
import {
  isLedOccupied, validateSegment, validateLayout, formatSegs, formatRange,
  createEmptyLayout, readbackToParts, filterEmptyParts,
} from "../../utils/part-editor";
import { PHASE, MAX_PARTS, MAX_PART_SEGS } from "../../utils/protocol/constants";
import type { LayoutPart } from "../../utils/protocol/types";

/** 单颗灯珠的显示状态。 */
interface LedCell {
  index: number;
  occupied: boolean;
  partId: number; // -1 = 未分配
  partName: string;
}

Page({
  data: {
    stripId: 0,
    ledCount: 60,
    parts: [] as LayoutPart[],
    partCount: 1,
    /** 当前编辑的部位索引 */
    activePartId: 0,
    /** 段列表（用于当前部位） */
    segs: [] as Array<[number, number]>,
    /** 灯珠方格渲染数据 */
    ledCells: [] as LedCell[],
    /** 选段模式：null = 浏览，{ start, end } = 拖选中 */
    selecting: null as { start: number; end: number } | null,
    /** 选中起点的灯珠索引 */
    selectStart: -1,
    phase: 0,
    phaseOptions: [
      { value: PHASE.CONTINUOUS, label: "连续" },
      { value: PHASE.PER_SEGMENT, label: "各自起点" },
    ],
    partName: "",
    /** 消息提示 */
    hint: "",
    /** 是否正在加载 */
    loading: true,
    /** 是否可以提交 */
    canCommit: true,
  },

  onLoad(query: Record<string, string>) {
    const stripId = parseInt(query.stripId ?? "0", 10);
    this.setData({ stripId: Number.isFinite(stripId) ? stripId : 0 });
    this.loadLayout();
  },

  async loadLayout() {
    const session = getSession();
    const state = session.deviceState;
    if (!state) {
      this.setData({ hint: "未连接设备，请先连接", loading: false });
      return;
    }
    const ledCount = state.stripLedCounts[this.data.stripId] ?? 0;
    const partCount = state.partCounts[this.data.stripId] ?? 0;
    if (ledCount === 0) {
      this.setData({ hint: `链 ${this.data.stripId} 未分配灯珠`, loading: false });
      return;
    }
    // 从设备重新查询布局（提交后读回最新）
    const res = await session.queryLayout(this.data.stripId);
    const cached = res.kind === "ok" ? res.layout : session.layout[this.data.stripId];
    const parts = readbackToParts(this.data.stripId, cached, Math.max(partCount, 1));
    // 确保至少有一个部位
    if (parts.length === 0) {
      parts.push(...createEmptyLayout(this.data.stripId, 1));
    }
    const activePartId = 0;
    const activePart = parts[activePartId];
    this.setData({
      ledCount,
      parts,
      partCount: Math.max(partCount, 1),
      activePartId,
      segs: activePart.segs,
      phase: activePart.phase,
      partName: activePart.name,
      loading: false,
    });
    this.renderLedCells();
  },

  /** 渲染灯珠方格。 */
  renderLedCells() {
    const cells: LedCell[] = [];
    const allParts = this.data.parts;
    for (let i = 0; i < this.data.ledCount; i += 1) {
      let occupied = false;
      let partId = -1;
      let partName = "";
      for (const p of allParts) {
        for (const [s, e] of p.segs) {
          if (i >= s && i <= e) {
            occupied = true;
            partId = p.partId;
            partName = p.name || `部位 ${p.partId}`;
            break;
          }
        }
        if (occupied) break;
      }
      // 当前拖选中
      const sel = this.data.selecting;
      if (sel && i >= sel.start && i <= sel.end) {
        occupied = true;
        partId = this.data.activePartId;
        partName = "拖选中";
      }
      cells.push({ index: i, occupied, partId, partName });
    }
    this.setData({ ledCells: cells });
  },

  /** 切换当前编辑的部位。 */
  onPartTap(e: any) {
    const partId = e.currentTarget.dataset.part as number;
    const parts = this.data.parts;
    if (partId < 0 || partId >= parts.length) return;
    const p = parts[partId];
    this.setData({
      activePartId: partId,
      segs: p.segs,
      phase: p.phase,
      partName: p.name,
      selecting: null,
      selectStart: -1,
    });
    this.renderLedCells();
  },

  /** 灯珠方格点击：开始/结束选段。 */
  onLedTap(e: any) {
    const index = e.currentTarget.dataset.index as number;
    if (this.data.selecting === null) {
      // 开始新选段
      this.setData({
        selecting: { start: index, end: index },
        selectStart: index,
      });
    } else {
      // 结束选段
      const start = Math.min(this.data.selecting.start, index);
      const end = Math.max(this.data.selecting.end, index);
      this.addSegment(start, end);
    }
    this.renderLedCells();
  },

  /** 添加一个段到当前部位。 */
  addSegment(start: number, end: number) {
    const parts = this.data.parts;
    const activePartId = this.data.activePartId;
    const p = parts[activePartId];
    const segs = p.segs;
    // 校验
    const err = validateSegment(start, end, this.data.ledCount, parts);
    if (err) {
      this.setData({ hint: `段无效：${err}` });
      this.setData({ selecting: null, selectStart: -1 });
      this.renderLedCells();
      return;
    }
    if (segs.length >= MAX_PART_SEGS) {
      this.setData({ hint: `段数已达上限 ${MAX_PART_SEGS}` });
      this.setData({ selecting: null, selectStart: -1 });
      this.renderLedCells();
      return;
    }
    segs.push([start, end]);
    // 更新 parts
    parts[activePartId] = { ...p, segs: segs.slice(), segCount: segs.length };
    this.setData({
      parts,
      segs: segs.slice(),
      selecting: null,
      selectStart: -1,
      hint: `已添加段 ${formatRange(start, end)}`,
    });
    this.renderLedCells();
  },

  /** 删除某个段。 */
  onDeleteSeg(e: any) {
    const segIdx = e.currentTarget.dataset.idx as number;
    const parts = this.data.parts;
    const activePartId = this.data.activePartId;
    const p = parts[activePartId];
    const segs = p.segs.filter((_, i) => i !== segIdx);
    parts[activePartId] = { ...p, segs: segs.slice(), segCount: segs.length };
    this.setData({
      parts,
      segs: segs.slice(),
      hint: `已删除段 ${segIdx + 1}`,
    });
    this.renderLedCells();
  },

  /** 相位模式切换。 */
  onPhaseChange(e: any) {
    const phase = e.detail.value as number;
    const parts = this.data.parts;
    const activePartId = this.data.activePartId;
    const p = parts[activePartId];
    parts[activePartId] = { ...p, phase };
    this.setData({ parts, phase });
  },

  /** 部位名输入。 */
  onNameInput(e: any) {
    const name = e.detail.value as string;
    const parts = this.data.parts;
    const activePartId = this.data.activePartId;
    const p = parts[activePartId];
    parts[activePartId] = { ...p, name, nameLen: name.length };
    this.setData({ parts, partName: name });
  },

  /** 取消当前拖选。 */
  onCancelSelect() {
    this.setData({ selecting: null, selectStart: -1 });
    this.renderLedCells();
  },

  /** 提交布局。 */
  onCommitTap() {
    const parts = filterEmptyParts(this.data.parts);
    if (parts.length === 0) {
      this.setData({ hint: "没有已分配段的部位，无法提交" });
      return;
    }
    // 校验（整份校验，validateLayout 内部跨部位检查用 i<j，不会自重叠）
    const verr = validateLayout(this.data.stripId, parts, this.data.ledCount);
    if (verr) {
      this.setData({ hint: `校验失败：${verr}` });
      return;
    }
    this.setData({ hint: "提交中…", canCommit: false });
    void getSession().layoutCommit(parts).then((result) => {
      if (result.kind === "ok") {
        this.setData({ hint: "布局已提交", canCommit: true });
        void this.loadLayout();
      } else if (result.kind === "ack-error") {
        this.setData({ hint: `提交失败：结果码 ${result.ack.resultCode}`, canCommit: true });
      } else if (result.kind === "stale") {
        this.setData({ hint: "连接已变化，请重试", canCommit: true });
      } else {
        this.setData({ hint: `提交失败：${result.message}`, canCommit: true });
      }
    });
  },

  /** 清空当前部位的所有段。 */
  onClearSegs() {
    const parts = this.data.parts;
    const activePartId = this.data.activePartId;
    const p = parts[activePartId];
    parts[activePartId] = { ...p, segs: [], segCount: 0 };
    this.setData({ parts, segs: [], hint: "已清空当前部位的段" });
    this.renderLedCells();
  },
});