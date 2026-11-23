/** 场景编辑器（时间轴）：每部位时间轴 + 步骤 + 两层灯效 + 循环模式。 */

import { getSession } from "../../utils/session/singleton";
import {
  formatDuration, formatLayer, effectLabel,
  layerPickerOptions, pickerIndexToType, pickerIndexForType, layerFieldVisibility,
  normalizeLayer, switchEffectType,
  validateDuration,
  getStepsForPart, getPartHead, totalDuration,
  createEmptyStep, createStaticLayer,
} from "../../utils/scene-editor";
import type { LayerPickerOption, LayerFieldVisibility } from "../../utils/scene-editor";
import { LOOP, EFFECT_TYPE, NO_EFFECT, MAX_STEPS, resultName } from "../../utils/protocol/constants";
import { EMPTY_EFFECT } from "../../utils/protocol/types";
import type { SceneStep, EffectLayer } from "../../utils/protocol/types";
import type { EditResult } from "../../utils/session/session";

const LAYER0_OPTIONS = layerPickerOptions(false);
const LAYER1_OPTIONS = layerPickerOptions(true);

const LOOP_OPTIONS = [
  { value: LOOP.NONE, label: "不循环" },
  { value: LOOP.ALL, label: "全部循环" },
  { value: LOOP.LAST, label: "末步循环" },
];

/** 把设备/编码失败翻译成用户能判断「改参数还是重试」的文案。 */
function editFailureText(result: EditResult): string {
  if (result.kind === "ack-error") {
    return `结果码 ${result.ack.resultCode}（${resultName(result.ack.resultCode)}）`;
  }
  if (result.kind === "error") return result.message;
  if (result.kind === "storage") return `本地存储失败：${result.message}`;
  if (result.kind === "stale") return "连接已切换，请重试";
  return "未知原因";
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
    parts: [] as Array<{ stripId: number; partId: number; name: string; stepCount: number; loop: number; on: boolean }>,
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

  async loadSteps() {
    const session = getSession();
    const sceneRes = await session.queryScene(this.data.sceneId);
    const scene = sceneRes.kind === "ok" ? sceneRes.scene : session.scene;
    if (!scene) return;
    const [stripId, partId] = this.data.activeKey.split(":").map(Number);
    const steps = getStepsForPart(scene, stripId, partId);
    const head = getPartHead(scene, stripId, partId);
    const decorated = steps.map((s) => ({
      ...s,
      layer0Label: formatLayer(s.layer0),
      layer1Label: formatLayer(s.layer1),
      durationLabel: formatDuration(s.durationMs),
    }));
    const totalMs = totalDuration(steps);
    this.setData({
      steps: decorated,
      loop: head?.loop ?? LOOP.ALL,
      totalMs,
    });
    // 加载第一步到编辑器
    if (decorated.length > 0) {
      this.loadStepIntoEditor(decorated[0]);
      this.setData({ activeStepIndex: 0 });
    } else {
      this.loadStepIntoEditor(null);
    }
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

  /** 切换部位。 */
  onPartTap(e: any) {
    const key = `${e.currentTarget.dataset.strip}:${e.currentTarget.dataset.part}`;
    this.setData({ activeKey: key });
    this.loadSteps();
  },

  /** 切换步骤。 */
  onStepTap(e: any) {
    const index = e.currentTarget.dataset.index as number;
    const steps = this.data.steps;
    if (index < 0 || index >= steps.length) return;
    this.setData({ activeStepIndex: index });
    this.loadStepIntoEditor(steps[index]);
  },

  /** 添加步骤。 */
  onAddStep() {
    const [stripId, partId] = this.data.activeKey.split(":").map(Number);
    const session = getSession();
    const scene = session.scene;
    const currentCount = this.data.steps.length;
    if (currentCount >= MAX_STEPS) {
      this.setData({ hint: `步数已达上限 ${MAX_STEPS}` });
      return;
    }
    const stepIndex = currentCount;
    // 先更新 ScenePart 头（stepCount + 1）
    void session.scenePart(this.data.sceneId, stripId, partId, {
      stepCount: stepIndex + 1,
      loop: this.data.loop,
      on: true,
    }).then((r) => {
      if (r.kind !== "ok") {
        this.setData({ hint: `更新步数失败：${editFailureText(r)}` });
        return;
      }
      // 写步骤
      const step: SceneStep = createEmptyStep(this.data.sceneId, stripId, partId, stepIndex);
      step.durationMs = 1000;
      step.layer0 = createStaticLayer(0, 255, 100);
      void session.sceneStep(this.data.sceneId, stripId, partId, stepIndex, step).then((sr) => {
        if (sr.kind === "ok") {
          this.setData({ hint: `已添加步骤 ${stepIndex + 1}` });
          this.loadSteps();
        } else {
          this.setData({ hint: `写步骤失败：${editFailureText(sr)}` });
        }
      });
    });
  },

  /** 删除最后一步。 */
  onDeleteLastStep() {
    const [stripId, partId] = this.data.activeKey.split(":").map(Number);
    const session = getSession();
    const currentCount = this.data.steps.length;
    if (currentCount === 0) {
      this.setData({ hint: "没有可删除的步骤" });
      return;
    }
    const newCount = currentCount - 1;
    void session.scenePart(this.data.sceneId, stripId, partId, {
      stepCount: newCount,
      loop: this.data.loop,
      on: true,
    }).then((r) => {
      if (r.kind === "ok") {
        this.setData({ hint: `已删除步骤 ${currentCount}` });
        this.loadSteps();
      } else {
        this.setData({ hint: `删除失败：${editFailureText(r)}` });
      }
    });
  },

  /** 循环模式切换。 */
  onLoopChange(e: any) {
    const loop = e.detail.value as number;
    const [stripId, partId] = this.data.activeKey.split(":").map(Number);
    const session = getSession();
    void session.scenePart(this.data.sceneId, stripId, partId, {
      stepCount: this.data.steps.length,
      loop,
      on: true,
    }).then((r) => {
      if (r.kind === "ok") {
        this.setData({ loop, hint: "循环模式已更新" });
      } else {
        this.setData({ hint: `更新失败：${editFailureText(r)}` });
      }
    });
  },

  /** 时长输入。 */
  onDurationInput(e: any) {
    const ms = parseInt(e.detail.value, 10);
    this.setData({ durationMs: Number.isFinite(ms) ? ms : 0 });
  },

  /** 保存当前步骤。 */
  onSaveStep() {
    const [stripId, partId] = this.data.activeKey.split(":").map(Number);
    const session = getSession();
    const stepIndex = this.data.activeStepIndex;
    const err = validateDuration(this.data.durationMs);
    if (err) { this.setData({ hint: err }); return; }
    const layer0 = normalizeLayer(this.editorLayer(0));
    if (layer0.type === NO_EFFECT) {
      this.setData({ hint: "底层不能是空层" });
      return;
    }
    const layer1 = normalizeLayer(this.editorLayer(1));
    const step: SceneStep = {
      sceneId: this.data.sceneId,
      stripId,
      partId,
      stepIndex,
      durationMs: this.data.durationMs,
      layer0,
      layer1,
    };
    void session.sceneStep(this.data.sceneId, stripId, partId, stepIndex, step).then((r) => {
      if (r.kind === "ok") {
        this.applyLayerEdit(0, layer0);
        this.applyLayerEdit(1, layer1);
        this.setData({ hint: `步骤 ${stepIndex + 1} 已保存` });
        this.loadSteps();
      } else {
        this.setData({ hint: `保存失败：${editFailureText(r)}` });
      }
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
    this.applyLayerEdit(0, switchEffectType(this.editorLayer(0), type, false));
  },
  onLayer0HueInput(e: any) { this.setData({ layer0Hue: parseInt(e.detail.value, 10) || 0 }); },
  onLayer0SatInput(e: any) { this.setData({ layer0Sat: parseInt(e.detail.value, 10) || 0 }); },
  onLayer0PeriodInput(e: any) { this.setData({ layer0Period: parseInt(e.detail.value, 10) || 0 }); },
  onLayer0LevelInput(e: any) { this.setData({ layer0Level: parseInt(e.detail.value, 10) || 0 }); },

  /** 层1 类型切换：从空层切到真实效果时补默认亮度 50。 */
  onLayer1TypeChange(e: any) {
    const type = pickerIndexToType(LAYER1_OPTIONS, Number(e.detail.value));
    this.applyLayerEdit(1, switchEffectType(this.editorLayer(1), type, true));
  },
  onLayer1HueInput(e: any) { this.setData({ layer1Hue: parseInt(e.detail.value, 10) || 0 }); },
  onLayer1SatInput(e: any) { this.setData({ layer1Sat: parseInt(e.detail.value, 10) || 0 }); },
  onLayer1PeriodInput(e: any) { this.setData({ layer1Period: parseInt(e.detail.value, 10) || 0 }); },
  onLayer1LevelInput(e: any) { this.setData({ layer1Level: parseInt(e.detail.value, 10) || 0 }); },
});