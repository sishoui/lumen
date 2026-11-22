import { createHash, timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export interface AdminCredentials {
  readonly user: string;
  readonly password: string;
}

export function parseBasicAuth(header: string | undefined): { user: string; password: string } | null {
  if (typeof header !== "string") return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (match === null) return null;
  const encoded = match[1];
  if (encoded === undefined) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

/** 看板鉴权：HTTP Basic。用户名/密码都在环境变量里，没有注册、没有会话。 */
export function checkAdminAuth(header: string | undefined, creds: AdminCredentials): boolean {
  const parsed = parseBasicAuth(header);
  if (parsed === null) return false;
  const userOk = safeEqual(parsed.user, creds.user);
  const passOk = safeEqual(parsed.password, creds.password);
  return userOk && passOk;
}

/**
 * 小程序写入端的应用级令牌。
 * 只能证明请求来自该构建的小程序，不能防伪造。个人测试阶段接受这一点。
 */
export function checkAppToken(header: string | undefined, expected: string): boolean {
  if (typeof header !== "string" || header.length === 0) return false;
  return safeEqual(header, expected);
}