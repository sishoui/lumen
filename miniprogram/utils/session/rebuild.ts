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
 * 收尾帧由 queryMultiFrame 直接返回，不再从正文帧里二次查找。
 */

import type { Transport } from "../ble/transport";
import type { TimerApi } from "../ble/throttle";
import type {
  DeviceInfo,
  DeviceState,
  LayoutReadback,
  SceneReport,
  StripConfig,
} from "../protocol/types";
import {
  buildSceneReport,
  parseDeviceInfoReport,
  parseLayoutListEnd,
  parseLayoutReport,
  parseSceneListEnd,
  parseScenePartReport,
  parseSceneStepReport,
  parseStripConfigReport,
} from "../protocol/commands";
import { cmdQueryDeviceInfo, cmdQueryLayout, cmdQueryScene, cmdQueryStripConfig } from "../protocol/commands";
import { CMD, DEVICE_CMD } from "../protocol/constants";
import { queryMultiFrame, querySingle } from "./query";

/** 重建期间的本地镜像。 */
export interface RebuildResult {
  state: DeviceState;
  stripConfig: StripConfig | null;
  layout: Array<LayoutReadback | null>;
  scene: SceneReport | null;
  deviceInfo: DeviceInfo | null;
}

export interface RebuildOptions {
  /** 等待单条命令 ACK 的上限（ms）。 */
  ackTimeoutMs?: number;
  /** 等待查询报告（收尾帧）的上限（ms）。 */
  reportTimeoutMs?: number;
  timer?: TimerApi;
}

export async function rebuildFromDevice(
  transport: Transport,
  state: DeviceState,
  opts: RebuildOptions = {},
): Promise<RebuildResult> {
  const queryTimeoutMs = opts.reportTimeoutMs ?? opts.ackTimeoutMs ?? 1500;
  const queryOpts = { timeoutMs: queryTimeoutMs, timer: opts.timer };
  let seq = 1;
  const next = (): number => {
    const s = seq;
    seq = (seq + 1) & 0xff;
    if (seq === 0) seq = 1;
    return s;
  };

  // 2. StripConfig
  const stripRes = await querySingle(
    transport,
    CMD.QUERY_STRIP_CONFIG,
    cmdQueryStripConfig().payload,
    next(),
    DEVICE_CMD.STRIP_CONFIG_REPORT,
    queryOpts,
  );
  const stripConfig = stripRes.ok ? parseStripConfigReport(stripRes.tail.payload) : null;

  // 3. 逐链 QueryLayout
  const layout: Array<LayoutReadback | null> = Array.from({ length: 8 }, () => null);
  for (let stripId = 0; stripId < 8; stripId += 1) {
    const partCount = state.partCounts[stripId] ?? 0;
    if (partCount <= 0) continue;
    const res = await queryMultiFrame(
      transport,
      CMD.QUERY_LAYOUT,
      cmdQueryLayout(stripId).payload,
      next(),
      DEVICE_CMD.LAYOUT_LIST_END,
      queryOpts,
    );
    if (!res.ok) continue;
    try {
      const parts = res.body
        .filter((f) => f.command === DEVICE_CMD.LAYOUT_REPORT)
        .map((f) => parseLayoutReport(f.payload));
      const end = parseLayoutListEnd(res.tail.payload);
      layout[stripId] = { stripId, parts, partMask: end.partMask };
    } catch {
      // 该链读回内容不完整：保持 null，不拿半份数据冒充成功。
    }
  }

  // 4. QueryScene(activeScene)
  const sceneRes = await queryMultiFrame(
    transport,
    CMD.QUERY_SCENE,
    cmdQueryScene(state.activeScene).payload,
    next(),
    DEVICE_CMD.SCENE_LIST_END,
    queryOpts,
  );
  let scene: SceneReport | null = null;
  if (sceneRes.ok) {
    try {
      const parts = sceneRes.body
        .filter((f) => f.command === DEVICE_CMD.SCENE_PART_REPORT)
        .map((f) => parseScenePartReport(f.payload));
      const steps = sceneRes.body
        .filter((f) => f.command === DEVICE_CMD.SCENE_STEP_REPORT)
        .map((f) => parseSceneStepReport(f.payload));
      const end = parseSceneListEnd(sceneRes.tail.payload);
      scene = buildSceneReport(state.activeScene, end.name, parts, steps);
    } catch {
      scene = null;
    }
  }

  // 5. DeviceInfo
  const infoRes = await querySingle(
    transport,
    CMD.QUERY_DEVICE_INFO,
    cmdQueryDeviceInfo().payload,
    next(),
    DEVICE_CMD.DEVICE_INFO_REPORT,
    queryOpts,
  );
  const deviceInfo = infoRes.ok ? parseDeviceInfoReport(infoRes.tail.payload) : null;

  return { state, stripConfig, layout, scene, deviceInfo };
}
