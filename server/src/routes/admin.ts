import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { checkAdminAuth } from "../auth.ts";
import { listDevices, listRecentLogs, listUsers, type Db } from "../db.ts";
import { devicesPage, logsPage, unauthorizedPage, usersPage } from "../views.ts";

export interface AdminRouteConfig {
  readonly db: Db;
  readonly adminUser: string;
  readonly adminPassword: string;
}

export async function registerAdminRoutes(app: FastifyInstance, config: AdminRouteConfig): Promise<void> {
  const creds = { user: config.adminUser, password: config.adminPassword };

  await app.register(
    async (admin) => {
      // 鉴权先于 405：onRequest 在 handler 之前跑，匿名写方法先吃 401。
      admin.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
        const header = request.headers.authorization;
        if (!checkAdminAuth(header, creds)) {
          return reply
            .code(401)
            .header("WWW-Authenticate", 'Basic realm="lumen admin", charset="UTF-8"')
            .type("text/html; charset=utf-8")
            .send(unauthorizedPage());
        }
        return undefined;
      });

      admin.get("/", async (_request, reply) => reply.redirect("/admin/devices", 302));

      admin.get("/devices", async (_request, reply) => {
        return reply.type("text/html; charset=utf-8").send(devicesPage(listDevices(config.db)));
      });

      admin.get("/users", async (_request, reply) => {
        return reply.type("text/html; charset=utf-8").send(usersPage(listUsers(config.db)));
      });

      admin.get("/logs", async (_request, reply) => {
        return reply.type("text/html; charset=utf-8").send(logsPage(listRecentLogs(config.db, 100)));
      });

      const write405 = async (_request: FastifyRequest, reply: FastifyReply) =>
        reply.code(405).header("Allow", "GET, HEAD").send({
          error: "method_not_allowed",
          message: "只读看板不接受写操作",
        });

      admin.route({
        method: ["POST", "PUT", "PATCH", "DELETE"],
        url: "/*",
        handler: write405,
      });
      admin.route({
        method: ["POST", "PUT", "PATCH", "DELETE"],
        url: "/",
        handler: write405,
      });
    },
    { prefix: "/admin" },
  );
}