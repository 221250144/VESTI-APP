import type { Conversation } from "../types";

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

const summaryDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

const summaryDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const summaryDateTimeWithYearFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

const detailDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function getConversationSourceCreatedAt(conversation: Conversation): number | null {
  return isFiniteTimestamp(conversation.source_created_at)
    ? conversation.source_created_at
    : null;
}

function getConversationFirstCapturedAt(conversation: Conversation): number {
  return isFiniteTimestamp(conversation.first_captured_at)
    ? conversation.first_captured_at
    : conversation.created_at;
}

function getConversationLastCapturedAt(conversation: Conversation): number {
  return isFiniteTimestamp(conversation.last_captured_at)
    ? conversation.last_captured_at
    : conversation.updated_at;
}

function getConversationOriginAt(conversation: Conversation): number {
  return getConversationSourceCreatedAt(conversation) ?? getConversationFirstCapturedAt(conversation);
}

function getConversationRecordModifiedAt(conversation: Conversation): number {
  return conversation.updated_at;
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

function formatSummaryStarted(value: number): string {
  return summaryDateFormatter.format(new Date(value));
}

function formatSummaryUpdated(value: number, originAt: number): string {
  if (isSameCalendarDay(value, originAt)) {
    return timeFormatter.format(new Date(value));
  }
  if (isSameCalendarYear(value, originAt)) {
    return summaryDateTimeFormatter.format(new Date(value));
  }
  return summaryDateTimeWithYearFormatter.format(new Date(value));
}

function formatDetailTimestamp(value: number): string {
  return detailDateTimeFormatter.format(new Date(value));
}

export function buildReaderTimestampFooterModel(
  conversation: Conversation
): ReaderTimestampFooterModel {
  const originAt = getConversationOriginAt(conversation);
  const recordModifiedAt = getConversationRecordModifiedAt(conversation);
  const captureFreshnessAt = getConversationLastCapturedAt(conversation);
  const sourceCreatedAt = getConversationSourceCreatedAt(conversation);

  const details: ReaderTimestampDetailItem[] = [
    {
      key: "started",
      label: "Started",
      value: formatDetailTimestamp(originAt),
    },
    {
      key: "last_updated",
      label: "Last updated",
      value: formatDetailTimestamp(recordModifiedAt),
    },
  ];

  if (!sharesDisplayedMinute(captureFreshnessAt, recordModifiedAt)) {
    details.push({
      key: "captured",
      label: "Captured",
      value: formatDetailTimestamp(captureFreshnessAt),
    });
  }

  if (sourceCreatedAt !== null && !sharesDisplayedMinute(sourceCreatedAt, originAt)) {
    details.push({
      key: "source_time",
      label: "Source Time",
      value: formatDetailTimestamp(sourceCreatedAt),
    });
  }

  return {
    summaryStarted: formatSummaryStarted(originAt),
    summaryUpdated: formatSummaryUpdated(recordModifiedAt, originAt),
    details,
  };
}
