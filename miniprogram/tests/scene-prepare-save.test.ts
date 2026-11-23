/**
 * #28 回归：保存顺序必须是「先校验用户输入，再归一化」。
 *
 * 修复前的 onSaveStep 先 normalizeLayer 再校验，心跳周期 200 在进入校验器
 * 前被置 0（0 = 设备默认），校验器看到合法值直接放行 —— 非法输入被吞。
 * 这里把页面保存路径抽出的纯函数 prepareLayersForSave 钉住：
 * 非法输入必须 ok=false 且带字段级错误；合法输入归一化后字段符合预期。
 */

import { describe, it, expect } from "vitest";
import { prepareLayersForSave } from "../utils/scene-editor";
import { switchEffectType } from "../utils/scene-editor";
import { EFFECT_TYPE, NO_EFFECT } from "../utils/protocol/constants";
import type { EffectLayer } from "../utils/protocol/types";

const EMPTY: EffectLayer = { type: NO_EFFECT, hue: 0, sat: 0, periodMs: 0, p5: 0, flags: 0, level: 0 };

/** 编辑器当前值 → EffectLayer，与页面 editorLayer 构造一致。 */
function edited(overrides: Partial<EffectLayer> = {}): EffectLayer {
  return {
    type: EFFECT_TYPE.BREATHING, hue: 1200, sat: 200,
    periodMs: 1000, p5: 0, flags: 0, level: 70,
    ...overrides,
  };
}

describe("#28 保存前先校验再归一化（prepareLayersForSave）", () => {
  it("心跳周期 200：ok=false，错误含 500–1500（不被 normalizeLayer 清零吞掉）", () => {
    const result = prepareLayersForSave(edited({ type: EFFECT_TYPE.HEARTBEAT, periodMs: 200 }), { ...EMPTY });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("应拒绝心跳周期 200");
    expect(result.errors.some((e) => e.field === "period")).toBe(true);
    expect(result.errors[0].message).toContain("500–1500");
  });

  it("心跳周期 500/1500：ok=true 且 period 保留", () => {
    for (const periodMs of [500, 1500]) {
      const result = prepareLayersForSave(edited({ type: EFFECT_TYPE.HEARTBEAT, periodMs }), { ...EMPTY });
      expect(result.ok, `心跳周期 ${periodMs} 应通过`).toBe(true);
      if (!result.ok) throw new Error(`心跳周期 ${periodMs} 被拒：${result.errors[0].message}`);
      expect(result.layer0.type).toBe(EFFECT_TYPE.HEARTBEAT);
      expect(result.layer0.periodMs).toBe(periodMs);
    }
  });

  it("呼吸 period=1000 → switchEffectType 切静态 → ok=true 且 periodMs=0", () => {
    const l0 = switchEffectType(edited({ type: EFFECT_TYPE.BREATHING, periodMs: 1000 }), EFFECT_TYPE.STATIC, false);
    const result = prepareLayersForSave(l0, { ...EMPTY });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("静态应合法");
    expect(result.layer0.periodMs).toBe(0);
  });

  it("熄灭：ok=true 且 hue/sat/period 全 0", () => {
    const l0 = switchEffectType(edited({ hue: 1200, sat: 200, periodMs: 1000 }), EFFECT_TYPE.OFF, false);
    const result = prepareLayersForSave(l0, { ...EMPTY });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("熄灭应合法");
    expect(result.layer0.hue).toBe(0);
    expect(result.layer0.sat).toBe(0);
    expect(result.layer0.periodMs).toBe(0);
  });

  it("level 101：ok=false 且不发送路径可用", () => {
    const result = prepareLayersForSave(edited({ level: 101 }), { ...EMPTY });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("level 101 应被拒");
    expect(result.errors.some((e) => e.field === "level")).toBe(true);
  });

  it("叠加层空层：ok=true 且 type=0xFF 全 0", () => {
    const empty = switchEffectType(edited(), NO_EFFECT, true);
    const result = prepareLayersForSave(edited({ type: EFFECT_TYPE.STATIC, periodMs: 0, hue: 500, sat: 255, level: 100 }), empty);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("叠加层空层应合法");
    expect(result.layer1).toEqual({ ...EMPTY });
  });
});