/** 控制页（tab）：整机开关 / 亮度滑块 / 每链开关与灯珠数 / 场景切换 / 自检 / 版本号×5 日志入口。 */

import { getSession } from "../../utils/session/singleton";
import { TapSequence } from "../../utils/ble/log-panel";
import { ledCountLimit, planLedCountSet } from "../../utils/led-count";
import { sceneCountLimit, sceneOptions, sceneSelection, sceneOptionClass } from "../../utils/scene-select";
import type { SceneOption } from "../../utils/scene-select";
import { MAX_LEDS } from "../../utils/protocol/constants";
import { describeCommandFailure } from "../../utils/feedback";

/** 控制页每链行的数据形态；ledDraft 是输入框文本，ledCount 是设备读回值。 */
interface StripRow {
  stripId: number;
  ledCount: number;
  ledDraft: string;
  on: boolean;
}

Page({
  data: {
    state: null as any,
    /** 每链行：提交成功后 ledDraft 按设备读回值重置。 */
    stripRows: [] as StripRow[],
    /** 单链灯珠数上限（DeviceInfoReport.maxLeds，缺失回退协议常量）。 */
    maxLeds: MAX_LEDS,
    /** 场景选择卡：选项来自设备能力 maxScenes（缺失回退协议常量）。 */
    sceneOptions: [] as Array<SceneOption & { active: boolean; cls: string }>,
    /** 当前选中的场景（0 基）；选中态与激活态分开。 */
    selectedSceneId: 0,
    /** 当前激活场景（State.activeScene）；-1 表示未知。 */
    activeSceneId: -1,
    hint: "",
    firmwareVersion: "—",
    logVisible: false,
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    getSession().onShow();
    this.setData({ hint: "" });
    this.refresh();
  },

  refresh() {
    const session = getSession();
    const state = session.deviceState;
    if (!state) {
      this.setData({ state: null, stripRows: [] });
      return;
    }
    const stripRows = [];
    for (let i = 0; i < state.stripCount; i += 1) {
      const ledCount = state.stripLedCounts[i] ?? 0;
      stripRows.push({
        stripId: i,
        ledCount,
        ledDraft: String(ledCount),
        on: (state.stripPowerMask & (1 << i)) !== 0,
      });
    }
    const info = session.deviceInfo;
    this.applySceneSelection();
    this.setData({
      state,
      stripRows,
      maxLeds: ledCountLimit(info),
      firmwareVersion: info ? `${info.firmwareMajor}.${info.firmwareMinor}` : "—",
    });
  },

  /** 场景卡按设备能力重算；选择落在能力外时夹到最后一个可用场景。 */
  applySceneSelection() {
    const maxScenes = sceneCountLimit(getSession().deviceInfo);
    const state = getSession().deviceState;
    const selection = sceneSelection(
      maxScenes,
      this.data.selectedSceneId,
      state ? state.activeScene : -1,
    );
    const cards = sceneOptions(maxScenes).map((option) => ({
      ...option,
      active: option.id === selection.activeSceneId,
      cls: sceneOptionClass(option.id, selection),
    }));
    this.setData({
      sceneOptions: cards,
      selectedSceneId: selection.selectedSceneId,
      activeSceneId: selection.activeSceneId,
    });
  },

  onPowerChange(e: any) {
    const on = e.detail.value as boolean;
    void getSession().setPower(on).then((result) => {
      if (result.kind === "ok") {
        this.setData({ hint: "" });
        this.refresh();
        return;
      }
      // 离散命令：失败必须可见（结果码中文 + 动作），并刷新 State 反映设备真实值。
      this.refresh();
      this.setData({ hint: describeCommandFailure(result, "开机") });
    });
  },

  onBrightnessChanging(e: any) {
    getSession().setBrightness(e.detail.value as number);
    // 立即反映到页面 state（乐观更新，设备值由后续 ACK readState 校正）
    this.refresh();
  },

  onBrightnessChange(e: any) {
    getSession().setBrightness(e.detail.value as number);
    getSession().flushBrightness();
    this.refresh();
  },

  onStripPowerChange(e: any) {
    const stripId = e.currentTarget.dataset.strip as number;
    const on = e.detail.value as boolean;
    void getSession().setStripPower(stripId, on).then((result) => {
      if (result.kind === "ok") {
        this.setData({ hint: "" });
        this.refresh();
        return;
      }
      // 离散命令：标明链号，用户知道是哪条链没生效。
      this.refresh();
      this.setData({ hint: describeCommandFailure(result, `链 ${stripId} ${on ? "开" : "关"}电`) });
    });
  },

  /* ---------------- 每链灯珠数（#25） ---------------- */

  onLedCountInput(e: any) {
    const stripId = e.currentTarget.dataset.strip as number;
    this.setRowDraft(stripId, String(e.detail.value ?? ""));
  },

  /** 失焦提交：越界在发送前拦截；合法值走 SetLedCount，成功后按 State 读回刷新。 */
  onLedCountBlur(e: any) {
    void this.commitLedCount(e.currentTarget.dataset.strip as number);
  },

  /** 键盘确认提交（部分平台确认后会再触发 blur，由 pending 守卫去重）。 */
  onLedCountConfirm(e: any) {
    void this.commitLedCount(e.currentTarget.dataset.strip as number);
  },

  setRowDraft(stripId: number, text: string) {
    const stripRows = this.data.stripRows.map((row: StripRow) => (
      row.stripId === stripId ? { ...row, ledDraft: text } : row
    ));
    this.setData({ stripRows });
  },

  async commitLedCount(stripId: number): Promise<void> {
    if (this._ledPending) return;
    const row = this.data.stripRows.find((r: StripRow) => r.stripId === stripId);
    if (!row) return;
    const plan = planLedCountSet(row.ledDraft, row.ledCount, this.data.maxLeds);
    if (plan.kind === "reject") {
      // 发送前拦截：提示含上限，输入框恢复显示设备当前值
      this.setRowDraft(stripId, String(row.ledCount));
      this.setData({ hint: `${plan.reason}，当前 ${row.ledCount} 颗` });
      return;
    }
    if (plan.kind === "noop") {
      // 没改动不发命令
      this.setRowDraft(stripId, String(row.ledCount));
      return;
    }
    this._ledPending = true;
    try {
      const result = await getSession().setLedCount(stripId, plan.value);
      if (result.kind === "ok") {
        this.refresh();
        const readback = getSession().deviceState?.stripLedCounts[stripId];
        this.setData({
          hint: readback === plan.value
            ? `链 ${stripId} 灯珠数已设为 ${readback} 颗`
            : `链 ${stripId} 请求 ${plan.value} 颗，读回 ${readback} 颗`,
        });
        return;
      }
      // 失败：恢复显示设备当前值，结果码给中文原因（Busy 已由会话层重试一次）
      this.refresh();
      this.setData({ hint: describeCommandFailure(result, `链 ${stripId} 设置灯珠数`) });
    } finally {
      this._ledPending = false;
    }
  },

  /* ---------------- 链选择：点链行进该链的部位编辑器 ---------------- */

  /* ---------------- 场景选择与激活（#30） ---------------- */

  /** 点场景卡：只改选中态，不触发任何命令。 */
  onSceneSelectTap(e: any) {
    const sceneId = Number(e?.currentTarget?.dataset?.scene as number);
    if (!Number.isInteger(sceneId) || sceneId < 0) return;
    const selection = sceneSelection(
      sceneCountLimit(getSession().deviceInfo),
      sceneId,
      this.data.activeSceneId,
    );
    this.setData({
      selectedSceneId: selection.selectedSceneId,
      sceneOptions: this.data.sceneOptions.map((card: SceneOption & { active: boolean; cls: string }) => ({
        ...card,
        cls: sceneOptionClass(card.id, selection),
      })),
    });
  },

  /** 编辑选中的场景：把选择带进编辑器。 */
  onSceneEditorTap() {
    wx.navigateTo({ url: `/pages/scene/scene?sceneId=${this.data.selectedSceneId}` });
  },

  /** 激活选中的场景：成功后刷新 State，高亮随读回的 activeScene 移动。 */
  onActivateSceneTap() {
    const sceneId = this.data.selectedSceneId;
    void getSession().activateScene(sceneId).then((r) => {
      if (r.kind === "ok") {
        this.refresh();
        const readback = getSession().deviceState?.activeScene;
        const readbackHint = readback == null
          ? "，未能读回设备状态"
          : (readback === sceneId ? "" : `，设备当前激活 ${readback + 1}`);
        this.setData({ hint: `场景 ${sceneId + 1} 已激活${readbackHint}` });
        return;
      }
      this.refresh();
      this.setData({ hint: describeCommandFailure(r, `激活场景 ${sceneId + 1}`) });
    });
  },

  onPartEditorTap(e: any) {
    const stripId = Number(e?.currentTarget?.dataset?.strip ?? 0);
    wx.navigateTo({ url: `/pages/part/part?stripId=${stripId}` });
  },

  onSelfTestTap() {
    // 离散命令：立即告诉用户命令已发出（红→绿→蓝→白），失败再给原因。
    this.setData({ hint: "自检已开始（红→绿→蓝→白）" });
    void getSession().selfTest().then((result) => {
      if (result.kind === "ok") {
        this.setData({ hint: "自检已开始（红→绿→蓝→白）" });
        return;
      }
      this.refresh();
      this.setData({ hint: describeCommandFailure(result, "自检") });
    });
  },

  /** 占位：给 catchtap 用，阻止链行内的输入/开关点击冒泡触发导航。 */
  noop() {
    // 有意空实现
  },

  onVersionTap() {
    if (!this._tapSeq) this._tapSeq = new TapSequence(5, 2000);
    if (this._tapSeq.tap(Date.now())) {
      this.setData({ logVisible: true });
      this._tapSeq.reset();
    }
  },

  _tapSeq: null as TapSequence | null,
  /** 灯珠数提交在途守卫：blur 与 confirm 双触发时只发一条命令。 */
  _ledPending: false,
});