export interface ConversationTimeLike {
  source_created_at?: number | null;
  first_captured_at?: number;
  last_captured_at?: number;
  created_at: number;
  updated_at: number;
}

export interface ReaderTimestampDetailItem {
  key: "started" | "last_updated" | "captured" | "source_time";
  label: string;
  value: string;
}

export interface ReaderTimestampFooterModel {
  summaryStarted: string;
  summaryUpdated: string;
  details: ReaderTimestampDetailItem[];
}

export interface TimestampFooterLabels {
  started: string;
  lastUpdated: string;
  captured: string;
  sourceTime: string;
  summaryStarted: string;
  summaryUpdated: string;
}

function makeDateFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, options);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isSameCalendarDay(left: number, right: number): boolean {
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  return (
    leftDate.getFullYear() === rightDate.getFullYear() &&
    leftDate.getMonth() === rightDate.getMonth() &&
    leftDate.getDate() === rightDate.getDate()
  );
}

function isSameCalendarYear(left: number, right: number): boolean {
  return new Date(left).getFullYear() === new Date(right).getFullYear();
}

function sharesDisplayedMinute(left: number, right: number): boolean {
  return Math.floor(left / 60000) === Math.floor(right / 60000);
}

function formatSummaryStarted(value: number, locale: string): string {
  return makeDateFormatter(locale, { month: "short", day: "numeric" }).format(new Date(value));
}

function formatSummaryUpdated(value: number, originAt: number, locale: string): string {
  if (isSameCalendarDay(value, originAt)) {
    return makeDateFormatter(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
  }
  if (isSameCalendarYear(value, originAt)) {
    return makeDateFormatter(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
  }
  return makeDateFormatter(locale, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatDetailTimestamp(value: number, locale: string): string {
  return makeDateFormatter(locale, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function getConversationSourceCreatedAt(
  conversation: ConversationTimeLike
): number | null {
  return isFiniteTimestamp(conversation.source_created_at)
    ? conversation.source_created_at
    : null;
}

export function getConversationFirstCapturedAt(
  conversation: ConversationTimeLike
): number {
  return isFiniteTimestamp(conversation.first_captured_at)
    ? conversation.first_captured_at
    : conversation.created_at;
}

export function getConversationLastCapturedAt(
  conversation: ConversationTimeLike
): number {
  return isFiniteTimestamp(conversation.last_captured_at)
    ? conversation.last_captured_at
    : conversation.updated_at;
}

export function getConversationOriginAt(
  conversation: ConversationTimeLike
): number {
  return (
    getConversationSourceCreatedAt(conversation) ??
    getConversationFirstCapturedAt(conversation)
  );
}

export function getConversationCaptureFreshnessAt(
  conversation: ConversationTimeLike
): number {
  return getConversationLastCapturedAt(conversation);
}

export function getConversationRecordModifiedAt(
  conversation: ConversationTimeLike
): number {
  return conversation.updated_at;
}

export function buildReaderTimestampFooterModel(
  conversation: ConversationTimeLike,
  labels: TimestampFooterLabels,
  locale: string = "en"
): ReaderTimestampFooterModel {
  const originAt = getConversationOriginAt(conversation);
  const recordModifiedAt = getConversationRecordModifiedAt(conversation);
  const captureFreshnessAt = getConversationCaptureFreshnessAt(conversation);
  const sourceCreatedAt = getConversationSourceCreatedAt(conversation);

  const details: ReaderTimestampDetailItem[] = [
    {
      key: "started",
      label: labels.started,
      value: formatDetailTimestamp(originAt, locale),
    },
    {
      key: "last_updated",
      label: labels.lastUpdated,
      value: formatDetailTimestamp(recordModifiedAt, locale),
    },
  ];

  if (!sharesDisplayedMinute(captureFreshnessAt, recordModifiedAt)) {
    details.push({
      key: "captured",
      label: labels.captured,
      value: formatDetailTimestamp(captureFreshnessAt, locale),
    });
  }

  if (sourceCreatedAt !== null && !sharesDisplayedMinute(sourceCreatedAt, originAt)) {
    details.push({
      key: "source_time",
      label: labels.sourceTime,
      value: formatDetailTimestamp(sourceCreatedAt, locale),
    });
  }

  return {
    summaryStarted: `${labels.summaryStarted} ${formatSummaryStarted(originAt, locale)}`,
    summaryUpdated: `${labels.summaryUpdated} ${formatSummaryUpdated(recordModifiedAt, originAt, locale)}`,
    details,
  };
}
