# VESTI-APP

Vesti 的本地优先桌面端：自动发现并归档本机 AI 编程工具的会话，把不同平台的数据标准化到同一个本地数据库；配合 VESTI 浏览器扩展回收网页端 AI 对话，在本地完成整理、检索、提炼与接力。

> 当前版本：`0.3.0`。Windows x64 已验证；macOS 和 Linux 尚未完成发布验证。

## 当前能力

### 收集引擎

- 捕获 Codex、Cursor、Kimi Code、Claude Code 的本地会话（`@vesti/capture-core` 另内置 aider 适配器，App 默认采集清单暂未启用）。
- 启动时增量同步，并持续监听后续文件变化；原始会话文件以 gzip 全量保留在本地 vault。
- WSL 检测与采集：自动枚举发行版与用户 home，经 `\\wsl$` UNC 路径读取；WSL 会话以 `wsl:<distro>` host 标记区分，文件事件不可靠时以 60 秒轮询兜底。
- 浏览器扩展桥：loopback HTTP 服务（`127.0.0.1:28765`，Bridge Protocol v1.1），配对后接收扩展的全量/每日增量导入，网页端对话与 CLI 会话在同一会话树中呈现。
- 对话树索引与 digest：`project_registry` 支撑来源→项目→会话树；`session_digests` 保存 LLM 压缩摘要与向量 embedding，无模型服务时逐级降级，不阻塞采集。

### 知识整理空间

- 统一展示会话、消息、工具调用、Token 和项目路径；会话列表超过 300 条启用虚拟滚动（自实现，无第三方依赖）。
- 自动分类（classify）：LLM 建议话题路径，置信度 ≥ 60% 自动归入话题，其余进入待确认队列；手动分类永不被覆盖。
- 来源→项目→话题树形导航（SourceTreeNav），浏览器来源按站点域名分组。
- 整理助手（OrganizePanel）：基于本地规则的批量清空、跨源重复合并、批量标签与批量归档，先预览后执行。

### 上游导出

- Obsidian / Markdown：导出到所选库目录下的 `VestiExport/<来源>/<项目>/` 结构，带 frontmatter；受限写盘，路径越界即拒绝。
- Notion：token 方式导出为新页面，重复导出时归档旧页并重建。

### 下游消费

- Summary / Explore：对已有会话运行，结果保存在本地。
- AI 接力（relay）：多选会话生成交接包，可复制 prompt / Markdown、导出 `.md`、生成 CLI 启动命令（Kimi CLI / Claude Code / Codex），或推送浏览器扩展注入目标平台输入框。
- 知识提取（extract）：从会话提取知识点、代码片段、决策与可复用提示词，可一键存入沉淀区。
- 沉淀区（deposits）：按模板（个人背景知识 / 项目开发状态 / 写作风格 / 自定义提炼）蒸馏知识，再生成自动形成版本链。
- 日总结与周报：每日定时（默认 21:30）自动生成日报；周报手动生成，汇总最近 7 天。

### AITI

- AITI 个人画像维持现状：本地纯计算的思维指纹，不调用 LLM。

### 外观

- 自绘标题栏：Windows/Linux 自绘最小化/最大化/关闭按钮，macOS 使用原生红绿灯。
- 桌面悬浮球：整幅透明 PNG + `drop-shadow`，无白边漏出；展开/收起瞬时 resize，无残影。
- 4 套猫头鹰皮肤：经典、午夜星空、像素、樱花，设置页即时切换。

### 基础设施

- `schema_migrations` 迁移机制：schema 变更以追加式迁移条目发布，同事务执行，失败整体回滚。
- EmbeddingService + 向量检索：FTS5 全文与向量候选经 RRF 融合（SessionRecall），向量不可用时自动退化为纯全文。
- AgentService kind 注册表：summary / explore / digest / classify / relay / extract / distill / daily 八种任务统一注册、统一解析。
- 根 vitest 测试体系覆盖主进程服务与渲染层纯逻辑，`@vesti/capture-core` 另有独立测试套件。
- 常驻 Windows 系统托盘，支持开机启动、隐藏启动和关闭到托盘。

## 快速开始

需要 Node.js `22.12+` 和 pnpm `10`：

```powershell
git clone git@github.com:221250144/VESTI-APP.git
cd VESTI-APP
corepack enable
pnpm install
pnpm start
```

`pnpm start` 会先构建仓库内的 `@vesti/capture-core`，准备 Electron ABI 对应的 `better-sqlite3` 原生模块，再启动开发窗口。

## 功能使用指引

### 连接 VESTI 浏览器扩展

1. 设置 →「连接 VESTI 扩展」→ 生成配对码。配对码为 6 位数字，5 分钟内有效，一次性使用；生成新码会使旧码立即失效。
2. 在扩展设置页的「连接桌面」卡片输入配对码完成配对。App 侧只保存加密后的 token，扩展侧 token 不出扩展存储。
3. 配对成功后扩展首次做全量导入，之后按每日增量同步（以服务端返回的 cursor 为游标），也可在扩展侧手动立即同步。
4. 协议细节见 [docs/bridge-protocol.md](docs/bridge-protocol.md)。

### WSL 来源采集

无需配置。启动时自动执行 `wsl.exe -l -q` 枚举发行版，扫描 `\\wsl$\<distro>\home` 下的用户目录（并探测 root），按平台特征目录（`.claude/projects`、`.codex/sessions`、`.kimi-code/sessions`（旧名 `.kimi/sessions` 兜底）等）识别来源。9P 共享上的文件事件不可靠，App 每 60 秒对 WSL 文件做一次增量轮询（未变化的文件只做 stat 比对，代价很低）。WSL 会话在来源树中以 `wsl:<distro>` 与 Windows 原生会话区分。

### AI 接力

1. 在文库列表进入多选模式，勾选一个或多个会话，点击「生成交接包」。
2. 在接力面板中复制 suggested prompt 或完整 Markdown，导出 `.md`（`VestiRelay/` 目录），或生成 CLI 启动命令——交接包写入 `~/.vesti/relay/` 后给出 Kimi CLI / Claude Code / Codex 的启动命令。
3. 已配对扩展时可「推送浏览器」：prompt 进入 bridge outbox，扩展轮询取出并注入对应平台的输入框（只填充不发送，由你确认后发出）。

### 沉淀区

Dock →「沉淀区」：选择模板与范围（项目 / 话题 / 时间段 / 当前选择）后由 LLM 蒸馏生成。同一范围再次生成时自动递增版本并链接上一版。知识提取面板的结果可一键保存到沉淀区，也可导出 Markdown / JSON。

### 日总结与周报

设置 →「日志」设定每日生成时间（默认 21:30）。到点自动生成当日日报，聚合当日 CLI 会话 digest 与网页端对话摘要；无可用模型时回退本地模板。昨天的缺失日报会在启动时补跑。周报在日志页手动生成，汇总最近 7 天日报与活动统计。

### 悬浮球与皮肤

设置 →「应用行为」开启「显示桌面悬浮球」；设置 →「悬浮球皮肤」在经典 / 午夜星空 / 像素 / 樱花之间切换，即时生效。悬浮球可拖拽，松手后吸附最近的屏幕左右边缘。

## 构建 Windows 安装包

```powershell
pnpm typecheck
pnpm make
```

生成文件：

```text
out/installer/Vesti-0.3.0-Setup.exe
```

安装器采用 NSIS 向导，可选择程序安装目录；完成页可选择创建桌面快捷方式和立即启动。当前开发构建未进行商业代码签名，Windows 可能显示“未知发布者”。

如果安装过旧的 Squirrel 版本（默认位于 `%LOCALAPPDATA%\vesti_app`），请先从 Windows“设置 → 应用 → 已安装的应用”卸载旧版本。内容数据不会随旧程序卸载而删除。

## 设置说明

设置页当前分区（按顺序）：

- 应用行为：开机启动、开机时隐藏窗口、关闭到托盘、显示桌面悬浮球。
- 采集引擎：启动时实时采集，Codex、Cursor、Kimi Code、Claude Code 独立开关，WSL 来源状态。
- 连接 VESTI 扩展：生成配对码、查看/断开已配对客户端。
- 内容数据与隐私：选择/打开内容目录、清空 Agent 历史结果。
- 上游导出：Obsidian 库目录与 Notion token / 目标页面。
- 模型服务：Demo Proxy、自定义 OpenAI 兼容接口、模型参数和加密 API Key。
- 洞察偏好：输出语言、自定义分析要求、是否包含思考摘要和工具详情。
- 整理：自动分类开关与模式（自动落库 / 仅建议）、待确认队列。
- 日志：每日日报生成时间。
- 网络与代理：跟随 Windows 系统代理、直接连接或自定义 HTTP/HTTPS/SOCKS 代理。
- 外观与语言：主题与界面语言。
- 悬浮球皮肤：4 套猫头鹰皮肤选择。
- 关于 Vesti：版本信息。

程序安装位置和内容数据位置是两个不同概念。默认内容目录为：

```text
%USERPROFILE%\.vesti
```

应用设置默认位于：

```text
%APPDATA%\Vesti\settings.json
```

修改内容目录后需要重启。Vesti 当前不会自动搬移旧目录；确认新目录工作正常后，再由用户自行处理旧数据。

## 数据与安全边界

- Renderer 开启 `contextIsolation` 和 sandbox，并关闭 `nodeIntegration`。
- 采集引擎只读取已启用工具的本地会话文件，不做键盘监听、屏幕录制或进程注入。
- 扩展桥仅绑定 `127.0.0.1`，不监听任何外部网卡；配对码一次性、5 分钟过期；bridge token 经 Electron `safeStorage` 加密后才落盘。
- API Key 与 Notion token 同样使用 `safeStorage` 加密；Renderer 无法读取保存后的明文。
- 上游导出受限写盘：目标路径必须严格落在用户选择的导出根目录内，拒绝绝对路径与 `..` 越界，写盘采用临时文件 + 原子重命名。
- 浏览和归档完全在本地完成。
- 唯一出网点是模型服务与 Notion API：只有主动运行 Summary / Explore / 整理 / 接力 / 日报等 Agent 任务或测试模型连接时，相关内容才会发送到设置中的模型服务；Notion 导出只发往 notion.com。
- 可在“洞察偏好”中关闭思考摘要或工具详情，减少发送给模型的内容。

## 仓库结构

```text
VESTI-APP/
├─ packages/capture-core/      # 可复用的 TypeScript 采集与标准化引擎
├─ packages/vesti-ui/          # 桌面/扩展共享的 UI 组件包
├─ src/main/                   # Electron 主进程服务
├─ src/shared/                 # Renderer 与主进程共享契约
├─ src/capsule/                # 桌面悬浮球（含皮肤素材）
├─ src/App.tsx                 # React 界面
├─ build/                      # NSIS 自定义安装页
├─ scripts/                    # Electron/原生模块构建准备
└─ docs/                       # 架构、收集引擎与扩展桥协议文档
```

App 只依赖 `@vesti/capture-core` 的包接口，不直接引用 CLI 命令。当前核心作为 workspace 包随仓库发布，保证单独克隆即可构建；后续可原样迁移到独立共享仓库或包注册表，让 CLI 和 App 同时依赖同一版本。

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm start` | 启动开发环境 |
| `pnpm core:build` | 单独构建采集核心 |
| `pnpm typecheck` | 构建核心并检查 App 类型 |
| `pnpm test` | 运行根 vitest 与各包测试 |
| `pnpm package` | 生成未安装的 Electron 应用目录 |
| `pnpm make` | 生成 Windows NSIS 安装包 |

## 常见问题

### 托盘中看不到 Vesti

确认运行的是 `0.3.0` 或更新版本。Windows 可能把新图标放进任务栏右侧的“隐藏的图标”区域；可在 Windows 任务栏设置中将 Vesti 固定显示。右键托盘图标可以打开/隐藏窗口、立即同步、暂停采集或退出。

### 扩展配对失败

确认 App 正在运行且设置页「连接 VESTI 扩展」中 bridge 状态正常（端口被占用时会显示错误）。配对码 5 分钟过期且一次性，超时或输错后请重新生成。

### WSL 会话没有出现

确认 `wsl.exe -l -q` 能列出发行版，且对应工具的会话确实写在 WSL 的 home 目录下。WSL 文件不依赖文件事件，最晚在 60 秒轮询后入库。

### Summary / Explore 提示网络错误

默认选择“跟随系统代理”。如果 VPN 只提供本地端口但未写入 Windows 系统代理，请在“网络与代理”中选择“自定义代理”，例如 `http://127.0.0.1:7890`，保存后执行“保存并测试模型”。

### 修改数据目录后没有变化

保存设置后重启 Vesti。当前版本不会自动复制旧数据库和 Agent 结果。

## 文档

- [docs/architecture.md](docs/architecture.md)：分层、安全边界、迁移机制、WSL 抽象与 AgentService 约定。
- [docs/collection-engine.md](docs/collection-engine.md)：收集引擎设计——适配器矩阵、统一数据模型、增量同步与 vault、树索引与 digest、检索融合。
- [docs/bridge-protocol.md](docs/bridge-protocol.md)：Bridge Protocol v1.1 完整协议（端点、鉴权、配对流、增量游标、outbox、错误码）。
