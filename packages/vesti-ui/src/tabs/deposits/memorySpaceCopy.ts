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
  /** Longer functional intro shown in the hover tooltip (what the module is
   * and where its data comes from). */
  tip: string;
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
  /** Group label for memories that resolve to no conversation-tree project. */
  unlinkedProject: string;
  /** aria text for collapsed-section toggles. */
  expandSection: string;
  /** aria text for expanded-section toggles. */
  collapseSection: string;
}

export const MEMORY_SPACE_COPY: Record<MemorySpaceLocale, MemorySpaceCopy> = {
  en: {
    backToOverview: "Overview",
    entryCount: "{count}",
    memories: {
      title: "Memories",
      desc: "Long-term memories distilled by dreams.",
      tip: "Facts your dreams distilled from daily sessions, filed into per-project cards. Open one to read, edit, or delete it.",
      empty: "No memories yet — sleep on it and have a dream.",
    },
    dreams: {
      title: "Dreams",
      desc: "Dream run logs and the owl diary.",
      tip: "A log of every dream run — what it extracted and maintained — plus the reflective owl diary.",
      empty: "No dream logs yet — run a dream and one will be left here.",
    },
    daily: {
      title: "Daily log",
      desc: "Your AI activity, summarized every day.",
      tip: "Auto-generated every evening: capture stats, a timeline of the day, and weekly rollups.",
      empty: "No logs yet.",
    },
    deposits: {
      title: "Deposits",
      desc: "Distilled knowledge documents with version chains.",
      tip: "Template-distilled documents (project states, writing style, and more), each keeping its full version history.",
      empty: "No deposits yet — pick a template to generate one.",
    },
    todayDone: "Today's log is ready",
    todayPending: "No log for today yet",
    weeklyTitle: "Weekly reports",
    dailyEmpty: "No logs yet — they generate automatically every evening.",
    pickLogHint: "Select a log on the left to read it.",
    unlinkedProject: "Unlinked",
    expandSection: "Expand",
    collapseSection: "Collapse",
  },
  zh: {
    backToOverview: "总览",
    entryCount: "{count} 条",
    memories: {
      title: "记忆",
      desc: "做梦沉淀出的长期记忆。",
      tip: "梦境从每日会话中蒸馏出的长期记忆，按来源项目分卡片归档；点开可阅读、编辑或删除。",
      empty: "还没有记忆——睡一觉，做个梦。",
    },
    dreams: {
      title: "梦境",
      desc: "做梦日志与猫头鹰日记。",
      tip: "每次做梦运行的记录——提取了什么、维护了什么——以及反思性的猫头鹰日记。",
      empty: "还没有梦境日志——跑一次做梦就会留下一篇。",
    },
    daily: {
      title: "日志",
      desc: "每天自动汇总的 AI 活动记录。",
      tip: "每天傍晚自动生成：当日捕获统计、活动时间线，以及每周汇总周报。",
      empty: "还没有日志。",
    },
    deposits: {
      title: "沉淀",
      desc: "蒸馏出的知识文档，带版本链。",
      tip: "按模板蒸馏的知识文档（项目状态、写作风格等），每篇都保留完整版本历史。",
      empty: "还没有沉淀——挑一个模板生成一篇。",
    },
    todayDone: "今日日志已生成",
    todayPending: "今日日志还未生成",
    weeklyTitle: "周报",
    dailyEmpty: "还没有日志——每天傍晚会自动生成。",
    pickLogHint: "在左侧选择一条日志查看内容。",
    unlinkedProject: "未关联",
    expandSection: "展开",
    collapseSection: "收起",
  },
  ja: {
    backToOverview: "概要",
    entryCount: "{count} 件",
    memories: {
      title: "メモリー",
      desc: "夢が蒸留した長期記憶。",
      tip: "夢が毎日のセッションから蒸留した長期記憶を、プロジェクト別カードで保管。開いて読む・編集・削除できます。",
      empty: "まだメモリーがありません——夢を見てみましょう。",
    },
    dreams: {
      title: "夢",
      desc: "ドリームログとフクロウ日記。",
      tip: "毎回の夢の実行記録——何を抽出し、何を整えたか——と内省的なフクロウ日記。",
      empty: "まだドリームログがありません——夢を実行するとここに残ります。",
    },
    daily: {
      title: "ログ",
      desc: "毎日自動でまとめられる AI アクティビティ記録。",
      tip: "毎晩自動生成：その日のキャプチャ統計とタイムライン、週次レポート。",
      empty: "まだログがありません。",
    },
    deposits: {
      title: "デポジット",
      desc: "バージョンチェーン付きの蒸留ナレッジドキュメント。",
      tip: "テンプレートで蒸留した文書（プロジェクト状態、文体など）。完全なバージョン履歴付き。",
      empty: "まだデポジットがありません——テンプレートから生成できます。",
    },
    todayDone: "今日のログは生成済み",
    todayPending: "今日のログはまだ未生成",
    weeklyTitle: "週次レポート",
    dailyEmpty: "まだログがありません——毎晩自動で生成されます。",
    pickLogHint: "左のログを選択して内容を表示します。",
    unlinkedProject: "未関連",
    expandSection: "展開",
    collapseSection: "折りたたむ",
  },
  ko: {
    backToOverview: "개요",
    entryCount: "{count}개",
    memories: {
      title: "메모리",
      desc: "꿈이 증류해 낸 장기 기억.",
      tip: "꿈이 매일의 세션에서 증류한 장기 기억을 프로젝트별 카드로 정리. 열어서 읽고, 편집하고, 삭제할 수 있습니다.",
      empty: "아직 메모리가 없습니다 — 꿈을 꾸어 보세요.",
    },
    dreams: {
      title: "꿈",
      desc: "드림 로그와 부엉이 일기.",
      tip: "매번 꿈 실행의 기록 — 무엇을 추출하고 정리했는지 — 과 성찰적인 부엉이 일기.",
      empty: "아직 드림 로그가 없습니다 — 꿈을 실행하면 여기에 남습니다.",
    },
    daily: {
      title: "로그",
      desc: "매일 자동으로 요약되는 AI 활동 기록.",
      tip: "매일 저녁 자동 생성: 당일 캡처 통계와 타임라인, 주간 리포트.",
      empty: "아직 로그가 없습니다.",
    },
    deposits: {
      title: "디파짓",
      desc: "버전 체인이 있는 증류 지식 문서.",
      tip: "템플릿으로 증류한 문서(프로젝트 상태, 글쓰기 스타일 등). 전체 버전 이력을 보관합니다.",
      empty: "아직 디파짓이 없습니다 — 템플릿을 골라 생성해 보세요.",
    },
    todayDone: "오늘 로그 생성 완료",
    todayPending: "오늘 로그가 아직 없습니다",
    weeklyTitle: "주간 리포트",
    dailyEmpty: "아직 로그가 없습니다 — 매일 저녁 자동으로 생성됩니다.",
    pickLogHint: "왼쪽에서 로그를 선택해 내용을 확인하세요.",
    unlinkedProject: "연결되지 않음",
    expandSection: "펼치기",
    collapseSection: "접기",
  },
};
