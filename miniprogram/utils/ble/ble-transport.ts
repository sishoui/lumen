/**
 * BleTransport：Transport 接口的真实 BLE 实现（工单 #6 决策 4）。
 *
 * 职责：
 *  - 适配器 / 扫描 / 连接 / 固定初始化流水线（MTU → services → chars → notify → 读 State）；
 *  - 写入串行化（SerialWriter）+ 逻辑帧分片（chunk.ts）；
 *  - 入站 notify 分片重组（ChunkAssembler）→ 逻辑帧派发；
 *  - 订阅表（link / frame / adapter）。
 *
 * wx 边界：所有 wx.* 调用经 WxApi 接口（构造注入），本文件不直触全局 wx。
 */

import {
  DEFAULT_CHUNK_CAPACITY,
  RX_UUID,
  SERVICE_UUID,
  STATE_BYTES,
  STATE_UUID,
  TX_UUID,
} from "../protocol/constants";
import { bytesToHex } from "../protocol/hex";
import { parseState } from "../protocol/commands";
import { ChunkAssembler, chunkCapacityForMtu, chunkDataCapacity, chunkFrame } from "../protocol/chunk";
import type { AdapterState, DeviceState, DiscoveredDevice, LinkState } from "../protocol/types";
import { AckWaiters } from "./ack-waiters";
import { WxCallError, errorText } from "./errors";
import { SerialWriter } from "./writer";
import { FrameLog } from "./log";
import type { WxApi } from "./wx-api";
import type { Transport } from "./transport";

export interface BleTransportOptions {
  wxApi: WxApi;
  /** notify 订阅超时（ms）。 */
  notifyTimeoutMs?: number;
}

type FrameListener = (frame: Uint8Array) => void;
type LinkListener = (state: LinkState) => void;
type AdapterListener = (state: AdapterState) => void;
type ScanListener = (device: DiscoveredDevice) => void;

export class BleTransport implements Transport {
  private readonly wxApi: WxApi;
  private readonly writer: SerialWriter;
  private readonly ackWaiters = new AckWaiters();
  private readonly assembler = new ChunkAssembler();
  private readonly frameListeners: FrameListener[] = [];
  private readonly linkListeners: LinkListener[] = [];
  private readonly adapterListeners: AdapterListener[] = [];
  private scanListener: ScanListener | null = null;

  private _linkState: LinkState = "idle";
  private _currentDeviceId: string | null = null;
  private _chunkCapacity: number = DEFAULT_CHUNK_CAPACITY;
  private destroyed = false;
  private adapterAvailable = false;
  private log = new FrameLog({ capacity: 200 });
  private readStateResolver: ((value: ArrayBuffer) => void) | null = null;

  get logSource(): FrameLog { return this.log; }

  constructor(opts: BleTransportOptions) {
    this.wxApi = opts.wxApi;
    this.writer = new SerialWriter((bytes) => this.writeOne(bytes));
    this.wxApi.onBLEConnectionStateChange((res) => {
      if (!res.connected && res.deviceId === this._currentDeviceId) {
        this.handleUnexpectedDisconnect();
      }
    });
    this.wxApi.onBLECharacteristicValueChange((res) => {
      if (res.deviceId !== this._currentDeviceId) return;
      const charId = res.characteristicId?.toUpperCase() ?? "";
      if (charId === STATE_UUID) {
        if (this.readStateResolver) {
          this.readStateResolver(res.value);
          this.readStateResolver = null;
        }
        return;
      }
      if (charId !== TX_UUID) return;
      const bytes = new Uint8Array(res.value);
      const result = this.assembler.push(bytes);
      if (result.kind === "frame") {
        for (const fn of this.frameListeners.slice()) {
          try { fn(result.frame); } catch { /* ignore */ }
        }
      }
    });
    this.wxApi.onBluetoothAdapterStateChange((res) => {
      const next: AdapterState = res.available ? "on" : "off";
      this.adapterAvailable = res.available;
      for (const fn of this.adapterListeners.slice()) {
        try { fn(next); } catch { /* ignore */ }
      }
      if (!res.available && this._linkState === "ready") {
        this.handleUnexpectedDisconnect();
      }
    });
  }

  get linkState(): LinkState { return this._linkState; }
  get currentDeviceId(): string | null { return this._currentDeviceId; }
  get chunkCapacity(): number { return this._chunkCapacity; }

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

  async connect(deviceId: string, broadcastName?: string): Promise<DeviceState> {
    this.assertNotDestroyed();
    this.setLinkState("connecting");
    try {
      await this.wxApi.openBluetoothAdapter();
      const adapter = await this.wxApi.getBluetoothAdapterState();
      this.adapterAvailable = adapter.available;
      if (!adapter.available) {
        throw new Error("蓝牙适配器不可用");
      }
      await this.wxApi.createBLEConnection(deviceId);
      this._currentDeviceId = deviceId;

      if (this.wxApi.setBLEMTU) {
        try {
          const { mtu } = await this.wxApi.setBLEMTU({ deviceId, mtu: 185 });
          this._chunkCapacity = chunkCapacityForMtu(mtu);
        } catch {
          this._chunkCapacity = DEFAULT_CHUNK_CAPACITY;
        }
      }

      const services = await this.wxApi.getBLEDeviceServices(deviceId);
      const hasService = services.services.some((s) => s.uuid.toUpperCase() === SERVICE_UUID);
      if (!hasService) {
        throw new Error(`未找到 Lumen 服务 ${SERVICE_UUID}`);
      }

      const chars = await this.wxApi.getBLEDeviceCharacteristics(deviceId, SERVICE_UUID);
      const hasRx = chars.characteristics.some((c) => c.uuid.toUpperCase() === RX_UUID);
      const hasTx = chars.characteristics.some((c) => c.uuid.toUpperCase() === TX_UUID);
      const hasState = chars.characteristics.some((c) => c.uuid.toUpperCase() === STATE_UUID);
      if (!hasRx || !hasTx || !hasState) {
        throw new Error("未找到 RX/TX/State 特征值");
      }

      await this.wxApi.notifyBLECharacteristicValueChange({
        deviceId,
        serviceId: SERVICE_UUID,
        characteristicId: TX_UUID,
        state: true,
      });

      this.assembler.reset();
      this.writer.revive();

      const state = await this.readStateInternal(deviceId);
      this.setLinkState("ready");
      void broadcastName;
      return state;
    } catch (err) {
      this.ackWaiters.reset(err instanceof Error ? err : new Error(String(err)));
      this.writer.reset(err instanceof Error ? err : new Error(String(err)));
      this._currentDeviceId = null;
      this.setLinkState("failed");
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this._currentDeviceId !== null) {
      const id = this._currentDeviceId;
      this._currentDeviceId = null;
      try { await this.wxApi.closeBLEConnection(id); } catch { /* idempotent */ }
    }
    this.writer.reset(new Error("主动断开"));
    this.ackWaiters.reset(new Error("主动断开"));
    this.assembler.reset();
    this.setLinkState("idle");
  }

  async sendFrame(frame: Uint8Array): Promise<void> {
    this.assertNotDestroyed();
    if (this._currentDeviceId === null) {
      throw new Error("未连接");
    }
    const chunks = chunkFrame(frame, this._chunkCapacity);
    for (const chunk of chunks) {
      await this.writer.enqueue(chunk);
    }
  }

  async readState(): Promise<DeviceState> {
    this.assertNotDestroyed();
    if (this._currentDeviceId === null) {
      throw new Error("未连接");
    }
    return this.readStateInternal(this._currentDeviceId);
  }

  async startScan(onDevice: ScanListener): Promise<void> {
    this.assertNotDestroyed();
    this.scanListener = onDevice;
    this.wxApi.onBluetoothDeviceFound((devices) => {
      for (const d of devices) {
        const name = d.localName ?? d.name ?? "";
        if (!name.startsWith("LUMEN-")) continue;
        this.scanListener?.({
          deviceId: d.deviceId,
          name,
          rssi: typeof d.RSSI === "number" ? d.RSSI : 0,
        });
      }
    });
    await this.wxApi.openBluetoothAdapter();
    await this.wxApi.startBluetoothDevicesDiscovery({
      services: [SERVICE_UUID],
      allowDuplicatesKey: false,
    });
  }

  stopScan(): void {
    this.scanListener = null;
    this.wxApi.offBluetoothDeviceFound?.();
    void this.wxApi.stopBluetoothDevicesDiscovery().catch(() => undefined);
  }

  destroy(): void {
    this.destroyed = true;
    this.stopScan();
    this.writer.reset(new Error("destroy"));
    this.ackWaiters.reset(new Error("destroy"));
    this.assembler.reset();
    this.frameListeners.length = 0;
    this.linkListeners.length = 0;
    this.adapterListeners.length = 0;
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) throw new Error("BleTransport 已 destroy");
  }

  private async writeOne(bytes: Uint8Array): Promise<void> {
    if (this._currentDeviceId === null) {
      throw new Error("未连接");
    }
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await this.wxApi.writeBLECharacteristicValue({
      deviceId: this._currentDeviceId,
      serviceId: SERVICE_UUID,
      characteristicId: RX_UUID,
      value: buffer,
    });
  }

  private async readStateInternal(deviceId: string): Promise<DeviceState> {
    const promise = new Promise<ArrayBuffer>((resolve) => {
      this.readStateResolver = resolve;
    });
    await this.wxApi.readBLECharacteristicValue({
      deviceId,
      serviceId: SERVICE_UUID,
      characteristicId: STATE_UUID,
    });
    const value = await promise;
    const bytes = new Uint8Array(value);
    if (bytes.length !== STATE_BYTES) {
      throw new Error(`State 长度 ${bytes.length} ≠ ${STATE_BYTES}`);
    }
    return parseState(bytes);
  }

  private handleUnexpectedDisconnect(): void {
    if (this._currentDeviceId === null) return;
    const err = new WxCallError("连接", { errCode: 10006, errMsg: "连接已断开" });
    this.writer.reset(err);
    this.ackWaiters.reset(err);
    this.assembler.reset();
    this._currentDeviceId = null;
    this.setLinkState("reconnecting");
  }
}

export { errorText, bytesToHex };