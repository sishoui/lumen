/** 设备页（tab）：扫描 LUMEN- 设备 + 点卡连接 + 演示模式开关。 */

import { getSession, rebuildSessionForCurrentMockMode } from "../../utils/session/singleton";
import { LinkSubscription } from "../../utils/session/link-subscription";
import { mockModeEnabled, setMockMode, createWxStorage } from "../../utils/mock/mock-mode";
import type { DiscoveredDevice } from "../../utils/protocol/types";

const STATUS_TEXT: Record<string, string> = {
  idle: "未连接",
  connecting: "连接中…",
  ready: "已连接",
  reconnecting: "重连中…",
  failed: "未连接（点击设备重试）",
};

Page({
  data: {
    devices: [] as Array<DiscoveredDevice & { _index: number }>,
    scanning: false,
    linkState: "idle",
    statusText: STATUS_TEXT.idle,
    currentDeviceId: "" as string,
    mockMode: true,
  },

  onLoad() {
    const storage = createWxStorage();
    this.setData({ mockMode: mockModeEnabled(storage) });
    this.bindLinkState();
  },

  onShow() {
    getSession().onShow();
  },

  /** 订阅当前会话的链路状态变化。重复调用先解绑旧订阅；模式切换后须重新绑定。 */
  bindLinkState() {
    const session = getSession();
    const transport = session.transportRef;
    const update = () => {
      const state = session.linkState;
      this.setData({
        linkState: state,
        statusText: STATUS_TEXT[state] ?? state,
        currentDeviceId: transport.currentDeviceId ?? "",
      });
    };
    update();
    this._linkSub.bind(transport, () => update());
  },

  onUnload() {
    this._linkSub.unbind();
  },

  onScanTap() {
    const session = getSession();
    if (this.data.scanning) {
      session.stopScan();
      this.setData({ scanning: false });
      return;
    }
    this.setData({ devices: [], scanning: true });
    // 注：以前这里用 this.setData((prev) => ...) 的函数式写法，微信开发者工具
    // 在 scan 回调里调 setData(fn) 会报错（"setData is not a function" 或被当成
    // 普通对象传入），导致设备列表永远清掉后填不回来。改成命令式：先把设备
    // 追加到本地数组，再一次性 setData。扫描回调里现算 prev 的语义由闭包变量
    // 承担，行为等价且兼容真机。
    const found: Array<DiscoveredDevice & { _index: number }> = [];
    void session
      .startScan((device) => {
        const exists = found.some((d) => d.deviceId === device.deviceId);
        if (exists) return;
        found.push(device);
        this.setData({ devices: found.slice() });
      })
      .catch((err) => {
        console.error("[device] 扫描失败", err);
        this.setData({ scanning: false });
      });
  },

  onDeviceTap(e: any) {
    const index = e.currentTarget.dataset.index as number;
    const device = this.data.devices[index];
    if (!device) return;
    const session = getSession();
    this.setData({ statusText: "连接中…" });
    void session
      .connect(device.deviceId, device.name)
      .then(() => {
        this.setData({ statusText: "已连接", linkState: "ready", currentDeviceId: device.deviceId });
        wx.switchTab({ url: "/pages/control/control" });
      })
      .catch((err) => {
        console.error("[device] 连接失败", err);
        this.setData({ statusText: "连接失败" });
      });
  },

  onMockModeChange(e: any) {
    const enabled = e.detail.value as boolean;
    setMockMode(createWxStorage(), enabled);
    this.setData({ mockMode: enabled });

    // 开关即时生效：按新偏好重建会话（旧会话销毁、transport 换成另一种实现）。
    // 设备列表清空并重订阅新会话的链路状态，用户重新点「扫描设备」即可看到
    // 演示模式的 3 台虚拟设备（或真实模式下的 BLE 扫描结果）。
    const rebuilt = rebuildSessionForCurrentMockMode();
    this.bindLinkState();
    this.setData({ devices: [], scanning: false });
    wx.showToast({
      title: rebuilt
        ? (enabled ? "已切换演示模式" : "已切换真实模式")
        : "已设置（重启生效）",
      icon: "none",
    });
  },

  _linkSub: new LinkSubscription(),
});