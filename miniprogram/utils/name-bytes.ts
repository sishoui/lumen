/**
 * 名字 UTF-8 字节数校验（部位名 / 场景名）。
 *
 * 协议（docs/protocol.md §2 `NAME_BYTES = 24`、§7.3 LayoutPart name_len ≤ 24、
 * §7.4 SceneName name_len ≤ 24）以 UTF-8 字节数计算上限，不强制字符边界。
 * 页面在输入时显示已用字节数，超限阻止提交并提示具体「X 字节，上限 24」。
 *
 * 小程序环境不一定有 TextEncoder / Buffer，这里手算 UTF-8 字节数，
 * 规则与 utils/protocol/commands.ts 的 encodeUtf8 一致：
 *   - ASCII（U+0000..U+007F）            1 字节
 *   - 拉丁补充等（U+0080..U+07FF）        2 字节
 *   - 中文/基本汉字（U+0800..U+FFFF）     3 字节
 *   - 代理对（astral / emoji 等）         4 字节
 *
 * 纯函数，无 wx / TextEncoder 依赖，L2 可直接跑。
 */

import { NAME_BYTES } from "./protocol/constants";

/** 计算字符串的 UTF-8 字节数；代理对（emoji）算 4 字节。 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // 高位代理：紧跟低位代理才成对；未成对也按 3 字节算，与 encodeUtf8 的 for..of 行为一致。
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // 孤立低位代理：未成对，按 3 字节算。
      bytes += 3;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export interface NameByteCheck {
  /** 是否通过（≤ limit） */
  ok: boolean;
  /** 已用 UTF-8 字节数 */
  bytes: number;
  /** 上限（默认 24） */
  limit: number;
  /** 不通过时的提示文案；通过时为空字符串 */
  message: string;
}

/**
 * 校验名字的 UTF-8 字节数是否 ≤ limit（默认 24）。
 * 超限 message 形如「名字是 27 字节，上限 24」，页面可直接显示。
 */
export function validateNameBytes(name: string, limit: number = NAME_BYTES): NameByteCheck {
  const bytes = utf8ByteLength(name);
  if (bytes <= limit) {
    return { ok: true, bytes, limit, message: "" };
  }
  return { ok: false, bytes, limit, message: `名字是 ${bytes} 字节，上限 ${limit}` };
}

/** 「已用 X / 24 字节」输入提示文案。 */
export function nameByteLabel(name: string, limit: number = NAME_BYTES): string {
  return `已用 ${utf8ByteLength(name)} / ${limit} 字节`;
}