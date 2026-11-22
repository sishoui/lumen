/**
 * BLE 分片与重组（纯函数/纯状态机，不依赖 wx.*，可在 node 里单测）。
 *
 * 契约见 docs/protocol.md §4：
 *  - 每次 write / notify 都带 1 字节 ctrl 头：bit7 FIRST、bit6 LAST、bit5-0 序号；
 *  - 不分片的帧也必须带 ctrl（FIRST|LAST = 0xC0），不允许裸帧；
 *  - 数据上限 = chunk_capacity − 1（分片头占 1 字节），capacity 未知按 20；
 *  - 重组：FIRST 重入丢弃旧缓冲（latest-wins）；累计超过 240 丢弃；
 *    LAST 时交出完整逻辑帧；超时 1000ms 丢弃且不回复。
 */

import {
  ASSEMBLY_TIMEOUT_MS,
  CHUNK_FIRST,
  CHUNK_INDEX_MASK,
  CHUNK_LAST,
  DEFAULT_CHUNK_CAPACITY,
  MAX_CHUNK_CAPACITY,
  MAX_FRAME_BYTES,
} from "./constants";

/** capacity 归一化：未知/过小按 20，过大按 180。 */
export function normalizeChunkCapacity(capacity: number | null | undefined): number {
  if (capacity === null || capacity === undefined || !Number.isFinite(capacity)) {
    return DEFAULT_CHUNK_CAPACITY;
  }
  const value = Math.floor(capacity);
  if (value < DEFAULT_CHUNK_CAPACITY) {
    return DEFAULT_CHUNK_CAPACITY;
  }
  return value > MAX_CHUNK_CAPACITY ? MAX_CHUNK_CAPACITY : value;
}

/** 由 ATT MTU 推出单次写上限：`chunk_capacity = min(mtu − 3, 180)`。 */
export function chunkCapacityForMtu(mtu: number | null | undefined): number {
  if (mtu === null || mtu === undefined || !Number.isFinite(mtu)) {
    return DEFAULT_CHUNK_CAPACITY;
  }
  return normalizeChunkCapacity(Math.floor(mtu) - 3);
}

/** 单次写的数据上限（分片头占 1 字节）。 */
export function chunkDataCapacity(capacity: number | null | undefined): number {
  return normalizeChunkCapacity(capacity) - 1;
}

/**
 * 把一条逻辑帧切成写序列。单分片时 ctrl = 0xC0。
 * 序号按 6 位回绕（0-63），仅用于诊断，接收端不作连续性要求。
 */
export function chunkFrame(
  frame: Uint8Array,
  capacity: number | null | undefined,
): Uint8Array[] {
  const dataCapacity = chunkDataCapacity(capacity);
  const chunks: Uint8Array[] = [];
  const total = frame.length;
  const count = Math.max(1, Math.ceil(total / dataCapacity));
  for (let i = 0; i < count; i += 1) {
    const start = i * dataCapacity;
    const end = Math.min(start + dataCapacity, total);
    const chunk = new Uint8Array(1 + (end - start));
    let ctrl = (i & CHUNK_INDEX_MASK) & ~(CHUNK_FIRST | CHUNK_LAST);
    if (i === 0) {
      ctrl |= CHUNK_FIRST;
    }
    if (i === count - 1) {
      ctrl |= CHUNK_LAST;
    }
    chunk[0] = ctrl;
    chunk.set(frame.subarray(start, end), 1);
    chunks.push(chunk);
  }
  return chunks;
}

/** 单次 push 的判定结果：还要更多分片 / 一条完整逻辑帧 / 丢弃。 */
export type ChunkResult =
  | { kind: "incomplete" }
  | { kind: "frame"; frame: Uint8Array }
  | { kind: "error"; reason: "empty" | "orphan" | "overflow" };

export interface ChunkAssemblerOptions {
  timeoutMs?: number;
  now?: () => number;
}

/**
 * 设备 → 小程序的入站重组缓冲。
 * 不是「流」而是「一问一答」：一次只有一条逻辑帧在途，所以单一缓冲足够。
 * 任何异常都清空缓冲——宁可丢一帧（等 ACK 超时重试），也不要拼接出错误帧。
 */
export class ChunkAssembler {
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private buffer: number[] = [];
  private lastAt = 0;

  constructor(opts: ChunkAssemblerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? ASSEMBLY_TIMEOUT_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  get pending(): boolean {
    return this.buffer.length > 0;
  }

  get size(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = [];
    this.lastAt = 0;
  }

  /**
   * 喂一个分片。
   * 返回 `frame` 时缓冲已清空；返回 `error` 时同样已清空。
   */
  push(bytes: Uint8Array): ChunkResult {
    if (bytes.length === 0) {
      this.reset();
      return { kind: "error", reason: "empty" };
    }

    const now = this.now();
    if (this.buffer.length > 0 && now - this.lastAt > this.timeoutMs) {
      this.reset();
    }

    const ctrl = bytes[0] & 0xff;
    const isFirst = (ctrl & CHUNK_FIRST) !== 0;
    const isLast = (ctrl & CHUNK_LAST) !== 0;
    const data = bytes.subarray(1);

    if (isFirst) {
      this.buffer = [];
    } else if (this.buffer.length === 0) {
      return { kind: "error", reason: "orphan" };
    }

    for (let i = 0; i < data.length; i += 1) {
      this.buffer.push(data[i] & 0xff);
    }
    this.lastAt = now;

    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.reset();
      return { kind: "error", reason: "overflow" };
    }

    if (!isLast) {
      return { kind: "incomplete" };
    }

    const frame = Uint8Array.from(this.buffer);
    this.reset();
    return { kind: "frame", frame };
  }
}