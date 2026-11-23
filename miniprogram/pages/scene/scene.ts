/** 场景编辑器（时间轴）：每部位时间轴 + 步骤 + 两层灯效 + 循环模式。 */

import { getSession } from "../../utils/session/singleton";
import {
  EFFECT_NAMES, LOOP_NAMES, PHASE_NAMES,
  formatDuration, formatLayer,
  validateDuration, validateLoop, validateStepCount,
  getStepsForPart, getPartHead, maxStepCount, totalDuration,
  createEmptyStep, createStaticLayer,
  isLayerEmpty,
} from "../../utils/scene-editor";
import { LOOP, EFFECT_TYPE, NO_EFFECT, MAX_STEPS, MAX_SCENES } from "../../utils/protocol/constants";
import type { SceneStep, EffectLayer } from "../../utils/protocol/types";

const EFFECT_OPTIONS = [
  { value: EFFECT_TYPE.STATIC, label: "静态" },
  { value: EFFECT_TYPE.BREATHING, label: "呼吸" },
  { value: EFFECT_TYPE.RAINBOW, label: "彩虹" },
  { value: EFFECT_TYPE.COMET, label: "流光" },
  { value: EFFECT_TYPE.STROBE, label: "爆闪" },
  { value: EFFECT_TYPE.HEARTBEAT, label: "心跳" },
  { value: EFFECT_TYPE.OFF, label: "熄灭" },
  { value: EFFECT_TYPE.FLICKER, label: "随机" },
  { value: NO_EFFECT, label: "空层" },
];

const LOOP_OPTIONS = [
  { value: LOOP.NONE, label: "不循环" },
  { value: LOOP.ALL, label: "全部循环" },
  { value: LOOP.LAST, label: "末步循环" },
];

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
    /** 效果选项 */
    effectOptions: EFFECT_OPTIONS,
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
    if (!step) {
      this.setData({
        editingStep: null,
        durationMs: 1000,
        layer0Type: EFFECT_TYPE.STATIC,
        layer0Hue: 0, layer0Sat: 255, layer0Period: 2000, layer0Level: 100,
        layer1Type: NO_EFFECT,
        layer1Hue: 0, layer1Sat: 0, layer1Period: 0, layer1Level: 0,
      });
      return;
    }
    const l0 = step.layer0;
    const l1 = step.layer1;
    this.setData({
      editingStep: step,
      durationMs: step.durationMs,
      layer0Type: l0.type,
      layer0Hue: l0.hue, layer0Sat: l0.sat,
      layer0Period: l0.periodMs, layer0Level: l0.level,
      layer1Type: l1.type,
      layer1Hue: l1.hue, layer1Sat: l1.sat,
      layer1Period: l1.periodMs, layer1Level: l1.level,
    });
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
        this.setData({ hint: `更新步数失败：${r.kind}` });
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
          this.setData({ hint: `写步骤失败：${sr.kind}` });
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
        this.setData({ hint: `删除失败：${r.kind}` });
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
        this.setData({ hint: `更新失败：${r.kind}` });
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
    const step: SceneStep = {
      sceneId: this.data.sceneId,
      stripId,
      partId,
      stepIndex,
      durationMs: this.data.durationMs,
      layer0: {
        type: this.data.layer0Type,
        hue: this.data.layer0Hue,
        sat: this.data.layer0Sat,
        periodMs: this.data.layer0Period,
        p5: 0,
        flags: 0,
        level: this.data.layer0Level,
      },
      layer1: this.data.layer1Type === NO_EFFECT
        ? { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 }
        : {
            type: this.data.layer1Type,
            hue: this.data.layer1Hue,
            sat: this.data.layer1Sat,
            periodMs: this.data.layer1Period,
            p5: 0,
            flags: 0,
            level: this.data.layer1Level,
          },
    };
    void session.sceneStep(this.data.sceneId, stripId, partId, stepIndex, step).then((r) => {
      if (r.kind === "ok") {
        this.setData({ hint: `步骤 ${stepIndex + 1} 已保存` });
        this.loadSteps();
      } else {
        this.setData({ hint: `保存失败：${r.kind}` });
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
        this.setData({ hint: `保存失败：${r.kind}` });
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
        this.setData({ hint: `激活失败：${r.kind}` });
      }
    });
  },

  /** 层0 类型切换。 */
  onLayer0TypeChange(e: any) {
    this.setData({ layer0Type: e.detail.value });
  },
  onLayer0HueInput(e: any) { this.setData({ layer0Hue: parseInt(e.detail.value, 10) || 0 }); },
  onLayer0SatInput(e: any) { this.setData({ layer0Sat: parseInt(e.detail.value, 10) || 0 }); },
  onLayer0PeriodInput(e: any) { this.setData({ layer0Period: parseInt(e.detail.value, 10) || 0 }); },
  onLayer0LevelInput(e: any) { this.setData({ layer0Level: parseInt(e.detail.value, 10) || 0 }); },

  /** 层1 类型切换。 */
  onLayer1TypeChange(e: any) {
    this.setData({ layer1Type: e.detail.value });
  },
  onLayer1HueInput(e: any) { this.setData({ layer1Hue: parseInt(e.detail.value, 10) || 0 }); },
  onLayer1SatInput(e: any) { this.setData({ layer1Sat: parseInt(e.detail.value, 10) || 0 }); },
  onLayer1PeriodInput(e: any) { this.setData({ layer1Period: parseInt(e.detail.value, 10) || 0 }); },
  onLayer1LevelInput(e: any) { this.setData({ layer1Level: parseInt(e.detail.value, 10) || 0 }); },
});