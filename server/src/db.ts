import { DatabaseSync, type StatementSync } from "node:sqlite";
import { MIGRATIONS, SCHEMA_SQL } from "./schema.ts";
import { resolveDeviceKey, type DeviceIdentityInput, type Platform } from "./identity.ts";

export type Db = DatabaseSync;

export interface UsageLogInput {
  readonly userKey: string;
  readonly displayName?: string | null;
  readonly device: DeviceIdentityInput;
  readonly startedAt: number;
  readonly endedAt?: number | null;
  readonly clientEventId: string;
  readonly reportedAt: number;
}

export interface WriteResult {
  readonly id: number;
  readonly duplicate: boolean;
  readonly deviceKey: string;
  readonly deviceKeyKind: "hardware" | "name" | "raw";
}

export interface DeviceRow {
  readonly device_key: string;
  readonly device_name: string | null;
  readonly use_count: number;
  readonly user_count: number;
  readonly last_seen_at: number;
  readonly mac_count: number;
}

export interface UserRow {
  readonly id: number;
  readonly user_key: string;
  readonly display_name: string | null;
  readonly first_seen_at: number;
  readonly last_seen_at: number;
  readonly use_count: number;
  readonly device_count: number;
}

export interface LogRow {
  readonly id: number;
  readonly user_key: string;
  readonly device_key: string;
  readonly device_name: string | null;
  readonly platform: string;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly reported_at: number;
  readonly client_event_id: string;
}

function readUserVersion(db: Db): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function writeUserVersion(db: Db, version: number): void {
  // PRAGMA 不能用参数绑定。version 由 MIGRATIONS 提供，不是外部输入。
  db.exec(`PRAGMA user_version = ${Math.trunc(version)}`);
}

/**
 * 建库 + 迁移。幂等：每次启动都调用，已是最新版时什么都不做。
 *
 * 顺序不能颠倒：先 `SCHEMA_SQL`（保证全新库有基础表），再跑增量迁移
 * （处理已有库需要补的列）。全新库跑完 SCHEMA_SQL 后 user_version 仍是 0，
 * 迁移条目必须能安全地在空表上重放。
 */
export function migrate(db: Db): void {
  db.exec(SCHEMA_SQL);

  const current = readUserVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return;

  db.exec("BEGIN");
  try {
    for (const m of pending) {
      db.exec(m.sql);
    }
    const target = Math.max(...pending.map((m) => m.version));
    writeUserVersion(db, target);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

/** 在事务里执行 fn。失败回滚并抛出原错误。不能嵌套（SQLite 不支持嵌套 BEGIN）。 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** 预编译语句缓存：同一 SQL 在热点路径上反复执行，避免每次重新 prepare。 */
const statementCache = new WeakMap<Db, Map<string, StatementSync>>();

function stmt(db: Db, sql: string): StatementSync {
  let perDb = statementCache.get(db);
  if (perDb === undefined) {
    perDb = new Map();
    statementCache.set(db, perDb);
  }
  let cached = perDb.get(sql);
  if (cached === undefined) {
    cached = db.prepare(sql);
    perDb.set(sql, cached);
  }
  return cached;
}

export function recordUsage(db: Db, input: UsageLogInput): WriteResult {
  const resolved = resolveDeviceKey(input.device);

  return inTransaction(db, () => {
    const now = input.reportedAt;
    stmt(
      db,
      `INSERT INTO users (user_key, display_name, first_seen_at, last_seen_at)
       VALUES (@userKey, @displayName, @startedAt, @startedAt)
       ON CONFLICT(user_key) DO UPDATE SET
         display_name  = COALESCE(excluded.display_name, users.display_name),
         first_seen_at = MIN(users.first_seen_at, excluded.first_seen_at),
         last_seen_at  = MAX(users.last_seen_at, excluded.last_seen_at)`,
    ).run({
      userKey: input.userKey,
      displayName: input.displayName ?? null,
      startedAt: input.startedAt,
    });

    const user = stmt(db, "SELECT id FROM users WHERE user_key = ?").get(input.userKey) as
      | { id: number }
      | undefined;
    if (user === undefined) throw new Error("users 行刚写入却读不到");

    const existing = stmt(
      db,
      "SELECT id, ended_at FROM usage_logs WHERE client_event_id = ?",
    ).get(input.clientEventId) as { id: number; ended_at: number | null } | undefined;

    if (existing !== undefined) {
      // 后补：重复 POST 带 endedAt 而库里还是 NULL 时，补一次；已有值不覆盖。
      if (existing.ended_at === null && input.endedAt != null) {
        stmt(db, "UPDATE usage_logs SET ended_at = ? WHERE id = ?").run(input.endedAt, existing.id);
      }
      return {
        id: Number(existing.id),
        duplicate: true,
        deviceKey: resolved.key,
        deviceKeyKind: resolved.kind,
      };
    }

    const info = stmt(
      db,
      `INSERT INTO usage_logs
         (user_id, device_key, device_name, device_id, platform,
          started_at, ended_at, reported_at, client_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      user.id,
      resolved.key,
      resolved.name,
      input.device.deviceId ?? null,
      input.device.platform,
      input.startedAt,
      input.endedAt ?? null,
      now,
      input.clientEventId,
    );

    const newId = Number(info.lastInsertRowid);

    // 自动收尾：同一 (用户, 设备) 上一条还开着（ended_at IS NULL）的会话，
    // 用本次开始时间关掉它。App 被杀不会留下永远开着的一行。
    stmt(
      db,
      `UPDATE usage_logs
          SET ended_at = ?
        WHERE user_id = ? AND device_key = ? AND ended_at IS NULL
          AND started_at <= ? AND id <> ?`,
    ).run(input.startedAt, user.id, resolved.key, input.startedAt, newId);

    return {
      id: newId,
      duplicate: false,
      deviceKey: resolved.key,
      deviceKeyKind: resolved.kind,
    };
  });
}

export function listDevices(db: Db): DeviceRow[] {
  return stmt(db, "SELECT * FROM v_devices ORDER BY last_seen_at DESC, device_key ASC").all() as unknown as DeviceRow[];
}

export function listUsers(db: Db): UserRow[] {
  return stmt(db, "SELECT * FROM v_users ORDER BY last_seen_at DESC, id ASC").all() as unknown as UserRow[];
}

export function listRecentLogs(db: Db, limit = 100): LogRow[] {
  return stmt(
    db,
    `SELECT l.id, u.user_key, l.device_key, l.device_name, l.platform,
            l.started_at, l.ended_at, l.reported_at, l.client_event_id
       FROM usage_logs l
       JOIN users u ON u.id = l.user_id
      ORDER BY l.started_at DESC, l.id DESC
      LIMIT ?`,
  ).all(limit) as unknown as LogRow[];
}

export function isPlatform(value: unknown): value is Platform {
  return (
    value === "android" || value === "ios" || value === "devtools" || value === "unknown"
  );
}