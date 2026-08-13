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
