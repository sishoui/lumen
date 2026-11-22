/**
 * MockTransport：演示模式传输层（工单 #6 决策 8）。
 * 与 BleTransport 实现同一个 Transport 接口（implements 编译期强制）。
 *
 * 与真机的已知差异（刻意保留，写在文件头避免被当成 bug）：
 *  - 无 GATT / MTU / 分片：命令一步到位；
 *  - 不因距离断开；无 10006 / 10008；
 *  - 时间即时（slow 场景除外，会加 40ms 延迟）。
 *
 * 为什么这么写（工单 #6）：会话、页面、列表派生全部按真实数据流走，
 * 关掉 mock 一行不用改。「连接」是真的走 connect → 初始化 → ready。
 */

import {
  DEFAULT_CHUNK_CAPACITY,
} from "../protocol/constants";
import { encodeFrame, decodeFrame } from "../protocol/frame";
import { bytesToHex } from "../protocol/hex";
import type { AdapterState, DeviceState, DiscoveredDevice, LinkState } from "../protocol/types";
import { MockDeviceRuntime, type MockScenario } from "../mock/mock-runtime";
import { MOCK_DEVICES, mockSpecOf } from "../mock/mock-devices";
import { FrameLog } from "./log";
import type { Transport } from "./transport";

type FrameListener = (frame: Uint8Array) => void;
type LinkListener = (state: LinkState) => void;
type AdapterListener = (state: AdapterState) => void;
type ScanListener = (device: DiscoveredDevice) => void;

export interface MockTransportOptions {
  scenario?: MockScenario;
  /** 帧派发延迟（slow 场景默认 40ms）。 */
  delayMs?: number;
  timer?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
}

export class MockTransport implements Transport {
  private readonly runtimes = new Map<string, MockDeviceRuntime>();
  private readonly scenario: MockScenario;
  private readonly delayMs: number;
  private readonly timer: { setTimeout: (fn: () => void, ms: number) => number; clearTimeout: (h: number) => void };
  private readonly frameListeners: FrameListener[] = [];
  private readonly linkListeners: LinkListener[] = [];
  private readonly adapterListeners: AdapterListener[] = [];
  private scanListener: ScanListener | null = null;
  private _linkState: LinkState = "idle";
  private _currentDeviceId: string | null = null;
  private seqCounter = 1;
  private log = new FrameLog({ capacity: 200 });

  /** 暴露日志源（组件读取）。 */
  get logSource(): FrameLog { return this.log; }

  constructor(opts: MockTransportOptions = {}) {
    this.scenario = opts.scenario ?? "normal";
    this.delayMs = opts.delayMs ?? (this.scenario === "slow" ? 40 : 0);
    this.timer = opts.timer ?? { setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number, clearTimeout: (h) => clearTimeout(h) };
  }

  get linkState(): LinkState { return this._linkState; }
  get currentDeviceId(): string | null { return this._currentDeviceId; }
  get chunkCapacity(): number { return DEFAULT_CHUNK_CAPACITY; }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.push(listener);
    return () => {
      const i = this.frameListeners.indexOf(listener);
      if (i >= 0) this.frameListeners.splice(i, 1);
    };
  }

  onLinkChange(listener: LinkListener): () => void {
    this.linkListeners.push(listener);
    return () => {
      const i = this.linkListeners.indexOf(listener);
      if (i >= 0) this.linkListeners.splice(i, 1);
    };
  }

  onAdapterState(listener: AdapterListener): () => void {
    this.adapterListeners.push(listener);
    return () => {
      const i = this.adapterListeners.indexOf(listener);
      if (i >= 0) this.adapterListeners.splice(i, 1);
    };
  }

  private setLinkState(state: LinkState): void {
    if (this._linkState === state) return;
    this._linkState = state;
    for (const fn of this.linkListeners.slice()) {
      try { fn(state); } catch { /* ignore */ }
    }
  }

  async connect(deviceId: string, _broadcastName?: string): Promise<DeviceState> {
    if (this.scenario === "offline") {
      this.setLinkState("failed");
      throw new Error("MockTransport offline 场景：连接失败");
    }
    const spec = mockSpecOf(deviceId);
    if (!spec) {
      this.setLinkState("failed");
      throw new Error(`MockTransport: 未知设备 ${deviceId}`);
    }
    if (!this.runtimes.has(deviceId)) {
      this.runtimes.set(deviceId, new MockDeviceRuntime(spec, { scenario: this.scenario, timer: this.timer }));
    }
    this._currentDeviceId = deviceId;
    this.setLinkState("ready");
    return this.runtimes.get(deviceId)!.readStateObject();
  }

  async disconnect(): Promise<void> {
    this._currentDeviceId = null;
    this.setLinkState("idle");
  }

  async sendFrame(frame: Uint8Array): Promise<void> {
    if (this._currentDeviceId === null) {
      throw new Error("MockTransport: 未连接");
    }
    const runtime = this.runtimes.get(this._currentDeviceId);
    if (!runtime) {
      throw new Error("MockTransport: 设备 runtime 不存在");
    }
    const decoded = decodeFrame(frame);
    if (!decoded.ok) {
      return;
    }
    const seq = this.seqCounter;
    this.seqCounter = (this.seqCounter + 1) & 0xff;
    const frames = runtime.handleCommand(decoded.command, decoded.payload, decoded.seq || seq);
    // 派发（slow 场景延迟）
    const dispatch = () => {
      for (const f of frames) {
        this.log.push({
          ts: Date.now(), dir: "rx", hex: bytesToHex(f),
          command: f.length >= 3 ? f[2] : undefined, seq: f.length >= 4 ? f[3] : undefined,
          parsed: `cmd=0x${(f.length >= 3 ? f[2] : 0).toString(16)}`, ok: true,
        });
        for (const fn of this.frameListeners.slice()) {
          try { fn(f); } catch { /* ignore */ }
        }
      }
    };
    this.log.push({
      ts: Date.now(), dir: "tx", hex: bytesToHex(frame),
      command: decoded.command, seq: decoded.seq,
      parsed: `cmd=0x${decoded.command.toString(16)}`, ok: true,
    });
    if (this.delayMs > 0) {
      this.timer.setTimeout(dispatch, this.delayMs);
    } else {
      dispatch();
    }
  }

  async readState(): Promise<DeviceState> {
    if (this._currentDeviceId === null) {
      throw new Error("MockTransport: 未连接");
    }
    const runtime = this.runtimes.get(this._currentDeviceId);
    if (!runtime) {
      throw new Error("MockTransport: 设备 runtime 不存在");
    }
    return runtime.readStateObject();
  }

  async startScan(onDevice: ScanListener): Promise<void> {
    this.scanListener = onDevice;
    for (const spec of MOCK_DEVICES) {
      this.scanListener({
        deviceId: spec.deviceId,
        name: spec.broadcastName,
        rssi: -58,
      });
    }
  }

  stopScan(): void {
    this.scanListener = null;
  }

  destroy(): void {
    this.frameListeners.length = 0;
    this.linkListeners.length = 0;
    this.adapterListeners.length = 0;
    this.scanListener = null;
    this.runtimes.clear();
  }
}