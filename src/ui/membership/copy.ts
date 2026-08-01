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
