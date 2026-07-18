// Extracted from the extension's messaging/protocol.ts: on desktop the
// renderer talks to the repository in-process, so only the payload shapes
// shared by the storage layer are kept here.
import type { Platform } from "./types";

export interface DateRange {
  start: number;
  end: number;
}

export interface ConversationFilters {
  platform?: Platform;
  search?: string;
  dateRange?: DateRange;
}

export interface ConversationUpdateChanges {
  topic_id?: number | null;
  is_starred?: boolean;
  tags?: string[];
}
