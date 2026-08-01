# Vesti 会员与登录服务端实施规格

- 更新时间：2026-07-27
- 状态：可直接交给后端 Agent 执行
- 目标版本：Vesti App Beta

## 0. 给执行 Agent 的指令

这是一项实现、测试和部署任务，不是调研或只写方案的任务。开始前先阅读目标服务器上已有服务、反向代理、数据库、部署脚本和密钥管理方式；在不破坏现有 LLM 代理的前提下，完成本文 P0 范围，提交代码、迁移、自动化测试、OpenAPI 文档和部署运行手册。

若服务器权限、域名或微信/QQ 凭证暂时缺失：

1. 先把不依赖真实凭证的代码、数据库、模拟 OAuth 测试、Docker 本地环境和部署脚本全部完成。
2. 使用 `.env.example` 占位，不得伪造、硬编码或提交任何 Secret。
3. 明确列出最后缺少的输入和可复制执行的上线命令。
4. 未获得授权时不得修改域名 DNS、生产数据库、现有代理服务或防火墙。

## 1. 已确定的产品规则

以下规则视为需求，不由执行 Agent 自行更改：

- Vesti App 必须登录后使用。
- 只有登录且会员有效的用户才能解锁产品能力。
- 支持用户名密码、微信和 QQ 三种登录身份；它们都归属于同一个 Vesti 用户主体。
- 用户第一次在服务端创建 Vesti 账号时，立即赠送 3 个自然月 Beta 会员。
- 赠送按服务端用户计算且只能发生一次，不按设备、安装次数或登录方式计算。
- “3 个自然月”不是 90 天。例如 1 月 31 日 10:00 UTC 注册，应在 4 月 30 日 10:00 UTC 到期。
- 会员有效区间为 `startsAt <= serverNow < expiresAt`，恰好到达 `expiresAt` 即失效。
- 服务器是账号和会员状态的唯一可信来源；不得信任 Electron 本地文件、客户端时间或客户端传入的 `isMember`。
- 当前不接支付和自动续费，但模型必须支持以后新增购买、续费、退款、管理员调整和撤销。
- Vesti 的本地会话数据仍留在用户设备上。认证服务器不得上传 AI 对话内容。

当前 App 已有 `membership.json` 本地 Beta 门禁。它只能作为开发兼容层，不能作为正式服务端会员凭证，也不能直接导入为可信会员时长。

## 2. P0 范围与非目标

### 2.1 P0 必须完成

- 服务端用户名密码注册与登录。
- 微信开放平台扫码登录。
- QQ 互联 OAuth 登录。
- 一个用户绑定多个登录身份的数据库能力；绑定接口可以在 App UI 后续开放。
- 首次注册三个月会员的事务、并发幂等和审计记录。
- Access Token、Refresh Token 轮换、退出当前设备、退出全部设备。
- 当前用户、会员状态和 App 启动 Bootstrap 接口。
- 短期离线使用所需的服务端签名会员凭证。
- 账号冻结、会员撤销和过期门禁。
- PostgreSQL 迁移、OpenAPI 3.1、自动化测试、Docker 部署、日志、监控、备份和回滚说明。
- 为现有 LLM 代理提供可验证的用户与会员凭证，但不要把认证逻辑复制进 LLM 代理。

### 2.2 暂不包含

- 微信支付、支付宝、银行卡和订阅计费。
- 自动账号合并。
- 管理后台网页。
- 手机号验证码、找回密码和邮件服务。
- 云端同步用户的本地对话内容。

未实现找回密码前，用户名密码用户忘记密码只能通过已绑定的微信/QQ登录，或由受控管理员流程处理。上线页面必须如实说明这一限制。

## 3. 交付物

执行 Agent 最终应交付：

1. 一个独立的认证服务仓库或现有后端中的独立模块，建议服务名 `vesti-auth-service`。
2. 可重复执行的 PostgreSQL 迁移和最小种子数据。
3. 完整的 `openapi.yaml`，作为 App 与服务端接口的唯一契约。
4. `.env.example`、Dockerfile、`compose.yaml` 和反向代理示例。
5. 单元测试、PostgreSQL 集成测试、OAuth 模拟测试、并发幂等测试和安全回归测试。
6. 本地开发、测试、首次部署、升级、备份、恢复、回滚运行手册。
7. 生产环境 Smoke Test 结果；真实微信/QQ凭证未就绪时，提供明确的待验证项。
8. 服务域名、镜像版本、迁移版本、Git commit、健康检查地址和已知限制。

不得把认证代码直接塞进 Electron，也不建议和 LLM 代理使用同一个进程。Beta 阶段可以部署在同一台 VPS，但应使用不同容器、不同进程、独立数据库角色和独立 Secret，以降低故障影响。

## 4. 推荐架构

```text
Vesti Electron App
  │
  │ HTTPS / Bearer Access Token
  v
api.<vesti-domain>
  │
  ├── Auth API
  │     ├── 用户名密码
  │     ├── 微信 / QQ OAuth
  │     ├── Access / Refresh Token
  │     └── App Bootstrap / 会员凭证
  │
  ├── Membership Domain
  │     ├── 首次赠送
  │     ├── 有效性计算
  │     └── 会员事件审计
  │
  ├── PostgreSQL
  └── Redis（单实例 Beta 可选；多实例和统一限流时必需）

微信开放平台 / QQ互联
  └── HTTPS callback -> Auth API -> vesti://auth/callback

现有 LLM Proxy
  └── 只验证 Auth API 签发的公钥令牌及会员声明
```

### 4.1 技术选型

推荐使用团队已有的 TypeScript 技术栈：

- Node.js：固定一个仍受支持的 LTS 版本，并在容器与 CI 中锁定。
- TypeScript 严格模式。
- Fastify 或 NestJS + Fastify；若服务器已有成熟框架，可沿用，但不得改变本文接口和安全边界。
- PostgreSQL 16 或更新的受支持版本。
- Drizzle、Kysely 或 Prisma 之一；数据库约束和 SQL 迁移仍是最终防线。
- Zod/JSON Schema 做请求和响应校验。
- Argon2id 保存密码；若部署环境无法可靠安装原生依赖，可使用 Node `scrypt`，但必须独立随机盐并保存完整参数。
- JWT 使用 Ed25519/EdDSA 或 ES256 非对称签名，禁止把对称签名 Secret 放进 App。
- 测试使用 Vitest/Jest + Testcontainers PostgreSQL，OAuth 使用本地 Mock Provider。

### 4.2 建议目录

```text
vesti-auth-service/
  src/
    app.ts
    config/
    modules/
      auth/
      users/
      oauth/
      membership/
      devices/
      admin/
      health/
    infrastructure/
      database/
      crypto/
      logging/
      rate-limit/
  migrations/
  openapi/openapi.yaml
  test/
    unit/
    integration/
    e2e/
  scripts/
    migrate.ts
    create-signing-key.ts
    membership-admin.ts
  Dockerfile
  compose.yaml
  .env.example
  README.md
  docs/runbook.md
```

## 5. 配置和 Secret

至少定义以下环境变量；具体名称可以统一调整，但必须出现在 `.env.example` 和配置校验中：

| 变量 | 必需 | 说明 |
|---|---:|---|
| `NODE_ENV` | 是 | `development/test/production` |
| `PORT` | 是 | 容器内部监听端口 |
| `PUBLIC_BASE_URL` | 是 | 如 `https://api.example.com`，禁止尾随 `/` |
| `DATABASE_URL` | 是 | 仅认证服务可用的 PostgreSQL 账号 |
| `REDIS_URL` | 否 | 多实例、分布式限流和缓存时启用 |
| `ACCESS_TOKEN_PRIVATE_KEY_FILE` | 是 | Ed25519/ES256 私钥只读挂载路径；生产优先 KMS/HSM |
| `ACCESS_TOKEN_KEY_ID` | 是 | 令牌 `kid` |
| `ENTITLEMENT_PRIVATE_KEY_FILE` | 离线开启时 | 离线会员凭证专用私钥只读挂载路径 |
| `ENTITLEMENT_KEY_ID` | 是 | 离线凭证 `kid` |
| `REFRESH_TOKEN_HASH_KEY` | 是 | 仅用于 Refresh Token HMAC |
| `REAUTH_TOKEN_HASH_KEY` | 是 | 仅用于 Reauth Token HMAC |
| `INSTALLATION_ID_HASH_KEY_V1` | 是 | 仅用于安装 ID HMAC，名称包含轮换版本 |
| `AUDIT_IP_HASH_KEY` | 是 | 仅用于审计 IP 前缀 HMAC |
| `REQUEST_FINGERPRINT_KEY` | 是 | 仅用于注册幂等指纹 HMAC |
| `ACCESS_TOKEN_ISSUER` | 是 | 固定 JWT `iss` |
| `ACCESS_TOKEN_AUDIENCES` | 是 | 固定 JWT `aud`列表 |
| `ACCESS_TOKEN_TTL_SECONDS` | 是 | 上限建议 900，仍不得越过会员到期 |
| `REFRESH_TOKEN_TTL_DAYS` | 是 | Session 绝对期限建议 30 |
| `OFFLINE_GRACE_HOURS` | 是 | `0`关闭；启用时建议且最大不超过72 |
| `SERVICE_INTROSPECTION_CREDENTIAL` | 是 | LLM Proxy 等受信服务调用 introspection；优先 mTLS |
| `CURRENT_TERMS_VERSION` | 是 | 当前用户协议版本 |
| `CURRENT_PRIVACY_VERSION` | 是 | 当前隐私政策版本 |
| `WECHAT_APP_ID` | 上线微信时 | 微信开放平台网站应用 AppID |
| `WECHAT_APP_SECRET` | 上线微信时 | 仅服务端持有 |
| `WECHAT_CALLBACK_URL` | 上线微信时 | HTTPS 回调地址 |
| `QQ_APP_ID` | 上线 QQ 时 | QQ互联 AppID |
| `QQ_APP_SECRET` | 上线 QQ 时 | 仅服务端持有 |
| `QQ_CALLBACK_URL` | 上线 QQ 时 | HTTPS 回调地址 |
| `ALLOWED_APP_VERSIONS` | 否 | 强制升级策略，初期可只记录不拦截 |
| `LOG_LEVEL` | 是 | 生产建议 `info` |

要求：

- 生产私钥优先使用 KMS/HSM；否则使用 Secret Manager、Docker Secret 或只读挂载文件。禁止进入普通环境转储、Git、镜像层、构建日志或错误上报。
- 启动时严格校验配置；生产环境缺少签名密钥或数据库配置应直接退出，不能使用默认值。
- 微信/QQ Access Token 若仅用于读取一次身份信息，读取完成后立即丢弃，不要长期保存。
- 提供密钥轮换流程，并允许当前公钥和上一把公钥同时验证一段过渡期。
- 不同用途的 HMAC Key 不得复用；轮换安装 ID Key 时用 `installation_hash_key_version`支持双读新写，不能让所有设备突然变成新设备。

## 6. PostgreSQL 数据模型

### 6.1 通用约定

- 所有主键使用 UUID。
- 所有时间使用 `timestamptz`，服务和数据库统一按 UTC 处理。
- 关键业务判断使用数据库事务时间或服务端可信时钟，不使用客户端时间。
- 用户名在业务层执行 `trim -> Unicode NFKC -> 大小写归一化`，并把归一化结果写入唯一列。
- 会员事件是追加式审计日志；应用数据库角色不能随意更新或删除。
- 是否过期根据当前时间动态计算，不依赖定时任务把状态改成 `expired`。

### 6.2 核心表

#### `users`

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(64),
  username_normalized VARCHAR(128),
  display_name VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted')),
  locale VARCHAR(16),
  timezone VARCHAR(64),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  deleted_at TIMESTAMPTZ,
  CHECK (
    (status = 'deleted' AND deleted_at IS NOT NULL)
    OR (status <> 'deleted' AND deleted_at IS NULL)
  )
);

CREATE UNIQUE INDEX users_username_normalized_unique
  ON users(username_normalized)
  WHERE username_normalized IS NOT NULL;
```

OAuth 新用户可以没有用户名；界面用经清洗的第三方昵称或随机生成的稳定显示名。昵称、头像和未验证邮箱不得作为账号合并依据。

#### `password_credentials`

```sql
CREATE TABLE password_credentials (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  password_algorithm VARCHAR(32) NOT NULL DEFAULT 'argon2id',
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ
);
```

`password_hash` 保存 Argon2id PHC 字符串或包含参数的 scrypt 结构，禁止保存明文或可逆密码。

#### `oauth_identities`

```sql
CREATE TABLE oauth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(16) NOT NULL CHECK (provider IN ('wechat', 'qq')),
  issuer VARCHAR(255) NOT NULL DEFAULT '',
  client_id VARCHAR(128) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  union_subject VARCHAR(255),
  display_name VARCHAR(255),
  avatar_url TEXT,
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  last_login_at TIMESTAMPTZ,
  UNIQUE(provider, issuer, client_id, subject)
);

CREATE INDEX oauth_identities_user_id_idx ON oauth_identities(user_id);
```

微信 `subject` 保存当前应用的 `openid`，可信时额外保存 `unionid`；QQ 保存 QQ互联返回的应用范围用户标识。`client_id` 必须进入唯一约束。`profile`只能保存经过字段白名单和长度限制的最小资料；默认不要永久保存 Provider 原始响应。头像 URL、昵称不再需要时应清除，并纳入隐私清单和保留期限。

#### `membership_plans`、`memberships`

```sql
CREATE TABLE membership_plans (
  code VARCHAR(64) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  available_for_signup BOOLEAN NOT NULL DEFAULT TRUE,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
);

INSERT INTO membership_plans(code, name, features)
VALUES ('beta', 'Vesti Beta', '{"appAccess": true}'::jsonb)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE memberships (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_code VARCHAR(64) NOT NULL REFERENCES membership_plans(code),
  status VARCHAR(16) NOT NULL DEFAULT 'enabled'
    CHECK (status IN ('enabled', 'revoked')),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  trial_granted_at TIMESTAMPTZ,
  auto_renew BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at TIMESTAMPTZ,
  revoked_reason VARCHAR(128),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CHECK (ends_at > starts_at),
  CHECK (
    (status = 'enabled' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX memberships_ends_at_idx ON memberships(ends_at);
```

种子迁移执行后必须断言 `beta` 的名称与 Feature 值符合发布版本；不能因为 `ON CONFLICT DO NOTHING`而静默保留意外配置。

`available_for_signup`只控制是否允许新开通，不影响已经存在的会员。在线门禁使用当前 SQL 语句的可信时间，会员可用条件固定为：

```sql
users.status = 'active'
AND memberships.status = 'enabled'
AND memberships.starts_at <= statement_timestamp()
AND statement_timestamp() < memberships.ends_at
```

#### `membership_events`

```sql
CREATE TABLE membership_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  event_type VARCHAR(64) NOT NULL,
  event_key VARCHAR(128) NOT NULL,
  plan_code VARCHAR(64) REFERENCES membership_plans(code),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  effective_at TIMESTAMPTZ NOT NULL,
  starts_at_before TIMESTAMPTZ,
  ends_at_before TIMESTAMPTZ,
  starts_at_after TIMESTAMPTZ,
  ends_at_after TIMESTAMPTZ,
  actor_type VARCHAR(32) NOT NULL
    CHECK (actor_type IN ('system', 'user', 'admin', 'payment', 'migration')),
  actor_id VARCHAR(255),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(user_id, event_key),
  CHECK (
    event_type <> 'initial_trial_granted'
    OR event_key = 'initial_signup_trial:v1'
  )
);

CREATE INDEX membership_events_user_time_idx
  ON membership_events(user_id, occurred_at DESC);

CREATE UNIQUE INDEX membership_events_one_initial_trial_per_user
  ON membership_events(user_id)
  WHERE event_type = 'initial_trial_granted';
```

首次赠送必须固定使用 `event_type='initial_trial_granted'` 和 `event_key='initial_signup_trial:v1'`。Check 与部分唯一索引共同构成防止同一用户重复领取的数据库最后防线。`0010_indexes_and_permissions.sql` 必须撤销应用角色对该表的 `UPDATE/DELETE`，只允许领域服务所需的 `SELECT/INSERT`，并用真实数据库角色测试。

#### `devices`、`auth_sessions` 与 `refresh_tokens`

```sql
CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id_hash BYTEA NOT NULL,
  device_name VARCHAR(255),
  platform VARCHAR(32),
  os_version VARCHAR(128),
  app_version VARCHAR(64),
  device_public_key BYTEA,
  device_key_algorithm VARCHAR(32),
  device_key_version INTEGER,
  installation_hash_key_version INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  revoked_at TIMESTAMPTZ,
  UNIQUE(user_id, installation_id_hash),
  UNIQUE(id, user_id),
  CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  ),
  CHECK (
    (device_public_key IS NULL AND device_key_algorithm IS NULL AND device_key_version IS NULL)
    OR (device_public_key IS NOT NULL AND device_key_algorithm IS NOT NULL AND device_key_version IS NOT NULL)
  )
);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  registration_request_id UUID,
  status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_reason VARCHAR(64),
  UNIQUE(id, user_id),
  FOREIGN KEY(device_id, user_id) REFERENCES devices(id, user_id),
  CHECK (absolute_expires_at > created_at),
  CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,
  token_hash_key_version INTEGER NOT NULL DEFAULT 1,
  parent_token_id UUID,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_reason VARCHAR(64),
  UNIQUE(id, session_id),
  FOREIGN KEY(parent_token_id, session_id)
    REFERENCES refresh_tokens(id, session_id),
  CHECK (expires_at > issued_at)
);

CREATE TABLE reauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  session_id UUID NOT NULL,
  purpose VARCHAR(32) NOT NULL
    CHECK (purpose IN ('identity_link', 'identity_unlink', 'password_change', 'account_delete')),
  token_hash BYTEA NOT NULL UNIQUE,
  token_hash_key_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  FOREIGN KEY(session_id, user_id) REFERENCES auth_sessions(id, user_id),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + INTERVAL '10 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE UNIQUE INDEX refresh_tokens_parent_once
  ON refresh_tokens(parent_token_id)
  WHERE parent_token_id IS NOT NULL;

CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_device_idx ON auth_sessions(device_id);
CREATE INDEX auth_sessions_registration_request_idx ON auth_sessions(registration_request_id);
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens(session_id);
CREATE INDEX reauth_tokens_session_idx ON reauth_tokens(session_id);
```

App 首次安装生成随机 `installationId` 并保存在系统安全存储；不要采集 MAC、主板号等硬件指纹。服务端只保存带版本、独立用途密钥计算的安装 ID HMAC。一个 `auth_sessions` 对应一次登录和一个 Refresh Token Family，JWT `sid`固定等于 `auth_sessions.id`。所有后继 Refresh Token 继承 Session 的 `absolute_expires_at`，轮换不会重新获得 30 天。Refresh Token 与 Reauth Token 都使用至少 256 bit CSPRNG，数据库只保存用途隔离的 HMAC。Reauth Token绑定 `user_id + session_id + 单一 purpose`，最多10分钟、只能原子消费一次；Session吊销时同步吊销未消费 Reauth Token。

#### `oauth_transactions`

```sql
CREATE TABLE oauth_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(16) NOT NULL CHECK (provider IN ('wechat', 'qq')),
  purpose VARCHAR(16) NOT NULL CHECK (purpose IN ('login', 'link', 'reauth')),
  target_user_id UUID REFERENCES users(id),
  source_session_id UUID,
  reauth_token_id UUID REFERENCES reauth_tokens(id),
  requested_reauth_purpose VARCHAR(32)
    CHECK (requested_reauth_purpose IN ('identity_link', 'identity_unlink', 'password_change', 'account_delete')),
  device_installation_hash BYTEA NOT NULL,
  client_state VARCHAR(128) NOT NULL,
  terms_version VARCHAR(64) NOT NULL,
  privacy_version VARCHAR(64) NOT NULL,
  consent_asserted_at TIMESTAMPTZ,
  browser_start_token_hash BYTEA NOT NULL UNIQUE,
  browser_started_at TIMESTAMPTZ,
  provider_state_hash BYTEA UNIQUE,
  pkce_challenge VARCHAR(128) NOT NULL,
  poll_secret_hash BYTEA NOT NULL UNIQUE,
  ticket_hash BYTEA UNIQUE,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'consumed', 'failed', 'expired')),
  completed_user_id UUID REFERENCES users(id),
  error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  ticket_expires_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  FOREIGN KEY(source_session_id, target_user_id)
    REFERENCES auth_sessions(id, user_id),
  CHECK (expires_at > created_at),
  CHECK (
    (browser_started_at IS NULL AND provider_state_hash IS NULL)
    OR (browser_started_at IS NOT NULL AND provider_state_hash IS NOT NULL)
  ),
  CHECK (browser_started_at IS NULL OR consent_asserted_at IS NOT NULL),
  CHECK (
    (purpose = 'login' AND target_user_id IS NULL AND source_session_id IS NULL)
    OR (purpose IN ('link', 'reauth') AND target_user_id IS NOT NULL AND source_session_id IS NOT NULL)
  ),
  CHECK (
    (purpose = 'link' AND reauth_token_id IS NOT NULL)
    OR (purpose <> 'link' AND reauth_token_id IS NULL)
  ),
  CHECK (
    (purpose = 'reauth' AND requested_reauth_purpose IS NOT NULL)
    OR (purpose <> 'reauth' AND requested_reauth_purpose IS NULL)
  ),
  CHECK (
    purpose = 'login'
    OR completed_user_id IS NULL
    OR completed_user_id = target_user_id
  ),
  CHECK (ticket_expires_at IS NULL OR completed_at IS NULL OR ticket_expires_at > completed_at),
  CHECK (
    (
      status = 'pending'
      AND completed_user_id IS NULL
      AND completed_at IS NULL
      AND ticket_hash IS NULL
      AND ticket_expires_at IS NULL
      AND consumed_at IS NULL
      AND error_code IS NULL
    )
    OR (
      status = 'completed'
      AND completed_user_id IS NOT NULL
      AND completed_at IS NOT NULL
      AND ticket_hash IS NOT NULL
      AND ticket_expires_at IS NOT NULL
      AND consumed_at IS NULL
    )
    OR (
      status = 'consumed'
      AND completed_user_id IS NOT NULL
      AND completed_at IS NOT NULL
      AND ticket_hash IS NOT NULL
      AND ticket_expires_at IS NOT NULL
      AND consumed_at IS NOT NULL
    )
    OR (status = 'failed' AND error_code IS NOT NULL AND consumed_at IS NULL)
    OR (status = 'expired' AND consumed_at IS NULL)
  )
);
```

Browser Start Token、Provider State、poll secret 和一次性 ticket 都只保存哈希。`consent_asserted_at`初始必须为 NULL，只有用户在 Vesti HTTPS 页面明确点击同意后才由服务器写入；随后才能启动 Provider 授权，禁止创建 Flow 就伪记同意。Authorize 路由必须原子消费 Browser Start Token，不能只凭 Flow ID 反复启动授权。Provider Flow 默认 10 分钟过期，ticket 默认 60 秒过期，成功兑换后不可再次使用。`client_state`只是回传给发起 App 的随机关联值，不是 Provider State；限制为固定 Base64URL 格式并在日志中脱敏。定时清理 24 小时前的终态事务。

#### `registration_requests` 与 `audit_events`

```sql
CREATE TABLE registration_requests (
  idempotency_key UUID PRIMARY KEY,
  request_fingerprint BYTEA NOT NULL,
  user_id UUID REFERENCES users(id),
  status VARCHAR(16) NOT NULL CHECK (status IN ('processing', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'processing' AND completed_at IS NULL)
    OR
    (status = 'completed' AND user_id IS NOT NULL AND completed_at IS NOT NULL)
  )
);

ALTER TABLE auth_sessions
  ADD CONSTRAINT auth_sessions_registration_request_fk
  FOREIGN KEY(registration_request_id)
  REFERENCES registration_requests(idempotency_key);

CREATE TABLE consent_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  document_type VARCHAR(32) NOT NULL
    CHECK (document_type IN ('terms', 'privacy')),
  document_version VARCHAR(64) NOT NULL,
  consent_method VARCHAR(32) NOT NULL,
  request_id UUID,
  consented_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  withdrawn_at TIMESTAMPTZ,
  UNIQUE(user_id, document_type, document_version)
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID,
  user_id UUID REFERENCES users(id),
  event_type VARCHAR(64) NOT NULL,
  outcome VARCHAR(16) NOT NULL,
  ip_prefix_hash BYTEA,
  user_agent VARCHAR(512),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
);
```

注册请求要求 `Idempotency-Key: <UUID>`。请求指纹必须由服务端使用 HMAC 覆盖流程版本、规范化用户名、密码、安装 ID 和会影响业务结果的字段；只保存 HMAC，不能保存原始密码或普通 SHA-256。重复键且请求不同返回 `409 IDEMPOTENCY_KEY_REUSED`。用户名和 OAuth 新注册都必须在创建账号的同一事务中写入当时有效的用户协议与隐私政策版本；Provider 授权本身不等于同意 Vesti 协议。

### 6.3 迁移顺序

建议拆成只增不改的迁移：

```text
0001_extensions.sql
0002_users_and_credentials.sql
0003_oauth_identities.sql
0004_membership_plans.sql
0005_memberships_and_events.sql
0006_devices_sessions_and_tokens.sql
0007_oauth_transactions.sql
0008_registration_consent_and_audit.sql
0009_calendar_month_function.sql
0010_indexes_and_permissions.sql
```

CI 同时验证空库迁移和从上一版本升级；服务启动不得静默执行破坏性迁移。生产迁移前备份，失败必须可回滚应用版本和恢复数据库。

## 7. 领域规则和事务

### 7.1 三个自然月

统一实现 `addUtcCalendarMonths(source, 3)`，规则必须和当前 App 一致：

1. 读取 UTC 年、月、日和时间。
2. 把月份增加 3。
3. 如果目标月份没有源日期，则截断到目标月份最后一天。
4. 保留 UTC 时、分、秒和毫秒。

必须覆盖以下测试：

| 开通时间（UTC） | 到期时间（UTC） |
|---|---|
| `2026-01-31T10:00:00Z` | `2026-04-30T10:00:00Z` |
| `2025-11-30T10:00:00Z` | `2026-02-28T10:00:00Z` |
| `2027-11-30T10:00:00Z` | `2028-02-29T10:00:00Z` |
| `2024-02-29T10:00:00Z` | `2024-05-29T10:00:00Z` |
| `2026-12-31T23:59:59Z` | `2027-03-31T23:59:59Z` |

禁止使用客户端时间、`90 * 24h`，也不要受服务器所在时区影响。

迁移中提供唯一数据库实现，避免 JavaScript `setUTCMonth()` 的月末溢出和毫秒/微秒误差：

```sql
CREATE OR REPLACE FUNCTION add_utc_calendar_months(
  source_time TIMESTAMPTZ,
  month_count INTEGER
)
RETURNS TIMESTAMPTZ
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT (
    (source_time AT TIME ZONE 'UTC')
    + make_interval(months => month_count)
  ) AT TIME ZONE 'UTC';
$$;
```

注册事务读取一次 `transaction_timestamp()`，让 `users.registered_at`、`memberships.starts_at` 和首次事件 `effective_at` 使用同一个值；`memberships.ends_at=add_utc_calendar_months(starts_at, 3)`。在线门禁则使用每条语句的 `statement_timestamp()`，避免长事务跨过到期点后仍按事务开始时间放行。

### 7.2 首次注册事务

用户名注册和 OAuth 首次登录必须共用同一个领域用例，例如 `createUserWithInitialMembership()`。建议流程：

1. 在事务外完成耗时的密码哈希，但不写数据。
2. 开启数据库事务；需要时使用 `SERIALIZABLE` 并只对可重试的序列化错误重试有限次数。
3. 在当前事务中执行 `INSERT ... ON CONFLICT DO NOTHING` 创建 `registration_requests`，随后对该 Key `SELECT ... FOR UPDATE`，不得在另一个事务预先留下永久 `processing`。
4. 插入 `users`。
5. 插入 `password_credentials` 或 `oauth_identities`。
6. 只读取一次 `transaction_timestamp()` 作为开通时间。
7. 先插入唯一的 `initial_signup_trial:v1` 会员事件；只有 `INSERT ... RETURNING`确实返回新事件时才创建/更新会员投影。
8. 插入 `memberships`，到期时间为开通时间后 3 个 UTC 自然月。
9. Upsert 当前设备并创建 `auth_sessions`与初始 Refresh Token，把 `registration_request_id`关联到 Session。
10. 标记幂等请求完成并提交。
11. 提交后才返回令牌。

任何一步失败必须整体回滚，不允许出现“用户存在但无会员”“有会员但无事件”或“OAuth 身份已占用但用户未完成”的半成品。以后支付、续期和管理员调整也必须先原子保留唯一事件，再更新投影；不能先延长到期时间再用 `ON CONFLICT DO NOTHING` 写事件。

### 7.3 幂等和并发

- 相同 `Idempotency-Key` 和相同请求应得到同一个用户与会员结果，但不要求字节级重放原 Token 响应；不得保存旧 Refresh Token 明文。
- 相同幂等键但请求指纹不同，返回 `409 IDEMPOTENCY_KEY_REUSED`。
- 相同用户名的并发注册以数据库唯一约束决定唯一成功者。
- 相同 OAuth 身份的重复或并发回调最终只能对应一个用户。
- 修改会员前用 `SELECT ... FOR UPDATE` 锁定该用户的会员投影，并递增 `version`。
- 注册、支付回调、管理员调整以后都必须有稳定、唯一的事件键。
- 禁止使用没有唯一约束兜底的“先查不存在，再插入”逻辑。

注册请求重试的精确行为：

1. 新插入幂等记录：继续正常注册。
2. 已存在且指纹不同：回滚并返回 409。
3. 已存在且仍在处理中：短暂等待/重试锁，不创建第二个用户。
4. 已完成且指纹相同：重新验证注册证明；吊销该 `registration_request_id`关联而客户端可能未收到的初始 Session，创建并返回一个新 Session，不创建用户、不赠送会员。

OAuth 首次注册的稳定幂等键由服务端 OAuth Flow ID 派生，不能信任客户端自行提供。

### 7.4 身份绑定

- 未登录用户使用一个从未出现的微信/QQ身份：创建 Vesti 用户并首次赠送。
- 身份已经存在：只登录对应用户，更新 `last_login_at`，不延长会员。
- 已登录用户主动绑定另一身份：绑定到当前 `user_id`，不创建用户、不赠送。
- 身份已属于其他用户：返回 `409 IDENTITY_ALREADY_BOUND`，不自动合并。
- 不得根据昵称、头像或相同用户名合并账号。
- 删除最后一个可登录身份之前，必须先设置密码或绑定另一身份。

Beta 阶段的赠送只能保证“每个 Vesti 用户一次”。若产品要求严格限制“每个自然人一次”，仅凭用户名、微信和 QQ 无法彻底防刷，需要另行引入手机号验证或风控；不要在本任务中暗中收集硬件指纹。

## 8. HTTP API 契约

### 8.1 通用规范

- Base URL：`https://api.<domain>/v1`
- JSON 字段统一使用 `camelCase`，OpenAPI 必须与实际响应一致。
- 时间统一返回 RFC 3339 UTC 字符串，例如 `2026-07-27T10:00:00.000Z`。
- 认证头：`Authorization: Bearer <accessToken>`。
- 客户端头：`X-Vesti-App-Version`、`X-Vesti-Platform`、`X-Request-Id`。
- 注册等非幂等写操作使用 `Idempotency-Key: <UUID>`。
- 服务端为每个请求生成或沿用合法的 Request ID，并在响应头返回。
- 不接受客户端传入任意 OAuth `redirectUri`。
- Access Token `aud`、会员到期、账号/会员状态都必须由服务端验证；CORS 不是鉴权手段。

统一错误格式：

```json
{
  "error": {
    "code": "AUTH_INVALID_CREDENTIALS",
    "message": "用户名或密码不正确",
    "retryable": false,
    "requestId": "uuid",
    "details": {}
  }
}
```

生产环境 `message` 不得泄露数据库、Provider 返回体、堆栈或账号是否存在。

### 8.2 端点总表

| 方法 | 路径 | 认证 | 用途 |
|---|---|---:|---|
| `GET` | `/health/live` | 否 | 进程存活，不泄露配置 |
| `GET` | `/health/ready` | 内网/探针 | 数据库等依赖就绪 |
| `GET` | `/.well-known/jwks.json` | 否 | Access Token 公钥和轮换 |
| `GET` | `/.well-known/vesti-entitlement-jwks.json` | 否 | 离线凭证公钥和轮换 |
| `GET` | `/legal/documents/current` | 否 | 当前协议版本和公开链接 |
| `POST` | `/auth/register` | 否 | 用户名密码注册并首次赠送 |
| `POST` | `/auth/login` | 否 | 用户名密码登录 |
| `POST` | `/auth/token/refresh` | Refresh Token | 轮换令牌 |
| `POST` | `/auth/introspect` | 仅受信服务身份 | LLM Proxy 在线查询账号/会员状态 |
| `POST` | `/auth/logout` | Body 中的 Refresh Token | 退出当前会话，幂等 |
| `POST` | `/auth/logout-all` | Access Token | 吊销用户所有会话 |
| `POST` | `/auth/reauth/password` | Access Token + 当前密码 | 获取 10 分钟单用途 Reauth Token |
| `POST` | `/auth/password/change` | Access + Reauth Token | 修改密码并轮换全部会话 |
| `GET` | `/auth/me` | Access Token | 用户和已绑定身份 |
| `GET` | `/membership/me` | Access Token | 权威会员状态 |
| `GET` | `/app/bootstrap` | Access Token | App 启动所需用户、会员和离线凭证 |
| `POST` | `/auth/oauth/desktop-flows` | 否 | 创建微信/QQ桌面登录事务 |
| `GET` | `/auth/oauth/:provider/authorize` | 浏览器事务 | 跳转 Provider |
| `GET` | `/auth/oauth/:provider/callback` | Provider | Provider 固定回调 |
| `POST` | `/auth/oauth/desktop-flows/:id/exchange` | 一次性 code + PKCE | 换 Vesti Token |
| `POST` | `/auth/oauth/desktop-flows/:id/poll` | poll secret | Deep Link 失败兜底 |
| `DELETE` | `/auth/oauth/desktop-flows/:id` | poll secret | 取消事务 |
| `POST` | `/auth/identities/oauth/desktop-flows` | Access + Reauth Token | 绑定新身份 |
| `DELETE` | `/auth/identities/:provider` | Access + Reauth Token | 解绑身份 |
| `GET` | `/devices` | Access Token | 查看设备会话 |
| `DELETE` | `/devices/:id` | Access Token | 吊销指定设备 |
| `DELETE` | `/account` | Access + Reauth Token | 注销账号 |

两个 JWKS 路径不放在 `/v1` 下。响应必须带合理的缓存头；密钥轮换时先发布新公钥、再开始签名、最后在所有旧令牌过期后移除旧公钥。

### 8.3 注册

```http
POST /v1/auth/register
Idempotency-Key: 1fcd3ea0-...
```

```json
{
  "username": "vesti_user",
  "password": "a long password",
  "locale": "zh-CN",
  "consent": {
    "termsVersion": "2026-07-27",
    "privacyVersion": "2026-07-27",
    "accepted": true
  },
  "device": {
    "installationId": "random UUID stored by the App",
    "name": "DESKTOP-ABC",
    "platform": "windows",
    "osVersion": "Windows 11",
    "appVersion": "0.3.0",
    "publicKey": "base64url installation public key",
    "keyAlgorithm": "Ed25519",
    "keyVersion": 1
  }
}
```

用户名 NFKC 规范化后 3～32 个字符，首尾是字母或数字，中间可使用 `.`、`_`、`-`。生产密码下限设为 12、上限 256 字符，并允许密码管理器粘贴；当前本地 App 的 8 位提示在服务端接入时必须同步升级。服务端确认协议版本是当前可接受版本，并以自己的事务时间记录同意。
离线凭证启用时，设备公钥三字段必填且必须通过格式/算法白名单校验；完全在线模式可以省略。

成功返回 `201`：

```json
{
  "user": {
    "id": "uuid",
    "username": "vesti_user",
    "displayName": "vesti_user",
    "loginMethods": ["password"]
  },
  "membership": {
    "planCode": "beta",
    "state": "active",
    "canUseApp": true,
    "memberSince": "2026-07-27T10:00:00.000Z",
    "expiresAt": "2026-10-27T10:00:00.000Z",
    "daysRemaining": 92,
    "serverTime": "2026-07-27T10:00:00.000Z"
  },
  "tokens": {
    "accessToken": "ey...",
    "tokenType": "Bearer",
    "accessExpiresIn": 900,
    "refreshToken": "opaque-random-token",
    "refreshExpiresIn": 2592000,
    "sessionId": "uuid"
  },
  "entitlementReceipt": "signed-JWS"
}
```

### 8.4 登录、刷新与退出

`POST /auth/login` 使用和注册相同的 `username/password/device` 结构。用户不存在和密码错误统一返回 `401 AUTH_INVALID_CREDENTIALS`。

```http
POST /v1/auth/token/refresh
```

```json
{
  "refreshToken": "opaque-random-token",
  "installationId": "installation UUID"
}
```

刷新成功返回全新的 Access Token 和 Refresh Token。服务端在同一事务内锁定旧 Token、标记 `consumed_at`、创建后继 Token；若旧 Token 已被消费却再次出现，返回 `401 REFRESH_TOKEN_REUSED` 并吊销整个 `auth_sessions`。所有后继 Token 继承 Session 的 30 天绝对到期，`refreshExpiresIn`返回剩余秒数，不在每次轮换时重置。

`POST /auth/logout`不要求尚未过期的 Access Token，JSON Body 接收当前 Refresh Token并吊销对应 Session；无论已经吊销与否都返回 `204`。`POST /auth/logout-all`使用 Access Token吊销该用户全部 Session。App 即使遇到网络错误也应删除本地凭证。客户端必须对 Refresh 请求做 single-flight，避免一次网络超时后的并发重试被识别为 Token 重放。

敏感操作使用 10 分钟、单用途、服务端可撤销且一次性的 Reauth Token。密码用户调用：

```http
POST /v1/auth/reauth/password
Authorization: Bearer <accessToken>

{
  "password": "current password",
  "purpose": "identity_link"
}
```

成功返回：

```json
{
  "reauthToken": "opaque random token",
  "purpose": "identity_link",
  "expiresIn": 600
}
```

OAuth-only 用户通过 `purpose='reauth'` 的完整 Provider Flow 获取相同结构，而不是创建新登录 Session或再次赠送会员。调用敏感接口时在 `X-Vesti-Reauth-Token`头中提交；服务端验证 `sub/user_id`、`sid/session_id`、精确 purpose、有效期、未撤销和未消费，并在目标操作同一事务内原子消费。绑定/解绑开始与回调完成时都必须再次确认目标用户、原 Session 和 Reauth Token 有效。

`POST /auth/password/change`接收 `newPassword`并要求 `purpose='password_change'`的 Reauth Token。成功事务中更新哈希、递增凭证版本、吊销所有旧 Session和 Reauth Token，再为当前设备创建一个新 Session并返回新 Token Pair；不得让旧 Refresh Token继续使用。

### 8.5 会员与 Bootstrap

`GET /membership/me` 和 `GET /app/bootstrap` 必须即时依据服务端账号和会员记录计算，不接受客户端状态。二者响应不可混用：

`GET /membership/me`只返回：

```json
{
  "membership": {
    "planCode": "beta",
    "state": "active",
    "canUseApp": true,
    "memberSince": "2026-07-27T10:00:00.000Z",
    "expiresAt": "2026-10-27T10:00:00.000Z",
    "daysRemaining": 92,
    "version": 1
  },
  "serverTime": "2026-07-27T10:00:00.000Z"
}
```

`GET /app/bootstrap`返回完整启动信息：

```json
{
  "user": {
    "id": "uuid",
    "username": "vesti_user",
    "displayName": "Vesti User",
    "loginMethods": ["password", "wechat"]
  },
  "membership": {
    "planCode": "beta",
    "state": "active",
    "canUseApp": true,
    "memberSince": "2026-07-27T10:00:00.000Z",
    "expiresAt": "2026-10-27T10:00:00.000Z",
    "daysRemaining": 92,
    "version": 1,
    "offlineValidUntil": "2026-07-30T10:00:00.000Z"
  },
  "entitlementReceipt": "signed-JWS",
  "minimumSupportedAppVersion": null,
  "serverTime": "2026-07-27T10:00:00.000Z"
}
```

`daysRemaining = max(0, ceil((expiresAt - serverTime) / 86400秒))`，只用于显示。过期用户仍然可以保持登录，以便查看账号、导出或删除自己的本地数据；`canUseApp=false`，产品能力返回 `403 MEMBERSHIP_EXPIRED`。

### 8.6 错误码

至少实现：

| HTTP | Code | 场景 |
|---:|---|---|
| 400 | `VALIDATION_ERROR` | 参数不合法 |
| 400 | `USERNAME_INVALID` | 用户名格式错误 |
| 400 | `PASSWORD_TOO_WEAK` | 密码不符合规则 |
| 401 | `AUTH_INVALID_CREDENTIALS` | 用户不存在或密码错误 |
| 401 | `ACCESS_TOKEN_INVALID` | Access Token 无效 |
| 401 | `ACCESS_TOKEN_EXPIRED` | Access Token 过期 |
| 401 | `REFRESH_TOKEN_INVALID` | Refresh Token 无效 |
| 401 | `REFRESH_TOKEN_EXPIRED` | Refresh Token 已过期，App 应清理并重新登录 |
| 401 | `REFRESH_TOKEN_REUSED` | 检测到重放 |
| 401 | `REAUTH_REQUIRED` | 需要近期重新验证 |
| 401 | `REAUTH_INVALID` | Reauth Token 无效或 purpose/session 不匹配 |
| 410 | `REAUTH_EXPIRED` | Reauth Token 已过期 |
| 409 | `REAUTH_CONSUMED` | Reauth Token 已使用 |
| 403 | `ACCOUNT_SUSPENDED` | 账号被冻结 |
| 403 | `MEMBERSHIP_REQUIRED` | 没有会员记录 |
| 403 | `MEMBERSHIP_EXPIRED` | 会员到期 |
| 403 | `MEMBERSHIP_REVOKED` | 会员被撤销 |
| 409 | `USERNAME_TAKEN` | 用户名已注册 |
| 409 | `IDENTITY_ALREADY_BOUND` | 身份属于其他用户 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 相同键对应不同请求 |
| 409 | `OAUTH_FLOW_CONSUMED` | OAuth 事务已兑换 |
| 410 | `OAUTH_FLOW_EXPIRED` | OAuth 事务过期 |
| 400 | `OAUTH_STATE_INVALID` | Provider State 无效 |
| 400 | `OAUTH_PKCE_INVALID` | PKCE verifier 无效 |
| 400 | `OAUTH_CONSENT_DENIED` | 用户取消授权 |
| 400 | `OAUTH_TICKET_INVALID` | 一次性 Ticket 无效 |
| 410 | `OAUTH_TICKET_EXPIRED` | 一次性 Ticket 过期 |
| 429 | `RATE_LIMITED` | 请求过多，附 `Retry-After` |
| 429 | `OAUTH_SLOW_DOWN` | 轮询过快 |
| 502 | `OAUTH_PROVIDER_ERROR` | Provider 返回错误 |
| 503 | `OAUTH_PROVIDER_UNAVAILABLE` | Provider 暂时不可用 |
| 503 | `SERVICE_UNAVAILABLE` | 服务或依赖不可用 |

## 9. 微信与 QQ 桌面 OAuth

### 9.1 开放平台准备

- 微信：申请并审核“网站应用”，配置固定 HTTPS 回调，使用网站应用扫码登录。参考[微信开放平台网站应用登录](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html)。
- QQ：在 QQ互联创建并审核应用，配置固定 HTTPS 回调，按 Authorization Code -> Access Token -> OpenID 流程。QQ 官方说明支持网站和移动应用接入，并明确不建议 iframe：[QQ互联 OAuth 2.0](https://wiki.connect.qq.com/oauth2-0%E7%AE%80%E4%BB%8B)。
- Provider `AppSecret` 只存在服务器；Electron 永远只知道 Vesti API 地址和公开 AppID（若确有展示需要）。
- 只申请完成登录所需的最小 Scope，不读取好友、通讯录等无关信息。

### 9.2 创建桌面事务

App 主进程生成：

```text
codeVerifier  = 32～64 bytes CSPRNG
codeChallenge = BASE64URL(SHA256(codeVerifier))
clientState   = 32 bytes CSPRNG
```

```http
POST /v1/auth/oauth/desktop-flows
```

```json
{
  "provider": "wechat",
  "codeChallenge": "...",
  "codeChallengeMethod": "S256",
  "clientState": "...",
  "locale": "zh-CN",
  "consent": {
    "termsVersion": "2026-07-27",
    "privacyVersion": "2026-07-27",
    "accepted": true
  },
  "device": {
    "installationId": "...",
    "platform": "windows",
    "appVersion": "0.3.0",
    "publicKey": "base64url installation public key",
    "keyAlgorithm": "Ed25519",
    "keyVersion": 1
  }
}
```

响应：

```json
{
  "flowId": "uuid",
  "authorizationUrl": "https://api.example.com/v1/auth/oauth/wechat/authorize?...",
  "pollSecret": "opaque-random-secret",
  "expiresIn": 600,
  "pollInterval": 3
}
```

App 只能使用 `shell.openExternal(authorizationUrl)` 打开系统浏览器，不使用 Electron WebView、iframe 或内嵌 Provider 密码页。
`authorizationUrl`中必须带 128 bit 以上、只使用一次的 Browser Start Token；数据库只保存哈希。Authorize 路由原子消费它后再生成 Provider State，重复打开不得覆盖正在使用的 State。
首次登录 Flow 在跳转 Provider 前由 Vesti 自己的 HTTPS 页面展示当前用户协议和隐私政策链接，并要求明确点击继续；不得把微信/QQ授权等同于同意 Vesti 协议。服务端把 Flow 中的版本和自己的确认时间写入新用户 `consent_records`。

### 9.3 Provider 回调

服务端：

1. 为 Provider 单独生成至少 128 bit 的随机 `state`，只保存哈希并绑定 Flow。
2. 仅跳转到白名单 Provider 地址。
3. 回调时校验 State、Flow 状态和 10 分钟有效期。
4. 用服务端 Secret 换取 Provider Token，并获取 OpenID/UnionID。
5. 在事务中登录已有身份，或创建用户并首次赠送。
6. 生成 60 秒有效、只能使用一次的 Login Ticket，只保存哈希。
7. 标记 Flow 完成，渲染不包含 Token 的成功/失败页面。
8. 尝试打开：

```text
vesti://auth/callback?flowId=<uuid>&ticket=<one-time-ticket>&state=<clientState>
```

Deep Link 中禁止出现 Vesti Access/Refresh Token、微信/QQ Token、AppSecret 或用户 OpenID。

反向代理和应用访问日志对 Provider callback、authorize 和 Deep Link 落地页禁止记录 Query String。回调/结果页面必须设置 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`和严格 CSP，不加载统计脚本、字体、图片或其他第三方资源。

### 9.4 PKCE 兑换和轮询

App 收到 Deep Link 后调用：

```http
POST /v1/auth/oauth/desktop-flows/:flowId/exchange
```

```json
{
  "ticket": "one-time-ticket",
  "codeVerifier": "original verifier"
}
```

服务端必须验证 PKCE S256、Flow、Ticket、状态、有效期和一次性；成功后原子地消费 Flow 并返回标准登录响应。即使其他程序抢占了 `vesti://`，没有 App 内存中的 `codeVerifier`也不能换取令牌。

Deep Link 失败时固定使用以下唯一轮询契约，不返回无法从哈希恢复的 Ticket：

```http
POST /v1/auth/oauth/desktop-flows/:flowId/poll
Authorization: Vesti-Poll <pollSecret>
Content-Type: application/json

{ "codeVerifier": "original verifier" }
```

- 未完成返回 `202 {"status":"pending","retryAfter":3}`。
- 已完成时同时验证 poll secret 与 PKCE，原子消费 Flow并直接返回标准登录响应。
- Deep Link exchange 与 poll 竞争时只能有一个成功。
- 轮询过快返回 `OAUTH_SLOW_DOWN`，不得通过 GET、Query 或日志传递 Secret/Token。
- 取消使用 `DELETE`同一路径并在 `Authorization: Vesti-Poll`中携带 Secret。

绑定与重新认证使用同一 Flow 状态机，但行为不同：

- `purpose='link'`：创建 Flow 时必须原子消费 `identity_link` Reauth Token，把其 ID、`target_user_id`和发起 Session绑定到 Flow；回调时确认该 Token确实为本 Flow消费且目标 Session仍有效，然后才绑定身份。
- `purpose='reauth'`：要求有效 Access Token并绑定 `target_user_id`和发起 Session，但不要求已有 Reauth Token；完整 Provider授权成功后只签发指定 purpose 的 Reauth Token，不创建登录 Session、不赠送会员。

这样可以防止被窃取的旧 Access Token直接绑定攻击者身份，也避免“为了重新认证先要求重新认证”的循环依赖。

## 10. Token、会员凭证和服务间验证

### 10.1 Access Token

- JWT，常规上限 15 分钟；活跃会员 Token 的 `exp = min(now + 15分钟, membership.ends_at)`，不得越过精确会员到期点。
- 使用 Ed25519/EdDSA 或 ES256，固定允许算法。
- 必须校验 `iss`、`aud`、`sub`、`sid`、`jti`、`iat`、`nbf`、`exp`、`tokenType`；`sid`固定映射 `auth_sessions.id`。
- 不写入密码、Provider OpenID、昵称等不必要信息。
- 会员声明只能用于短 TTL 快速判断；服务端关键接口仍应检查数据库或短 TTL 权威缓存。

固定 Payload 形状：

```json
{
  "iss": "https://api.example.com",
  "aud": ["vesti-api", "vesti-llm-proxy"],
  "sub": "user UUID",
  "sid": "auth session UUID",
  "jti": "token UUID",
  "tokenType": "access",
  "authTime": 1785136800,
  "membership": {
    "canUseApp": true,
    "version": 1,
    "expiresAt": 1793095200
  },
  "iat": 1785136800,
  "nbf": 1785136800,
  "exp": 1785137700
}
```

过期用户可以获得仅用于账号管理的 Access Token，`membership.canUseApp=false`；LLM Proxy 和其他产品接口必须拒绝。所有验证端还要独立比较 `now < membership.expiresAt`。

### 10.2 Refresh Token

- 至少 256 bit 不透明随机值，建议 30 天绝对有效期。
- 数据库只保存哈希，每次使用都轮换。
- 重放旧 Token 时吊销整个 `auth_sessions`并要求重新登录。
- 退出、修改密码、冻结账号、删除账号和管理员“退出全部设备”都应吊销对应会话。

### 10.3 离线会员凭证

Vesti 是本地优先产品。服务必须实现可配置的签名离线凭证能力；生产 `OFFLINE_GRACE_HOURS`由产品负责人上线前明确签字确认，推荐 72，设为 0 表示完全在线。启用时 `/app/bootstrap` 返回独立的 Ed25519 签名 JWS。

JWS Protected Header：

```json
{
  "alg": "EdDSA",
  "kid": "entitlement-2026-01",
  "typ": "vesti-entitlement+jwt"
}
```

Payload：

```json
{
  "iss": "vesti-auth",
  "aud": "vesti-desktop-entitlement",
  "sub": "user UUID",
  "cnf": { "jkt": "SHA-256 fingerprint of installation public key" },
  "planCode": "beta",
  "membershipVersion": 1,
  "membershipExpiresAt": 1793095200,
  "offlineValidUntil": 1785396000,
  "iat": 1785136800,
  "exp": 1785396000,
  "jti": "uuid"
}
```

- `offlineValidUntil`最多是签发后配置小时数，且不得晚于会员到期时间；App 必须验证 `exp=offlineValidUntil`、`exp <= iat + grace`及 `exp <= membershipExpiresAt`。
- 每次安装生成独立 Ed25519/P-256密钥对，私钥进入 OS 安全存储，设备表保存公钥；凭证 `cnf.jkt`绑定公钥指纹。数据库查询用的服务端 HMAC `installation_id_hash`不是 App 可验证的凭证绑定值。
- App 维护包含当前及过渡公钥的 Key Ring，按固定 `typ`、算法和 `kid`验证；新公钥必须先随 App/远程可信 Key Set 发布，再开始签名，旧钥保留至全部旧凭证过期。私钥泄露时吊销 Key、停止签发并通过最低版本策略强制升级。
- 登出时删除凭证；超过离线窗口必须联网。
- App 在 OS 安全存储记录最近可信 `serverTime`，离线计算使用 `max(systemTime,lastTrustedServerTime)`并检测明显回拨；这只能增加篡改成本，不能把用户可控 Electron 变成不可破解 DRM。
- 账号冻结或会员撤销最多延迟离线窗口生效；只有负责人接受该取舍才允许生产值大于 0。
- 即使凭证过期，用户仍应可以访问导出和删除本地数据的最低限度入口。

### 10.4 现有 LLM 代理

认证服务公开当前和过渡期公钥/JWKS，LLM 代理验证 Vesti Access Token 的签名、发行方、受众、有效期和会员声明。要求：

- LLM 代理不再相信客户端传入的 service token 或 `member=true`。
- 非会员、过期、撤销和冻结账号拒绝 LLM/Embedding 请求。
- AppSecret 和认证私钥不复制给 LLM 代理；代理只拿公钥。
- 到期时间同时受 JWT `exp`和 `membership.expiresAt`限制。冻结和撤销通过仅供受信服务调用的 introspection 权威检查，缓存上限 30 秒；不得只凭 15 分钟旧声明继续放行。
- 认证服务不可用时，代理不应对从未验证的请求 Fail Open。

Introspection 仅通过内网/mTLS或独立服务凭证开放，Body 中的 Token必须被日志中间件完全脱敏：

```http
POST /v1/auth/introspect
Authorization: <trusted service identity>

{ "token": "access JWT" }
```

```json
{
  "active": true,
  "sub": "user UUID",
  "sid": "session UUID",
  "accountStatus": "active",
  "membership": {
    "canUseApp": true,
    "version": 1,
    "expiresAt": "2026-10-27T10:00:00.000Z"
  },
  "serverTime": "2026-07-27T10:00:00.000Z"
}
```

任一签名、Session、账号或会员检查失败时返回 `active=false`，不泄露具体账号资料。

### 10.5 Electron 凭证存储边界

- Access Token优先只驻留 Electron 主进程内存。
- Refresh Token、安装私钥和最近可信服务器时间写入 Windows Credential Manager/DPAPI、macOS Keychain、Linux Secret Service 等 OS 安全存储。
- 禁止写入 Renderer、LocalStorage、普通 JSON、Dexie或明文 SQLite。
- Linux 若 Electron `safeStorage`退化为 `basic_text`，不得静默明文保存；应要求系统 Secret Service，或退化为每次启动重新登录。
- Renderer 只接收脱敏后的用户和会员状态，不接收 Refresh Token、Provider Token或私钥。

## 11. 安全要求

### 11.1 密码与账号

- Argon2id 参数以生产服务器基准为准，使单次验证约 100～300ms；每个密码独立 Salt。
- 密码长度 12～256，允许空格和 Unicode；使用离线常见/泄露密码名单拒绝明显弱密码，不把待检密码发送给第三方。
- 登录失败统一提示，不暴露用户名是否存在。
- 不使用永久账号锁定；连续失败采用限速和短期退避，避免攻击者制造拒绝服务。
- 修改密码前要求近期重新认证，并吊销全部 Refresh Token。
- 没有手机号或邮箱前，不实现不安全的密保问题。

### 11.2 初始限流建议

| 操作 | 初始限制 |
|---|---:|
| 注册 | 每 IP 每小时 3～5 次 |
| 登录失败 | 每账号及每 IP 每 10 分钟 5 次 |
| OAuth 开始 | 每 IP 每 10 分钟 10 次 |
| OAuth 回调 | 每事务一次 |
| Refresh | 每会话每分钟 20 次 |
| 管理操作 | 更严格并要求二次认证 |

返回 `429` 和 `Retry-After`。限流键中的规范化用户名使用 HMAC，不在 Redis Key 中暴露明文。仅信任自有反向代理写入的 `X-Forwarded-For`。

### 11.3 日志和审计

必须审计注册、登录成功/失败、OAuth绑定/解绑、Refresh Token 重放、退出、密码修改、首次赠送、会员调整/撤销、账号删除、管理员操作和密钥轮换。

日志和错误监控禁止记录：密码、密码哈希、Authorization/Cookie、Access/Refresh Token、OAuth Code/State/Ticket、完整连接字符串、微信/QQ Token、用户 AI 对话内容。推荐记录截断或 HMAC 后的 IP、Request ID、Session ID、结果和内部错误码。

### 11.4 管理操作

Beta 阶段优先提供只在服务器上运行的受控 CLI：

```text
membership-admin inspect --user <id-or-username>
membership-admin extend --user <id> --months 3 --reason <ticket>
membership-admin revoke --user <id> --reason <ticket>
membership-admin restore --user <id> --reason <ticket>
membership-admin logout-all --user <id> --reason <ticket>
```

CLI 必须调用同一领域服务、锁定会员行、写会员事件和管理员审计，不能直接 `UPDATE memberships`。它还必须满足：

- 禁止共享管理员账号；每位管理员有独立身份。
- 使用短期 SSH证书/受控跳板机与 `sudo`白名单，或由公司 SSO + MFA签发短期管理员会话凭证；不能仅因为“能登录服务器”就自动拥有会员修改权。
- 审计 `actor_id`从经过验证的个人身份映射得到，不接受可由命令行任意伪造的 `--actor`。
- 每项变更强制填写工单/原因，记录旧值、新值、主机、请求 ID 和结果。
- 高风险的撤销、批量退出和密钥操作要求再次 MFA或双人复核。

未来管理后台另做 SSO、MFA 和 RBAC，不把管理端点裸露到公网。

### 11.5 注销和数据生命周期

`DELETE /account`执行受审计的匿名化事务，不直接对 `users`做物理级联删除：

1. 要求 10 分钟内的 Reauth Token。
2. 立即吊销全部 Session、Refresh Token和离线凭证版本。
3. 删除密码凭证和 OAuth 身份，清除 Provider昵称、头像和原始资料。
4. 删除或匿名化设备名、公钥、IP/User-Agent 等非必要信息。
5. 将 `users.status='deleted'`、清空用户名、替换显示名并写 `deleted_at`。
6. 将会员撤销并追加 `account_deleted`事件。
7. 会员/安全审计只保留无法直接识别用户的 UUID、事件类型和法律/安全所需字段，按公开保留期限清理。
8. 记录备份中的数据会按备份轮换周期自然淘汰。

物理删除会被会员和审计外键阻止是有意设计。是否保留经过独立 HMAC 的第三方身份“试用已领取”墓碑以防注销重领，必须由产品与隐私合规共同决定并公开期限；本任务不得自行永久保存 Provider 标识。

## 12. 部署和运维任务

### 12.1 环境

- 至少区分 `development`、`staging`、`production`，数据库和 Secret 完全隔离。
- Beta 可先单台 VPS：Caddy/Nginx + Auth API + PostgreSQL；Redis 可按需要增加。
- Auth 服务与 LLM Proxy 使用独立容器/进程、数据库角色、Secret 和健康检查。
- 主机自动安装安全更新或进入明确补丁窗口；防火墙默认拒绝。PostgreSQL/Redis 不暴露公网；公网只开放 80/443，SSH 使用密钥并限制来源。
- 容器非 root 运行，固定镜像和依赖版本，启用 TLS 1.2+、HSTS 和安全响应头。
- 服务器启用 NTP；会员时间不依赖桌面端时钟。

### 12.2 发布流程

1. CI 执行格式检查、类型检查、全部测试、Secret 扫描、依赖和镜像漏洞扫描。
2. 构建带 Git commit 和不可变 tag 的镜像。
3. 生产迁移前生成可恢复备份。
4. 运行版本化迁移；失败时停止发布。
5. 部署新服务，等待 `/health/live` 和 `/health/ready`。
6. 执行注册、登录、刷新、会员查询和 OAuth Mock Smoke Test。
7. 真实 Provider 凭证可用后各执行一次微信、QQ人工登录。
8. 观察错误率和延迟后完成切流；保留上一镜像与回滚命令。

`/health/live`只说明进程存活；`/health/ready`检查数据库等关键依赖，但不得泄露版本、地址、表结构或 Secret。

### 12.3 备份与恢复

- PostgreSQL 每日全量备份；生产必须启用 WAL/PITR并把加密备份写入异机、独立权限域，否则无法达到下面的 RPO。
- Beta 目标：RPO 不超过 15 分钟，RTO 不超过 4 小时。
- 备份加密并存到独立权限域；监控最近成功时间。
- 至少每季度真实恢复演练，核对用户、会员事件和会话撤销状态。
- 文档写清备份保留和用户删除数据在备份中的自然淘汰期限。

### 12.4 监控和告警

至少监控：

- API 可用率、流量、P50/P95/P99、4xx/5xx/超时。
- PostgreSQL连接、慢查询、磁盘、备份；Redis内存和错误（如启用）。
- 注册/登录/OAuth各阶段成功率。
- Refresh Token 重放、异常注册量、每小时首次赠送数量。
- 会员查询失败和异常管理员调整。
- CPU、内存、磁盘、TLS证书和域名到期。

准备签名密钥泄露、数据库泄露、Provider Secret 泄露、Token 大规模重放、错误发布导致会员失效、数据库损坏、OAuth 中断、域名/证书失效的 Runbook。

### 12.5 合规上线项

- 提供用户协议、隐私政策、第三方信息共享清单和账号注销说明。
- 记录用户同意的协议版本、时间和方式；不得默认勾选。
- 认证服务器默认只收账号、第三方稳定标识、会员、会话、必要设备和安全审计信息，不收本地 AI 对话。
- 提供查看/更正账号、查看/解绑身份、撤销设备和注销账号的能力。
- 明确未成年人策略：Beta 可禁止 14 岁以下用户注册；若允许，则必须另做监护人同意和未成年人信息保护流程。
- 与云服务商、监控、备份等受托处理方签署/确认必要的数据处理条款；境外监控或备份启用前评估跨境传输。
- 建立个人信息安全事件通知流程，并在隐私政策列出 `profile`白名单、设备名、User-Agent、IP HMAC等字段及各自保留期限。
- 若 API 或官网部署在中国大陆，完成域名实名认证、ICP备案，并向接入商确认桌面应用及后续收费业务所需手续。
- 微信/QQ开放平台的主体、官网、隐私政策和回调域名需通过其审核。
- 正式上线前由熟悉中国互联网与个人信息保护的专业人员复核，开发 Agent 不自行给出法律承诺。

## 13. 当前本地会员迁移

当前 Electron 的 `membership.json` 可被用户修改，服务端不得把其中用户名、哈希或到期时间当作可信输入。

推荐迁移策略：

1. 更新后的 App 首次启动显示服务端登录/注册。
2. 用户在服务器第一次创建账号，按正常规则获得一次新的三个月会员。
3. 不上传本地密码哈希，也不要求上传会话数据。
4. 登录成功后 App 使用服务器令牌和签名离线凭证；本地文件降级为兼容标记，之后移除。
5. 用户原有 SQLite、Dexie 和 vault 数据保持原位，不因登录方式改变而删除。

如果产品不希望旧用户重新获得三个月，需要另行设计由服务端签发的一次性迁移码；现有本地文件本身不能证明用户资格。

## 14. 测试与验收矩阵

### 14.1 注册和会员

- 用户名、微信、QQ首次创建都产生一个用户、一个会员投影和一个首次赠送事件。
- 相同请求重试、20～50并发请求、重复 OAuth 回调都只赠送一次。
- 即使错误事件键被传入，数据库部分唯一索引仍阻止第二次首次赠送。
- 相同幂等键不同请求返回 409。
- 事务任意中间步骤失败后全部回滚。
- 绑定第二个身份不增加会员时间。
- 月末、闰年、跨年、UTC午夜和服务器不同时区结果一致。
- 到期前 1ms 有效，恰好到期失效，修改客户端时间无效。

### 14.2 OAuth

- State 不匹配、过期、重放均拒绝。
- Browser Start Token 只可消费一次，重复 authorize 不覆盖 Provider State。
- 错误 PKCE verifier 拒绝。
- Ticket 只可使用一次且 60 秒过期。
- Deep Link 失败后轮询仍能完成。
- Deep Link 与轮询并发只有一个兑换成功。
- 用户取消、Provider超时/错误、重复回调都有稳定错误码和可理解网页。
- 相同昵称绝不触发合并，同一身份不能属于两个用户。
- OAuth 新用户没有当前协议明确同意时不能创建账号；成功创建后两类 `consent_records`齐全。
- authorize/callback访问日志不包含 Query，结果页响应头和 CSP 符合要求。
- 绑定和解绑使用过期/错误 Reauth Token 均被拒绝。

### 14.3 Token 和门禁

- Refresh 正常轮换；旧 Token 重放吊销整个 Session。
- 同一个旧 Token 并发刷新只有一个成功。
- Token父子关系不能跨 Session、用户或设备，且一个父 Token 只能产生一个子 Token。
- 当前设备退出、全部退出、设备撤销、密码修改、冻结账号行为正确。
- 未登录返回 401；无会员/过期/撤销/冻结返回对应 403。
- LLM Proxy 不接受客户端伪造会员字段或无效签名。
- Access Token绝不晚于有效会员结束时间；Proxy 独立比较会员到期并执行最多30秒缓存的权威 introspection。
- Refresh Token只存在OS安全存储，自动化/人工检查确认未进入Renderer、JSON、Dexie或SQLite。
- 离线宽限为 0 和负责人批准的非零配置都经过测试；启用时签名、公钥指纹绑定、系统时间回拨检测和真实到期上限全部生效。

### 14.4 数据库和部署

- 空 PostgreSQL 能迁移到最新版本，上一版本升级不丢数据。
- 数据库中不存在明文密码、Refresh Token、OAuth Secret。
- 唯一约束阻止重复用户名、身份和首次赠送。
- 应用角色不能修改/删除会员事件。
- 注册状态字段、OAuth purpose/目标用户、ticket唯一性等数据库约束拒绝非法组合。
- 日志脱敏测试扫描不到敏感字段。
- 备份能恢复；迁移失败和应用发布都可回滚。
- Secret/依赖/镜像扫描不存在未处理的严重或高危问题。

完整自动化测试通过、真实 Provider 人工 Smoke Test 通过且生产监控可见后，才算 P0 完成。

## 15. 执行顺序和 Definition of Done

### Task 1：发现与基线

- 盘点服务器 OS、容器、反向代理、域名、端口、现有 LLM Proxy 和数据库。
- 备份现有配置，记录不能中断的服务。
- 输出最终选型和部署拓扑；不因选型改变本文业务规则。

完成标准：本地可启动空 API，配置校验和健康检查可用。

### Task 2：数据库与领域层

- 编写全部迁移、种子、用户、身份、会员、设备、Token和审计仓储。
- 实现三个自然月、会员判断、首次赠送、管理员事件和并发幂等。

完成标准：空库/升级迁移、月末、回滚和 20～50 并发测试通过。

### Task 3：用户名密码与会话

- 实现注册、登录、Session、刷新轮换、重放检测、退出、设备、Reauth、修改密码、协议同意和 Bootstrap。
- 实现密码哈希、限流、统一错误和日志脱敏。

完成标准：接口测试与安全回归全部通过，数据库没有敏感明文。

### Task 4：微信/QQ OAuth

- 实现一次性 Browser Start Token、桌面 Flow、系统浏览器跳转、Provider回调、PKCE兑换、Deep Link和唯一轮询兜底契约。
- 使用 Mock Provider 覆盖 CI；凭证就绪后完成真实人工测试。

完成标准：所有成功、取消、超时、重放和并发场景通过。

### Task 5：离线凭证与代理集成

- 生成独立非对称密钥，按负责人批准的离线窗口（0关闭，启用时最大72小时）签发且不越过会员到期的离线凭证。
- 提供 JWKS/公钥和 LLM Proxy 验证中间件或清晰集成补丁。

完成标准：伪造、过期、错误设备、撤销后的在线请求均被拒绝。

### Task 6：部署和运行保障

- 完成镜像、Compose/编排、HTTPS、数据库私网、迁移、备份、监控、告警和 Runbook。
- 完成 Staging，再部署 Production；记录可复制回滚命令。

完成标准：健康检查、Smoke Test、备份恢复和回滚演练通过。

### Task 7：文档与交接

- 提交 OpenAPI、ER关系说明、环境变量、Provider配置、部署、密钥轮换、备份恢复和故障处理文档。
- 给 App Agent 提供 Base URL、OpenAPI、公开验证密钥、错误码和 Staging 测试账号/流程。

完成标准：一个未参与开发的人能按文档启动本地环境并完成注册、登录、刷新和会员查询。

## 16. 开工前需要产品负责人提供

- 目标服务器地址、操作系统、SSH/部署方式和允许的变更范围。
- 正式或暂定 API 域名，以及 DNS/证书管理权限。
- PostgreSQL 是自建还是云数据库，备份存放位置。
- 微信开放平台主体和网站应用的申请状态、AppID/Secret及审核回调域。
- QQ互联主体和应用申请状态、AppID/Secret及审核回调地址。
- 隐私政策、用户协议和官网地址。
- 现有 LLM Proxy 的认证方式和仓库位置。
- 是否接受最长 72 小时离线使用，以及封禁延迟的风险。
- 旧本地 Beta 用户是否在服务端重新获得一次三个月会员。
- 生产告警接收人和故障联系人。

缺少真实微信/QQ凭证不应阻塞核心服务开发，但会阻塞 Provider 生产验收；缺少服务器或域名权限不应阻塞本地 Docker 和 Staging 交付。

## 17. 最终汇报模板

执行 Agent 完成后按以下格式汇报：

```text
Git repository / commit:
Deployed environment:
Public API base URL:
Docker image/tag:
Database migration version:
OpenAPI location:
JWKS/public key location:
Health check result:
Automated test result:
Concurrency/idempotency result:
WeChat live test result:
QQ live test result:
Backup/restore test result:
Rollback command and result:
Secrets not committed verification:
Remaining blockers/risks:
Inputs required from owner:
```

只有代码、迁移、测试、部署运行证据和交接文档齐全，才可标记任务完成。
