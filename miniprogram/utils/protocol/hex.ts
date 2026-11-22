/** 十六进制工具。日志统一大写、空格分隔；向量比较用无分隔大写。 */

export function bytesToHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((b) => (b & 0xff).toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

/** 无分隔大写 hex，用于与测试向量的 frame_hex 逐字节比较。 */
export function bytesToCompactHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((b) => (b & 0xff).toString(16).padStart(2, "0").toUpperCase())
    .join("");
}

/** 容忍空格与冒号、大小写；长度非偶数或含非法字符返回 null。 */
export function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.replace(/[\s:]/g, "");
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    return null;
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}