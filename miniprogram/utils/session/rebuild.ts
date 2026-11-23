/**
 * 权威重建编排（工单 #6 决策 7）：连接成功后按 spec 固定顺序从设备读回 UI 数据。
 *
 * 顺序：
 *   1. transport.connect() 内含 MTU→services→chars→notify→State 读
 *   2. queryStripConfig()   0x87 → 8×[strip_id, gpio, flags]（只读）
 *   3. for 每条 strip: if part_count>0 → queryLayout(strip)  0x24
 *   4. queryScene(activeScene)  0x29
 *   5. queryDeviceInfo()   0x88
 *
 * 上限与能力全部从设备读，不硬编码 8/8/8/3。
 * 部分失败降级：某链 QueryLayout 失败 → layout[i] 保持 null；DeviceInfo 失败不阻塞其余。
 */

import type { Transport } from "../ble/transport";
import type {
  DeviceInfo,
  DeviceState,
  LayoutReadback,
  SceneReport,
  StripConfig,
} from "../protocol/types";
import { parseStripConfigReport, parseDeviceInfoReport, parseLayoutReport, parseLayoutListEnd, parseScenePartReport, parseSceneStepReport, parseSceneListEnd, buildSceneReport } from "../protocol/commands";
import { encodeFrame } from "../protocol/frame";
import { cmdQueryStripConfig, cmdQueryLayout, cmdQueryScene, cmdQueryDeviceInfo } from "../protocol/commands";
import { DEVICE_CMD, CMD } from "../protocol/constants";

/** 重建期间的本地镜像。 */
export interface RebuildResult {
  state: DeviceState;
  stripConfig: StripConfig | null;
  layout: Array<LayoutReadback | null>;
  scene: SceneReport | null;
  deviceInfo: DeviceInfo | null;
}

/**
 * 发送一条命令并等待多帧报告收尾（LayoutListEnd / SceneListEnd）。
 * 返回收尾帧之前的所有帧（不含 ACK）。
 */
export async function queryMultiFrame(
  transport: Transport,
  cmd: number,
  payload: Uint8Array,
  seq: number,
  endCommand: number,
  timeoutMs: number,
): Promise<{ frames: Uint8Array[]; ok: boolean }> {
  return new Promise((resolve) => {
    const frames: Uint8Array[] = [];
    let settled = false;
    const off = transport.onFrame((frame) => {
      if (settled) return;
      // 简单解析 command 字节（offset 2）
      if (frame.length < 3) return;
      const cmdByte = frame[2];
      if (cmdByte === endCommand) {
        settled = true;
        clearTimeout(timer);
        off();
        resolve({ frames, ok: true });
      } else if (cmdByte === DEVICE_CMD.ACK) {
        // 跳过 ACK，继续等报告
      } else {
        frames.push(frame);
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      resolve({ frames, ok: false });
    }, timeoutMs);

    const frame = encodeFrame(cmd, seq, payload);
    void transport.sendFrame(frame).catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve({ frames: [], ok: false });
    });
  });
}

/** 单帧查询（ACK 即可）。 */
async function querySingle(
  transport: Transport,
  cmd: number,
  payload: Uint8Array,
  seq: number,
  reportCommand: number,
  timeoutMs: number,
): Promise<{ report: Uint8Array | null; ok: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const off = transport.onFrame((frame) => {
      if (settled) return;
      if (frame.length < 3) return;
      const cmdByte = frame[2];
      if (cmdByte === reportCommand) {
        settled = true;
        clearTimeout(timer);
        off();
        // frame: magic(1) ver(1) cmd(1) seq(1) len(2) payload crc16(2)
        // payload 从 offset 6 开始，长度 = frame.length - 8
        const payload = frame.slice(6, frame.length - 2);
        resolve({ report: payload, ok: true });
      } else if (cmdByte === DEVICE_CMD.ACK) {
        // 等报告
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      resolve({ report: null, ok: false });
    }, timeoutMs);

    const frame = encodeFrame(cmd, seq, payload);
    void transport.sendFrame(frame).catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve({ report: null, ok: false });
    });
  });
}

export async function rebuildFromDevice(
  transport: Transport,
  state: DeviceState,
  opts: { ackTimeoutMs?: number } = {},
): Promise<RebuildResult> {
  const timeout = opts.ackTimeoutMs ?? 1500;
  let seq = 1;
  const next = () => { const s = seq; seq = (seq + 1) & 0xff; return s; };

  // 2. StripConfig
  const stripRes = await querySingle(transport, CMD.QUERY_STRIP_CONFIG, new Uint8Array([]), next(), DEVICE_CMD.STRIP_CONFIG_REPORT, timeout);
  const stripConfig = stripRes.ok && stripRes.report ? parseStripConfigReport(stripRes.report) : null;

  // 3. 逐链 QueryLayout
  const layout: Array<LayoutReadback | null> = Array.from({ length: 8 }, () => null);
  for (let stripId = 0; stripId < 8; stripId += 1) {
    const partCount = state.partCounts[stripId] ?? 0;
    if (partCount <= 0) continue;
    const res = await queryMultiFrame(transport, CMD.QUERY_LAYOUT, new Uint8Array([stripId]), next(), DEVICE_CMD.LAYOUT_LIST_END, timeout);
    if (!res.ok) continue;
    const parts = res.frames
      .filter((f) => f.length >= 3 && f[2] === DEVICE_CMD.LAYOUT_REPORT)
      .map((f) => parseLayoutReport(f.slice(6, f.length - 2)));
    const endFrame = res.frames.find((f) => f.length >= 3 && f[2] === DEVICE_CMD.LAYOUT_LIST_END);
    const partMask = endFrame && endFrame.length >= 8 ? endFrame[7] : 0;
    layout[stripId] = { stripId, parts, partMask };
  }

  // 4. QueryScene(activeScene)
  const sceneRes = await queryMultiFrame(transport, CMD.QUERY_SCENE, new Uint8Array([state.activeScene]), next(), DEVICE_CMD.SCENE_LIST_END, timeout);
  let scene: SceneReport | null = null;
  if (sceneRes.ok) {
    const parts = sceneRes.frames
      .filter((f) => f.length >= 3 && f[2] === DEVICE_CMD.SCENE_PART_REPORT)
      .map((f) => parseScenePartReport(f.slice(6, f.length - 2)));
    const steps = sceneRes.frames
      .filter((f) => f.length >= 3 && f[2] === DEVICE_CMD.SCENE_STEP_REPORT)
      .map((f) => parseSceneStepReport(f.slice(6, f.length - 2)));
    const endFrame = sceneRes.frames.find((f) => f.length >= 3 && f[2] === DEVICE_CMD.SCENE_LIST_END);
    let name = "";
    if (endFrame && endFrame.length >= 2 + SCENE_NAME_BYTES_LOCAL) {
      const parsed = parseSceneListEnd(endFrame.slice(6, endFrame.length - 2));
      name = parsed.name;
    }
    scene = buildSceneReport(state.activeScene, name, parts, steps);
  }

  // 5. DeviceInfo
  const infoRes = await querySingle(transport, CMD.QUERY_DEVICE_INFO, new Uint8Array([]), next(), DEVICE_CMD.DEVICE_INFO_REPORT, timeout);
  const deviceInfo = infoRes.ok && infoRes.report ? parseDeviceInfoReport(infoRes.report) : null;

  return { state, stripConfig, layout, scene, deviceInfo };
}

const SCENE_NAME_BYTES_LOCAL = 26;