/**
 * Kimi Code wire.jsonl Event Types
 * Wire format: {timestamp: float_seconds, message: {type: string, payload: {...}}}
 * First line is always: {type: "metadata", protocol_version: "1.3"}
 */

// ==================== Wire Line Format ====================

export interface KimiWireLine {
  timestamp?: number;  // Unix seconds (float)
  message?: { type: string; payload: any };
  type?: string;       // Only for metadata line
  protocol_version?: string;
}

// ==================== Payload Types ====================

export interface KimiTurnBeginPayload {
  user_input: string | Array<{ type: string; text: string }>;
}

export interface KimiStepBeginPayload {
  n: number;
}

export interface KimiContentPartPayload {
  type: 'think' | 'text';
  think?: string;
  text?: string;
  encrypted?: unknown;
}

export interface KimiToolCallPayload {
  type: 'function';
  id: string;
  function: { name: string; arguments: string };
  extras?: unknown;
}

export interface KimiToolCallPartPayload {
  arguments_part: string;
}

export interface KimiToolResultPayload {
  tool_call_id: string;
  return_value: {
    is_error: boolean;
    output: string | unknown[];
    message?: string;
    display?: unknown[];
    extras?: unknown;
  };
}

export interface KimiStatusUpdatePayload {
  context_usage?: number;
  token_usage?: {
    input_other?: number;
    output?: number;
    input_cache_read?: number;
    input_cache_creation?: number;
  };
  message_id?: string;
}

export interface KimiSubagentEventPayload {
  task_tool_call_id: string;
  event: { type: string; payload: any };
}

export interface KimiApprovalRequestPayload {
  id: string;
  tool_call_id: string;
  sender: string;
  action: string;
  description: string;
  display?: unknown[];
}

export interface KimiApprovalResponsePayload {
  request_id: string;
  response: string;  // 'approve_for_session', 'deny', etc.
}

export interface KimiErrorPayload {
  error_type?: string;
  message?: string;
}

// ==================== Metadata ====================

export interface KimiSessionMetadata {
  session_id?: string;
  title?: string;
  title_generated?: boolean;
  wire_mtime?: number;
  archived?: boolean;
  archived_at?: number | null;
}

// ==================== Config ====================

export interface KimiConfig {
  work_dirs?: Array<{
    path: string;
    kaos?: string;
    last_session_id?: string | null;
  }>;
}
