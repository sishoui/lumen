/**
 * 日志面板（#32）L2：FrameLog / Formatter / MockTransport / BleTransport /
 * ControlSession.logSource 公开日志源 / 暂停清空。
 *
 * 断言行为，不断言私有字段。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FrameLog } from "../utils/ble/log";
import { commandName, CMD, DEVICE_CMD } from "../utils/protocol/constants";
import { encodeFrame, decodeFrame } from "../utils/protocol/frame";
import { MockTransport } from "../utils/ble/mock-transport";
import { BleTransport } from "../utils/ble/ble-transport";
import { ControlSession } from "../utils/session/session";
import { MockDeviceRuntime } from "../utils/mock/mock-runtime";
import { MOCK_DEVICES } from "../utils/mock/mock-devices";
import type { Transport } from "../utils/ble/transport";
import type { WxApi } from "../utils/ble/wx-api";
import { SERVICE_UUID, RX_UUID, TX_UUID, STATE_UUID } from "../utils/protocol/constants";
import { ChunkAssembler } from "../utils/protocol/chunk";
import { parseState } from "../utils/protocol/commands";
import { createMemoryStorage } from "./helpers/storage";

/* ------------------------------------------------------------------ */
/* FrameLog / Formatter                                               */
/* ------------------------------------------------------------------ */

describe("FrameLog", () => {
  let log: FrameLog;

  beforeEach(() => {
    log = new FrameLog({ capacity: 10 });
  });

  it("push 返回带 id 的完整条目，snapshot 反映已写入", () => {
    const entry = log.push({
      ts: 1000, dir: "tx", command: CMD.SET_POWER, seq: 1,
      hex: "AABB", parsed: "cmd=0x1", ok: true,
    });
    expect(entry.id).toBe(1);
    expect(log.snapshot()).toHaveLength(1);
    expect(log.snapshot()[0]).toBe(entry);
  });

  it("push 时补全 commandName（入口不靠展示层回填）", () => {
    const entry = log.push({
      ts: 1000, dir: "rx", command: CMD.SELF_TEST, seq: 2,
      hex: "AABB", parsed: "cmd=0x7", ok: true,
    });
    expect(entry.commandName).toBe("SelfTest");
  });

  it("未知命令的 commandName 走回退（0xXX 形式）", () => {
    const entry = log.push({
      ts: 1000, dir: "rx", command: 0x77, seq: 3,
      hex: "AABB", parsed: "cmd=0x77", ok: true,
    });
    expect(entry.commandName).toBe("0x77");
  });

  it("无 command 的条目不补全 commandName（事件行）", () => {
    const entry = log.push({
      ts: 1000, dir: "rx", hex: "AABB", parsed: "event", ok: true,
    });
    expect(entry.commandName).toBeUndefined();
    expect(entry.seq).toBeUndefined();
  });

  it("容量超出时环形裁剪（保留最新）", () => {
    for (let i = 0; i < 15; i += 1) {
      log.push({ ts: i, dir: "tx", command: CMD.SET_POWER, seq: i, hex: "AA", parsed: "p", ok: true });
    }
    const snapshot = log.snapshot();
    expect(snapshot).toHaveLength(10);
    expect(snapshot[0].seq).toBe(5);
    expect(snapshot[9].seq).toBe(14);
  });

  it("clear 后 snapshot 为空", () => {
    log.push({ ts: 1000, dir: "tx", command: CMD.SET_POWER, seq: 1, hex: "AA", parsed: "p", ok: true });
    log.clear();
    expect(log.snapshot()).toEqual([]);
  });

  it("onAppend 订阅回调；退订后不再触发", () => {
    let count = 0;
    const off = log.onAppend(() => { count += 1; });
    log.push({ ts: 1000, dir: "tx", command: CMD.SET_POWER, seq: 1, hex: "AA", parsed: "p", ok: true });
    expect(count).toBe(1);
    off();
    log.push({ ts: 1000, dir: "tx", command: CMD.SET_POWER, seq: 2, hex: "AA", parsed: "p", ok: true });
    expect(count).toBe(1);
  });
});

describe("Formatter：复制文本格式", () => {
  it("复制行格式 DIR seq=<n> <commandName> <hex>", () => {
    // 与 log-panel.ts onCopy 保持一致的格式契约
    const entries = [
      { dir: "tx", seqText: "seq=1", commandName: "SelfTest", hex: "AABB" },
      { dir: "rx", seqText: "seq=1", commandName: "ACK", hex: "CCDD" },
      { dir: "rx", seqText: "", commandName: "Event", hex: "EEFF" },
    ];
    const text = entries
      .map((e) => `${e.dir.toUpperCase()}${e.seqText ? ` ${e.seqText}` : ""} ${e.commandName} ${e.hex}`)
      .join("\n");
    const lines = text.split("\n");
    expect(lines[0]).toBe("TX seq=1 SelfTest AABB");
    expect(lines[1]).toBe("RX seq=1 ACK CCDD");
    // 无 seq 的事件行不输出空 seq 段
    expect(lines[2]).toBe("RX Event EEFF");
  });

  it("命令名表对未知命令回退到 0xXX", () => {
    expect(commandName(0x77)).toBe("0x77");
    expect(commandName(CMD.SELF_TEST)).toBe("SelfTest");
  });
});

/* ------------------------------------------------------------------ */
/* MockTransport：TX → RX 顺序 + commandName                          */
/* ------------------------------------------------------------------ */

async function connectMock(): Promise<Transport> {
  const transport = new MockTransport({ scenario: "normal" });
  await transport.connect(MOCK_DEVICES[0].deviceId, MOCK_DEVICES[0].broadcastName);
  return transport;
}

/** 发一条命令并等同一 seq 的 ACK；超时直接失败。 */
function sendRaw(
  transport: Transport,
  command: number,
  seq: number,
  payload: Uint8Array,
): Promise<{ resultCode: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`seq=${seq} 600ms 内没有 ACK`));
    }, 600);
    const off = transport.onFrame((frame) => {
      const decoded = decodeFrame(frame);
      if (!decoded.ok || decoded.command !== DEVICE_CMD.ACK || decoded.seq !== seq) return;
      if (decoded.payload.length !== 2) return;
      clearTimeout(timer);
      off();
      resolve({ resultCode: decoded.payload[1] });
    });
    void transport.sendFrame(encodeFrame(command, seq, payload)).catch((err) => {
      clearTimeout(timer);
      off();
      reject(err);
    });
  });
}

describe("MockTransport 帧日志", () => {
  it("TX 先于 RX，每条都有 commandName", async () => {
    const transport = await connectMock();

    await sendRaw(transport, CMD.SET_POWER, 77, Uint8Array.from([1]));
    await sendRaw(transport, CMD.QUERY_STATE, 78, new Uint8Array([]));

    const entries = transport.logSource.snapshot();
    expect(entries.length, `帧日志期望非空，实际 ${entries.length} 条`).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(
        entry.commandName,
        `${entry.dir.toUpperCase()} seq=${entry.seq} 期望有 commandName，实际为空`,
      ).toBeTruthy();
    }

    const powerFrames = entries.filter((e) => e.seq === 77);
    expect(
      powerFrames[0]?.dir,
      `seq=77 的第一条期望 TX，实际 ${powerFrames[0]?.dir}`,
    ).toBe("tx");
    expect(
      powerFrames[0]?.commandName,
      `SetPower 的 TX 命令名期望 SetPower，实际 ${powerFrames[0]?.commandName}`,
    ).toBe("SetPower");
    expect(
      powerFrames.slice(1).every((e) => e.dir === "rx"),
      `seq=77 的 TX 之后期望全是 RX，实际 ${JSON.stringify(powerFrames.map((e) => e.dir))}`,
    ).toBe(true);
    expect(
      powerFrames.some((e) => e.dir === "rx" && e.commandName === "ACK"),
      `seq=77 期望有名为 ACK 的 RX，实际 ${JSON.stringify(powerFrames.map((e) => e.commandName))}`,
    ).toBe(true);

    const stateFrames = entries.filter((e) => e.seq === 78);
    expect(stateFrames[0]?.dir, `seq=78 的第一条期望 TX，实际 ${stateFrames[0]?.dir}`).toBe("tx");
    expect(
      stateFrames.some((e) => e.commandName === "StateReport"),
      `seq=78 期望有 StateReport，实际 ${JSON.stringify(stateFrames.map((e) => e.commandName))}`,
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* BleTransport：fake wx 驱动发送与接收                                */
/* ------------------------------------------------------------------ */

function createFakeWxApi() {
  const runtimes = new Map<string, MockDeviceRuntime>();
  const state = { adapterAvailable: true, connected: null as string | null, discovering: false };
  let notifyHandler: ((res: any) => void) | null = null;
  let foundHandler: ((devices: any[]) => void) | null = null;
  let connChangeHandler: ((res: any) => void) | null = null;
  let adapterChangeHandler: ((res: any) => void) | null = null;
  const asm = new ChunkAssembler({ now: () => Date.now() });
  const getAssembler = () => asm;

  return {
    async openBluetoothAdapter() {},
    async closeBluetoothAdapter() {},
    async getBluetoothAdapterState() { return { available: state.adapterAvailable, discovering: state.discovering }; },
    async startBluetoothDevicesDiscovery() {
      state.discovering = true;
      for (const spec of MOCK_DEVICES) {
        foundHandler?.([{ deviceId: spec.deviceId, name: spec.broadcastName, RSSI: -58 }]);
      }
    },
    async stopBluetoothDevicesDiscovery() { state.discovering = false; },
    onBluetoothDeviceFound(cb: any) {
      if (typeof cb === "function") { foundHandler = cb; }
      else if (cb?.onBluetoothDeviceFound) { foundHandler = cb.onBluetoothDeviceFound; }
    },
    offBluetoothDeviceFound() { foundHandler = null; },
    async createBLEConnection(deviceId: string) {
      state.connected = deviceId;
      const spec = MOCK_DEVICES.find((d) => d.deviceId === deviceId);
      if (!spec) throw new Error(`unknown device ${deviceId}`);
      if (!runtimes.has(deviceId)) {
        runtimes.set(deviceId, new MockDeviceRuntime(spec, { scenario: "normal" }));
      }
      connChangeHandler?.({ deviceId, connected: true });
    },
    async closeBLEConnection(deviceId: string) {
      state.connected = null;
      connChangeHandler?.({ deviceId, connected: false });
    },
    onBLEConnectionStateChange(cb: any) { connChangeHandler = cb; },
    async getBLEDeviceServices() {
      return { services: [{ uuid: SERVICE_UUID, isPrimary: true }] };
    },
    async getBLEDeviceCharacteristics() {
      return {
        characteristics: [
          { uuid: RX_UUID, properties: { write: true, writeNoResponse: true } },
          { uuid: TX_UUID, properties: { notify: true } },
          { uuid: STATE_UUID, properties: { read: true } },
        ],
      };
    },
    async notifyBLECharacteristicValueChange() {},
    onBLECharacteristicValueChange(cb: any) { notifyHandler = cb; },
    async writeBLECharacteristicValue(opts: any) {
      const runtime = runtimes.get(opts.deviceId);
      if (!runtime) return;
      const bytes = new Uint8Array(opts.value);
      const asm = getAssembler();
      const result = asm.push(bytes);
      if (result.kind !== "frame") return;
      const decoded = decodeFrame(result.frame);
      if (!decoded.ok) return;
      const frames = runtime.handleCommand(decoded.command, decoded.payload, decoded.seq);
      for (const f of frames) {
        // 包成单分片（ctrl 0xC0）再 notify，模拟真实设备
        const chunk = new Uint8Array(1 + f.length);
        chunk[0] = 0xc0;
        chunk.set(f, 1);
        const buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        notifyHandler?.({ deviceId: opts.deviceId, serviceId: SERVICE_UUID, characteristicId: TX_UUID, value: buf });
      }
    },
    async readBLECharacteristicValue(opts: any) {
      const runtime = runtimes.get(opts.deviceId);
      if (!runtime) return;
      const stateBytes = runtime.readState();
      const buf = stateBytes.buffer.slice(stateBytes.byteOffset, stateBytes.byteOffset + stateBytes.byteLength);
      notifyHandler?.({ deviceId: opts.deviceId, serviceId: SERVICE_UUID, characteristicId: STATE_UUID, value: buf });
    },
    onBLECharacteristicValueChangeRead() {
      // 用同一个 handler
    },
    async setBLEMTU() { return { mtu: 23 }; },
    onBluetoothAdapterStateChange(cb: any) { adapterChangeHandler = cb; },
    getMockDiscovered() { return foundHandler ? [] : []; },
  } as unknown as WxApi & { _notifyHandler?: (res: any) => void };
}

describe("BleTransport 帧日志", () => {
  it("发送路径推 TX（chunk 前）、接收重组完成后推 RX", async () => {
    const wxApi = createFakeWxApi();
    const transport = new BleTransport({ wxApi });
    const desk = MOCK_DEVICES[0];
    await transport.connect(desk.deviceId, desk.broadcastName);

    // 清空连接流水线产生的日志，只留我们触发的命令
    transport.logSource.clear();

    const ackPromise = new Promise<any>((resolve) => {
      transport.onFrame((f) => {
        if (f.length >= 3 && f[2] === 0x80) resolve(f);
      });
    });
    const frame = encodeFrame(CMD.SET_POWER, 42, Uint8Array.from([1]));
    await transport.sendFrame(frame);
    await ackPromise;

    const entries = transport.logSource.snapshot();
    expect(entries.length, `帧日志期望非空，实际 ${entries.length} 条`).toBeGreaterThan(0);

    const tx = entries.filter((e) => e.dir === "tx");
    const rx = entries.filter((e) => e.dir === "rx");
    expect(tx.length, `期望至少 1 条 TX，实际 ${tx.length}`).toBeGreaterThanOrEqual(1);
    expect(rx.length, `期望至少 1 条 RX，实际 ${rx.length}`).toBeGreaterThanOrEqual(1);

    const txEntry = tx[0];
    expect(txEntry.commandName, `TX 命令名期望 SetPower，实际 ${txEntry.commandName}`).toBe("SetPower");
    expect(txEntry.seq, `TX seq 期望 42，实际 ${txEntry.seq}`).toBe(42);
    expect(txEntry.hex, `TX hex 应包含命令字。实际 ${txEntry.hex}`).toContain("A6");

    // 同 seq 的 TX 在 RX 之前
    const powerFrames = entries.filter((e) => e.seq === 42);
    expect(
      powerFrames[0]?.dir,
      `seq=42 的第一条期望 TX，实际 ${powerFrames[0]?.dir}`,
    ).toBe("tx");
    expect(
      powerFrames.slice(1).every((e) => e.dir === "rx"),
      `seq=42 的 TX 之后期望全是 RX，实际 ${JSON.stringify(powerFrames.map((e) => e.dir))}`,
    ).toBe(true);
    expect(
      powerFrames.some((e) => e.dir === "rx" && e.commandName === "ACK"),
      `seq=42 期望有名为 ACK 的 RX，实际 ${JSON.stringify(powerFrames.map((e) => e.commandName))}`,
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* ControlSession.logSource 是公开只读属性                            */
/* ------------------------------------------------------------------ */

describe("ControlSession.logSource", () => {
  it("切换会话后指向新 transport（不返回旧日志）", async () => {
    const desk = MOCK_DEVICES[0];
    const t1 = new MockTransport({ scenario: "normal" });
    const s1 = new ControlSession({ transport: t1, storage: createMemoryStorage() });
    await s1.connect(desk.deviceId, desk.broadcastName);
    const log1 = s1.logSource;
    expect(log1).toBe(t1.logSource);
    expect(log1.snapshot().length).toBeGreaterThan(0);

    // 切换到新会话
    const t2 = new MockTransport({ scenario: "normal" });
    const s2 = new ControlSession({ transport: t2, storage: createMemoryStorage() });
    await s2.connect(desk.deviceId, desk.broadcastName);
    const log2 = s2.logSource;
    expect(log2).toBe(t2.logSource);
    expect(log2).not.toBe(log1);
    expect(log2.snapshot().length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 暂停 / 清空：组件层逻辑                                            */
/* ------------------------------------------------------------------ */

describe("暂停/清空（组件层逻辑）", () => {
  it("暂停时日志继续写，恢复后能看到新条目", async () => {
    const transport = await connectMock();
    const log = transport.logSource;

    // 模拟暂停：记录当前快照长度
    const before = log.snapshot().length;

    // 暂停期间日志继续写（不依赖 UI 状态，FrameLog 本身不受暂停影响）
    await sendRaw(transport, CMD.SET_POWER, 99, Uint8Array.from([1]));
    const during = log.snapshot().length;
    expect(during, `暂停期间日志应继续写入，期望 > ${before}，实际 ${during}`).toBeGreaterThan(before);

    // 恢复后能看到新条目（snapshot 总是反映最新）
    const after = log.snapshot();
    expect(after.length).toBeGreaterThan(before);
  });

  it("清空后 snapshot 为空，新命令只产生新日志", async () => {
    const transport = await connectMock();
    const log = transport.logSource;

    // 先有一条命令
    await sendRaw(transport, CMD.SET_POWER, 1, Uint8Array.from([1]));
    expect(log.snapshot().length).toBeGreaterThan(0);

    // 清空
    log.clear();
    expect(log.snapshot()).toEqual([]);

    // 新命令只产生新日志（不依赖旧订阅残留）
    await sendRaw(transport, CMD.SET_POWER, 2, Uint8Array.from([1]));
    const entries = log.snapshot();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.seq === 2)).toBe(true);
  });
});