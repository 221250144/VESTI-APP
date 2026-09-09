// Onboarding wizard: first-run guided setup for VESTI.
// Renders as a full-screen overlay with step-by-step cards.
// Stores completion state in ui-prefs as "onboarding.completed".
//
// Steps:
//   0. Welcome — what VESTI is
//   1. Capture — connect AI platforms
//   2. Library — how conversations are organized
//   3. Explore — learn from your conversations
//   4. Settings — configure preferences
//   5. Done — ready to start

import React, { useEffect, useState } from "react";

export type SupportedLocale = "en" | "zh" | "ja" | "ko";

interface OnboardingCopy {
  stepLabel: string;
  title: string;
  description: string;
  features: string[];
  nextLabel: string;
  backLabel: string;
  skipLabel: string;
  doneLabel: string;
  doneTitle: string;
  doneBody: string;
}

const COPY: Record<SupportedLocale, OnboardingCopy> = {
  zh: {
    stepLabel: "第 {current} 步，共 {total} 步",
    title: "",
    description: "",
    features: [],
    nextLabel: "下一步",
    backLabel: "上一步",
    skipLabel: "跳过引导",
    doneLabel: "开始使用",
    doneTitle: "一切就绪！",
    doneBody: "VESTI 会在后台持续捕捉和整理你的 AI 对话。你随时可以在设置中调整偏好。",
  },
  en: {
    stepLabel: "Step {current} of {total}",
    title: "",
    description: "",
    features: [],
    nextLabel: "Next",
    backLabel: "Back",
    skipLabel: "Skip tour",
    doneLabel: "Get started",
    doneTitle: "You're all set!",
    doneBody: "VESTI will continuously capture and organize your AI conversations in the background. You can adjust preferences anytime in Settings.",
  },
  ja: {
    stepLabel: "ステップ {current}/{total}",
    title: "",
    description: "",
    features: [],
    nextLabel: "次へ",
    backLabel: "戻る",
    skipLabel: "スキップ",
    doneLabel: "始める",
    doneTitle: "準備完了！",
    doneBody: "VESTIはバックグラウンドでAI会話を継続的にキャプチャして整理します。設定はいつでも変更できます。",
  },
  ko: {
    stepLabel: "{current} / {total} 단계",
    title: "",
    description: "",
    features: [],
    nextLabel: "다음",
    backLabel: "이전",
    skipLabel: "건너뛰기",
    doneLabel: "시작하기",
    doneTitle: "준비 완료!",
    doneBody: "VESTI가 백그라운드에서 AI 대화를 지속적으로 캡처하고 정리합니다. 설정에서 언제든지 기본 설정을 조정할 수 있습니다.",
  },
};

// Per-step content (separate from the shared labels above).
type StepBase = "welcome" | "capture" | "library" | "explore" | "settings";

interface StepContent {
  icon: string;
  titleKey: StepBase;
  bodyKey: StepBase;
  featuresKey: StepBase;
}

const STEP_TITLES = {
  welcome_zh: "欢迎使用 VESTI",
  welcome_en: "Welcome to VESTI",
  welcome_ja: "VESTIへようこそ",
  welcome_ko: "VESTI에 오신 것을 환영합니다",
  capture_zh: "连接你的 AI 平台",
  capture_en: "Connect Your AI Platforms",
  capture_ja: "AIプラットフォームを接続",
  capture_ko: "AI 플랫폼 연결",
  library_zh: "你的 AI 记忆库",
  library_en: "Your AI Memory Library",
  library_ja: "あなたのAIメモリライブラリ",
  library_ko: "당신의 AI 메모리 라이브러리",
  explore_zh: "从对话中学习",
  explore_en: "Learn from Your Conversations",
  explore_ja: "会話から学ぶ",
  explore_ko: "대화에서 배우기",
  settings_zh: "个性化设置",
  settings_en: "Make It Yours",
  settings_ja: "自分好みにカスタマイズ",
  settings_ko: "나만의 설정",
};

const STEP_BODIES = {
  welcome_zh: "VESTI 是你所有 AI 对话的智能管家。它会自动捕捉、整理和归档你在 ChatGPT、Claude、Kimi 等平台上的每一次对话——让你随时回顾、学习和接力。",
  welcome_en: "VESTI is the intelligent hub for all your AI conversations. It automatically captures, organizes, and archives every conversation across ChatGPT, Claude, Kimi, and more — so you can review, learn, and hand off anytime.",
  welcome_ja: "VESTIはすべてのAI会話のインテリジェントハブです。ChatGPT、Claude、Kimiなどのプラットフォームでの会話を自動的にキャプチャし、整理、アーカイブします。",
  welcome_ko: "VESTI는 모든 AI 대화를 위한 지능형 허브입니다. ChatGPT, Claude, Kimi 등에서 대화를 자동으로 캡처, 정리, 아카이브하여 언제든지 검토하고 학습할 수 있습니다.",
  capture_zh: "安装 VESTI 浏览器扩展后，你在 ChatGPT、Claude、Kimi、DeepSeek、豆包、Gemini、通义千问、元宝等平台上的每一次对话都会被自动捕捉。",
  capture_en: "After installing the VESTI browser extension, every conversation on ChatGPT, Claude, Kimi, DeepSeek, and more is automatically captured as you chat.",
  capture_ja: "VESTIブラウザ拡張機能をインストールすると、ChatGPT、Claude、Kimi、DeepSeekなどでの会話が自動的にキャプチャされます。",
  capture_ko: "VESTI 브라우저 확장 프로그램을 설치하면 ChatGPT, Claude, Kimi, DeepSeek 등에서의 대화가 자동으로 캡처됩니다.",
  library_zh: "所有对话自动按项目、主题和时间线整理。你可以打标签、归档、搜索，或者把多个会话的上下文打包成「交接包」传给另一个 AI 继续工作。",
  library_en: "All conversations are automatically organized by project, topic, and timeline. Tag, archive, search, or bundle context from multiple sessions into a handoff pack for another AI to continue.",
  library_ja: "すべての会話はプロジェクト、トピック、タイムラインごとに自動的に整理されます。タグ付け、アーカイブ、検索、または複数のセッションのコンテキストをハンドオフパックにバンドルできます。",
  library_ko: "모든 대화는 프로젝트, 주제, 타임라인별로 자동 정리됩니다. 태그, 아카이브, 검색 또는 여러 세션의 컨텍스트를 핸드오프 팩으로 묶을 수 있습니다.",
  explore_zh: "「学习」页面将你的对话整理成个人知识地图——按领域展示深浅分布、术语表和待解决问题。「圆桌」可以召集多角色 AI 讨论你的判断性问题。",
  explore_en: "The Learn page turns your conversations into a personal knowledge map — domains, depth distribution, glossary, and open questions. The Roundtable convenes a panel of AI personas to debate your questions.",
  explore_ja: "学習ページは会話を個人の知識マップに変換します—ドメイン、深さの分布、用語集、未解決の質問。円卓会議はAIパネルを招集して質問を議論します。",
  explore_ko: "학습 페이지는 대화를 개인 지식 맵으로 변환합니다—도메인, 깊이 분포, 용어집, 미해결 질문. 원탁회의는 AI 패널을 소집하여 질문을 토론합니다.",
  settings_zh: "在设置中配置 AI 模型、语言偏好、自动分类策略和日报生成。默认「开箱即用」模式下，对话文本会经 Vesti 网关转发至第三方模型服务，用于摘要、搜索与日志等功能；配置自带密钥（BYOK）则发送到你自己的接口。你可以随时在设置中切换。",
  settings_en: "Configure AI models, language preferences, auto-classification, and daily reports in Settings. In the default ready-to-use mode, conversation text is sent through the Vesti gateway to third-party LLM providers for digest, search, and journal features; with your own key (BYOK) requests go to your own endpoint instead. You can switch anytime in Settings.",
  settings_ja: "設定でAIモデル、言語設定、自動分類、日次レポートを構成します。デフォルトの「すぐに使える」モードでは、要約・検索・日記などの機能のために会話テキストが Vesti ゲートウェイ経由で第三者の LLM プロバイダーに送信されます。自分のキー（BYOK）を設定した場合は自分のエンドポイントに送信されます。設定でいつでも切り替えられます。",
  settings_ko: "설정에서 AI 모델, 언어 기본 설정, 자동 분류, 일일 보고서를 구성합니다. 기본 「바로 사용」 모드에서는 요약, 검색, 일지 등의 기능을 위해 대화 텍스트가 Vesti 게이트웨이를 통해 타사 LLM 제공업체로 전송됩니다. 자체 키(BYOK)를 구성하면 사용자의 엔드포인트로 전송됩니다. 설정에서 언제든 전환할 수 있습니다.",
};

const STEP_FEATURES = {
  welcome_zh: ["自动捕捉 8+ AI 平台对话", "智能分类归档", "跨会话 AI 工作接力", "个人知识地图"],
  welcome_en: ["Auto-capture 8+ AI platforms", "Smart classification & archiving", "Cross-session AI handoff", "Personal knowledge map"],
  welcome_ja: ["8以上のAIプラットフォームを自動キャプチャ", "スマート分類とアーカイブ", "セッション間AIハンドオフ", "個人ナレッジマップ"],
  welcome_ko: ["8개 이상 AI 플랫폼 자동 캡처", "스마트 분류 및 아카이브", "세션 간 AI 핸드오프", "개인 지식 맵"],
  capture_zh: ["ChatGPT、Claude、Kimi、DeepSeek", "豆包、Gemini、通义千问、元宝", "VESTI CLI 支持本地 AI Agent", "安装扩展后即刻开始捕捉"],
  capture_en: ["ChatGPT, Claude, Kimi, DeepSeek", "Gemini, Qwen, Doubao, Yuanbao", "VESTI CLI for local AI agents", "Starts capturing immediately"],
  capture_ja: ["ChatGPT、Claude、Kimi、DeepSeek", "Gemini、Qwen、Doubao、Yuanbao", "VESTI CLI for local AI agents", "すぐにキャプチャを開始"],
  capture_ko: ["ChatGPT, Claude, Kimi, DeepSeek", "Gemini, Qwen, Doubao, Yuanbao", "VESTI CLI for local AI agents", "즉시 캡처 시작"],
  library_zh: ["按项目/主题自动分组", "全文和语义搜索", "标签和手动归档", "AI 交接包一键生成"],
  library_en: ["Auto-group by project/topic", "Full-text & semantic search", "Tags & manual archiving", "One-click AI handoff packs"],
  library_ja: ["プロジェクト/トピックで自動グループ化", "全文・セマンティック検索", "タグと手動アーカイブ", "ワンクリックAIハンドオフパック"],
  library_ko: ["프로젝트/주제별 자동 그룹화", "전체 텍스트 및 시맨틱 검색", "태그 및 수동 아카이브", "원클릭 AI 핸드오프 팩"],
  explore_zh: ["领域深浅分布图", "自动术语表", "待解决问题追踪", "多角色 AI 圆桌讨论"],
  explore_en: ["Domain depth distribution", "Auto-generated glossary", "Open question tracking", "Multi-persona AI roundtable"],
  explore_ja: ["ドメイン深度分布", "自動生成用語集", "未解決の質問追跡", "マルチペルソナAI円卓会議"],
  explore_ko: ["도메인 깊이 분포", "자동 생성 용어집", "미해결 질문 추적", "다중 페르소나 AI 원탁회의"],
  settings_zh: ["AI 模型和语言配置", "自动分类策略", "主题和外观", "数据导出和备份"],
  settings_en: ["AI model & language config", "Auto-classification policy", "Theme & appearance", "Data export & backup"],
  settings_ja: ["AIモデルと言語設定", "自動分類ポリシー", "テーマと外観", "データエクスポートとバックアップ"],
  settings_ko: ["AI 모델 및 언어 설정", "자동 분류 정책", "테마 및 디자인", "데이터 내보내기 및 백업"],
};

const STEPS: StepContent[] = [
  { icon: "🎉", titleKey: "welcome", bodyKey: "welcome", featuresKey: "welcome" },
  { icon: "🔌", titleKey: "capture", bodyKey: "capture", featuresKey: "capture" },
  { icon: "📚", titleKey: "library", bodyKey: "library", featuresKey: "library" },
  { icon: "🧠", titleKey: "explore", bodyKey: "explore", featuresKey: "explore" },
  { icon: "⚙️", titleKey: "settings", bodyKey: "settings", featuresKey: "settings" },
];

function tKey(locale: SupportedLocale, base: StepBase): keyof typeof STEP_TITLES {
  return `${base}_${locale}`;
}

export interface OnboardingProps {
  locale: SupportedLocale;
  onComplete: () => void;
  onSkip: () => void;
}

export function OnboardingWizard({ locale, onComplete, onSkip }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const copy = COPY[locale] ?? COPY.en;
  const isDone = step >= STEPS.length;

  const finish = () => {
    setLeaving(true);
    setTimeout(onComplete, 300);
  };

  const skip = () => {
    setLeaving(true);
    setTimeout(onSkip, 300);
  };

  const next = () => {
    if (step + 1 >= STEPS.length) {
      finish();
    } else {
      setStep(step + 1);
    }
  };

  const prev = () => {
    if (step > 0) setStep(step - 1);
  };

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "Enter") next();
      if (e.key === "ArrowLeft") prev();
      if (e.key === "Escape") skip();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [step]);

  if (isDone) {
    return (
      <div
        className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${
          leaving ? "opacity-0" : "opacity-100"
        }`}
      >
        <div className="w-full max-w-md mx-4 rounded-card border border-border-subtle bg-bg-surface-card p-10 text-center shadow-2xl animate-in zoom-in-95">
          <div className="text-5xl mb-5">🚀</div>
          <h2 className="font-serif text-[24px] text-text-primary mb-3">
            {copy.doneTitle}
          </h2>
          <p className="text-[14px] leading-relaxed text-text-secondary mb-8">
            {copy.doneBody}
          </p>
          <button onClick={finish} className={buttonPrimary}>
            {copy.doneLabel}
          </button>
        </div>
      </div>
    );
  }

  const current = STEPS[step];
  const title = STEP_TITLES[tKey(locale, current.titleKey)] ?? "";
  const body = STEP_BODIES[tKey(locale, current.bodyKey)] ?? "";
  const features = STEP_FEATURES[tKey(locale, current.featuresKey)] ?? [];

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${
        leaving ? "opacity-0" : "opacity-100"
      }`}
    >
      <div className="w-full max-w-lg mx-4 rounded-card border border-border-subtle bg-bg-surface-card shadow-2xl animate-in zoom-in-95">
        {/* Progress bar */}
        <div className="px-6 pt-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] uppercase tracking-[0.16em] text-text-tertiary">
              {copy.stepLabel.replace("{current}", String(step + 1)).replace("{total}", String(STEPS.length))}
            </span>
            <button
              onClick={skip}
              className="text-[12px] text-text-tertiary hover:text-text-secondary transition-colors"
            >
              {copy.skipLabel}
            </button>
          </div>
          <div className="h-1 rounded-full bg-bg-tertiary overflow-hidden">
            <div
              className="h-full rounded-full bg-accent-primary transition-all duration-500 ease-out"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        {/* Content */}
        <div className="px-8 py-7">
          <div className="text-4xl mb-4">{current.icon}</div>
          <h2 className="font-serif text-[22px] text-text-primary mb-3">{title}</h2>
          <p className="text-[14px] leading-relaxed text-text-secondary mb-5">{body}</p>
          <ul className="space-y-2">
            {features.map((f, i) => (
              <li key={i} className="flex items-start gap-2.5 text-[13px] text-text-secondary">
                <span className="mt-0.5 text-accent-primary text-[10px]">◆</span>
                {f}
              </li>
            ))}
          </ul>
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 flex items-center justify-between">
          <button
            onClick={prev}
            disabled={step === 0}
            className={`${buttonSecondary} ${step === 0 ? "opacity-30 cursor-not-allowed" : ""}`}
          >
            {copy.backLabel}
          </button>

          {/* Step dots */}
          <div className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`w-2 h-2 rounded-full transition-all duration-300 ${
                  i === step
                    ? "bg-accent-primary scale-125"
                    : i < step
                      ? "bg-accent-primary/40"
                      : "bg-bg-tertiary"
                }`}
              />
            ))}
          </div>

          <button onClick={next} className={buttonPrimary}>
            {step === STEPS.length - 1 ? copy.doneLabel : copy.nextLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Inline button classes (match the SettingsPage patterns).
const buttonPrimary =
  "inline-flex items-center gap-1.5 rounded-btn bg-accent-primary px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 transition-colors";
const buttonSecondary =
  "inline-flex items-center gap-1.5 rounded-btn border border-border-default bg-transparent px-4 py-2 text-[13px] text-text-secondary hover:bg-bg-secondary transition-colors";
