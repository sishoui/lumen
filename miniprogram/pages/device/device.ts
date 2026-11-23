/** 设备页（tab）：扫描 LUMEN- 设备 + 点卡连接 + 演示模式开关。 */

import { getSession, rebuildSessionForCurrentMockMode } from "../../utils/session/singleton";
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

  /** 订阅当前会话的链路状态变化。重建会话后须重新调用。 */
  bindLinkState() {
    const session = getSession();
    const transport = session.transportRef;
    const update = () => {
      const state = session.linkState;
      this.setData({
        linkState: state,
        statusText: STATUS_TEXT[state] ?? state,
        currentDeviceId: transport?.currentDeviceId ?? "",
      });
    };
    update();
    transport?.onLinkChange?.(() => update());
  },

  onScanTap() {
    const session = getSession();
    if (this.data.scanning) {
      session.stopScan();
      this.setData({ scanning: false });
      return;
    }
    this.setData({ devices: [], scanning: true });
    void session
      .startScan((device) => {
        this.setData((prev: any) => {
          const exists = prev.devices.some((d: DiscoveredDevice) => d.deviceId === device.deviceId);
          if (exists) return prev;
          return { devices: [...prev.devices, device] };
        });
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
});