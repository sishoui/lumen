/** 控制页（tab）：整机开关 / 亮度滑块 / 每链开关与灯珠数 / 场景切换 / 自检 / 版本号×5 日志入口。 */

import { getSession } from "../../utils/session/singleton";
import { TapSequence } from "../../utils/ble/log-panel";
import { ledCountLimit, planLedCountSet } from "../../utils/led-count";
import { MAX_LEDS, resultName } from "../../utils/protocol/constants";

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
    this.setData({
      state,
      stripRows,
      maxLeds: ledCountLimit(info),
      firmwareVersion: info ? `${info.firmwareMajor}.${info.firmwareMinor}` : "—",
    });
  },

  onPowerChange(e: any) {
    const on = e.detail.value as boolean;
    void getSession().setPower(on).then(() => this.refresh());
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
    void getSession().setStripPower(stripId, on).then(() => this.refresh());
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
      if (result.kind === "ack-error") {
        this.setData({ hint: `链 ${stripId} 设置失败：${resultName(result.ack.resultCode)}` });
      } else if (result.kind === "stale") {
        this.setData({ hint: "连接已变化，请重试" });
      } else {
        this.setData({ hint: `链 ${stripId} 设置失败：${result.message}` });
      }
    } finally {
      this._ledPending = false;
    }
  },

  /* ---------------- 链选择：点链行进该链的部位编辑器 ---------------- */

  onPartEditorTap(e: any) {
    const stripId = Number(e?.currentTarget?.dataset?.strip ?? 0);
    wx.navigateTo({ url: `/pages/part/part?stripId=${stripId}` });
  },

  onSceneEditorTap() {
    wx.navigateTo({ url: "/pages/scene/scene?sceneId=0" });
  },

  onSelfTestTap() {
    void getSession().selfTest();
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