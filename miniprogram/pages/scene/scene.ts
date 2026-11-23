/** 场景编辑器（时间轴）：每部位时间轴 + 步骤 + 两层灯效 + 循环模式。 */

import { getSession } from "../../utils/session/singleton";
import {
  formatDuration, formatLayer, effectLabel,
  layerPickerOptions, pickerIndexToType, pickerIndexForType, layerFieldVisibility,
  normalizeLayer, switchEffectType, validateLayerForSend,
  validateDuration,
  getStepsForPart, getPartHead, totalDuration,
  createEmptyStep, createStaticLayer,
} from "../../utils/scene-editor";
import type { LayerPickerOption, LayerFieldVisibility } from "../../utils/scene-editor";
import { runTimelineWrite, editFailureText } from "../../utils/scene-writer";
import type { TimelineOperation, TimelineWriteOutcome } from "../../utils/scene-writer";
import { LOOP, EFFECT_TYPE, NO_EFFECT } from "../../utils/protocol/constants";
import { EMPTY_EFFECT } from "../../utils/protocol/types";
import type { SceneStep, EffectLayer, SceneReport } from "../../utils/protocol/types";

const LAYER0_OPTIONS = layerPickerOptions(false);
const LAYER1_OPTIONS = layerPickerOptions(true);

const LOOP_OPTIONS = [
  { value: LOOP.NONE, label: "不循环" },
  { value: LOOP.ALL, label: "全部循环" },
  { value: LOOP.LAST, label: "末步循环" },
];

interface ScenePartRow {
  stripId: number;
  partId: number;
  name: string;
  stepCount: number;
  loop: number;
  on: boolean;
}

interface ScenePageData {
  layer0Type: number;
  layer0Hue: number;
  layer0Sat: number;
  layer0Period: number;
  layer0Level: number;
  layer1Type: number;
  layer1Hue: number;
  layer1Sat: number;
  layer1Period: number;
  layer1Level: number;
  layer0Options: LayerPickerOption[];
  layer1Options: LayerPickerOption[];
  layer0Fields: LayerFieldVisibility;
  layer1Fields: LayerFieldVisibility;
  layer0PickerIndex: number;
  layer1PickerIndex: number;
  layer0Label: string;
  layer1Label: string;
}

Page({
  data: {
    sceneId: 0,
    sceneName: "",
    /** 部位列表（来自布局） */
    parts: [] as ScenePartRow[],
    /** 当前编辑的部位 */
    activeKey: "" as string,
    /** 当前部位的步骤列表 */
    steps: [] as Array<SceneStep & { layer0Label: string; layer1Label: string; durationLabel: string }>,
    /** 当前编辑的步骤索引 */
    activeStepIndex: 0,
    /** 当前步骤的编辑字段 */
    editingStep: null as SceneStep | null,
    /** 循环模式 */
    loop: LOOP.ALL,
    /** 步骤时长（ms） */
    durationMs: 1000,
    /** 层0 编辑 */
    layer0Type: EFFECT_TYPE.STATIC,
    layer0Hue: 0,
    layer0Sat: 255,
    layer0Period: 2000,
    layer0Level: 100,
    /** 层1 编辑 */
    layer1Type: NO_EFFECT,
    layer1Hue: 0,
    layer1Sat: 0,
    layer1Period: 0,
    layer1Level: 0,
    /** 每层各自的 picker 选项（value 是协议 type），底层不含空层 */
    layer0Options: LAYER0_OPTIONS,
    layer1Options: LAYER1_OPTIONS,
    /** 每层字段可见性（wxml 条件渲染与 L4 断言共用） */
    layer0Fields: layerFieldVisibility(EFFECT_TYPE.STATIC),
    layer1Fields: layerFieldVisibility(NO_EFFECT),
    /** picker 的 value 是索引，type → 索引在这里换算 */
    layer0PickerIndex: pickerIndexForType(LAYER0_OPTIONS, EFFECT_TYPE.STATIC),
    layer1PickerIndex: pickerIndexForType(LAYER1_OPTIONS, NO_EFFECT),
    layer0Label: effectLabel(EFFECT_TYPE.STATIC),
    layer1Label: effectLabel(NO_EFFECT),
    /** 发送前校验的字段级错误；非空时阻止发送并在页面内联展示 */
    layerErrors: [] as Array<{ field: string; message: string }>,
    loopOptions: LOOP_OPTIONS,
    /** 消息 */
    hint: "",
    loading: true,
    /** 总时长 */
    totalMs: 0,
  },

  onLoad(query: Record<string, string>) {
    const sceneId = parseInt(query.sceneId ?? "0", 10);
    this.setData({ sceneId: Number.isFinite(sceneId) ? sceneId : 0 });
    this.loadScene();
  },

  async loadScene() {
    const session = getSession();
    const state = session.deviceState;
    if (!state) {
      this.setData({ hint: "未连接设备", loading: false });
      return;
    }
    // 查询场景
    const result = await session.queryScene(this.data.sceneId);
    if (result.kind !== "ok") {
      this.setData({ hint: `场景加载失败：${result.kind === "error" ? result.message : result.kind}`, loading: false });
      return;
    }
    const scene = result.scene;
    this.setData({ sceneName: scene.name });
    // 从布局读取部位列表
    const parts: Array<{ stripId: number; partId: number; name: string; stepCount: number; loop: number; on: boolean }> = [];
    for (let stripId = 0; stripId < (state.stripCount || 1); stripId += 1) {
      const partCount = state.partCounts[stripId] ?? 0;
      if (partCount <= 0) continue;
      const cached = session.layout[stripId];
      for (let partId = 0; partId < partCount; partId += 1) {
        const partName = cached?.parts?.find((p) => p.partId === partId)?.name || `部位 ${partId}`;
        const head = getPartHead(scene, stripId, partId);
        parts.push({
          stripId,
          partId,
          name: partName,
          stepCount: head?.stepCount ?? 0,
          loop: head?.loop ?? LOOP.ALL,
          on: head?.on ?? true,
        });
      }
    }
    if (parts.length === 0) {
      this.setData({ hint: "没有布局部位，请先在部位编辑器划分", loading: false });
      return;
    }
    const activeKey = `${parts[0].stripId}:${parts[0].partId}`;
    this.setData({ parts, activeKey, loading: false });
    this.loadSteps();
  },

  /** 用设备读回刷新编辑区；preferredIndex 超出范围时夹到有效下标。 */
  applySceneReadback(scene: SceneReport, preferredIndex: number) {
    const [stripId, partId] = this.data.activeKey.split(":").map(Number);
    const steps = getStepsForPart(scene, stripId, partId);
    const head = getPartHead(scene, stripId, partId);
    const decorated = steps.map((s) => ({
      ...s,
      layer0Label: formatLayer(s.layer0),
      layer1Label: formatLayer(s.layer1),
      durationLabel: formatDuration(s.durationMs),
    }));
    const index = Math.max(0, Math.min(preferredIndex, decorated.length - 1));
    const parts = this.data.parts.map((part: ScenePartRow) => {
      const partHead = getPartHead(scene, part.stripId, part.partId);
      return {
        ...part,
        stepCount: partHead?.stepCount ?? 0,
        loop: partHead?.loop ?? part.loop,
        on: partHead?.on ?? part.on,
      };
    });
    this.setData({
      steps: decorated,
      totalMs: totalDuration(steps),
      parts,
      loop: head?.loop ?? this.data.loop,
      activeStepIndex: index,
    });
    if (decorated.length > 0) {
      this.loadStepIntoEditor(decorated[index]);
    } else {
      this.loadStepIntoEditor(null);
    }
  },

  /** 从设备重新读回时间轴；默认保持当前编辑步。 */
  async loadSteps(preferredIndex?: number): Promise<boolean> {
    const result = await getSession().queryScene(this.data.sceneId);
    if (result.kind !== "ok") {
      const reason = result.kind === "error" ? result.message : "连接已切换";
      this.setData({ hint: `读取场景失败：${reason}`, loading: false });
      return false;
    }
    this.applySceneReadback(result.scene, preferredIndex ?? this.data.activeStepIndex);
    this.setData({ loading: false });
    return true;
  },

  loadStepIntoEditor(step: SceneStep | null) {
    const l0 = step
      ? (step.layer0.type === NO_EFFECT
          ? switchEffectType(step.layer0, EFFECT_TYPE.STATIC, false)
          : normalizeLayer(step.layer0))
      : createStaticLayer(0, 255, 100);
    const l1 = step ? normalizeLayer(step.layer1) : { ...EMPTY_EFFECT };
    this.setData({ editingStep: step, durationMs: step ? step.durationMs : 1000 });
    this.applyLayerEdit(0, l0);
    this.applyLayerEdit(1, l1);
  },

  /** 把一层写回编辑区：值、picker 索引、标签、可见性一次到位。 */
  applyLayerEdit(which: 0 | 1, layer: EffectLayer) {
    const options = which === 0 ? LAYER0_OPTIONS : LAYER1_OPTIONS;
    const visible = layerFieldVisibility(layer.type);
    const pickerIndex = pickerIndexForType(options, layer.type);
    const label = effectLabel(layer.type);
    if (which === 0) {
      this.setData({
        layer0Type: layer.type,
        layer0Hue: layer.hue, layer0Sat: layer.sat,
        layer0Period: layer.periodMs, layer0Level: layer.level,
        layer0Fields: visible, layer0PickerIndex: pickerIndex, layer0Label: label,
      });
      return;
    }
    this.setData({
      layer1Type: layer.type,
      layer1Hue: layer.hue, layer1Sat: layer.sat,
      layer1Period: layer.periodMs, layer1Level: layer.level,
      layer1Fields: visible, layer1PickerIndex: pickerIndex, layer1Label: label,
    });
  },

  editorLayer(which: 0 | 1): EffectLayer {
    const data = this.data as ScenePageData;
    if (which === 0) {
      return {
        type: data.layer0Type,
        hue: data.layer0Hue, sat: data.layer0Sat,
        periodMs: data.layer0Period, p5: 0, flags: 0, level: data.layer0Level,
      };
    }
    return {
      type: data.layer1Type,
      hue: data.layer1Hue, sat: data.layer1Sat,
      periodMs: data.layer1Period, p5: 0, flags: 0, level: data.layer1Level,
    };
  },

  /** 切换部位：按决策 5 选中第 1 步。 */
  onPartTap(e: any) {
    const key = `${e.currentTarget.dataset.strip}:${e.currentTarget.dataset.part}`;
    this.setData({ activeKey: key });
    void this.loadSteps(0);
  },

  /** 切换步骤。 */
  onStepTap(e: any) {
    const index = e.currentTarget.dataset.index as number;
    const steps = this.data.steps;
    if (index < 0 || index >= steps.length) return;
    this.setData({ activeStepIndex: index });
    this.loadStepIntoEditor(steps[index]);
  },

  /** 执行一次写计划并刷新页面；选中策略由调用方给出。 */
  async runTimeline(
    op: TimelineOperation,
    preferredIndex: (outcome: TimelineWriteOutcome) => number,
  ): Promise<void> {
    const [stripId, partId] = this.data.activeKey.split(":").map(Number);
    const outcome = await runTimelineWrite(getSession(), this.data.sceneId, stripId, partId, op);
    if (outcome.scene) {
      this.applySceneReadback(outcome.scene, preferredIndex(outcome));
    }
    this.setData({ hint: outcome.message });
  },

  /** 添加步骤：新步默认 1000ms，完成后选中新的最后一步。 */
  async onAddStep(): Promise<void> {
    const [stripId, partId] = this.data.activeKey.split(":").map(Number);
    const newStep = createEmptyStep(this.data.sceneId, stripId, partId, 0);
    newStep.durationMs = 1000;
    newStep.layer0 = createStaticLayer(0, 255, 100);
    await this.runTimeline(
      { kind: "add", newStep },
      (outcome: TimelineWriteOutcome) => outcome.failedStepIndex ?? outcome.steps.length - 1,
    );
  },

  /** 删除最后一步：选中 min(当前步, 新步数−1)。 */
  async onDeleteLastStep(): Promise<void> {
    await this.runTimeline(
      { kind: "deleteLast" },
      (outcome: TimelineWriteOutcome) => Math.min(this.data.activeStepIndex, outcome.steps.length - 1),
    );
  },

  /** 循环模式切换：只改 loop，不重写任何步骤。 */
  async onLoopChange(e: any): Promise<void> {
    await this.runTimeline(
      { kind: "loop", loop: e.detail.value as number },
      () => this.data.activeStepIndex,
    );
  },

  /** 时长输入。 */
  onDurationInput(e: any) {
    const ms = parseInt(e.detail.value, 10);
    this.setData({ durationMs: Number.isFinite(ms) ? ms : 0 });
  },

  /** 保存当前步骤：成功后按读回刷新，并保持当前编辑步。 */
  async onSaveStep(): Promise<void> {
    const [stripId, partId] = this.data.activeKey.split(":").map(Number);
    const session = getSession();
    const stepIndex = this.data.activeStepIndex;
    const err = validateDuration(this.data.durationMs);
    if (err) { this.setData({ hint: err }); return; }
    const layer0 = normalizeLayer(this.editorLayer(0));
    const layer1 = normalizeLayer(this.editorLayer(1));
    const bad0 = validateLayerForSend(layer0, { isOverlay: false });
    const bad1 = validateLayerForSend(layer1, { isOverlay: true });
    if (!bad0.ok || !bad1.ok) {
      this.setData({
        layerErrors: [...bad0.errors, ...bad1.errors],
        hint: `参数不合法，未发送：${bad0.firstError || bad1.firstError}`,
      });
      return;
    }
    this.setData({ layerErrors: [] });
    const step: SceneStep = {
      sceneId: this.data.sceneId,
      stripId,
      partId,
      stepIndex,
      durationMs: this.data.durationMs,
      layer0,
      layer1,
    };
    const result = await session.sceneStep(this.data.sceneId, stripId, partId, stepIndex, step);
    if (result.kind !== "ok") {
      this.setData({ hint: `保存失败：${editFailureText(result)}` });
      return;
    }
    this.applyLayerEdit(0, layer0);
    this.applyLayerEdit(1, layer1);
    const readbackOk = await this.loadSteps(this.data.activeStepIndex);
    this.setData({
      hint: readbackOk
        ? `步骤 ${stepIndex + 1} 已保存`
        : `步骤 ${stepIndex + 1} 已保存，但读回失败，请重连查看设备实际状态`,
    });
  },

  /** 场景名输入。 */
  onSceneNameInput(e: any) {
    const name = e.detail.value as string;
    this.setData({ sceneName: name });
  },

  /** 保存场景名。 */
  onSaveSceneName() {
    const session = getSession();
    void session.sceneName(this.data.sceneId, this.data.sceneName).then((r) => {
      if (r.kind === "ok") {
        this.setData({ hint: "场景名已保存" });
      } else {
        this.setData({ hint: `保存失败：${editFailureText(r)}` });
      }
    });
  },

  /** 激活当前场景。 */
  onActivateTap() {
    const session = getSession();
    void session.activateScene(this.data.sceneId).then((r) => {
      if (r.kind === "ok") {
        this.setData({ hint: `场景 ${this.data.sceneId + 1} 已激活` });
      } else {
        this.setData({ hint: `激活失败：${editFailureText(r)}` });
      }
    });
  },

  /** 层0 类型切换：change 只做下标 → 协议 type，再按新类型归一化。 */
  onLayer0TypeChange(e: any) {
    const type = pickerIndexToType(LAYER0_OPTIONS, Number(e.detail.value));
    this.setData({ layerErrors: [] });
    this.applyLayerEdit(0, switchEffectType(this.editorLayer(0), type, false));
  },
  onLayer0HueInput(e: any) { this.setData({ layer0Hue: parseInt(e.detail.value, 10) || 0, layerErrors: [] }); },
  onLayer0SatInput(e: any) { this.setData({ layer0Sat: parseInt(e.detail.value, 10) || 0, layerErrors: [] }); },
  onLayer0PeriodInput(e: any) { this.setData({ layer0Period: parseInt(e.detail.value, 10) || 0, layerErrors: [] }); },
  onLayer0LevelInput(e: any) { this.setData({ layer0Level: parseInt(e.detail.value, 10) || 0, layerErrors: [] }); },

  /** 层1 类型切换：从空层切到真实效果时补默认亮度 50。 */
  onLayer1TypeChange(e: any) {
    const type = pickerIndexToType(LAYER1_OPTIONS, Number(e.detail.value));
    this.setData({ layerErrors: [] });
    this.applyLayerEdit(1, switchEffectType(this.editorLayer(1), type, true));
  },
  onLayer1HueInput(e: any) { this.setData({ layer1Hue: parseInt(e.detail.value, 10) || 0, layerErrors: [] }); },
  onLayer1SatInput(e: any) { this.setData({ layer1Sat: parseInt(e.detail.value, 10) || 0, layerErrors: [] }); },
  onLayer1PeriodInput(e: any) { this.setData({ layer1Period: parseInt(e.detail.value, 10) || 0, layerErrors: [] }); },
  onLayer1LevelInput(e: any) { this.setData({ layer1Level: parseInt(e.detail.value, 10) || 0, layerErrors: [] }); },
});