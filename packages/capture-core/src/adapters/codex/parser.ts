/**
 * Parses Codex rollout JSONL into Vesti's platform-neutral session contract.
 * Supports the current response_item/event_msg format and the older
 * ExecCommandBegin/End style event stream.
 */

import fs from 'fs-extra';
import path from 'path';
import type {
  ParsedMessage,
  ParsedSession,
  SessionTokenUsage,
  ToolCallBlock,
  ToolResultBlock,
} from '../../types/agent.js';
import type { ToolExecution } from '../../types/index.js';

interface RolloutRow {
  timestamp?: string | number;
  type?: string;
  payload?: Record<string, unknown>;
}

interface ActiveTool {
  callId: string;
  messageId: string;
  name: string;
  input: unknown;
  timestamp: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asTimestamp(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') return asTimestamp(numeric, fallback);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function jsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  const record = asRecord(value);
  for (const key of ['output', 'text', 'content', 'aggregated_output', 'stdout', 'message']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  try { return JSON.stringify(value); } catch { return String(value); }
}

function messageContent(payload: Record<string, unknown>): string {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content
    .map(item => {
      const part = asRecord(item);
      return typeof part.text === 'string' ? part.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function reasoningSummary(payload: Record<string, unknown>): string {
  if (typeof payload.summary === 'string') return payload.summary.trim();
  if (!Array.isArray(payload.summary)) return '';
  return payload.summary
    .map(item => {
      const part = asRecord(item);
      return typeof part.text === 'string' ? part.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function toolNameFromLegacy(type: string): string {
  if (/ExecCommand/i.test(type)) return 'shell_command';
  if (/PatchApply/i.test(type)) return 'apply_patch';
  if (/WebSearch/i.test(type)) return 'web_search';
  if (/McpToolCall/i.test(type)) return 'mcp_tool';
  return type.replace(/(?:Begin|End)$/i, '') || 'tool';
}

export class CodexParser {
  async parseFile(filePath: string): Promise<ParsedSession> {
    const raw = await fs.readFile(filePath, 'utf8');
    const rows: RolloutRow[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line) as RolloutRow); } catch { /* tolerate a trailing partial line */ }
    }

    const stat = await fs.stat(filePath);
    const metaRow = rows.find(row => row.type === 'session_meta');
    const meta = asRecord(metaRow?.payload);
    const fallbackId = path.basename(filePath, '.jsonl').match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0]
      ?? path.basename(filePath, '.jsonl');
    const sessionId = String(meta.session_id ?? meta.id ?? fallbackId);

    const messages: ParsedMessage[] = [];
    const toolExecutions: ToolExecution[] = [];
    const activeTools = new Map<string, ActiveTool>();
    const tokenUsage: SessionTokenUsage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      models: new Set<string>(),
    };
    const contextCompactions: Array<{ sequence: number; compactedAt: number; summary?: string }> = [];

    let index = 0;
    let projectPath = typeof meta.cwd === 'string' ? meta.cwd : '';
    let model = '';
    let firstPrompt = '';
    let gitBranch: string | undefined;
    const git = asRecord(meta.git);
    if (typeof git.branch === 'string') gitBranch = git.branch;

    const newId = (kind: string, preferred?: unknown) =>
      `codex-${sessionId}-${kind}-${typeof preferred === 'string' && preferred ? preferred : index++}`;

    const finishTool = (callId: string, resultId: string, result: string, isError: boolean, ts: number) => {
      const active = activeTools.get(callId);
      if (!active) return;
      toolExecutions.push({
        id: `codex-${sessionId}-tool-${callId}`,
        conversationId: '',
        toolUseMessageId: active.messageId,
        toolResultMessageId: resultId,
        toolUseId: callId,
        toolName: active.name,
        inputSummary: outputText(active.input).slice(0, 500),
        outputSummary: result.slice(0, 500),
        isError,
        durationMs: ts >= active.timestamp ? ts - active.timestamp : undefined,
        timestamp: active.timestamp,
      });
      activeTools.delete(callId);
    };

    for (const row of rows) {
      const payload = asRecord(row.payload);
      const ts = asTimestamp(row.timestamp, stat.mtimeMs);

      if (row.type === 'turn_context') {
        if (typeof payload.cwd === 'string') projectPath = payload.cwd;
        if (typeof payload.model === 'string') {
          model = payload.model;
          tokenUsage.models.add(model);
        }
        continue;
      }

      if (row.type === 'compacted') {
        contextCompactions.push({
          sequence: contextCompactions.length + 1,
          compactedAt: ts,
          summary: typeof payload.summary === 'string' ? payload.summary : undefined,
        });
        continue;
      }

      if (row.type === 'response_item') {
        const itemType = String(payload.type ?? '');
        if (itemType === 'message') {
          const role = String(payload.role ?? '');
          if (role !== 'user' && role !== 'assistant') continue;
          const text = messageContent(payload);
          if (!text) continue;
          const uuid = newId('message', payload.id);
          if (role === 'user' && !firstPrompt) firstPrompt = text;
          messages.push({
            uuid,
            type: role,
            role,
            timestamp: ts,
            contentText: text,
            cwd: projectPath || undefined,
            gitBranch,
            isToolResult: false,
            depth: 0,
          });
          continue;
        }

        if (itemType === 'reasoning') {
          const summary = reasoningSummary(payload);
          if (summary) {
            messages.push({
              uuid: newId('reasoning', payload.id),
              type: 'assistant',
              role: 'assistant',
              timestamp: ts,
              contentThinking: summary,
              cwd: projectPath || undefined,
              isToolResult: false,
              depth: 0,
            });
          }
          continue;
        }

        if (itemType === 'function_call' || itemType === 'custom_tool_call') {
          const callId = String(payload.call_id ?? payload.id ?? `call-${index}`);
          const name = String(payload.name ?? itemType);
          const input = jsonish(payload.arguments ?? payload.input ?? {});
          const messageId = newId('tool-call', callId);
          const toolCall: ToolCallBlock = { id: callId, name, input };
          messages.push({
            uuid: messageId,
            type: 'assistant',
            role: 'assistant',
            timestamp: ts,
            toolCalls: [toolCall],
            cwd: projectPath || undefined,
            isToolResult: false,
            depth: 0,
          });
          activeTools.set(callId, { callId, messageId, name, input, timestamp: ts });
          continue;
        }

        if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
          const callId = String(payload.call_id ?? '');
          const text = outputText(payload.output);
          const isError = Boolean(payload.is_error) || String(payload.status ?? '').toLowerCase() === 'error';
          const messageId = newId('tool-result', `${callId}-${index++}`);
          const toolResult: ToolResultBlock = { toolUseId: callId, content: text, isError };
          messages.push({
            uuid: messageId,
            type: 'user',
            role: 'user',
            timestamp: ts,
            toolResults: [toolResult],
            cwd: projectPath || undefined,
            isToolResult: true,
            depth: 0,
          });
          finishTool(callId, messageId, text, isError, ts);
          continue;
        }
      }

      if (row.type === 'event_msg') {
        const eventType = String(payload.type ?? '');
        if (eventType === 'token_count') {
          const info = asRecord(payload.info);
          const totals = asRecord(info.total_token_usage);
          tokenUsage.totalInputTokens = Number(totals.input_tokens ?? 0) || 0;
          tokenUsage.totalOutputTokens = Number(totals.output_tokens ?? 0) || 0;
          tokenUsage.totalCacheReadTokens = Number(totals.cached_input_tokens ?? 0) || 0;
          continue;
        }

        if (/Begin$/i.test(eventType) && typeof payload.call_id === 'string') {
          const callId = payload.call_id;
          if (activeTools.has(callId)) continue;
          const name = toolNameFromLegacy(eventType);
          const input = payload.command ?? payload.changes ?? payload.arguments ?? payload;
          const messageId = newId('legacy-tool-call', callId);
          messages.push({
            uuid: messageId,
            type: 'assistant',
            role: 'assistant',
            timestamp: ts,
            toolCalls: [{ id: callId, name, input }],
            cwd: typeof payload.cwd === 'string' ? payload.cwd : projectPath || undefined,
            isToolResult: false,
            depth: 0,
          });
          activeTools.set(callId, { callId, messageId, name, input, timestamp: ts });
          continue;
        }

        if (/End$/i.test(eventType) && typeof payload.call_id === 'string') {
          const callId = payload.call_id;
          if (!activeTools.has(callId)) continue;
          const text = outputText(payload.aggregated_output ?? payload.stdout ?? payload.output ?? payload);
          const isError = payload.success === false || Number(payload.exit_code ?? 0) !== 0;
          const messageId = newId('legacy-tool-result', `${callId}-${index++}`);
          messages.push({
            uuid: messageId,
            type: 'user',
            role: 'user',
            timestamp: ts,
            toolResults: [{ toolUseId: callId, content: text, isError }],
            isToolResult: true,
            depth: 0,
          });
          finishTool(callId, messageId, text, isError, ts);
        }
      }
    }

    for (const active of activeTools.values()) {
      toolExecutions.push({
        id: `codex-${sessionId}-tool-${active.callId}`,
        conversationId: '',
        toolUseMessageId: active.messageId,
        toolUseId: active.callId,
        toolName: active.name,
        inputSummary: outputText(active.input).slice(0, 500),
        isError: false,
        timestamp: active.timestamp,
      });
    }

    const timestamps = messages.map(message => message.timestamp).filter(value => value > 0);
    const startTime = timestamps.length ? Math.min(...timestamps) : asTimestamp(meta.timestamp, stat.birthtimeMs);
    const endTime = timestamps.length ? Math.max(...timestamps) : stat.mtimeMs;
    const cliVersion = typeof meta.cli_version === 'string' ? meta.cli_version : undefined;
    if (!model && typeof meta.model === 'string') model = meta.model;
    if (model) tokenUsage.models.add(model);

    return {
      sessionId,
      platform: 'codex',
      projectPath,
      gitBranch,
      claudeCodeVersion: cliVersion,
      model: model || undefined,
      messages,
      toolExecutions,
      subagents: [],
      tokenUsage,
      startTime,
      endTime,
      contextCompactions: contextCompactions.length ? contextCompactions : undefined,
      meta: {
        first_prompt: firstPrompt || undefined,
        cli_version: cliVersion,
        model_provider: meta.model_provider,
        source: meta.source,
        archived: filePath.includes(`${path.sep}archived_sessions${path.sep}`),
        reasoning_output_tokens: (() => {
          const tokenRow = [...rows].reverse().find(row => row.type === 'event_msg' && row.payload?.type === 'token_count');
          const totals = asRecord(asRecord(tokenRow?.payload?.info).total_token_usage);
          return Number(totals.reasoning_output_tokens ?? 0) || 0;
        })(),
      },
    };
  }
}
