/** 控制页（tab）：整机开关 / 亮度滑块 / 每链开关 / 场景切换 / 自检 / 版本号×5 日志入口。 */

import { getSession } from "../../utils/session/singleton";
import { TapSequence } from "../../utils/ble/log-panel";

Page({
  data: {
    state: null as any,
    stripRows: [] as Array<{ stripId: number; ledCount: number; on: boolean }>,
    firmwareVersion: "—",
    logVisible: false,
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    getSession().onShow();
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
      stripRows.push({
        stripId: i,
        ledCount: state.stripLedCounts[i] ?? 0,
        on: (state.stripPowerMask & (1 << i)) !== 0,
      });
    }
    const info = session.deviceInfo;
    this.setData({
      state,
      stripRows,
      firmwareVersion: info ? `${info.firmwareMajor}.${info.firmwareMinor}` : "—",
    });
  },

  onPowerChange(e: any) {
    const on = e.detail.value as boolean;
    void getSession().setPower(on).then(() => this.refresh());
  },

  onBrightnessChanging(e: any) {
    getSession().setBrightness(e.detail.value as number);
  },

  onBrightnessChange(e: any) {
    getSession().setBrightness(e.detail.value as number);
    getSession().flushBrightness();
  },

  onStripPowerChange(e: any) {
    const stripId = e.currentTarget.dataset.strip as number;
    const on = e.detail.value as boolean;
    void getSession().setStripPower(stripId, on).then(() => this.refresh());
  },

  onPartEditorTap() {
    wx.navigateTo({ url: "/pages/part/part?stripId=0" });
  },

  onSceneEditorTap() {
    wx.navigateTo({ url: "/pages/scene/scene?sceneId=0" });
  },

  onSelfTestTap() {
    void getSession().selfTest();
  },

  onVersionTap() {
    if (!this._tapSeq) this._tapSeq = new TapSequence(5, 2000);
    if (this._tapSeq.tap(Date.now())) {
      this.setData({ logVisible: true });
      this._tapSeq.reset();
    }
  },

  _tapSeq: null as TapSequence | null,
});