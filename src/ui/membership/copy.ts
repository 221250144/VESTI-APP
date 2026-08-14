import type { MembershipErrorCode } from "../../shared/contracts";
import type { SupportedLocale } from "../i18n/locales";

export type MembershipUiError = MembershipErrorCode | "password_mismatch" | "unexpected";

export interface MembershipCopy {
  language: string;
  toggleTheme: string;
  heroEyebrow: string;
  heroTitle: string;
  heroDescription: string;
  localFirst: string;
  localFirstDescription: string;
  trial: string;
  trialDescription: string;
  registerTitle: string;
  registerDescription: string;
  loginTitle: string;
  loginDescription: string;
  username: string;
  usernamePlaceholder: string;
  password: string;
  passwordPlaceholder: string;
  confirmPassword: string;
  confirmPasswordPlaceholder: string;
  register: string;
  registering: string;
  login: string;
  loggingIn: string;
  accountStoredLocally: string;
  expiredEyebrow: string;
  expiredTitle: string;
  expiredDescription: string;
  expiredFor: string;
  expiredAt: string;
  checkAgain: string;
  checking: string;
  logout: string;
  loggingOut: string;
  loadingTitle: string;
  loadingDescription: string;
  loadFailedTitle: string;
  loadFailedDescription: string;
  retry: string;
  betaMember: string;
  active: string;
  accountTitle: string;
  accountDescription: string;
  memberSince: string;
  membershipExpires: string;
  remainingDays: string;
  remainingDay: string;
  accountUsername: string;
  /** Badge + expiry-row note once an expired account continues as free tier. */
  freePlan: string;
  expiredToFreeNote: string;
  // ---- Credit card (settings) ----
  creditsTitle: string;
  creditsDescription: string;
  /** Balance line: "{remaining}" = remaining credits. */
  creditsRemaining: string;
  /** Quota line: "{quota}" = cycle allowance. */
  creditsQuota: string;
  /** Reset line: "{date}" = formatted reset instant. */
  creditsReset: string;
  /** Shown instead of the balance when llm.mode === 'custom_byok'. */
  creditsByok: string;
  /** Inline hint when remaining reaches 0. */
  creditsExhausted: string;
  creditsDocButton: string;
  creditsDocClose: string;
  // ---- 会员与积分说明 doc modal ----
  creditsDocTitle: string;
  creditsDocGreeting: string;
  creditsDocSections: Array<{ heading: string; body: string }>;
  // ---- 隐私说明与数据贡献协议 (registration consent + settings card) ----
  /** Checkbox label prefix, followed by the clickable privacyAgreementName. */
  consentPrefix: string;
  privacyAgreementName: string;
  /** Label text after the agreement name (empty for zh/en; ja/ko word order). */
  consentSuffix: string;
  privacyEyebrow: string;
  privacyTitle: string;
  /** "{version}" = PRIVACY_AGREEMENT_VERSION. */
  privacyVersion: string;
  privacyIntro: string;
  privacySections: Array<{ heading: string; body: string }>;
  /** Footer button that just closes the agreement modal. */
  privacyReadButton: string;
  /** Footer button that confirms consent (settings enable flow). */
  privacyAgreeButton: string;
  // ---- 数据贡献 card (settings) ----
  dataContributionTitle: string;
  dataContributionDescription: string;
  dataContributionHint: string;
  dataContributionViewAgreement: string;
  /** "{date}" = YYYY-MM-DD consent date. */
  dataContributionConsentedAt: string;
  dataContributionEnabled: string;
  dataContributionDisabled: string;
  errors: Record<MembershipUiError, string>;
}

export const MEMBERSHIP_COPY: Record<SupportedLocale, MembershipCopy> = {
  zh: {
    language: "界面语言",
    toggleTheme: "切换深浅色模式",
    heroEyebrow: "VESTI / BETA MEMBERSHIP",
    heroTitle: "让每一次 AI 对话，成为可积累的知识",
    heroDescription:
      "Vesti 在本地捕获、整理并连接你与 AI 的工作记录。注册后即可解锁完整产品。",
    localFirst: "本地优先",
    localFirstDescription: "账号与会话数据保存在当前设备上。",
    trial: "赠送 3 个月会员",
    trialDescription: "首次注册成功后立即生效，无需绑定付款方式。",
    registerTitle: "创建 Vesti 账号",
    registerDescription: "首次注册将自动开通 3 个月 Beta 会员。",
    loginTitle: "欢迎回来",
    loginDescription: "登录本机账号，继续使用你的 Vesti 工作空间。",
    username: "用户名",
    usernamePlaceholder: "输入用户名",
    password: "密码",
    passwordPlaceholder: "至少 8 位密码",
    confirmPassword: "确认密码",
    confirmPasswordPlaceholder: "再次输入密码",
    register: "注册并领取会员",
    registering: "正在创建账号…",
    login: "登录 Vesti",
    loggingIn: "正在登录…",
    accountStoredLocally: "当前为本地 Beta 账号，仅在这台设备上有效。",
    expiredEyebrow: "MEMBERSHIP EXPIRED",
    expiredTitle: "你的 Beta 会员已到期",
    expiredDescription:
      "续费功能正在准备中。会员恢复前，Vesti 的会话库、分析和 Agent 能力将保持锁定。",
    expiredFor: "已登录账号",
    expiredAt: "到期时间",
    checkAgain: "重新检查",
    checking: "正在检查…",
    logout: "退出登录",
    loggingOut: "正在退出…",
    loadingTitle: "正在验证会员状态",
    loadingDescription: "Vesti 正在安全地读取这台设备上的本地账号。",
    loadFailedTitle: "暂时无法读取会员状态",
    loadFailedDescription: "请重试。如果问题持续出现，你的会话数据仍会安全保留在本地。",
    retry: "重试",
    betaMember: "Beta 会员",
    active: "有效",
    accountTitle: "会员与账号",
    accountDescription: "管理当前设备上的 Vesti Beta 会员。",
    memberSince: "开通时间",
    membershipExpires: "会员到期",
    remainingDays: "剩余 {count} 天",
    remainingDay: "剩余 1 天",
    accountUsername: "用户名",
    freePlan: "免费版",
    expiredToFreeNote: "已转为免费版",
    creditsTitle: "积分",
    creditsDescription: "官方代理下智能服务的计量与余额。",
    creditsRemaining: "剩余 {remaining}",
    creditsQuota: "本期共 {quota}",
    creditsReset: "{date} 重置",
    creditsByok: "已配置自带密钥（BYOK），所有调用走你的密钥，不消耗积分。",
    creditsExhausted: "本周期积分已用完，重置后恢复；切换自带密钥可继续。",
    creditsDocButton: "会员与积分说明",
    creditsDocClose: "关闭",
    creditsDocTitle: "会员与积分说明",
    creditsDocGreeting: "亲爱的Vesti用户：\n\n感谢你把自己的 AI 工作记忆托付给 Vesti。",
    creditsDocSections: [
      {
        heading: "我们的约定",
        body: "Vesti 是本地优先的产品：你的对话库、记忆空间与账号信息都保存在你自己的设备上。会员与积分体系只有一个目的——覆盖真实的智能成本，让产品可以长期、健康地运转。",
      },
      {
        heading: "积分是什么",
        body: "积分是 Vesti 官方代理下智能服务的计量单位。约 1,000 tokens 的模型用量计 1 积分（每次调用最低 1 积分）；AI 绘图每张 20 积分。做梦、AI 接力压缩、记忆追踪树构建、夜话等功能的积分消耗，都来自这些功能背后真实的模型调用。",
      },
      {
        heading: "免费版",
        body: "注册账号即可长期使用免费版：每日 300 积分，零点重置，可用于接力压缩、记忆追踪树、夜话对话等日常功能。",
      },
      {
        heading: "Beta 会员",
        body: "每月 50,000 积分（按开通日每月重置），并解锁做梦、AITI 画像等高级功能。现在注册即赠送 3 个月 Beta 会员，无需绑定任何付款方式。",
      },
      {
        heading: "自带密钥（BYOK）",
        body: "如果你在设置中配置了自己的模型密钥，所有调用直接走你的密钥、由你的服务商计费，Vesti 不消耗任何积分。",
      },
      {
        heading: "透明与对账",
        body: "积分账本保存在本机（credits.json），每次扣减都有记录可查；官方网关同时记录用量日志用于对账。Beta 阶段为本地账本模式，未来正式计费时将升级为服务端签发。",
      },
      {
        heading: "过期之后",
        body: "会员到期不会锁死你的数据与工作空间——账号自动转为免费版，每日积分照常发放，所有本地数据始终属于你自己。",
      },
    ],
    consentPrefix: "我已阅读并同意",
    privacyAgreementName: "《隐私说明与数据贡献协议》",
    consentSuffix: "",
    privacyEyebrow: "PRIVACY & DATA CONTRIBUTION",
    privacyTitle: "隐私说明与数据贡献协议",
    privacyVersion: "版本 v{version}",
    privacyIntro:
      "在你注册并领取免费会员之前，请仔细阅读本协议。勾选同意即表示你已阅读并接受本协议；不同意则无法领取免费会员，但你仍可在阅读后随时改变主意。",
    privacySections: [
      {
        heading: "我们收集什么",
        body: "在你同意后，Vesti 会持续上传本地 AI 编程工具（Kimi Code、Claude Code、Codex、Cursor 等 CLI 与桌面 Agent）的对话记录：你与 AI 的消息正文、AI 的思考与回复、工具调用摘要（工具名、输入输出摘要）、涉及的文件路径、时间戳、Token 用量与模型信息。这些数据将用于改进 Vesti 产品，以及人工智能模型的训练与研究（包括强化学习训练数据）。",
      },
      {
        heading: "我们不收集什么",
        body: "浏览器端对话（Kimi、DeepSeek、ChatGPT、Claude、Gemini 等网页 AI）仅存储在你本地，永远不会被上传；内容命中手机号、电子邮箱、身份证号、银行卡号、私钥/API 密钥等个人信息或敏感凭据模式的会话，会被整条排除，不会上传；你的用户名与密码仅以加密形式存储在你自己的电脑上，永远不会离开你的设备。",
      },
      {
        heading: "匿名性",
        body: "上传数据通过随机生成的匿名贡献者 ID 标识，与你的用户名无关。服务器端不记录你的 IP 画像，仅做基本的频率限制。",
      },
      {
        heading: "数据存储与安全",
        body: "数据存储于我们自有的服务器（阿里云，中国境内），访问权限仅限于核心开发团队，不会出售或共享给任何第三方。",
      },
      {
        heading: "你的权利与退出",
        body: "你可以在「设置 → 会员与账号 → 数据贡献」中随时一键关闭：关闭后立即停止一切上传，本地待上传队列即时清空，不影响你的会员权益。如需删除已上传的数据，请联系我们并提供你的匿名贡献者 ID。本协议变更时，我们会要求你重新阅读并确认。",
      },
      {
        heading: "风险提示",
        body: "个人信息过滤基于自动模式检测，尽管我们持续改进检测能力，仍可能存在漏检。请避免在与 AI 的对话中输入你的真实姓名、住址、证件号码等敏感个人信息。",
      },
    ],
    privacyReadButton: "我已阅读",
    privacyAgreeButton: "我已阅读并同意",
    dataContributionTitle: "数据贡献",
    dataContributionDescription: "同意《隐私说明与数据贡献协议》后，本地 AI 编程工具的对话会匿名上传，用于模型训练与产品改进。",
    dataContributionHint:
      "仅上传本地 AI 编程工具的对话；浏览器对话永不上传；含个人信息的会话自动排除。",
    dataContributionViewAgreement: "查看完整协议",
    dataContributionConsentedAt: "同意于 {date}",
    dataContributionEnabled: "已开启",
    dataContributionDisabled: "已关闭",
    errors: {
      NOT_INITIALIZED: "会员服务尚未准备好，请稍后重试。",
      ALREADY_REGISTERED: "这台设备已经注册过 Vesti 账号，请直接登录。",
      INVALID_USERNAME: "用户名需为 3–32 个字母或数字，也可以使用 .、_、-。",
      WEAK_PASSWORD: "密码至少需要 8 位。",
      NOT_REGISTERED: "这台设备上还没有 Vesti 账号。",
      INVALID_CREDENTIALS: "用户名或密码不正确。",
      AUTHENTICATION_REQUIRED: "请先登录有效的 Vesti 会员账号。",
      MEMBERSHIP_EXPIRED: "该账号的 Beta 会员已经到期。",
      MEMBERSHIP_DATA_CORRUPT: "本地会员文件无法读取，请联系 Vesti 团队协助处理。",
      CONSENT_REQUIRED: "请先阅读并勾选同意《隐私说明与数据贡献协议》。",
      STORAGE_ERROR: "无法安全保存本地账号，请检查磁盘权限后重试。",
      password_mismatch: "两次输入的密码不一致。",
      unexpected: "操作没有完成，请稍后重试。",
    },
  },
  en: {
    language: "Interface language",
    toggleTheme: "Toggle light or dark mode",
    heroEyebrow: "VESTI / BETA MEMBERSHIP",
    heroTitle: "Turn every AI conversation into knowledge that compounds",
    heroDescription:
      "Vesti captures, organizes, and connects your AI work locally. Create an account to unlock the complete product.",
    localFirst: "Local first",
    localFirstDescription: "Your account and conversations stay on this device.",
    trial: "3 months included",
    trialDescription: "Your Beta membership starts immediately, with no payment method required.",
    registerTitle: "Create your Vesti account",
    registerDescription: "Your first registration includes three months of Beta membership.",
    loginTitle: "Welcome back",
    loginDescription: "Sign in to the account on this device to continue to your workspace.",
    username: "Username",
    usernamePlaceholder: "Enter your username",
    password: "Password",
    passwordPlaceholder: "At least 8 characters",
    confirmPassword: "Confirm password",
    confirmPasswordPlaceholder: "Enter your password again",
    register: "Register and activate membership",
    registering: "Creating account…",
    login: "Sign in to Vesti",
    loggingIn: "Signing in…",
    accountStoredLocally: "This is a local Beta account and is valid only on this device.",
    expiredEyebrow: "MEMBERSHIP EXPIRED",
    expiredTitle: "Your Beta membership has expired",
    expiredDescription:
      "Renewals are being prepared. Your library, analytics, and Agent features remain locked until membership is restored.",
    expiredFor: "Signed-in account",
    expiredAt: "Expired on",
    checkAgain: "Check again",
    checking: "Checking…",
    logout: "Sign out",
    loggingOut: "Signing out…",
    loadingTitle: "Checking your membership",
    loadingDescription: "Vesti is securely reading the local account on this device.",
    loadFailedTitle: "Membership status is unavailable",
    loadFailedDescription: "Try again. Your conversation data remains safely stored on this device.",
    retry: "Try again",
    betaMember: "Beta member",
    active: "Active",
    accountTitle: "Membership & account",
    accountDescription: "Manage the Vesti Beta membership on this device.",
    memberSince: "Member since",
    membershipExpires: "Membership expires",
    remainingDays: "{count} days remaining",
    remainingDay: "1 day remaining",
    accountUsername: "Username",
    freePlan: "Free tier",
    expiredToFreeNote: "Converted to the free tier",
    creditsTitle: "Credits",
    creditsDescription: "Metering and balance for intelligence served through the official proxy.",
    creditsRemaining: "{remaining} remaining",
    creditsQuota: "{quota} per cycle",
    creditsReset: "Resets {date}",
    creditsByok: "Your own key (BYOK) is configured — every call is billed by your provider and consumes no credits.",
    creditsExhausted: "This cycle's credits are used up; they return at reset, or switch to BYOK to keep going.",
    creditsDocButton: "Membership & credits guide",
    creditsDocClose: "Close",
    creditsDocTitle: "Membership & Credits",
    creditsDocGreeting: "Dear Vesti user,\n\nThank you for entrusting your AI work memory to Vesti.",
    creditsDocSections: [
      {
        heading: "Our promise",
        body: "Vesti is a local-first product: your conversation library, memory space, and account all live on your own device. Membership and credits exist for one purpose only — to cover real intelligence costs so the product can run sustainably for the long term.",
      },
      {
        heading: "What credits are",
        body: "Credits are the metering unit for Vesti's official-proxy intelligence services. Roughly 1,000 tokens of model usage cost 1 credit (minimum 1 credit per call); AI image generation costs 20 credits per image. The credits spent by Dream, AI relay compression, memory-tracking tree building, and Night Talk all come from the real model calls behind those features.",
      },
      {
        heading: "Free tier",
        body: "Register an account and use the free tier indefinitely: 300 credits per day, reset at midnight, usable for everyday features like relay compression, the memory-tracking tree, and Night Talk conversations.",
      },
      {
        heading: "Beta membership",
        body: "50,000 credits per month (reset monthly on your activation day), plus advanced features such as Dream and the AITI portrait. Sign up now and receive 3 months of Beta membership — no payment method required.",
      },
      {
        heading: "Bring your own key (BYOK)",
        body: "If you configure your own model key in Settings, every call goes directly through your key and is billed by your provider — Vesti consumes no credits at all.",
      },
      {
        heading: "Transparency & reconciliation",
        body: "The credit ledger lives on this device (credits.json), and every deduction is recorded and auditable; the official gateway also keeps usage logs for reconciliation. During Beta the ledger is local-only; it will be upgraded to server-issued metering when paid billing launches.",
      },
      {
        heading: "After expiry",
        body: "An expired membership never locks your data or workspace — the account automatically converts to the free tier, daily credits keep flowing, and all local data remains yours.",
      },
    ],
    consentPrefix: "I have read and agree to the ",
    privacyAgreementName: "Privacy & Data Contribution Agreement",
    consentSuffix: "",
    privacyEyebrow: "PRIVACY & DATA CONTRIBUTION",
    privacyTitle: "Privacy & Data Contribution Agreement",
    privacyVersion: "Version v{version}",
    privacyIntro:
      "Please read this agreement carefully before registering and claiming your free membership. Checking the box means you have read and accepted it; without consent the free membership cannot be claimed, but you can always change your mind after reading.",
    privacySections: [
      {
        heading: "What we collect",
        body: "Once you agree, Vesti continuously uploads conversations from local AI coding tools (Kimi Code, Claude Code, Codex, Cursor and other CLIs and desktop agents): your messages and the AI's replies, the AI's thinking, tool-call summaries (tool names, input/output summaries), file paths involved, timestamps, token usage, and model information. This data is used to improve Vesti and for AI model training and research, including reinforcement-learning training data.",
      },
      {
        heading: "What we never collect",
        body: "Browser-side conversations (web AIs such as Kimi, DeepSeek, ChatGPT, Claude, Gemini) are stored only on your device and are never uploaded. Any session whose content matches personal-information or sensitive-credential patterns — phone numbers, email addresses, ID numbers, bank card numbers, private keys/API keys — is excluded as a whole and never uploaded. Your username and password are stored only in encrypted form on your own computer and never leave your device.",
      },
      {
        heading: "Anonymity",
        body: "Uploaded data is identified by a randomly generated anonymous contributor ID, unrelated to your username. The server does not profile your IP address and applies only basic rate limiting.",
      },
      {
        heading: "Storage & security",
        body: "Data is stored on our own servers (Alibaba Cloud, mainland China), accessible only to the core development team, and is never sold to or shared with any third party.",
      },
      {
        heading: "Your rights & withdrawal",
        body: "You can turn contribution off at any time under Settings → Membership & account → Data contribution: all uploading stops immediately, the local pending-upload queue is cleared at once, and your membership benefits are unaffected. To delete data already uploaded, contact us with your anonymous contributor ID. When this agreement changes, we will ask you to read and confirm it again.",
      },
      {
        heading: "Risk notice",
        body: "Personal-information filtering relies on automated pattern detection; although we keep improving it, some cases may be missed. Please avoid entering sensitive personal information such as your real name, address, or ID numbers into AI conversations.",
      },
    ],
    privacyReadButton: "I have read it",
    privacyAgreeButton: "I have read and agree",
    dataContributionTitle: "Data contribution",
    dataContributionDescription:
      "With the Privacy & Data Contribution Agreement accepted, conversations from local AI coding tools are uploaded anonymously for model training and product improvement.",
    dataContributionHint:
      "Only conversations from local AI coding tools are uploaded; browser conversations are never uploaded; sessions containing personal information are automatically excluded.",
    dataContributionViewAgreement: "Read the full agreement",
    dataContributionConsentedAt: "Consented on {date}",
    dataContributionEnabled: "On",
    dataContributionDisabled: "Off",
    errors: {
      NOT_INITIALIZED: "The membership service is not ready yet. Please try again.",
      ALREADY_REGISTERED: "A Vesti account already exists on this device. Sign in instead.",
      INVALID_USERNAME: "Use 3–32 letters or numbers; ., _, and - are also allowed.",
      WEAK_PASSWORD: "Use a password with at least 8 characters.",
      NOT_REGISTERED: "No Vesti account is registered on this device.",
      INVALID_CREDENTIALS: "The username or password is incorrect.",
      AUTHENTICATION_REQUIRED: "Sign in with an active Vesti membership to continue.",
      MEMBERSHIP_EXPIRED: "The Beta membership for this account has expired.",
      MEMBERSHIP_DATA_CORRUPT: "The local membership file could not be read. Contact the Vesti team for help.",
      CONSENT_REQUIRED: "Please read and accept the Privacy & Data Contribution Agreement first.",
      STORAGE_ERROR: "Vesti could not safely save the local account. Check disk permissions and retry.",
      password_mismatch: "The passwords do not match.",
      unexpected: "The action could not be completed. Please try again.",
    },
  },
  ja: {
    language: "表示言語",
    toggleTheme: "ライト／ダークモードを切り替える",
    heroEyebrow: "VESTI / BETA MEMBERSHIP",
    heroTitle: "AI との対話を、積み重なる知識へ",
    heroDescription:
      "Vesti は AI との作業記録をローカルで収集・整理し、つなげます。アカウントを作成すると、すべての機能を利用できます。",
    localFirst: "ローカルファースト",
    localFirstDescription: "アカウントと会話データはこの端末に保存されます。",
    trial: "3 か月無料",
    trialDescription: "初回登録後すぐに有効になります。支払い方法の登録は不要です。",
    registerTitle: "Vesti アカウントを作成",
    registerDescription: "初回登録で 3 か月の Beta メンバーシップが有効になります。",
    loginTitle: "おかえりなさい",
    loginDescription: "この端末のアカウントにログインして、ワークスペースを開きます。",
    username: "ユーザー名",
    usernamePlaceholder: "ユーザー名を入力",
    password: "パスワード",
    passwordPlaceholder: "8 文字以上",
    confirmPassword: "パスワードの確認",
    confirmPasswordPlaceholder: "もう一度入力してください",
    register: "登録してメンバーシップを開始",
    registering: "アカウントを作成中…",
    login: "Vesti にログイン",
    loggingIn: "ログイン中…",
    accountStoredLocally: "このローカル Beta アカウントは、この端末でのみ有効です。",
    expiredEyebrow: "MEMBERSHIP EXPIRED",
    expiredTitle: "Beta メンバーシップの有効期限が切れました",
    expiredDescription:
      "更新機能は現在準備中です。再開されるまで、ライブラリ、分析、Agent 機能はロックされます。",
    expiredFor: "ログイン中のアカウント",
    expiredAt: "有効期限",
    checkAgain: "もう一度確認",
    checking: "確認中…",
    logout: "ログアウト",
    loggingOut: "ログアウト中…",
    loadingTitle: "メンバーシップを確認しています",
    loadingDescription: "この端末のローカルアカウントを安全に読み込んでいます。",
    loadFailedTitle: "メンバーシップを確認できません",
    loadFailedDescription: "再試行してください。会話データはこの端末に安全に保存されています。",
    retry: "再試行",
    betaMember: "Beta メンバー",
    active: "有効",
    accountTitle: "メンバーシップとアカウント",
    accountDescription: "この端末の Vesti Beta メンバーシップを管理します。",
    memberSince: "開始日",
    membershipExpires: "有効期限",
    remainingDays: "残り {count} 日",
    remainingDay: "残り 1 日",
    accountUsername: "ユーザー名",
    freePlan: "無料版",
    expiredToFreeNote: "無料版に移行しました",
    creditsTitle: "クレジット",
    creditsDescription: "公式プロキシ経由のインテリジェンスサービスの計量と残高です。",
    creditsRemaining: "残り {remaining}",
    creditsQuota: "今期の合計 {quota}",
    creditsReset: "{date} にリセット",
    creditsByok: "自分のキー（BYOK）を設定済みのため、すべての呼び出しはあなたのキー経由で課金され、クレジットは消費されません。",
    creditsExhausted: "今期のクレジットを使い切りました。リセット後に回復します。BYOK に切り替えると続けられます。",
    creditsDocButton: "メンバーシップとクレジットの説明",
    creditsDocClose: "閉じる",
    creditsDocTitle: "メンバーシップとクレジットについて",
    creditsDocGreeting: "親愛なる Vesti ユーザーの皆様：\n\nAI との作業の記憶を Vesti にお預けいただき、ありがとうございます。",
    creditsDocSections: [
      {
        heading: "私たちの約束",
        body: "Vesti はローカルファーストの製品です。会話ライブラリ、メモリー空間、アカウント情報はすべてあなた自身の端末に保存されます。メンバーシップとクレジットの目的はただひとつ——実際のインテリジェンスコストをまかない、製品が長く健全に運営され続けるようにすることです。",
      },
      {
        heading: "クレジットとは",
        body: "クレジットは Vesti 公式プロキシのインテリジェンスサービスの計量単位です。約 1,000 tokens のモデル使用量で 1 クレジット（1 回の呼び出しにつき最低 1 クレジット）、AI 画像生成は 1 枚 20 クレジットです。夢、AI リレー圧縮、記憶トラッキングツリーの構築、夜話などのクレジット消費は、これらの機能の背後にある実際のモデル呼び出しから生じています。",
      },
      {
        heading: "無料版",
        body: "アカウントを登録すれば、無料版をずっとお使いいただけます。毎日 300 クレジットが 0 時にリセットされ、リレー圧縮、記憶トラッキングツリー、夜話などの日常機能に利用できます。",
      },
      {
        heading: "Beta メンバーシップ",
        body: "毎月 50,000 クレジット（開通日を起点に毎月リセット）に加え、夢、AITI 画像などの高度な機能が解放されます。今ご登録いただくと 3 か月の Beta メンバーシップをプレゼント。お支払い方法の登録は不要です。",
      },
      {
        heading: "自分のキーを使う（BYOK）",
        body: "設定で自分のモデルキーを構成している場合、すべての呼び出しはあなたのキーを直接通り、ご利用のプロバイダーが課金します。Vesti はクレジットを一切消費しません。",
      },
      {
        heading: "透明性と照合",
        body: "クレジット台帳はこの端末（credits.json）に保存され、すべての引き落としが記録され、いつでも確認できます。公式ゲートウェイ側でも照合用の使用ログを記録しています。Beta 期間中はローカル台帳モードで、正式な課金の開始時にはサーバー発行へアップグレードされます。",
      },
      {
        heading: "有効期限が切れた後",
        body: "メンバーシップが切れても、データやワークスペースがロックされることはありません。アカウントは自動的に無料版に移行し、毎日のクレジットは引き続き付与されます。すべてのローカルデータは常にあなたのものです。",
      },
    ],
    consentPrefix: "",
    privacyAgreementName: "「プライバシーとデータ貢献に関する同意書」",
    consentSuffix: "に同意します",
    privacyEyebrow: "PRIVACY & DATA CONTRIBUTION",
    privacyTitle: "プライバシーとデータ貢献に関する同意書",
    privacyVersion: "バージョン v{version}",
    privacyIntro:
      "無料メンバーシップの登録・受け取り前に、本同意書をよくお読みください。チェックを入れると内容に同意したことになります。同意しない場合は無料メンバーシップを受け取れませんが、お読みいただいた後いつでも考えを変えられます。",
    privacySections: [
      {
        heading: "収集するもの",
        body: "同意後、Vesti はローカルの AI コーディングツール（Kimi Code、Claude Code、Codex、Cursor などの CLI・デスクトップ Agent）の会話記録を継続的にアップロードします。AI とのメッセージ本文、AI の思考と返信、ツール呼び出しの要約（ツール名・入出力の要約）、関連するファイルパス、タイムスタンプ、トークン使用量、モデル情報が含まれます。これらのデータは Vesti の改善と、AI モデルのトレーニング・研究（強化学習の訓練データを含む）に使用されます。",
      },
      {
        heading: "収集しないもの",
        body: "ブラウザ側の会話（Kimi、DeepSeek、ChatGPT、Claude、Gemini などの Web AI）はローカルにのみ保存され、アップロードされることはありません。電話番号、メールアドレス、身分証番号、銀行カード番号、秘密鍵/API キーなどの個人情報・機密認証情報パターンに一致した会話は、セッション全体が除外されアップロードされません。ユーザー名とパスワードは暗号化された形でのみお使いのコンピューターに保存され、デバイスから出ることはありません。",
      },
      {
        heading: "匿名性",
        body: "アップロードされるデータはランダムに生成された匿名の貢献者 ID で識別され、ユーザー名とは無関係です。サーバー側で IP プロファイリングは行わず、基本的なレート制限のみを実施します。",
      },
      {
        heading: "データの保存とセキュリティ",
        body: "データは自社サーバー（Alibaba Cloud、中国国内）に保存され、アクセスはコア開発チームに限定されます。第三者への販売・共有は一切行いません。",
      },
      {
        heading: "あなたの権利と退出",
        body: "「設定 → メンバーシップとアカウント → データ貢献」からいつでもワンクリックで無効化できます。無効化するとすべてのアップロードが即座に停止し、ローカルの送信待ちキューは直ちにクリアされます。メンバーシップの特典への影響はありません。アップロード済みデータの削除をご希望の場合は、匿名貢献者 ID を添えてご連絡ください。本同意書に変更がある場合は、再度お読みいただき確認を求めます。",
      },
      {
        heading: "リスクに関する注意",
        body: "個人情報のフィルタリングは自動パターン検出に基づいており、改善を続けていますが、見落としの可能性があります。AI との会話に本名、住所、証明書番号などの機密性の高い個人情報を入力しないでください。",
      },
    ],
    privacyReadButton: "読みました",
    privacyAgreeButton: "読みました、同意します",
    dataContributionTitle: "データ貢献",
    dataContributionDescription:
      "「プライバシーとデータ貢献に関する同意書」に同意すると、ローカル AI コーディングツールの会話が匿名でアップロードされ、モデルのトレーニングと製品改善に使われます。",
    dataContributionHint:
      "アップロードされるのはローカル AI コーディングツールの会話のみです。ブラウザの会話は永遠にアップロードされず、個人情報を含むセッションは自動的に除外されます。",
    dataContributionViewAgreement: "同意書全文を見る",
    dataContributionConsentedAt: "同意日 {date}",
    dataContributionEnabled: "オン",
    dataContributionDisabled: "オフ",
    errors: {
      NOT_INITIALIZED: "メンバーシップサービスの準備が完了していません。もう一度お試しください。",
      ALREADY_REGISTERED: "この端末にはすでに Vesti アカウントがあります。ログインしてください。",
      INVALID_USERNAME: "ユーザー名は 3～32 文字の英数字、または .、_、- を使用してください。",
      WEAK_PASSWORD: "8 文字以上のパスワードを使用してください。",
      NOT_REGISTERED: "この端末には Vesti アカウントが登録されていません。",
      INVALID_CREDENTIALS: "ユーザー名またはパスワードが正しくありません。",
      AUTHENTICATION_REQUIRED: "有効な Vesti メンバーアカウントでログインしてください。",
      MEMBERSHIP_EXPIRED: "このアカウントの Beta メンバーシップは期限切れです。",
      MEMBERSHIP_DATA_CORRUPT: "ローカルのメンバーシップファイルを読み取れません。Vesti チームにお問い合わせください。",
      CONSENT_REQUIRED: "先に「プライバシーとデータ貢献に関する同意書」をお読みいただき、同意にチェックを入れてください。",
      STORAGE_ERROR: "ローカルアカウントを保存できません。ディスクの権限を確認してください。",
      password_mismatch: "パスワードが一致しません。",
      unexpected: "操作を完了できませんでした。もう一度お試しください。",
    },
  },
  ko: {
    language: "인터페이스 언어",
    toggleTheme: "라이트 또는 다크 모드 전환",
    heroEyebrow: "VESTI / BETA MEMBERSHIP",
    heroTitle: "AI 대화를 쌓여 가는 지식으로",
    heroDescription:
      "Vesti는 AI 작업 기록을 로컬에서 수집하고 정리해 서로 연결합니다. 계정을 만들면 모든 기능을 사용할 수 있습니다.",
    localFirst: "로컬 우선",
    localFirstDescription: "계정과 대화 데이터는 이 기기에 저장됩니다.",
    trial: "3개월 무료 제공",
    trialDescription: "첫 가입 즉시 활성화되며 결제 수단을 등록할 필요가 없습니다.",
    registerTitle: "Vesti 계정 만들기",
    registerDescription: "처음 가입하면 3개월 Beta 멤버십이 자동으로 시작됩니다.",
    loginTitle: "다시 오신 것을 환영합니다",
    loginDescription: "이 기기의 계정으로 로그인해 작업 공간을 계속 이용하세요.",
    username: "사용자 이름",
    usernamePlaceholder: "사용자 이름 입력",
    password: "비밀번호",
    passwordPlaceholder: "8자 이상",
    confirmPassword: "비밀번호 확인",
    confirmPasswordPlaceholder: "비밀번호를 다시 입력",
    register: "가입하고 멤버십 시작",
    registering: "계정 만드는 중…",
    login: "Vesti 로그인",
    loggingIn: "로그인 중…",
    accountStoredLocally: "이 로컬 Beta 계정은 현재 기기에서만 유효합니다.",
    expiredEyebrow: "MEMBERSHIP EXPIRED",
    expiredTitle: "Beta 멤버십이 만료되었습니다",
    expiredDescription:
      "갱신 기능을 준비하고 있습니다. 멤버십이 복구될 때까지 라이브러리, 분석 및 Agent 기능이 잠깁니다.",
    expiredFor: "로그인한 계정",
    expiredAt: "만료일",
    checkAgain: "다시 확인",
    checking: "확인 중…",
    logout: "로그아웃",
    loggingOut: "로그아웃 중…",
    loadingTitle: "멤버십 확인 중",
    loadingDescription: "이 기기의 로컬 계정을 안전하게 불러오고 있습니다.",
    loadFailedTitle: "멤버십 상태를 확인할 수 없습니다",
    loadFailedDescription: "다시 시도하세요. 대화 데이터는 이 기기에 안전하게 보관되어 있습니다.",
    retry: "다시 시도",
    betaMember: "Beta 멤버",
    active: "활성",
    accountTitle: "멤버십 및 계정",
    accountDescription: "이 기기의 Vesti Beta 멤버십을 관리합니다.",
    memberSince: "시작일",
    membershipExpires: "만료일",
    remainingDays: "{count}일 남음",
    remainingDay: "1일 남음",
    accountUsername: "사용자 이름",
    freePlan: "무료 버전",
    expiredToFreeNote: "무료 버전으로 전환되었습니다",
    creditsTitle: "크레딧",
    creditsDescription: "공식 프록시 인텔리전스 서비스의 사용량 계량과 잔액입니다.",
    creditsRemaining: "남은 크레딧 {remaining}",
    creditsQuota: "이번 주기 총 {quota}",
    creditsReset: "{date}에 초기화",
    creditsByok: "자체 키(BYOK)가 구성되어 있어 모든 호출이 사용자의 키를 통해 이루어지며 크레딧을 소비하지 않습니다.",
    creditsExhausted: "이번 주기 크레딧을 모두 사용했습니다. 초기화 후 복구되며, BYOK로 전환하면 계속 사용할 수 있습니다.",
    creditsDocButton: "멤버십 및 크레딧 안내",
    creditsDocClose: "닫기",
    creditsDocTitle: "멤버십 및 크레딧 안내",
    creditsDocGreeting: "소중한 Vesti 사용자 여러분:\n\nAI 작업 기억을 Vesti에 맡겨 주셔서 감사합니다.",
    creditsDocSections: [
      {
        heading: "우리의 약속",
        body: "Vesti는 로컬 우선 제품입니다. 대화 라이브러리, 메모리 공간, 계정 정보는 모두 사용자의 기기에 저장됩니다. 멤버십과 크레딧의 목적은 단 하나 — 실제 인텔리전스 비용을 충당해 제품이 오랫동안 건강하게 운영되도록 하는 것입니다.",
      },
      {
        heading: "크레딧이란",
        body: "크레딧은 Vesti 공식 프록시 인텔리전스 서비스의 계량 단위입니다. 약 1,000 tokens의 모델 사용량이 1크레딧(호출당 최소 1크레딧)이며, AI 이미지 생성은 장당 20크레딧입니다. 꿈, AI 릴레이 압축, 메모리 트래킹 트리 구축, 밤의 대화 등 기능의 크레딧 소비는 모두 해당 기능 뒤의 실제 모델 호출에서 발생합니다.",
      },
      {
        heading: "무료 버전",
        body: "계정을 등록하면 무료 버전을 계속 사용할 수 있습니다. 매일 300 크레딧이 자정에 초기화되며, 릴레이 압축, 메모리 트래킹 트리, 밤의 대화 등 일상 기능에 사용할 수 있습니다.",
      },
      {
        heading: "Beta 멤버십",
        body: "매월 50,000 크레딧(개통일 기준 매월 초기화)과 함께 꿈, AITI 프로필 등 고급 기능이 잠금 해제됩니다. 지금 가입하면 3개월 Beta 멤버십을 드리며, 결제 수단을 등록할 필요가 없습니다.",
      },
      {
        heading: "자체 키 사용(BYOK)",
        body: "설정에서 자신의 모델 키를 구성했다면, 모든 호출이 사용자의 키를 통해 직접 이루어지고 제공업체가 요금을 청구합니다. Vesti는 크레딧을 전혀 소비하지 않습니다.",
      },
      {
        heading: "투명성과 대조",
        body: "크레딧 원장은 이 기기(credits.json)에 저장되며 모든 차감 내역을 확인할 수 있습니다. 공식 게이트웨이에도 대조용 사용 로그가 기록됩니다. Beta 단계에서는 로컬 원장 모드이며, 정식 과금 시 서버 발급 방식으로 업그레이드됩니다.",
      },
      {
        heading: "만료 이후",
        body: "멤버십이 만료되어도 데이터와 작업 공간은 잠기지 않습니다. 계정이 자동으로 무료 버전으로 전환되고 매일 크레딧이 계속 지급되며, 모든 로컬 데이터는 항상 사용자의 것입니다.",
      },
    ],
    consentPrefix: "",
    privacyAgreementName: "「개인정보 및 데이터 기여 동의서」",
    consentSuffix: "를 읽고 동의합니다",
    privacyEyebrow: "PRIVACY & DATA CONTRIBUTION",
    privacyTitle: "개인정보 및 데이터 기여 동의서",
    privacyVersion: "버전 v{version}",
    privacyIntro:
      "무료 멤버십을 등록하고 받기 전에 본 동의서를 주의 깊게 읽어 주세요. 체크박스를 선택하면 본 동의서를 읽고 동의한 것으로 간주됩니다. 동의하지 않으면 무료 멤버십을 받을 수 없지만, 읽은 후 언제든지 마음을 바꿀 수 있습니다.",
    privacySections: [
      {
        heading: "수집하는 항목",
        body: "동의 후 Vesti는 로컬 AI 코딩 도구(Kimi Code, Claude Code, Codex, Cursor 등 CLI 및 데스크톱 Agent)의 대화 기록을 지속적으로 업로드합니다. AI와 주고받은 메시지 본문, AI의 사고와 응답, 도구 호출 요약(도구 이름, 입력·출력 요약), 관련 파일 경로, 타임스탬프, 토큰 사용량 및 모델 정보가 포함됩니다. 이 데이터는 Vesti 제품 개선과 AI 모델 학습·연구(강화 학습 훈련 데이터 포함)에 사용됩니다.",
      },
      {
        heading: "수집하지 않는 항목",
        body: "브라우저 대화(Kimi, DeepSeek, ChatGPT, Claude, Gemini 등 웹 AI)는 사용자의 로컬에만 저장되며 절대 업로드되지 않습니다. 전화번호, 이메일 주소, 신분증 번호, 은행 카드 번호, 개인 키/API 키 등 개인 정보 또는 민감한 자격 증명 패턴에 해당하는 세션은 전체가 제외되어 업로드되지 않습니다. 사용자 이름과 비밀번호는 암호화된 형태로 사용자의 컴퓨터에만 저장되며 기기를 떠나지 않습니다.",
      },
      {
        heading: "익명성",
        body: "업로드된 데이터는 무작위로 생성된 익명 기여자 ID로 식별되며 사용자 이름과 무관합니다. 서버는 IP 프로파일링을 기록하지 않고 기본적인 속도 제한만 수행합니다.",
      },
      {
        heading: "데이터 저장 및 보안",
        body: "데이터는 자체 서버(Alibaba Cloud, 중국 본토)에 저장되며 핵심 개발 팀만 접근할 수 있고, 제3자에게 판매하거나 공유하지 않습니다.",
      },
      {
        heading: "사용자의 권리와 철회",
        body: "「설정 → 멤버십 및 계정 → 데이터 기여」에서 언제든 한 번의 클릭으로 끌 수 있습니다. 끄는 즉시 모든 업로드가 중단되고 로컬 업로드 대기열이 바로 비워지며, 멤버십 혜택에는 영향이 없습니다. 이미 업로드된 데이터의 삭제가 필요하면 익명 기여자 ID와 함께 문의해 주세요. 본 동의서가 변경되면 다시 읽고 확인해 주셔야 합니다.",
      },
      {
        heading: "위험 고지",
        body: "개인 정보 필터링은 자동 패턴 감지에 기반하며, 지속적으로 개선하고 있지만 누락될 가능성이 있습니다. AI와의 대화에 실명, 주소, 증명서 번호 등 민감한 개인 정보를 입력하지 마세요.",
      },
    ],
    privacyReadButton: "읽었습니다",
    privacyAgreeButton: "읽었으며 동의합니다",
    dataContributionTitle: "데이터 기여",
    dataContributionDescription:
      "「개인정보 및 데이터 기여 동의서」에 동의하면 로컬 AI 코딩 도구의 대화가 익명으로 업로드되어 모델 학습과 제품 개선에 사용됩니다.",
    dataContributionHint:
      "로컬 AI 코딩 도구의 대화만 업로드됩니다. 브라우저 대화는 절대 업로드되지 않으며, 개인 정보가 포함된 세션은 자동으로 제외됩니다.",
    dataContributionViewAgreement: "전체 동의서 보기",
    dataContributionConsentedAt: "동의일 {date}",
    dataContributionEnabled: "켜짐",
    dataContributionDisabled: "꺼짐",
    errors: {
      NOT_INITIALIZED: "멤버십 서비스가 아직 준비되지 않았습니다. 다시 시도해 주세요.",
      ALREADY_REGISTERED: "이 기기에 Vesti 계정이 이미 있습니다. 로그인해 주세요.",
      INVALID_USERNAME: "사용자 이름은 3~32자의 문자·숫자 또는 .、_、-를 사용하세요.",
      WEAK_PASSWORD: "8자 이상의 비밀번호를 사용하세요.",
      NOT_REGISTERED: "이 기기에 등록된 Vesti 계정이 없습니다.",
      INVALID_CREDENTIALS: "사용자 이름 또는 비밀번호가 올바르지 않습니다.",
      AUTHENTICATION_REQUIRED: "유효한 Vesti 멤버 계정으로 로그인해 주세요.",
      MEMBERSHIP_EXPIRED: "이 계정의 Beta 멤버십이 만료되었습니다.",
      MEMBERSHIP_DATA_CORRUPT: "로컬 멤버십 파일을 읽을 수 없습니다. Vesti 팀에 문의해 주세요.",
      CONSENT_REQUIRED: "먼저 「개인정보 및 데이터 기여 동의서」를 읽고 동의에 체크해 주세요.",
      STORAGE_ERROR: "로컬 계정을 저장할 수 없습니다. 디스크 권한을 확인해 주세요.",
      password_mismatch: "비밀번호가 일치하지 않습니다.",
      unexpected: "작업을 완료하지 못했습니다. 다시 시도해 주세요.",
    },
  },
};

export function formatMembershipDate(timestamp: number | null, locale: SupportedLocale): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return "—";
  const localeTag: Record<SupportedLocale, string> = {
    zh: "zh-CN",
    en: "en-US",
    ja: "ja-JP",
    ko: "ko-KR",
  };
  return new Intl.DateTimeFormat(localeTag[locale], {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(timestamp));
}

export function formatRemainingDays(copy: MembershipCopy, days: number): string {
  if (days === 1) return copy.remainingDay;
  return copy.remainingDays.replace("{count}", String(Math.max(0, days)));
}

/** Credit numbers (up to 50,000) get locale thousands separators. */
export function formatCreditCount(value: number, locale: SupportedLocale): string {
  const localeTag: Record<SupportedLocale, string> = {
    zh: "zh-CN",
    en: "en-US",
    ja: "ja-JP",
    ko: "ko-KR",
  };
  return new Intl.NumberFormat(localeTag[locale]).format(Math.max(0, Math.round(value)));
}

/** Credit reset instant: member cycles care about the day, free tier about midnight. */
export function formatCreditReset(timestamp: number | null, locale: SupportedLocale): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return "—";
  const localeTag: Record<SupportedLocale, string> = {
    zh: "zh-CN",
    en: "en-US",
    ja: "ja-JP",
    ko: "ko-KR",
  };
  return new Intl.DateTimeFormat(localeTag[locale], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

/** Marker main embeds in the exhaustion error message so renderers can detect it. */
export const CREDITS_EXHAUSTED_MARKER = "CREDITS_EXHAUSTED";

export function isCreditsExhaustedError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes(CREDITS_EXHAUSTED_MARKER);
}
