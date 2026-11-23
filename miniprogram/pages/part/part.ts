/** 部位编辑器（引脚分区）：灯珠方格 + 段拖选 + 相位模式 + LayoutCommit。 */

import { getSession } from "../../utils/session/singleton";
import {
  validateSegment, validateLayout, formatRange,
  readbackToParts, planLayoutCommit, layoutCommitFeedback,
  partLimit, canAddPart, addPartSlot, removePartSlot,
} from "../../utils/part-editor";
import { validateNameBytes, nameByteLabel } from "../../utils/name-bytes";
import { NAME_BYTES } from "../../utils/protocol/constants";
import { PHASE, MAX_PARTS, MAX_PART_SEGS } from "../../utils/protocol/constants";
import type { LayoutPart } from "../../utils/protocol/types";

/** 根 tsconfig 未引入小程序类型（基线红），这里只声明页面用到的 wx API。 */
declare const wx: {
  showModal(options: {
    title?: string;
    content: string;
    success?: (res: { confirm: boolean; cancel: boolean }) => void;
  }): void;
};

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
    /** 设备允许的部位槽位数与每部位段数（deviceInfo 缺失时回退协议常量） */
    maxParts: MAX_PARTS,
    maxPartSegs: MAX_PART_SEGS,
    /** 是否还能新增槽位 */
    canAdd: true,
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
    /** 当前部位名的 UTF-8 已用字节数（输入时实时更新） */
    partNameBytes: 0,
    /** 名字上限（字节），来自协议 NAME_BYTES */
    nameLimit: NAME_BYTES,
    /** 名字字节提示文案「已用 X / 24 字节」 */
    nameByteLabel: nameByteLabel(""),
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
    void this.loadLayout();
  },

  /** 从设备读回布局并刷新页面；返回读回是否成功。 */
  async loadLayout(): Promise<boolean> {
    const session = getSession();
    const state = session.deviceState;
    if (!state) {
      this.setData({ hint: "未连接设备，请先连接", loading: false });
      return false;
    }
    const ledCount = state.stripLedCounts[this.data.stripId] ?? 0;
    const partCount = state.partCounts[this.data.stripId] ?? 0;
    if (ledCount === 0) {
      this.setData({ hint: `链 ${this.data.stripId} 未分配灯珠`, loading: false });
      return false;
    }
    // 从设备重新查询布局（提交后读回最新）
    const res = await session.queryLayout(this.data.stripId);
    const readbackOk = res.kind === "ok";
    const parts = readbackToParts(
      this.data.stripId,
      readbackOk ? res.layout : (session.layout[this.data.stripId] ?? null),
      Math.max(partCount, 1),
    );
    const deviceInfo = session.deviceInfo;
    const maxParts = partLimit(deviceInfo);
    const maxPartSegs = deviceInfo?.maxPartSegs ?? MAX_PART_SEGS;
    const activePartId = 0;
    const activePart = parts[activePartId];
    this.setData({
      ledCount,
      parts,
      partCount: parts.length,
      maxParts,
      maxPartSegs,
      canAdd: canAddPart(parts, maxParts),
      activePartId,
      segs: activePart.segs,
      phase: activePart.phase,
      partName: activePart.name,
      partNameBytes: validateNameBytes(activePart.name).bytes,
      nameByteLabel: nameByteLabel(activePart.name),
      loading: false,
    });
    this.renderLedCells();
    return readbackOk;
  },

  /** 增删槽位后统一刷新槽位、当前部位字段与新增按钮状态。 */
  applyParts(parts: LayoutPart[], activePartId: number, hint: string) {
    const active = parts[activePartId] ?? parts[0];
    this.setData({
      parts,
      partCount: parts.length,
      canAdd: canAddPart(parts, this.data.maxParts),
      activePartId: active.partId,
      segs: active.segs,
      phase: active.phase,
      partName: active.name,
      partNameBytes: validateNameBytes(active.name).bytes,
      nameByteLabel: nameByteLabel(active.name),
      selecting: null,
      selectStart: -1,
      hint,
    });
    this.renderLedCells();
  },

  /** 新增槽位：追加到末尾并选中它。 */
  onAddPartTap() {
    const added = addPartSlot(this.data.parts, this.data.stripId, this.data.maxParts);
    if (added.kind === "rejected") {
      this.setData({ hint: added.reason });
      return;
    }
    this.applyParts(added.parts, added.partId, `已新增槽位 ${added.partId}`);
  },

  /** 删除当前槽位：空槽位直接删，有段槽位先确认。 */
  onDeletePartTap() {
    const partId = this.data.activePartId;
    const plan = removePartSlot(this.data.parts, partId, partId);
    if (plan.kind === "rejected") {
      this.setData({ hint: plan.reason });
      return;
    }
    if (plan.kind === "removed") {
      this.applyParts(plan.parts, plan.activePartId, `已删除槽位 ${partId}`);
      return;
    }
    wx.showModal({
      title: "删除部位槽位",
      content: plan.prompt,
      success: (res) => {
        if (!res.confirm) return;
        const done = removePartSlot(this.data.parts, partId, this.data.activePartId, { confirmed: true });
        if (done.kind === "removed") {
          this.applyParts(done.parts, done.activePartId, `已删除槽位 ${partId}`);
        }
      },
    });
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
    if (!parts[partId]) return;
    this.applyParts(parts, partId, "");
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
    if (segs.length >= this.data.maxPartSegs) {
      this.setData({ hint: `段数已达上限 ${this.data.maxPartSegs}` });
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
    const segs = p.segs.filter((_seg: [number, number], i: number) => i !== segIdx);
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
    const nameLen = validateNameBytes(name).bytes;
    parts[activePartId] = { ...p, name, nameLen };
    const check = validateNameBytes(name);
    this.setData({
      parts,
      partName: name,
      partNameBytes: check.bytes,
      nameByteLabel: nameByteLabel(name),
      hint: check.ok ? "" : check.message,
    });
  },

  /** 取消当前拖选。 */
  onCancelSelect() {
    this.setData({ selecting: null, selectStart: -1 });
    this.renderLedCells();
  },

  /** 提交布局。 */
  async onCommitTap(): Promise<void> {
    const plan = planLayoutCommit(this.data.parts);
    if (plan.length === 0) {
      this.setData({ hint: "没有已分配段的部位，无法提交" });
      return;
    }
    // 名字按 UTF-8 字节数校验：任一非空部位名超限即阻止提交，不发 LayoutCommit。
    for (const p of this.data.parts) {
      if (!p.name) continue;
      const nameCheck = validateNameBytes(p.name);
      if (!nameCheck.ok) {
        this.setData({ hint: `未提交：部位 ${p.partId} ${nameCheck.message}` });
        return;
      }
    }
    // 校验（整份校验，validateLayout 内部跨部位检查用 i<j，不会自重叠）
    const verr = validateLayout(this.data.stripId, plan, this.data.ledCount);
    if (verr) {
      this.setData({ hint: `校验失败：${verr}` });
      return;
    }
    this.setData({ hint: "提交中…", canCommit: false });
    const result = await getSession().layoutCommit(plan);
    if (result.kind !== "ok") {
      this.setData({ hint: layoutCommitFeedback(result, false), canCommit: true });
      return;
    }
    const readbackOk = await this.loadLayout();
    this.setData({ hint: layoutCommitFeedback(result, readbackOk), canCommit: true });
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