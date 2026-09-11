# 代码签名(Windows / macOS)

> 现状:Windows 安装包未用受信任证书签名,用户首次运行会遇到
> SmartScreen「Windows 已保护你的电脑」蓝色警告(需点「更多信息 → 仍要运行」)。
> 这不是 bug——只有受信任代码签名证书才能消除,本文档说明选型和接入方式。

## 为什么需要证书

SmartScreen 用「发布者声誉」决定是否拦截:没有受信任签名,或签名证书
声誉不足,都会弹警告。声誉只能靠时间+下载量积累(OV 证书),或者直接
购买 EV 证书获得即时声誉。没有免费的「立刻消除」方案。

## 选型

| 方案 | 成本 | SmartScreen 效果 | 适合 |
|---|---|---|---|
| **SignPath.io(开源免费)** | 免费 | 等同 OV,声誉随时间积累 | 开源项目,**首选尝试** |
| OV 代码签名证书 | ¥700–2000/年(Sectigo/SSL.com/环球诚信等) | 初期仍警告,数周~数月下载量后消退 | 正式商业发布 |
| EV 代码签名证书 | ¥2000–3500/年,需硬件 token 或云 HSM | **即时声誉**,不弹警告 | 预算充足、要立即体验 |

- SignPath Foundation 为开源项目提供免费代码签名(GitHub Actions 集成),
  我们满足条件(MIT 仓库公开)。申请:https://signpath.io → SignPath
  Foundation → 提交仓库审核,通常 1–2 周。
- EV 现在均为云 HSM 模式(SSL.com eSigner、DigiCert KeyLocker),
  可配合 CI;实体 USB token 不方便自动化。

## 接入方式(electron-builder 已内置支持)

构建脚本 `make:win` 无需改动,签名由 electron-builder 在打包时自动完成:

**OV / PFX 证书(本地构建)**

```bash
# Git Bash / PowerShell 设置环境变量后再 pnpm make:win
export CSC_LINK="/c/path/to/cert.pfx"          # 或 base64 内容
export CSC_KEY_PASSWORD="pfx密码"
pnpm make:win
```

**Windows 证书 store(导入过证书)**

```bash
export CSC_NAME="证书主题名(Subject CN)"
pnpm make:win
```

**SignPath / eSigner / KeyLocker(云签名)**

这些平台提供 signtool 兼容的调用方式。在 `electron-builder.yml` 增加
自定义签名钩子(需要时再实现,见 electron-builder 文档 `signtoolOptions`
与 `sign` hook);GitHub Actions 用官方 action(`signpath/github-action-submit-signing-request`
或 eSigner 的 `sslcom/esigner-codesign`)。

## 验证签名状态

```powershell
# Windows PowerShell
Get-AuthenticodeSignature .\out\installer\Vesti-*-Setup.exe
# Status 应为 Valid,SignerCertificate.Subject 显示公司名
```

## macOS(后续)

macOS 公证(notarization)需要 Apple Developer Program($99/年)+
`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` 环境变量,
electron-builder 的 `@electron/notarize` 已就位(hardenedRuntime 已开)。
发布 mac 版时再办。

## 当前缓解措施(无证书期间)

- 官网下载页提示用户 SmartScreen 警告的正常操作流程(「更多信息 → 仍要运行」)。
- 提供安装包 SHA-256 校验值供核对。
