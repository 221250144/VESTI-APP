# VESTI-APP

Vesti 的本地优先桌面端：自动发现并归档本机 AI 编程工具的会话，把不同平台的数据标准化到同一个本地数据库，再通过 Summary / Explore 进行消费。

> 当前版本：`0.2.1`。Windows x64 已验证；macOS 和 Linux 尚未完成发布验证。

## 当前能力

- 捕获 Codex、Cursor、Kimi Code 的本地会话。
- 启动时全量增量同步，并持续监听后续文件变化。
- 统一展示会话、消息、工具调用、Token 和项目路径。
- 对已有会话运行 Summary 与 Explore，结果保存在本地。
- 使用 Vesti Demo Proxy，或连接任意 OpenAI 兼容 API。
- 常驻 Windows 系统托盘，支持开机启动、隐藏启动和关闭到托盘。
- 配置启用的数据源、内容目录、Agent 隐私范围和系统/直连/自定义代理。

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

## 构建 Windows 安装包

```powershell
pnpm typecheck
pnpm make
```

生成文件：

```text
out/installer/Vesti-0.2.1-Setup.exe
```

安装器采用 NSIS 向导，可选择程序安装目录；完成页可选择创建桌面快捷方式和立即启动。当前开发构建未进行商业代码签名，Windows 可能显示“未知发布者”。

如果安装过旧的 Squirrel 版本（默认位于 `%LOCALAPPDATA%\vesti_app`），请先从 Windows“设置 → 应用 → 已安装的应用”卸载旧版本。内容数据不会随旧程序卸载而删除。

## 设置说明

设置页分为六部分：

- 应用行为：开机启动、开机时隐藏窗口、关闭到托盘。
- 采集引擎：启动时实时采集，以及 Codex、Cursor、Kimi Code 独立开关。
- 数据与隐私：选择/打开内容目录、清空 Agent 历史结果。
- 模型服务：Demo Proxy、自定义 OpenAI 兼容接口、模型参数和加密 API Key。
- 洞察偏好：输出语言、自定义分析要求、是否包含思考摘要和工具详情。
- 网络与代理：跟随 Windows 系统代理、直接连接或自定义 HTTP/HTTPS/SOCKS 代理。

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
- API Key 使用 Electron `safeStorage` 加密；Renderer 无法读取保存后的明文。
- 浏览和归档完全在本地完成。
- 只有主动运行 Summary / Explore 或测试模型连接时，相关请求才会发送到设置中的模型服务。
- 可在“洞察偏好”中关闭思考摘要或工具详情，减少发送给模型的内容。

## 仓库结构

```text
VESTI-APP/
├─ packages/capture-core/  # 可复用的 TypeScript 采集与标准化引擎
├─ src/main/               # Electron 主进程服务
├─ src/shared/             # Renderer 与主进程共享契约
├─ src/App.tsx             # React 界面
├─ build/                  # NSIS 自定义安装页
├─ scripts/                # Electron/原生模块构建准备
└─ docs/architecture.md    # 架构与适配器说明
```

App 只依赖 `@vesti/capture-core` 的包接口，不直接引用 CLI 命令。当前核心作为 workspace 包随仓库发布，保证单独克隆即可构建；后续可原样迁移到独立共享仓库或包注册表，让 CLI 和 App 同时依赖同一版本。

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm start` | 启动开发环境 |
| `pnpm core:build` | 单独构建采集核心 |
| `pnpm typecheck` | 构建核心并检查 App 类型 |
| `pnpm package` | 生成未安装的 Electron 应用目录 |
| `pnpm make` | 生成 Windows NSIS 安装包 |

## 常见问题

### 托盘中看不到 Vesti

确认运行的是 `0.2.1` 或更新版本。Windows 可能把新图标放进任务栏右侧的“隐藏的图标”区域；可在 Windows 任务栏设置中将 Vesti 固定显示。右键托盘图标可以打开/隐藏窗口、立即同步、暂停采集或退出。

### Summary / Explore 提示网络错误

默认选择“跟随系统代理”。如果 VPN 只提供本地端口但未写入 Windows 系统代理，请在“网络与代理”中选择“自定义代理”，例如 `http://127.0.0.1:7890`，保存后执行“保存并测试模型”。

### 修改数据目录后没有变化

保存设置后重启 Vesti。当前版本不会自动复制旧数据库和 Agent 结果。

## 文档

更详细的分层、安全边界和三类数据源策略见 [docs/architecture.md](docs/architecture.md)。
