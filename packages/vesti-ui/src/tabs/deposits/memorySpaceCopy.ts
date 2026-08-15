// Localized copy for the memory-space overview cards and the 日志 (daily log)
// drill-in, kept next to the components (same pattern as the shell's
// DOCK_COPY) so the shared translation files stay untouched.
//
// Locale detection: the deposits/daily label groups are only translated in
// en/zh (ja/ko fall back to English upstream), while the library group —
// threaded here as sendToLabels — IS translated in ja/ko. Probing both gives
// a reliable four-way signal without a dedicated locale prop.

export type MemorySpaceLocale = "en" | "zh" | "ja" | "ko";

/** Detect the UI locale from already-localized label text (CJK script probe,
 * mirroring library-tab's dateLocale derivation). Kana wins over kanji, so
 * the Japanese check must run before the Chinese one. */
export function detectMemorySpaceLocale(
  depositsLabels?: Record<string, string>,
  libraryLabels?: Record<string, unknown>,
): MemorySpaceLocale {
  const probe = [
    depositsLabels?.title ?? "",
    depositsLabels?.sectionMemories ?? "",
    String(libraryLabels?.justNow ?? ""),
    String(libraryLabels?.allConversations ?? ""),
  ].join(" ");
  if (/[가-힯]/.test(probe)) return "ko";
  if (/[ぁ-ゟァ-ヿ]/.test(probe)) return "ja";
  if (/[一-鿿]/.test(probe)) return "zh";
  return "en";
}

export interface MemorySpaceCardCopy {
  title: string;
  desc: string;
  empty: string;
}

export interface MemorySpaceCopy {
  backToOverview: string;
  /** Count badge on the cards, "{count}" placeholder. */
  entryCount: string;
  memories: MemorySpaceCardCopy;
  dreams: MemorySpaceCardCopy;
  daily: MemorySpaceCardCopy;
  deposits: MemorySpaceCardCopy;
  todayDone: string;
  todayPending: string;
  weeklyTitle: string;
  dailyEmpty: string;
  pickLogHint: string;
}

export const MEMORY_SPACE_COPY: Record<MemorySpaceLocale, MemorySpaceCopy> = {
  en: {
    backToOverview: "Overview",
    entryCount: "{count}",
    memories: {
      title: "Memories",
      desc: "Long-term memories distilled by dreams.",
      empty: "No memories yet — sleep on it and have a dream.",
    },
    dreams: {
      title: "Dreams",
      desc: "Dream run logs and the owl diary.",
      empty: "No dream logs yet — run a dream and one will be left here.",
    },
    daily: {
      title: "Daily log",
      desc: "Your AI activity, summarized every day.",
      empty: "No logs yet.",
    },
    deposits: {
      title: "Deposits",
      desc: "Distilled knowledge documents with version chains.",
      empty: "No deposits yet — pick a template to generate one.",
    },
    todayDone: "Today's log is ready",
    todayPending: "No log for today yet",
    weeklyTitle: "Weekly reports",
    dailyEmpty: "No logs yet — they generate automatically every evening.",
    pickLogHint: "Select a log on the left to read it.",
  },
  zh: {
    backToOverview: "总览",
    entryCount: "{count} 条",
    memories: {
      title: "记忆",
      desc: "做梦沉淀出的长期记忆。",
      empty: "还没有记忆——睡一觉，做个梦。",
    },
    dreams: {
      title: "梦境",
      desc: "做梦日志与猫头鹰日记。",
      empty: "还没有梦境日志——跑一次做梦就会留下一篇。",
    },
    daily: {
      title: "日志",
      desc: "每天自动汇总的 AI 活动记录。",
      empty: "还没有日志。",
    },
    deposits: {
      title: "沉淀",
      desc: "蒸馏出的知识文档，带版本链。",
      empty: "还没有沉淀——挑一个模板生成一篇。",
    },
    todayDone: "今日日志已生成",
    todayPending: "今日日志还未生成",
    weeklyTitle: "周报",
    dailyEmpty: "还没有日志——每天傍晚会自动生成。",
    pickLogHint: "在左侧选择一条日志查看内容。",
  },
  ja: {
    backToOverview: "概要",
    entryCount: "{count} 件",
    memories: {
      title: "メモリー",
      desc: "夢が蒸留した長期記憶。",
      empty: "まだメモリーがありません——夢を見てみましょう。",
    },
    dreams: {
      title: "夢",
      desc: "ドリームログとフクロウ日記。",
      empty: "まだドリームログがありません——夢を実行するとここに残ります。",
    },
    daily: {
      title: "ログ",
      desc: "毎日自動でまとめられる AI アクティビティ記録。",
      empty: "まだログがありません。",
    },
    deposits: {
      title: "デポジット",
      desc: "バージョンチェーン付きの蒸留ナレッジドキュメント。",
      empty: "まだデポジットがありません——テンプレートから生成できます。",
    },
    todayDone: "今日のログは生成済み",
    todayPending: "今日のログはまだ未生成",
    weeklyTitle: "週次レポート",
    dailyEmpty: "まだログがありません——毎晩自動で生成されます。",
    pickLogHint: "左のログを選択して内容を表示します。",
  },
  ko: {
    backToOverview: "개요",
    entryCount: "{count}개",
    memories: {
      title: "메모리",
      desc: "꿈이 증류해 낸 장기 기억.",
      empty: "아직 메모리가 없습니다 — 꿈을 꾸어 보세요.",
    },
    dreams: {
      title: "꿈",
      desc: "드림 로그와 부엉이 일기.",
      empty: "아직 드림 로그가 없습니다 — 꿈을 실행하면 여기에 남습니다.",
    },
    daily: {
      title: "로그",
      desc: "매일 자동으로 요약되는 AI 활동 기록.",
      empty: "아직 로그가 없습니다.",
    },
    deposits: {
      title: "디파짓",
      desc: "버전 체인이 있는 증류 지식 문서.",
      empty: "아직 디파짓이 없습니다 — 템플릿을 골라 생성해 보세요.",
    },
    todayDone: "오늘 로그 생성 완료",
    todayPending: "오늘 로그가 아직 없습니다",
    weeklyTitle: "주간 리포트",
    dailyEmpty: "아직 로그가 없습니다 — 매일 저녁 자동으로 생성됩니다.",
    pickLogHint: "왼쪽에서 로그를 선택해 내용을 확인하세요.",
  },
};
