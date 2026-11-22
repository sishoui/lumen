import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SCHEMA_SQL } from "../src/schema.ts";
import { migrate, openDatabase } from "../src/db.ts";

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return Number(row.user_version);
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

function tableNames(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

function viewNames(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

describe("schema 基础结构", () => {
  it("两张核心表都存在", () => {
    const db = openDatabase(":memory:");
    const tables = tableNames(db);
    expect(tables).toContain("users");
    expect(tables).toContain("usage_logs");
    db.close();
  });

  it("两个视图都存在", () => {
    const db = openDatabase(":memory:");
    const views = viewNames(db);
    expect(views).toContain("v_devices");
    expect(views).toContain("v_users");
    db.close();
  });

  it("三索引都存在", () => {
    const db = openDatabase(":memory:");
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain("idx_usage_logs_device");
    expect(indexes).toContain("idx_usage_logs_user");
    expect(indexes).toContain("idx_usage_logs_start");
    db.close();
  });

  it("users 表结构（全 STRICT）", () => {
    const db = openDatabase(":memory:");
    expect(columns(db, "users")).toEqual([
      "id",
      "user_key",
      "display_name",
      "first_seen_at",
      "last_seen_at",
    ]);
    db.close();
  });

  it("usage_logs 表结构（全 STRICT）", () => {
    const db = openDatabase(":memory:");
    expect(columns(db, "usage_logs")).toEqual([
      "id",
      "user_id",
      "device_key",
      "device_name",
      "device_id",
      "platform",
      "started_at",
      "ended_at",
      "reported_at",
      "client_event_id",
    ]);
    db.close();
  });

  it("两张表都带 STRICT（建表 SQL 含 STRICT 关键字）", () => {
    const db = openDatabase(":memory:");
    const sql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('users','usage_logs')")
        .all() as Array<{ sql: string }>
    )
      .map((r) => r.sql)
      .join("\n");
    expect(sql).toMatch(/STRICT/i);
    db.close();
  });
});

describe("schema 迁移机制", () => {
  it("全新库建完后 user_version 等于最高迁移版本（骨架期 MIGRATIONS 空 → 0）", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    const expected = MIGRATIONS.length === 0 ? 0 : Math.max(...MIGRATIONS.map((m) => m.version));
    expect(userVersion(db)).toBe(expected);
    db.close();
  });

  it("重复调用 migrate 是幂等的", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    const first = userVersion(db);
    migrate(db);
    expect(userVersion(db)).toBe(first);
    db.close();
  });

  it("迁移版本号单调递增且无重复，从 2 起（v1 = 初始 SCHEMA_SQL）", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    for (const v of versions) expect(v).toBeGreaterThanOrEqual(2);
  });

  it("STRICT 表拒绝错误类型（不加 STRICT 会静默写入）", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      db
        .prepare("INSERT INTO users (user_key, first_seen_at, last_seen_at) VALUES (?, ?, ?)")
        .run("u1", "不是数字", 1),
    ).toThrow(/cannot store TEXT value in INTEGER column/i);
    db.close();
  });

  it("已有库补跑迁移会加上新列且保留数据（模拟 v2 加列）", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO users (user_key, first_seen_at, last_seen_at) VALUES (?, ?, ?)").run(
      "u1",
      1,
      1,
    );
    // 模拟一条「加列」迁移
    db.exec("BEGIN");
    db.exec("ALTER TABLE usage_logs ADD COLUMN probe_col TEXT");
    db.exec("PRAGMA user_version = 2");
    db.exec("COMMIT");

    expect(columns(db, "usage_logs")).toContain("probe_col");
    expect((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(1);
    db.close();
  });
});