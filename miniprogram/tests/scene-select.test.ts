/** 场景选择领域工具（#30）：能力限制、选中/激活高亮、越界拒绝、切换后 step 归属。 */

import { describe, it, expect } from "vitest";
import {
  sceneCountLimit, sceneOptions, sceneSelection, ensureSceneIdInRange,
  scenePartKeyFor, sceneOptionClass,
} from "../utils/scene-select";
import { MAX_SCENES } from "../utils/protocol/constants";
import type { DeviceInfo } from "../utils/protocol/types";

describe("场景选择领域工具", () => {
  it("sceneCountLimit：上限来自 deviceInfo.maxScenes，缺失回退协议常量", () => {
    expect(sceneCountLimit(null), "无 deviceInfo 时回退 MAX_SCENES").toBe(MAX_SCENES);
    expect(sceneCountLimit({ maxScenes: 2 } as DeviceInfo), "有 deviceInfo 时按设备能力").toBe(2);
  });

  it("sceneOptions：按能力生成 1..N 选项，id 0 基、label 1 基", () => {
    expect(sceneOptions(3)).toEqual([
      { id: 0, label: "场景 1" },
      { id: 1, label: "场景 2" },
      { id: 2, label: "场景 3" },
    ]);
    expect(sceneOptions(2).map((o) => o.label), "maxScenes=2 只有两套").toEqual(["场景 1", "场景 2"]);
    expect(sceneOptions(0), "0 套场景为空选项").toEqual([]);
  });

  it("sceneSelection：选中与激活独立，越界选择夹到能力内", () => {
    expect(sceneSelection(3, 1, 0)).toEqual({ selectedSceneId: 1, activeSceneId: 0 });
    expect(sceneSelection(3, 0, 2), "激活场景与选中不同也能表达").toEqual({ selectedSceneId: 0, activeSceneId: 2 });
    // 回连后 maxScenes 变小：旧选择越界时夹到最后一个可用场景
    expect(sceneSelection(2, 2, 2), "maxScenes=2 时 3 越界夹到 1").toEqual({ selectedSceneId: 1, activeSceneId: 1 });
    expect(sceneSelection(3, -1, 1), "负选择夹到 0").toEqual({ selectedSceneId: 0, activeSceneId: 1 });
    expect(sceneSelection(3, 1, null), "无激活场景时为 -1（无高亮）").toEqual({ selectedSceneId: 1, activeSceneId: -1 });
  });

  it("ensureSceneIdInRange：越界在发送前拦截，原因含允许区间", () => {
    expect(ensureSceneIdInRange(0, 3)).toBeNull();
    expect(ensureSceneIdInRange(2, 3), "上限内合法").toBeNull();
    const bad = ensureSceneIdInRange(3, 3);
    expect(bad, "3 越界（0..2）").toContain("0..2");
    expect(ensureSceneIdInRange(-1, 3), "负数越界").toContain("0..2");
    expect(ensureSceneIdInRange(1.5, 3), "非整数越界").not.toBeNull();
    const tight = ensureSceneIdInRange(2, 2);
    expect(tight, "maxScenes=2 时场景 3（id=2）被拦").toContain("0..1");
  });

  it("sceneOptionClass：选中态优先于激活态，可区分", () => {
    const sel = { selectedSceneId: 1, activeSceneId: 0 };
    expect(sceneOptionClass(1, sel), "选中场景").toBe("selected");
    expect(sceneOptionClass(0, sel), "激活但未选中").toBe("active");
    expect(sceneOptionClass(2, sel), "既不选中也不激活").toBe("");
    const same = { selectedSceneId: 2, activeSceneId: 2 };
    expect(sceneOptionClass(2, same), "选中即激活时选中态优先").toBe("selected");
    expect(sceneOptionClass(2, { selectedSceneId: 2, activeSceneId: -1 })).toBe("selected");
  });

  it("scenePartKeyFor：当前部位在新场景存在则保留，否则回退第一个", () => {
    const keys = ["0:0", "0:1"];
    // 新场景两边都有 0:1：保留当前编辑部位
    expect(scenePartKeyFor(keys, "0:1", ["0:0", "0:1"], "0:0")).toBe("0:1");
    // 新场景只有 0:0：回退第一个可用
    expect(scenePartKeyFor(keys, "0:1", ["0:0"], "0:0")).toBe("0:0");
    // 新场景为空：回退 firstKey
    expect(scenePartKeyFor(keys, "0:1", [], "0:0")).toBe("0:0");
  });
});