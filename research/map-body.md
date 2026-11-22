## Destination

产出一份可执行的**落地 spec**（协议契约 + 四端设计 + 测试工具链），并在本仓库落地**最小可运行骨架**（固件 / 小程序 / 后端 / 测试四端各一个能 build + 跑通 smoke test 的骨架），作为后续按 spec 写完整实现的基础。地图终点是 spec 定稿 + 骨架 smoke 通过，不含完整功能实现。

## Notes

- **领域**：BLE 直连灯控系统（微信小程序 + ESP32 + WS2812B + 可选后端）
- **范围（in scope）**：固件端、小程序端、后端（可选）、测试工具链 L1–L5
- **不在范围（out of scope）**：完整功能实现（spec 写完后的实现工作）、云端/账号/OTA/协议向后兼容（文档第 7 节已明确排除）
- **技能**：每个会话先调用 `grilling` + `domain-modeling`；研究类 ticket 调 `research`；原型类 ticket 调 `prototype`
- **仓库**：`sishoui/bt-light`（将改名为 `sishoui/lumen`，见 ticket）
- **参考**：`C:\Users\13092\Desktop\项目\zcode\lumen\项目功能文档_新.md`（系统蓝图）、`C:\Users\13092\Desktop\项目\zcode\lumen\`（参考实现，只读）
- **硬件基线**：ESP32-C3FH4（锁死，不抽象）；WS2812B GRB；最多 8 链 × 100 颗；独立 5V 供电 + 74AHCT125 电平转换
- **协议契约策略**：spec 只描述「为什么」和「边界」，具体字节向量由代码侧单点持有（沿用 lumen 的「契约三件套同 commit」模式），spec 引用不复制
- **骨架依赖**：spec 总纲 → 协议契约 → {固件骨架, 小程序骨架, 后端骨架（blocked-by 小程序骨架）} 并行
- **旧原型处置**：物理删除 + 改名 + 「继承与扬弃」写入 spec 总纲；git 历史留底
- **assignee**：所有 ticket 由执行会话 assign 给 `@sishoui`

## Decisions so far

<!-- 决策记录区；每条 closed ticket 关闭后追加一行：名称 + gist + link -->

- [研究 — 协议向量形态与跨语言消费](https://github.com/sishoui/bt-light/issues/9): 方案 B（JSON 单文件 + 双端运行时读取），gen 脚本生成 + check 脚本独立校验，两端消费同一份 `docs/protocol-testvectors.json`，版本字段三份表示（protocol_version / 帧内 0x05 / firmware_version）
- [研究 — 测试工具链方案（L4/L5 环境搭建）](https://github.com/sishoui/bt-light/issues/10): 编排器 `node scripts/test-run.mjs --release`；L1 自研框架 + fopen JSON；L2 vitest 2.1；L3 vitest 3.2 + node:sqlite；L4 miniprogram-automator（须 --auto-port）；L5 自研 Python bleak 网关 + pyserial DTR/RTS 复位；「没跑」三态 SKIP 可见性

## Not yet specified

<!-- 雾区：能感到存在但还不能精确 ticket 化的问题。随 frontier 推进逐步毕业成 ticket -->

- ~~协议字字向量的具体形态~~（已毕业为 #9 research，已 resolve；#4 协议契约可 start）
- **小程序 UI 信息架构**：连接页 / 控制页 / 部位编辑器 / 场景编辑器 / 日志面板的组织方式；依赖「小程序骨架」ticket 完成后能 sketch
- ~~L4 UI 渲染回归的具体方案~~（已毕业为 #10 research，已 resolve；#8 测试工具链可 start 但 blocked-by 其他）
- ~~L5 e2e BLE 网关的形态~~（已毕业为 #10 research，已 resolve：自研 Python bleak 网关）
- **后端 usage_log 的 device_key 归一具体实现**：依赖「小程序骨架」定下 MAC 上报方式后能精确化
- **场景编辑器的交互模型**：增量写 vs 整份写？依赖「小程序骨架」完成后能 prototype

## Out of scope

<!-- 范围外工作：刻意排除，永不毕业。仅当目的地被重画时才作为新 effort 重启 -->

- 完整功能实现（spec + 骨架之后的所有编码工作，是下一个 wayfinder effort 或 plan 的事）
- 云端控制 / 远程控制（文档第 7 节）
- 账号体系（文档第 7 节）
- 设备归属 / 共享 / 角色权限（文档第 7 节）
- OTA / 配置同步 / 灯光配置副本（文档第 7 节）
- 协议向后兼容（版本即契约，断崖升级）
- 多硬件抽象（只支持 ESP32-C3FH4）
