/**
 * 演示模式生命周期（#33）：身份缓存 / 销毁顺序 / 模式切换 / 页面订阅。
 *
 * 断言的边界是用户与下游能看到的东西：storage 里的身份键、链路状态、
 * 回调次数、真实 BLE 的扫描与连接释放。不断言私有字段。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { ControlSession } from "../utils/session/session";
import { LinkSubscription } from "../utils/session/link-subscription";
import { MockTransport } from "../utils/ble/mock-transport";
import { BleTransport } from "../utils/ble/ble-transport";
import type { Transport } from "../utils/ble/transport";
import type { WxApi } from "../utils/ble/wx-api";
import { MOCK_DEVICES, DEVICE_CACHE_KEY } from "../utils/mock/mock-devices";
import { mockModeEnabled } from "../utils/mock/mock-mode";
import { loadCachedDevice } from "../utils/session/device-cache";
import { createMemoryStorage } from "./helpers/storage";
import { idleState } from "./helpers/scripted-transport";
import { encodeFrame, decodeFrame } from "../utils/protocol/frame";
import { cmdSceneName } from "../utils/protocol/commands";
import { CMD, DEVICE_CMD, RX_UUID, SERVICE_UUID, STATE_UUID, TX_UUID } from "../utils/protocol/constants";
import { MockDeviceRuntime } from "../utils/mock/mock-runtime";
import type {
  AdapterState, DeviceState, DiscoveredDevice, LinkState,
} from "../utils/protocol/types";

/** 让重建链（三段查询）跑完；每段只有微任务，没有真实计时器。 */
async function flushMicrotasks(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/**
 * 可控 Transport：计数、可选中继重建查询、可选「destroy 后仍保留监听」
 * 以模拟不守规矩的传输层，验证会话自己解绑。
 */
class ProbeTransport implements Transport {
  readonly persistsDeviceIdentity: boolean;
  private readonly autoRespond: boolean;
  private readonly keepListenersOnDestroy: boolean;

  destroyCount = 0;
  connectCalls = 0;
  scanning = false;
  onDestroy: (() => void) | null = null;

  private frameListeners: Array<(frame: Uint8Array) => void> = [];
  private linkListeners: Array<(state: LinkState) => void> = [];
  private scanListener: ((device: DiscoveredDevice) => void) | null = null;
  private _linkState: LinkState = "idle";
  private _currentDeviceId: string | null = null;

  constructor(opts: {
    persistsDeviceIdentity?: boolean;
    autoRespond?: boolean;
    keepListenersOnDestroy?: boolean;
  } = {}) {
    this.persistsDeviceIdentity = opts.persistsDeviceIdentity ?? false;
    this.autoRespond = opts.autoRespond ?? true;
    this.keepListenersOnDestroy = opts.keepListenersOnDestroy ?? false;
  }

  get linkState(): LinkState { return this._linkState; }
  get currentDeviceId(): string | null { return this._currentDeviceId; }
  get chunkCapacity(): number { return 179; }
  get linkListenerCount(): number { return this.linkListeners.length; }
  get frameListenerCount(): number { return this.frameListeners.length; }

  async connect(deviceId: string): Promise<DeviceState> {
    this.connectCalls += 1;
    this._currentDeviceId = deviceId;
    this.setLink("ready");
    return idleState();
  }

  async disconnect(): Promise<void> {
    this._currentDeviceId = null;
    this.setLink("idle");
  }

  async sendFrame(frame: Uint8Array): Promise<void> {
    if (!this.autoRespond) return;
    const decoded = decodeFrame(frame);
    if (!decoded.ok) return;
    this.emitFrame(encodeFrame(DEVICE_CMD.ACK, decoded.seq, new Uint8Array([decoded.command, 0])));
    if (decoded.command === CMD.QUERY_STRIP_CONFIG) {
      this.emitFrame(encodeFrame(DEVICE_CMD.STRIP_CONFIG_REPORT, decoded.seq, new Uint8Array(24)));
    } else if (decoded.command === CMD.QUERY_DEVICE_INFO) {
      this.emitFrame(encodeFrame(DEVICE_CMD.DEVICE_INFO_REPORT, decoded.seq, new Uint8Array(15)));
    } else if (decoded.command === CMD.QUERY_SCENE) {
      this.emitFrame(encodeFrame(DEVICE_CMD.SCENE_LIST_END, decoded.seq, cmdSceneName(0, "").payload));
    }
  }

  async readState(): Promise<DeviceState> {
    return idleState();
  }

  async startScan(onDevice: (device: DiscoveredDevice) => void): Promise<void> {
    this.scanning = true;
    this.scanListener = onDevice;
    this.emitScan({ deviceId: "probe", name: "LUMEN-PROBE", rssi: -40 });
  }

  stopScan(): void {
    this.scanning = false;
    this.scanListener = null;
  }

  onFrame(listener: (frame: Uint8Array) => void): () => void {
    this.frameListeners.push(listener);
    return () => {
      const i = this.frameListeners.indexOf(listener);
      if (i >= 0) this.frameListeners.splice(i, 1);
    };
  }

  onLinkChange(listener: (state: LinkState) => void): () => void {
    this.linkListeners.push(listener);
    return () => {
      const i = this.linkListeners.indexOf(listener);
      if (i >= 0) this.linkListeners.splice(i, 1);
    };
  }

  onAdapterState(_listener: (state: AdapterState) => void): () => void {
    return () => undefined;
  }

  destroy(): void {
    this.destroyCount += 1;
    this.stopScan();
    if (!this.keepListenersOnDestroy) {
      this.frameListeners = [];
      this.linkListeners = [];
    }
    this._currentDeviceId = null;
    this._linkState = "idle";
    this.onDestroy?.();
  }

  emitLink(state: LinkState): void {
    this.setLink(state);
  }

  emitScan(device: DiscoveredDevice): void {
    this.scanListener?.(device);
  }

  emitFrame(frame: Uint8Array): void {
    for (const fn of this.frameListeners.slice()) fn(frame);
  }

  private setLink(state: LinkState): void {
    if (this._linkState === state) return;
    this._linkState = state;
    for (const fn of this.linkListeners.slice()) fn(state);
  }
}

/** 最小 fake-wx：按 BleTransport 的调用顺序回 State，并记录扫描/断链动作。 */
function createWxProbe() {
  const calls: string[] = [];
  const desk = MOCK_DEVICES[0];
  const runtime = new MockDeviceRuntime(desk, { scenario: "normal" });
  let notifyHandler: ((res: any) => void) | null = null;

  const api: WxApi = {
    async openBluetoothAdapter() {},
    async closeBluetoothAdapter() {},
    async getBluetoothAdapterState() { return { available: true, discovering: false }; },
    async startBluetoothDevicesDiscovery() { calls.push("discovery:start"); },
    async stopBluetoothDevicesDiscovery() { calls.push("discovery:stop"); },
    onBluetoothDeviceFound() {},
    offBluetoothDeviceFound() {},
    async createBLEConnection(deviceId: string) { calls.push(`open:${deviceId}`); },
    async closeBLEConnection(deviceId: string) { calls.push(`close:${deviceId}`); },
    onBLEConnectionStateChange() {},
    async getBLEDeviceServices() {
      return { services: [{ uuid: SERVICE_UUID, isPrimary: true }] };
    },
    async getBLEDeviceCharacteristics(): Promise<{
      characteristics: Array<{ uuid: string; properties: Record<string, boolean> }>;
    }> {
      return {
        characteristics: [
          { uuid: RX_UUID, properties: { write: true } },
          { uuid: TX_UUID, properties: { notify: true } },
          { uuid: STATE_UUID, properties: { read: true } },
        ],
      };
    },
    async notifyBLECharacteristicValueChange() {},
    onBLECharacteristicValueChange(cb) { notifyHandler = cb; },
    async writeBLECharacteristicValue() {},
    async readBLECharacteristicValue(opts) {
      const bytes = runtime.readState();
      const value = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      notifyHandler?.({
        deviceId: opts.deviceId,
        serviceId: SERVICE_UUID,
        characteristicId: STATE_UUID,
        value,
      });
    },
    onBLECharacteristicValueChangeRead() {},
    async setBLEMTU() { return { mtu: 23 }; },
    onBluetoothAdapterStateChange() {},
  };

  return { api, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("身份缓存：能力位决定是否写入", () => {
  it("Mock 连接后不写真实设备身份缓存，冷启动仍判定为演示模式", async () => {
    const storage = createMemoryStorage();
    const session = new ControlSession({ transport: new MockTransport({ scenario: "normal" }), storage });
    const desk = MOCK_DEVICES[0];

    await session.connect(desk.deviceId, desk.broadcastName);
    await flushMicrotasks();

    expect(session.linkState).toBe("ready");
    expect(storage.get(DEVICE_CACHE_KEY)).toBeNull();
    expect(mockModeEnabled(storage)).toBe(true);
    session.destroy();
  });

  it("能力位 false 的传输层同样不写缓存（判据不是实现类）", async () => {
    const storage = createMemoryStorage();
    const transport = new ProbeTransport({ persistsDeviceIdentity: false });
    const session = new ControlSession({ transport, storage });

    await session.connect("FA:KE:00:00:00:01", "LUMEN-FAKE");
    expect(loadCachedDevice(storage)).toBeNull();
    session.destroy();
  });

  it("真实连接（能力位 true）写入身份缓存", async () => {
    const storage = createMemoryStorage();
    const transport = new ProbeTransport({ persistsDeviceIdentity: true });
    const session = new ControlSession({ transport, storage });

    await session.connect("A4:CF:12:9B:3E:01", "LUMEN-9B01");
    await flushMicrotasks();

    expect(loadCachedDevice(storage)?.deviceId).toBe("A4:CF:12:9B:3E:01");
    session.destroy();
  });

  it("MockTransport / BleTransport 的能力位固定为 false / true", () => {
    expect(new MockTransport().persistsDeviceIdentity).toBe(false);
    expect(new BleTransport({ wxApi: createWxProbe().api }).persistsDeviceIdentity).toBe(true);
  });
});

describe("销毁顺序与幂等", () => {
  it("destroy 先取消重连定时器，再销毁 transport；重复 destroy 不抛错", async () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const transport = new ProbeTransport();
    let pendingTimersAtTransportDestroy = -1;
    transport.onDestroy = () => {
      pendingTimersAtTransportDestroy = vi.getTimerCount();
    };
    const session = new ControlSession({ transport, storage, reconnectDelaysMs: [1000] });

    await session.connect("D1", "LUMEN-D1");
    await flushMicrotasks();
    transport.emitLink("reconnecting");
    expect(vi.getTimerCount()).toBe(1);

    session.destroy();

    expect(pendingTimersAtTransportDestroy).toBe(0);
    expect(transport.destroyCount).toBe(1);
    expect(() => session.destroy()).not.toThrow();
    expect(transport.destroyCount).toBe(1);

    vi.advanceTimersByTime(5000);
    expect(transport.connectCalls).toBe(1);
  });

  it("MockTransport.destroy 幂等且回到空闲", () => {
    const transport = new MockTransport();
    expect(() => transport.destroy()).not.toThrow();
    expect(() => transport.destroy()).not.toThrow();
    expect(transport.linkState).toBe("idle");
    expect(transport.currentDeviceId).toBeNull();
  });

  it("BleTransport.destroy 停止扫描并断开真实连接", async () => {
    const probe = createWxProbe();
    const transport = new BleTransport({ wxApi: probe.api });
    const desk = MOCK_DEVICES[0];

    await transport.connect(desk.deviceId);
    await transport.startScan(() => undefined);
    expect(probe.calls).toContain("discovery:start");

    transport.destroy();

    expect(probe.calls).toContain("discovery:stop");
    expect(probe.calls).toContain(`close:${desk.deviceId}`);
    expect(transport.linkState).toBe("idle");
    expect(transport.currentDeviceId).toBeNull();

    transport.destroy();
    expect(probe.calls.filter((call) => call.startsWith("close:"))).toHaveLength(1);
  });
});

describe("模式切换：旧回调不写新会话", () => {
  it("旧 transport 扫描/链路回调停止，新会话只有新监听", async () => {
    const storage = createMemoryStorage();
    const oldTransport = new ProbeTransport({ keepListenersOnDestroy: true });
    const oldSession = new ControlSession({ transport: oldTransport, storage });
    await oldSession.connect("OLD", "LUMEN-OLD");
    await flushMicrotasks();

    const scanned: string[] = [];
    await oldSession.startScan((device) => scanned.push(device.deviceId));
    expect(scanned).toEqual(["probe"]);

    const pageSub = new LinkSubscription();
    let pageUpdates = 0;
    pageSub.bind(oldTransport, () => { pageUpdates += 1; });
    expect(oldTransport.linkListenerCount).toBe(2);

    oldSession.destroy();

    expect(oldTransport.scanning).toBe(false);
    oldTransport.emitScan({ deviceId: "late", name: "LUMEN-LATE", rssi: -70 });
    expect(scanned).toEqual(["probe"]);
    expect(oldTransport.linkListenerCount).toBe(1);

    oldTransport.emitLink("reconnecting");
    expect(oldSession.linkState).toBe("ready");
    expect(pageUpdates).toBe(1);

    const newTransport = new ProbeTransport();
    const newSession = new ControlSession({ transport: newTransport, storage });
    await newSession.connect("NEW", "LUMEN-NEW");
    await flushMicrotasks();
    expect(newTransport.linkListenerCount).toBe(1);

    pageSub.bind(newTransport, () => { pageUpdates += 1; });
    expect(oldTransport.linkListenerCount).toBe(0);
    expect(newTransport.linkListenerCount).toBe(2);

    newTransport.emitLink("reconnecting");
    expect(newSession.linkState).toBe("reconnecting");
    expect(oldSession.linkState).toBe("ready");

    newSession.destroy();
  });
});

describe("页面订阅", () => {
  it("重复绑定先解绑旧订阅，unbind 幂等且退订后静默", () => {
    const transport = new ProbeTransport();
    const sub = new LinkSubscription();
    let first = 0;
    let second = 0;

    sub.bind(transport, () => { first += 1; });
    transport.emitLink("ready");
    expect(first).toBe(1);

    sub.bind(transport, () => { second += 1; });
    expect(transport.linkListenerCount).toBe(1);
    transport.emitLink("reconnecting");
    expect(first).toBe(1);
    expect(second).toBe(1);

    sub.unbind();
    expect(() => sub.unbind()).not.toThrow();
    expect(transport.linkListenerCount).toBe(0);
    transport.emitLink("idle");
    expect(second).toBe(1);
  });
});
