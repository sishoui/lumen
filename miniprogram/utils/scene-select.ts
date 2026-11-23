/**
 * 场景选择领域工具（#30）。
 * 控制页与场景编辑器共用：能力上限、选中/激活高亮、越界拒绝与切换后的
 * 部位归属校正只在这里定义，页面事件处理不做业务判断。
 */

import type { DeviceInfo } from "./protocol/types";
import { MAX_SCENES } from "./protocol/constants";

/** 设备允许的场景数；deviceInfo 缺失时回退协议常量。 */
export function sceneCountLimit(deviceInfo: DeviceInfo | null): number {
  return deviceInfo?.maxScenes ?? MAX_SCENES;
}

/** 场景选择器的一项；id 是 0 基场景号，label 只用于显示。 */
export interface SceneOption {
  id: number;
  label: string;
}

/** 1..maxScenes 的场景选项（0 基 id，显示用 1 基序号）。 */
export function sceneOptions(maxScenes: number): SceneOption[] {
  const count = Math.max(0, Math.floor(maxScenes));
  return Array.from({ length: count }, (_, id) => ({ id, label: `场景 ${id + 1}` }));
}

/**
 * 场景选择视图：选中与激活分开，激活场景不可从选中推导。
 * 选择落在设备能力之外（回连后 maxScenes 变小等）时夹到最后一个可用场景。
 */
export interface SceneSelection {
  selectedSceneId: number;
  activeSceneId: number;
}

export function sceneSelection(
  maxScenes: number,
  selectedSceneId: number,
  activeSceneId: number | null | undefined,
): SceneSelection {
  const last = Math.max(0, Math.floor(maxScenes) - 1);
  const clamp = (id: number): number => (
    Number.isFinite(id) ? Math.max(0, Math.min(Math.floor(id), last)) : 0
  );
  return {
    selectedSceneId: clamp(selectedSceneId),
    activeSceneId: activeSceneId == null || !Number.isFinite(activeSceneId) ? -1 : clamp(activeSceneId),
  };
}

/** 发送前拦截场景 ID 越界（#18 决策 13）。 */
export function ensureSceneIdInRange(sceneId: number, maxScenes: number): string | null {
  if (!Number.isInteger(sceneId) || sceneId < 0 || sceneId >= maxScenes) {
    return `场景 ID ${sceneId} 超出 0..${maxScenes - 1}`;
  }
  return null;
}

/** 切换场景后的当前编辑部位归属（"stripId:partId"）；新场景没有则回退 firstKey。 */
export function scenePartKeyFor(
  partKeys: readonly string[],
  currentKey: string,
  newPartKeys: readonly string[],
  firstKey: string,
): string {
  if (newPartKeys.includes(currentKey)) return currentKey;
  return newPartKeys.find((key) => partKeys.includes(key)) ?? firstKey;
}

/** 选中哪个场景按钮：选中态优先，未选中时用激活态兜底。 */
export function sceneOptionClass(
  optionId: number,
  selection: Pick<SceneSelection, "selectedSceneId" | "activeSceneId">,
): string {
  if (optionId === selection.selectedSceneId) return "selected";
  if (optionId === selection.activeSceneId) return "active";
  return "";
}