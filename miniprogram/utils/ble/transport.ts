/**
 * 传输层抽象（工单 #6 决策 4）。
 *
 * Transport 是会话层与 BLE / Mock 之间唯一的接口：会话层只看到这一组方法，
 * 不知道底下是 BleTransport 还是 MockTransport。这是「零 mock 分支」的结构基础。
 *
 * 分帧职责：传输层进出都是逻辑帧。BleTransport 内部做「逻辑帧 → 分片 →
 * 串行写」与「notify 分片 → 重组 → 逻辑帧」；MockTransport 一步到位。
 * 会话层不见 ctrl 字节。
 */

import type { AdapterState, DeviceState, DiscoveredDevice, LinkState } from "../protocol/types";

export interface Transport {
  /**
   * 连接 + 初始化流水线（MTU → services → chars → notify → 读 State）。
   * 成功时 linkState 变 ready 并返回整机状态；失败抛错且不留半开状态。
   */
  connect(deviceId: string, broadcastName?: string): Promise<DeviceState>;

  /** 主动断开。幂等：未连接时调用安全。 */
  disconnect(): Promise<void>;

  /**
   * 发送一个逻辑帧（≤240B）。分片与串行写入由传输层内部完成；
   * Promise 在最后一个 ATT 写完成时 resolve（不代表设备已 ACK）。
   */
  sendFrame(frame: Uint8Array): Promise<void>;

  /** 读 State 特征（32B，与 StateReport 同布局）。 */
  readState(): Promise<DeviceState>;

  /** 开始扫描：Service UUID 过滤 + 名字前缀 LUMEN-，每发现一台回调一次。 */
  startScan(onDevice: (device: DiscoveredDevice) => void): Promise<void>;
  stopScan(): void;

  /** 订阅入站逻辑帧（notify 分片重组后的原始字节；校验与解析在会话层）。 */
  onFrame(listener: (frame: Uint8Array) => void): () => void;

  /** 订阅连接状态变化（含非主动断线）。 */
  onLinkChange(listener: (state: LinkState) => void): () => void;

  /** 订阅适配器状态（10001 / iOS fail states 的分诊入口）。 */
  onAdapterState(listener: (state: AdapterState) => void): () => void;

  readonly linkState: LinkState;
  readonly currentDeviceId: string | null;
  /** 协商后的单写容量（chunk_capacity；MTU 未知时 = 20）。 */
  readonly chunkCapacity: number;

  /** 释放订阅与定时器；之后所有方法快速失败。 */
  destroy(): void;
}