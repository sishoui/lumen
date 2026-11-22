import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "./db.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerUsageRoutes } from "./routes/usage.ts";

export interface AppConfig {
  readonly db: Db;
  readonly adminUser: string;
  readonly adminPassword: string;
  readonly appToken: string;
  readonly logger?: boolean;
}

/** 测试缝：所有路由注册都在这里，测试通过 app.inject 走真实路由。 */
export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logger === true ? { level: "info" } : false,
    bodyLimit: 1024 * 1024,
  });

  app.get("/healthz", async () => ({ ok: true }));

  await registerUsageRoutes(app, { db: config.db, appToken: config.appToken });
  await registerAdminRoutes(app, {
    db: config.db,
    adminUser: config.adminUser,
    adminPassword: config.adminPassword,
  });

  return app;
}