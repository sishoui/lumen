import type { FastifyInstance } from "fastify";
import { checkAppToken } from "../auth.ts";
import { recordUsage, type Db } from "../db.ts";
import { validateLogPayload } from "../validate.ts";

export interface UsageRouteConfig {
  readonly db: Db;
  readonly appToken: string;
}

const APP_TOKEN_HEADER = "x-lumen-app-token";

export async function registerUsageRoutes(app: FastifyInstance, config: UsageRouteConfig): Promise<void> {
  app.post("/api/v1/usage-logs", async (request, reply) => {
    if (!checkAppToken(request.headers[APP_TOKEN_HEADER] as string | undefined, config.appToken)) {
      return reply
        .code(401)
        .send({ error: "unauthorized", message: `缺少或无效的 ${APP_TOKEN_HEADER}` });
    }

    const parsed = validateLogPayload(request.body);
    if (parsed.ok === false) {
      return reply.code(400).send({ error: "invalid_payload", details: parsed.errors });
    }

    const result = recordUsage(config.db, {
      userKey: parsed.value.userKey,
      displayName: parsed.value.displayName,
      device: parsed.value.device,
      startedAt: parsed.value.startedAt,
      endedAt: parsed.value.endedAt,
      clientEventId: parsed.value.clientEventId,
      reportedAt: Date.now(),
    });

    return reply.code(result.duplicate ? 200 : 201).send({
      id: result.id,
      duplicate: result.duplicate,
      deviceKey: result.deviceKey,
      deviceKeyKind: result.deviceKeyKind,
    });
  });
}