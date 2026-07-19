# Bridge Protocol v1.1

VESTI 桌面端（App）向 VESTI 浏览器扩展提供的本地通信协议。实现以 `src/main/extensionBridgeService.ts` 为准；本文档与其不一致时，以代码为准。

## 概述

- 传输：HTTP + JSON，仅绑定 `127.0.0.1`，默认端口 `28765`。不监听任何外部网卡，不 TLS（loopback 语义）。
- 内容类型：请求与响应均为 `application/json; charset=utf-8`。
- 协议版本：v1.1 是在 v1.0 基础上的**增量扩展**（新增 outbox 两个端点）。`/v1/status` 响应中的 `protocol` 字段恒为 `1`；客户端应通过 `capabilities` 数组做能力探测，而不是比较版本号。
- 状态持久化：客户端记录与 outbox 存于 App 的 `settings.json`（`bridge.clients` / `bridge.outbox`）。token 只以 safeStorage 密文落盘。

## 常量

| 常量 | 值 | 说明 |
|---|---|---|
| 默认端口 | `28765` | 可用构造参数覆盖；`/v1/status` 不返回端口 |
| `MAX_IMPORT_BODY_BYTES` | 200 MiB | import 请求体上限 |
| `PAIR_CODE_TTL_MS` | 5 分钟 | 配对码有效期 |
| `IMPORT_RESPONSE_TIMEOUT_MS` | 60 秒 | import 同步应答超时（超时转 202） |
| `MAX_OUTBOX_ITEMS` | 50 | outbox 积压上限，超出丢弃最旧 |
| `MAX_OUTBOX_PROMPT_CHARS` | 20 000 | 单条 outbox prompt 字符上限 |
| pair / ack 请求体上限 | 64 KiB | 两者各自的请求体上限 |
| `client` / `clientId` 长度上限 | 200 字符 | 配对入参 |

## 鉴权

- `POST /v1/pair` 使用一次性配对码（见「配对流程」）。
- 其余业务端点使用 Bearer token：`Authorization: Bearer <token>`。
- token 为 24 字节随机值的 base64url 编码，配对时由 App 生成并返回。App 侧只保存 `safeStorage` 加密后的密文；鉴权时逐客户端解密比对，比对使用 `timingSafeEqual`，无法解密的记录（如 OS keychain 轮换）直接跳过。
- token 不会出现在任何日志与状态接口中：`GET /v1/status` 与 App 内 `getStatus()` 均剔除了 `tokenEncrypted` 字段。

## 能力探测

### `GET /v1/status`（无鉴权）

```json
{
  "app": "vesti-desktop",
  "version": "0.3.0",
  "protocol": 1,
  "capabilities": ["pair", "import", "outbox"]
}
```

- `capabilities` 含 `"outbox"` 表示对端支持 Bridge Protocol v1.1 的 outbox 端点；v1.0 的 App 对 outbox 路由一律应答 `404 {"error":"not_found"}`。
- 扩展可用该端点探测桌面端是否在线、是否同app（`app === "vesti-desktop"`）。

## 配对流程

1. 用户在 App 设置页生成配对码：6 位数字（前导零补齐），5 分钟有效；**生成新码立即使旧码失效**。
2. 扩展提示用户输入配对码，并提交：

### `POST /v1/pair`

请求体：

```json
{ "code": "123456", "client": "vesti-extension", "clientId": "<扩展侧稳定ID>" }
```

- 三个字段均为必填字符串；`client` / `clientId` 非空且 ≤ 200 字符。
- 响应 `200`：`{ "token": "<base64url>" }`。
- 配对码**一次性**：校验通过后先消费再落库；同一 `clientId` 重复配对会覆盖旧记录（旧 token 随之失效）。
- 失败：`400 invalid_body`、`401 invalid_pair_code`（错误、过期或已使用）、`500 encryption_unavailable`。
- 扩展应自行安全保存 token 与 `clientId`；App 不提供 token 找回，丢失后重新配对即可。

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
| 404 | `not_found` | 路由不存在（含对 v1.0 对端请求 outbox） |
| 413 | `body_too_large` | 请求体超过对应端点上限 |
| 500 | `encryption_unavailable` | safeStorage 不可用，无法完成配对 |
| 500 | `import_failed` | 渲染端导入抛错（非超时） |
| 500 | `internal_error` | 未分类异常 |

## 兼容性与接入建议

1. 启动时 `GET /v1/status`：校验 `app === "vesti-desktop"`，读 `capabilities`。
2. 无 `"outbox"` 能力时降级为仅导入（v1.0 行为），不要重试 outbox 路由。
3. 配对→全量导入→进入每日增量 + outbox 轮询（参考实现：VESTI 扩展以 24 小时 alarm 做增量、2 分钟 alarm 轮询 outbox）。
4. 所有重试都安全：导入幂等、outbox at-least-once、配对码覆盖式重发。
