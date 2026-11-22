# bt-light server —— 使用日志后端 + 只读看板

对应 GitHub issue：[#14 后端骨架](https://github.com/sishoui/lumen/issues/14)。

**一句话定位**：两张用户数据表（`users` / `usage_logs`）+ 两个只读视图（`v_devices` / `v_users`）。**不做归属、不做共享、不做权限、不做远程控制、不做业务处理、不存任何灯光配置。** 控制路径始终是手机 ↔ 设备的本地 BLE 直连，后端永远不在控制链路上，设备 NVS 是灯光配置的唯一真相。

本目录是自含 npm 包：自带 `package.json` / `tsconfig` / `vitest.config` / `node_modules`。根仓库只做编排（`npm --prefix server run test`）。

---

## 1. 环境要求

- **Node ≥ 24**（硬约束）。`node:sqlite` 需 ≥22.5；Node 原生 TS 类型擦除需 ≥23.6；24 是当前 LTS。
- 不需要 C++ 编译器：`node:sqlite` 是 Node 内置模块，零原生编译。

## 2. 启动

```bash
cd server
npm install

# 准备 secrets（gitignored 的 .env）
cp .env.example .env
# 编辑 .env，至少改 ADMIN_PASSWORD / APP_TOKEN 为随机值
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"  # 生成 APP_TOKEN

npm run dev      # Node 24 原生跑 TS（--watch），零构建步骤
# 或
npm run build && npm start   # tsc 编译到 dist/，跑编译产物
```

`dev` / `build+start` / `vitest` 三个入口行为一致。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `DB_PATH` | `./data/lumen.db` | SQLite 文件路径；`:memory:` 用于测试 |
| `ADMIN_USER` | **必填** | 看板 Basic Auth 用户名 |
| `ADMIN_PASSWORD` | **必填** | 看板 Basic Auth 密码 |
| `APP_TOKEN` | **必填** | 小程序上报的 `x-lumen-app-token` 头 |

三个 secrets 无默认凭据：缺失启动直接抛错退出，不给「admin/admin」这种默认。

Node 24 下 `node:sqlite` 会打 `ExperimentalWarning`，是预期噪音不是失败，Node 转正后自动消失。

## 3. 测试

```bash
npm run typecheck   # tsc 严格档零错误
npm test            # vitest run：6 个文件全走 app.inject + :memory: SQLite
```

测试不监听端口、不联网、不依赖环境变量（每个用例独立 `:memory:` 库 + 假 secrets）。`npm test` 是 L3 入口，根 `package.json` 的 `test` 末尾通过 `npm --prefix server run test` 追加。

## 4. API 速览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/healthz` | 无 | 200 `{"ok":true}` 探活 |
| POST | `/api/v1/usage-logs` | `x-lumen-app-token` 头 | 上报一条使用日志。201 新建 / 200 幂等重复 |
| GET | `/admin` | Basic | 302 重定向到 `/admin/devices` |
| GET | `/admin/devices` | Basic | v_devices 全表 HTML |
| GET | `/admin/users` | Basic | v_users 全表 HTML |
| GET | `/admin/logs` | Basic | usage_logs 最近 100 条 HTML |
| POST/PUT/PATCH/DELETE | `/admin` 与 `/admin/*` | Basic（先于 405） | 405 + `Allow: GET, HEAD` |

## 5. device_key 归一（`src/identity.ts`）

写入时归一，单点实现。查询侧 `GROUP BY device_key`，零逻辑。

优先级：`hw:…`（设备自报 6 字节 MAC）> `name:LUMEN-XXXX`（广播名）> `raw:<platform>:<deviceId>`。

- 四种 MAC 形态（`AA:BB:CC:DD:EE:FF` / `aa-bb-cc-dd-ee-ff` / `aabbccddeeff` / `0x` 前缀）→ 同一 `hw:aa:bb:cc:dd:ee:ff`。
- 全零 MAC（`00:00:00:00:00:00`）当「读到但值坏」，回落下一档，否则所有故障设备挤进同一行。
- 非法 MAC 字符串在 `validate.ts` 当作「没带 hardwareId」，不 400（使用日志是旁路）。
- `raw:` 键带 platform 段，防跨平台撞车。

## 6. 幂等（`src/db.ts` 的 `recordUsage`）

`usage_logs.client_event_id TEXT NOT NULL UNIQUE` 既是唯一约束也是幂等键。写路径单事务：

1. upsert user（first_seen_at MIN，last_seen_at MAX）。
2. SELECT by client_event_id。命中 → 若库里 ended_at 还是 NULL 而请求带了 endedAt，补一次（不覆盖已有值）；返回 200 `duplicate:true`。
3. 未命中 → INSERT 新行（201 `duplicate:false`）。
4. auto-close：同一 (user_id, device_key) 上一条还开着的会话被本次 startedAt 关掉。App 被杀留下的 open 行由下一次会话自动收尾。

## 7. 目录

```
server/
├── src/
│   ├── index.ts          # 进程入口：readEnv → ensureDbDir → openDatabase → buildApp → listen；SIGINT/SIGTERM 优雅关闭
│   ├── app.ts            # buildApp(config) → FastifyInstance（测试缝）
│   ├── config.ts         # readEnv（三秘密必填无默认）+ ensureDbDir
│   ├── db.ts             # openDatabase / migrate / recordUsage / listDevices / listUsers / listRecentLogs
│   ├── schema.ts         # SCHEMA_SQL（两表两视图三索引）+ MIGRATIONS（空起）+ user_version
│   ├── identity.ts       # resolveDeviceKey 三级归一（纯函数）
│   ├── auth.ts           # safeEqual / parseBasicAuth / checkAdminAuth / checkAppToken
│   ├── validate.ts       # validateLogPayload 判别联合（手写，无 schema 库）
│   ├── views.ts          # devicesPage / usersPage / logsPage / unauthorizedPage
│   └── routes/
│       ├── usage.ts      # POST /api/v1/usage-logs（app token → validate → recordUsage）
│       └── admin.ts      # /admin 插件（Basic Auth + 405 catch-all，prefix 封装）
└── tests/                # vitest + node:sqlite，6 个文件
```

## 8. curl smoke 清单

```bash
# 启动（先填好 .env）
cd server && npm run dev

# 1. 探活
curl -s http://127.0.0.1:8787/healthz
# → {"ok":true}

# 2. 无 token → 401
curl -si -X POST http://127.0.0.1:8787/api/v1/usage-logs -H 'content-type: application/json' -d '{}'
# → 401 {"error":"unauthorized",...}

# 3. 带 token 新建 → 201，deviceKey 是 hw: 形态
curl -si -X POST http://127.0.0.1:8787/api/v1/usage-logs \
  -H "x-lumen-app-token: $APP_TOKEN" -H 'content-type: application/json' \
  -d '{"userKey":"local-0123456789abcdef","displayName":"小明","device":{"hardwareId":"3C:71:BF:00:00:01","deviceName":"LUMEN-0001","deviceId":"AA:BB:CC:DD:1A:2B","platform":"android"},"startedAt":1760000000000,"clientEventId":"smoke-1"}'
# → 201 {"id":1,"duplicate":false,"deviceKey":"hw:3c:71:bf:00:00:01","deviceKeyKind":"hardware"}

# 4. 同 clientEventId 重发 → 200 duplicate:true
curl -si -X POST http://127.0.0.1:8787/api/v1/usage-logs \
  -H "x-lumen-app-token: $APP_TOKEN" -H 'content-type: application/json' \
  -d '{"userKey":"local-0123456789abcdef","displayName":"小明","device":{"hardwareId":"3C:71:BF:00:00:01","deviceName":"LUMEN-0001","deviceId":"AA:BB:CC:DD:1A:2B","platform":"android"},"startedAt":1760000000000,"clientEventId":"smoke-1"}'
# → 200 {"id":1,"duplicate":true,...}

# 5. 看板（Basic Auth）
curl -s -u admin:"$ADMIN_PASSWORD" http://127.0.0.1:8787/admin/devices
# → 200 HTML，含 device_key 行

# 6. 带凭据写方法 → 405 + Allow: GET, HEAD
curl -si -u admin:"$ADMIN_PASSWORD" -X POST http://127.0.0.1:8787/admin/devices
# → 405, Allow: GET, HEAD

# 7. 匿名写方法 → 401（鉴权先于 405）
curl -si -X POST http://127.0.0.1:8787/admin/devices
# → 401 + WWW-Authenticate
```

## 9. 与参考实现 lumen/server 的差异

| 项 | lumen | 本仓库 | 原因 |
|---|---|---|---|
| 表 | v1 两表两视图 + v2 devices/user_devices 登记表 | 只有 v1 两表两视图，MIGRATIONS 空起 | spec §7 不做归属/共享 |
| 身份 | /api/v1/session（code2session 或 local 回落） | 无 session 端点，userKey 随日志体上报 | spec §7 不做账号体系 |
| 健康检查 | GET /health | GET /healthz | 工单验收原文 |
| 看板页 | devices/users/registry | devices/users/logs | 工单要求 GET devices/users/logs |
| 幂等写 | ON CONFLICT DO NOTHING（无 ended_at 后补） | SELECT-then-write + ended_at 后补 | 支持「开始/结束同一 clientEventId 两次上报」 |
| dev | build 后跑 dist | Node 24 原生 TS（.ts import + rewrite 构建） | 零 tsx 依赖 |
| 405 | admin 插件 catch-all 路由 | 同（逐字继承） | lumen 44 用例已验证 |