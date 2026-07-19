# Bridge Protocol v1.2

VESTI 桌面端（App）向 VESTI 浏览器扩展提供的本地通信协议。实现以 `src/main/extensionBridgeService.ts` 为准；本文档与其不一致时，以代码为准。

## 概述

- 传输：HTTP + JSON，仅绑定 `127.0.0.1`，默认端口 `28765`。不监听任何外部网卡，不 TLS（loopback 语义）。
- 内容类型：请求与响应均为 `application/json; charset=utf-8`。
- 协议版本：v1.2 / v1.1 均为 v1.0 基础上的**增量扩展**（v1.1 新增 outbox；v1.2 新增 associate 一键 TOFU 自动连接）。`/v1/status` 响应中的 `protocol` 字段恒为 `1`；客户端应通过 `capabilities` 数组做能力探测，而不是比较版本号。
- 状态持久化：客户端记录与 outbox 存于 App 的 `settings.json`（`bridge.clients` / `bridge.outbox`）。token 只以 safeStorage 密文落盘。

## 安全模型（v1.2）

仅绑定 `127.0.0.1` **不是认证**：同机任意进程都能访问该端口。v1.2 的防线是：

1. **配对窗口**：只有窗口开启时才能发起新连接（启动后自动开 10 分钟；设置页可手动再开 5 分钟）。窗口关闭时 `/v1/associate` 一律 409，本机其他进程无法静默抢连。
2. **一键 TOFU 确认**：窗口开启时的每次 associate 都同步等待用户在 App 原生对话框点「允许连接」（60 秒未操作按拒绝处理）。拒绝后 App 侧对该 clientId 冷却 10 分钟不再弹窗（仅内存，重启清零）。
3. **速率限制**：associate 按 clientId 每分钟最多 3 次（429），且全局最多 1 个待确认请求（409 busy），防止弹窗轰炸。
4. **Origin 可选项**：`settings.json` 的 `bridge.originAllowlist` 可精确钉住 `chrome-extension://<id>`；默认为空不强制——开发模式扩展 ID 随机，钉死会误伤，真正的闸门是上面的 TOFU 弹窗。
5. **Bearer token**：配对/确认成功后签发的 token 是后续 import/outbox 的唯一凭证，safeStorage 加密落盘。

## 常量

| 常量 | 值 | 说明 |
|---|---|---|
| 默认端口 | `28765` | 可用构造参数覆盖；`/v1/status` 不返回端口 |
| `MAX_IMPORT_BODY_BYTES` | 200 MiB | import 请求体上限 |
| `PAIR_CODE_TTL_MS` | 5 分钟 | 配对码有效期 |
| `IMPORT_RESPONSE_TIMEOUT_MS` | 60 秒 | import 同步应答超时（超时转 202） |
| `MAX_OUTBOX_ITEMS` | 50 | outbox 积压上限，超出丢弃最旧 |
| `MAX_OUTBOX_PROMPT_CHARS` | 20 000 | 单条 outbox prompt 字符上限 |
| pair / associate / ack 请求体上限 | 64 KiB | 各自的请求体上限 |
| `client` / `clientId` 长度上限 | 200 字符 | 配对/连接入参 |
| `STARTUP_PAIRING_WINDOW_MS` | 10 分钟 | App 启动后配对窗口自动开启时长 |
| `MANUAL_PAIRING_WINDOW_MS` | 5 分钟 | 设置页手动「打开配对窗口」时长 |
| `ASSOCIATE_CONFIRM_TIMEOUT_MS` | 60 秒 | 用户确认对话框超时（按拒绝处理） |
| `ASSOCIATE_RATE_LIMIT_PER_MINUTE` | 3 次 | 每 clientId 每分钟 associate 上限 |

## 鉴权

- `POST /v1/pair` 使用一次性配对码（见「配对码流程（兜底）」）。
- `POST /v1/associate` 使用配对窗口 + 用户一次性确认（见「自动连接（TOFU）」）。
- 其余业务端点使用 Bearer token：`Authorization: Bearer <token>`。
- token 为 24 字节随机值的 base64url 编码，配对/确认时由 App 生成并返回。App 侧只保存 `safeStorage` 加密后的密文；鉴权时逐客户端解密比对，比对使用 `timingSafeEqual`，无法解密的记录（如 OS keychain 轮换）直接跳过。
- token 不会出现在任何日志与状态接口中：`GET /v1/status` 与 App 内 `getStatus()` 均剔除了 `tokenEncrypted` 字段。

## 能力探测

### `GET /v1/status`（无鉴权）

```json
{
  "app": "vesti-desktop",
  "version": "0.3.0",
  "protocol": 1,
  "capabilities": ["pair", "import", "outbox", "associate"],
  "pairing_window": "open"
}
```

- `capabilities` 含 `"outbox"` 表示支持 v1.1 outbox 端点；含 `"associate"` 表示支持 v1.2 自动连接。v1.0 的 App 对新增路由一律应答 `404 {"error":"not_found"}`。
- `pairing_window` 为 `"open" | "closed"`（v1.2 起），扩展据此决定是发起 associate 还是提示用户去 App 打开窗口。
- 扩展可用该端点探测桌面端是否在线、是否同app（`app === "vesti-desktop"`）。扩展应轮询该端点：APP 先装、扩展后装时，等窗口开启即可自动连接。

## 自动连接（TOFU，v1.2）

一键 TOFU：扩展自动探测，App 弹一次「允许连接？」确认，之后长期免交互。

### `POST /v1/associate`

请求体：

```json
{ "client": "vesti-extension", "clientId": "<扩展侧稳定ID>" }
```

- 两个字段均为必填字符串，非空且 ≤ 200 字符，否则 `400 invalid_body`。
- **同步应答**：窗口开启时请求被挂起，直到用户在 App 对话框做出选择（最长 60 秒）：
  - 允许 → `200 { "token": "<base64url>" }`，此后凭 token 免确认；
  - 拒绝 → `403 { "error": "association_rejected" }`（App 侧对该 clientId 冷却 10 分钟不再弹窗，期间一律 403）；
  - 超时 → `403 { "error": "association_timeout" }`。
- 窗口关闭 → `409 { "error": "pairing_window_closed" }`。扩展应提示用户在 App 设置页「打开配对窗口」，并继续轮询 `/v1/status`。
- 已有其他请求等待确认 → `409 { "error": "associate_busy" }`，稍后重试即可。
- 同一 clientId 每分钟超过 3 次 → `429 { "error": "rate_limited" }`（所有 associate 尝试都计数，包括被拒绝的）。
- **重复 associate 语义（幂等）**：同一 clientId 再次 associate 会重新走窗口 + 确认流程，成功后**轮换 token**（旧 token 立即失效，记录被覆盖，与 `/v1/pair` 一致）。因此持有有效 token 的扩展不应再调用 associate；仅在 token 丢失/失效（import 返回 401）时重新 associate。
- `500 encryption_unavailable`：safeStorage 不可用。

## 浏览器通道的 CORS / Private Network Access

`/v1/status`、`/v1/pair`、`/v1/associate` 三个端点面向浏览器扩展，响应以下头部；`/v1/import`、`/v1/outbox*` 是 token 鉴权的非浏览器通道，**不**加任何 CORS 头：

- `OPTIONS` 预检应答 `204`，带 `Access-Control-Allow-Private-Network: true`、`Access-Control-Allow-Methods: GET, POST, OPTIONS`、`Access-Control-Allow-Headers: authorization, content-type`、`Access-Control-Max-Age: 600`。
- 请求 `Origin` 以 `chrome-extension://` 开头时，实际响应回 `Access-Control-Allow-Origin: <该 origin>`（精确回显）与 `Vary: Origin`；其他 origin（如普通网页）不回 ACAO，浏览器自行拦截。
- 预检中 origin 不允许时不回 ACAO（仍 204），浏览器会阻断后续实际请求。
- **Origin allowlist（可选）**：`settings.json` → `bridge.originAllowlist: string[]`。默认空 = 不强制；非空时对上述三个端点校验请求 Origin 精确匹配，不匹配的 chrome-extension origin 一律 `403 { "error": "origin_not_allowed" }`。无 Origin 头的非浏览器客户端不受影响。

## 配对码流程（兜底）

自动连接不可用时（如窗口无法打开）仍可用 6 位配对码手动连接：

1. 用户在 App 设置页「使用配对码连接」生成配对码：6 位数字（前导零补齐），5 分钟有效；**生成新码立即使旧码失效**。
2. 扩展提示用户输入配对码，并提交：

### `POST /v1/pair`

请求体：

```json
{ "code": "123456", "client": "vesti-extension", "clientId": "<扩展侧稳定ID>" }
```

- 三个字段均为必填字符串；`client` / `clientId` 非空且 ≤ 200 字符。
- 响应 `200`：`{ "token": "<base64url>" }`。
- 配对码**一次性**：校验通过后先消费再签发；同一 `clientId` 重复配对会覆盖旧记录（旧 token 随之失效）。
- 失败：`400 invalid_body`、`401 invalid_pair_code`（错误、过期或已使用）、`500 encryption_unavailable`。
- 扩展应自行安全保存 token 与 `clientId`；App 不提供 token 找回，丢失后重新配对（associate 或 pair）即可。

## 数据导入（全量 / 增量）

### `POST /v1/import`（Bearer）

请求体：

```json
{
  "format": "vesti_export.v1",
  "since": "2026-07-17T13:00:00.000Z",
  "data": { "...": "VESTI 导出包" }
}
```

- `format` 必须为 `"vesti_export.v1"`，否则 `400 unsupported_format`。
- `since` 可选，ISO 时间字符串；省略表示全量导入。类型非字符串时 `400 invalid_since`。
- `data` 必填对象，否则 `400 missing_data`。

成功响应 `200`：

```json
{ "conversations": 12, "messages": 340, "cursor": "2026-07-18T09:30:00.000Z" }
```

### 增量游标语义

- `cursor` 为本次导入记录中最新一条的捕获时间（`maxCapturedAt`，ISO 字符串）；当次无新记录时回显请求里的 `since`（都没有则为空串）。
- 扩展应持久化最近一次成功响应的 `cursor`，下次导入作为 `since` 传入。导入是**幂等**的（渲染端按 `[platform+uuid]` 合并），重复区间只会合并不会重复入库。
- 首次导入（无游标）省略 `since` 做全量；此后每日/手动增量。

### 超时语义

- 渲染端导入超过 60 秒未返回时，App 应答 `202 { "accepted": true }`。此时导入可能仍在进行；由于幂等，扩展随后以相同数据重试是安全的。
- 导入抛错（非超时）应答 `500 { "error": "import_failed" }`。

## 接力 outbox（v1.1）

outbox 是 App → 扩展方向的队列：App 内「AI 接力 → 推送浏览器」把 suggested prompt 入队，扩展轮询取出、注入目标平台输入框，成功后 ack 删除。

- App 侧入队：prompt 去空白，空串或超过 20 000 字符拒绝；`id` 单调递增（重启后从持久化最大值续排）；积压超过 50 条时丢弃最旧。
- 扩展侧应持久化「已见到的最大 id」，轮询时以 `after` 传入。

### `GET /v1/outbox?after=<id>`（Bearer）

- `after` 为**排他游标**：返回 `id > after` 的全部条目，按 id 升序。省略或为 `0` 时返回整个积压。
- `after` 必须是非负整数，否则 `400 invalid_after`。

响应 `200`：

```json
{ "items": [ { "id": 7, "prompt": "...", "createdAt": 1752820000000 } ] }
```

### `POST /v1/outbox/ack`（Bearer）

请求体：

```json
{ "ids": [7, 8] }
```

- `ids` 为必填数组，最多 200 个，元素必须是 ≥ 1 的整数，否则 `400 invalid_ids`。
- 语义：注入成功后确认删除。未知 id 直接忽略，不报错。
- 响应 `200`：`{ "acked": 2 }`（实际删除的条数）。
- 建议扩展在「注入并读回校验成功」后再 ack；ack 前崩溃的条目会在下次轮询重新出现（at-least-once 语义）。

## 错误码

所有错误响应形如 `{ "error": "<code>" }`。

| HTTP | code | 含义 |
|---|---|---|
| 400 | `invalid_body` | 请求体不是合法 JSON 对象 / 字段校验失败 |
| 400 | `empty_body` | 请求体为空 |
| 400 | `invalid_json` | JSON 解析失败 |
| 400 | `unsupported_format` | import 的 `format` 非 `vesti_export.v1` |
| 400 | `invalid_since` | `since` 类型非法 |
| 400 | `missing_data` | import 缺少 `data` |
| 400 | `invalid_after` | outbox 的 `after` 不是非负整数 |
| 400 | `invalid_ids` | ack 的 `ids` 非法（非数组 / 超 200 / 元素非正整数） |
| 401 | `invalid_pair_code` | 配对码错误、过期或已使用 |
| 401 | `unauthorized` | Bearer token 缺失或不匹配任何已配对客户端 |
| 403 | `association_rejected` | 用户在确认对话框拒绝（或该 clientId 处于拒绝冷却期 / 未配置确认回调） |
| 403 | `association_timeout` | 确认对话框 60 秒未操作，按拒绝处理 |
| 403 | `origin_not_allowed` | 配置了 `bridge.originAllowlist` 且请求 Origin 不在列表中 |
| 404 | `not_found` | 路由不存在（含对 v1.0 对端请求 outbox/associate） |
| 409 | `pairing_window_closed` | 配对窗口已关闭，无法发起自动连接 |
| 409 | `associate_busy` | 已有其他 associate 请求等待用户确认 |
| 413 | `body_too_large` | 请求体超过对应端点上限 |
| 429 | `rate_limited` | 同一 clientId 每分钟 associate 超过 3 次 |
| 500 | `encryption_unavailable` | safeStorage 不可用，无法完成配对 |
| 500 | `import_failed` | 渲染端导入抛错（非超时） |
| 500 | `internal_error` | 未分类异常 |

## 兼容性与接入建议

1. 启动时 `GET /v1/status`：校验 `app === "vesti-desktop"`，读 `capabilities` 与 `pairing_window`。
2. 无 `"outbox"` 能力时降级为仅导入（v1.0 行为），不要重试 outbox 路由；无 `"associate"` 能力时回退到配对码流程。
3. 有 `"associate"` 能力时：已持有有效 token → 直接同步；无 token 且 `pairing_window === "open"` → `POST /v1/associate` 等待用户一次性确认；窗口关闭 → 提示用户在 App 设置页「打开配对窗口」并轮询 status。associate 返回 401/丢失 token 的场景重新 associate 即可（token 轮换，旧 token 失效）。
4. 连接成功后：全量导入→进入每日增量 + outbox 轮询（参考实现：VESTI 扩展以 24 小时 alarm 做增量、2 分钟 alarm 轮询 outbox）。
5. 所有重试都安全：导入幂等、outbox at-least-once、配对码/associate 覆盖式重发。associate 注意 429/409 busy 退避。
