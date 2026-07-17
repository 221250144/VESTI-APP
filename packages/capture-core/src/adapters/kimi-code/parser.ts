/**
 * Kimi Code Parser
 * Parses wire.jsonl + metadata.json from Kimi Code sessions
 * Wire format: {timestamp: float_seconds, message: {type, payload}}
 */

import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import type { ParsedSession, ParsedMessage, ToolCallBlock, ToolResultBlock, SessionTokenUsage } from '../../types/agent.js';
import type { ToolExecution } from '../../types/index.js';
import type {
  KimiWireLine,
  KimiSessionMetadata,
  KimiConfig,
  KimiTurnBeginPayload,
  KimiContentPartPayload,
  KimiToolCallPayload,
  KimiToolCallPartPayload,
  KimiToolResultPayload,
  KimiStatusUpdatePayload,
  KimiSubagentEventPayload,
  KimiApprovalRequestPayload,
  KimiApprovalResponsePayload,
} from './types.js';
import os from 'os';

export class KimiCodeParser {

  async parseSessionDir(sessionDir: string): Promise<ParsedSession> {
    const wireFile = path.join(sessionDir, 'wire.jsonl');
    const metaFile = path.join(sessionDir, 'metadata.json');

    if (!await fs.pathExists(wireFile)) {
      throw new Error(`wire.jsonl not found in ${sessionDir}`);
    }

    // Read metadata
    let metadata: KimiSessionMetadata = {};
    if (await fs.pathExists(metaFile)) {
      try {
        const raw = await fs.readFile(metaFile, 'utf-8');
        if (raw.trim()) metadata = JSON.parse(raw);
      } catch { /* ignore */ }
    }

    // Parse wire.jsonl
    const content = await fs.readFile(wireFile, 'utf-8');
    const lines = this.parseWireLines(content);

    // Extract session ID from directory structure: {hash}/{uuid}
    const sessionId = path.basename(sessionDir);
    const hashDir = path.basename(path.dirname(sessionDir));

    // Resolve project path from hash
    const projectPath = await this.resolveProjectPath(hashDir);

    return this.buildSession(sessionId, lines, metadata, sessionDir, projectPath);
  }

  async parseSessionDirStream(sessionDir: string): Promise<ParsedSession> {
    const wireFile = path.join(sessionDir, 'wire.jsonl');
    const metaFile = path.join(sessionDir, 'metadata.json');

    if (!await fs.pathExists(wireFile)) {
      throw new Error(`wire.jsonl not found in ${sessionDir}`);
    }

    // Read metadata
    let metadata: KimiSessionMetadata = {};
    if (await fs.pathExists(metaFile)) {
      try {
        const raw = await fs.readFile(metaFile, 'utf-8');
        if (raw.trim()) metadata = JSON.parse(raw);
      } catch { /* ignore */ }
    }

    // Stream parse wire.jsonl
    const lines: KimiWireLine[] = [];
    const fileStream = fs.createReadStream(wireFile);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch { /* skip malformed */ }
    }

    const sessionId = path.basename(sessionDir);
    const hashDir = path.basename(path.dirname(sessionDir));
    const projectPath = await this.resolveProjectPath(hashDir);

    return this.buildSession(sessionId, lines, metadata, sessionDir, projectPath);
  }

  private parseWireLines(content: string): KimiWireLine[] {
    const lines: KimiWireLine[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch { /* skip malformed */ }
    }
    return lines;
  }

  /**
   * Resolve project path from hash directory name via kimi.json
   */
  private async resolveProjectPath(hashDir: string): Promise<string> {
    try {
      const configFile = path.join(os.homedir(), '.kimi', 'kimi.json');
      if (!await fs.pathExists(configFile)) return '';
      const config: KimiConfig = await fs.readJSON(configFile);
      if (!config.work_dirs) return '';

      for (const wd of config.work_dirs) {
        const hash = crypto.createHash('md5').update(wd.path).digest('hex');
        if (hash === hashDir) return wd.path;
      }
    } catch { /* ignore */ }
    return '';
  }

  private buildSession(
    sessionId: string,
    lines: KimiWireLine[],
    metadata: KimiSessionMetadata,
    sessionDir: string,
    projectPath: string,
  ): ParsedSession {
    const messages: ParsedMessage[] = [];
    const toolExecutions: ToolExecution[] = [];
    const tokenUsage: SessionTokenUsage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      models: new Set(),
    };

    let model: string | undefined;
    let msgIndex = 0;

    // Track active tool calls for pairing
    const activeToolCalls = new Map<string, {
      messageId: string;
      name: string;
      input: string;
      timestamp: number;
      displayData?: any[];
    }>();

    // Track compaction events
    const contextCompactions: Array<{ sequence: number; compactedAt: number; summary?: string }> = [];
    let compactionBeginTs: number | null = null;
    let compactionSeq = 0;

    // Track peak context usage
    let peakContextUsage = 0;

    for (const line of lines) {
      // Skip metadata line
      if (line.type === 'metadata') continue;
      if (!line.message) continue;

      const msgType = line.message.type;
      const payload = line.message.payload || {};
      // Kimi timestamps are float seconds
      const ts = line.timestamp ? Math.round(line.timestamp * 1000) : 0;

      switch (msgType) {
        case 'TurnBegin': {
          const p = payload as KimiTurnBeginPayload;
          const userText = typeof p.user_input === 'string'
            ? p.user_input
            : p.user_input
              ?.map(part => part.text)
              .filter(Boolean)
              .join('\n') || '';
          const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;
          messages.push({
            uuid,
            type: 'user',
            role: 'user',
            timestamp: ts,
            contentText: userText,
            isToolResult: false,
            depth: 0,
          });
          break;
        }

        case 'ContentPart': {
          const p = payload as KimiContentPartPayload;
          const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;
          if (p.type === 'think') {
            messages.push({
              uuid,
              type: 'assistant',
              role: 'assistant',
              timestamp: ts,
              contentThinking: p.think || '',
              isToolResult: false,
              depth: 0,
            });
          } else {
            messages.push({
              uuid,
              type: 'assistant',
              role: 'assistant',
              timestamp: ts,
              contentText: p.text || '',
              isToolResult: false,
              depth: 0,
            });
          }
          break;
        }

        case 'ToolCall': {
          const p = payload as KimiToolCallPayload;
          const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;
          const toolName = p.function?.name || 'unknown';
          const toolArgs = p.function?.arguments || '';
          const toolCallId = p.id || `tc-${msgIndex}`;

          const toolCall: ToolCallBlock = {
            id: toolCallId,
            name: toolName,
            input: toolArgs,
          };
          messages.push({
            uuid,
            type: 'assistant',
            role: 'assistant',
            timestamp: ts,
            toolCalls: [toolCall],
            isToolResult: false,
            depth: 0,
          });
          activeToolCalls.set(toolCallId, {
            messageId: uuid,
            name: toolName,
            input: toolArgs,
            timestamp: ts,
          });
          break;
        }

        case 'ToolCallPart': {
          // Streaming tool call arguments — not used for final output
          break;
        }

        case 'ToolResult': {
          const p = payload as KimiToolResultPayload;
          const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;
          const toolCallId = p.tool_call_id || '';
          const rv = p.return_value || { is_error: false, output: '' };
          const rawOutput = rv.output || rv.message || '';
          const outputParts: string[] = [];

          // Main output
          const mainOutput = typeof rawOutput === 'string'
            ? rawOutput
            : Array.isArray(rawOutput)
              ? rawOutput.map((o: any) => typeof o === 'string' ? o : o.text || '').join('\n')
              : String(rawOutput);
          if (mainOutput) outputParts.push(mainOutput);

          // Extract display data (diffs, briefs) for output summary
          if (rv.display && Array.isArray(rv.display)) {
            for (const item of rv.display as any[]) {
              if (item.type === 'diff' && item.path) {
                outputParts.push(`[diff ${item.path}]`);
              } else if (item.type === 'brief' && item.text) {
                outputParts.push(item.text);
              }
            }
          }

          const output = outputParts.join('\n');
          const isError = rv.is_error || false;

          const toolResult: ToolResultBlock = {
            toolUseId: toolCallId,
            content: output,
            isError,
          };
          messages.push({
            uuid,
            type: 'user',
            role: 'user',
            timestamp: ts,
            toolResults: [toolResult],
            isToolResult: true,
            depth: 0,
          });

          // Complete tool execution chain with display data
          const call = activeToolCalls.get(toolCallId);
          if (call) {
            toolExecutions.push({
              id: toolCallId,
              conversationId: '',
              toolUseMessageId: call.messageId,
              toolResultMessageId: uuid,
              toolUseId: toolCallId,
              toolName: call.name,
              inputSummary: call.input.slice(0, 500),
              outputSummary: output.slice(0, 500),
              displayData: rv.display && Array.isArray(rv.display) ? rv.display : undefined,
              isError,
              durationMs: ts > 0 && call.timestamp > 0 ? ts - call.timestamp : undefined,
              timestamp: call.timestamp,
            });
            activeToolCalls.delete(toolCallId);
          }
          break;
        }

        case 'StatusUpdate': {
          const p = payload as KimiStatusUpdatePayload;
          if (p.token_usage) {
            const tu = p.token_usage;
            tokenUsage.totalInputTokens += (tu.input_other || 0) + (tu.input_cache_read || 0) + (tu.input_cache_creation || 0);
            tokenUsage.totalOutputTokens += tu.output || 0;
            tokenUsage.totalCacheCreationTokens += tu.input_cache_creation || 0;
            tokenUsage.totalCacheReadTokens += tu.input_cache_read || 0;
          }
          if (p.context_usage && p.context_usage > peakContextUsage) {
            peakContextUsage = p.context_usage;
          }
          break;
        }

        case 'SubagentEvent': {
          const p = payload as KimiSubagentEventPayload;
          const subEvent = p.event;
          const subType = subEvent?.type;
          const subPayload = subEvent?.payload || {};
          const taskToolCallId = p.task_tool_call_id;

          if (subType === 'ToolCall') {
            // Subagent tool call → record as tool execution
            const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;
            const subTc = subPayload as KimiToolCallPayload;
            const toolName = subTc.function?.name || 'unknown';
            const toolArgs = subTc.function?.arguments || '';
            const toolCallId = subTc.id || `sub-tc-${msgIndex}`;
            messages.push({
              uuid,
              type: 'assistant',
              role: 'assistant',
              timestamp: ts,
              toolCalls: [{ id: toolCallId, name: toolName, input: toolArgs }],
              isToolResult: false,
              depth: 1,
              agentId: taskToolCallId,
            });
            activeToolCalls.set(toolCallId, {
              messageId: uuid,
              name: toolName,
              input: toolArgs,
              timestamp: ts,
            });
          } else if (subType === 'ToolResult') {
            // Subagent tool result → complete execution chain
            const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;
            const subTr = subPayload as KimiToolResultPayload;
            const toolCallId = subTr.tool_call_id || '';
            const rv = subTr.return_value || { is_error: false, output: '' };
            const rawOut = rv.output || rv.message || '';
            const outParts: string[] = [];
            const mainOut = typeof rawOut === 'string' ? rawOut
              : Array.isArray(rawOut) ? rawOut.map((o: any) => typeof o === 'string' ? o : o.text || '').join('\n')
              : String(rawOut);
            if (mainOut) outParts.push(mainOut);
            if (rv.display && Array.isArray(rv.display)) {
              for (const item of rv.display as any[]) {
                if (item.type === 'diff' && item.path) outParts.push(`[diff ${item.path}]`);
                else if (item.type === 'brief' && item.text) outParts.push(item.text);
              }
            }
            const output = outParts.join('\n');
            const isError = rv.is_error || false;

            messages.push({
              uuid,
              type: 'user',
              role: 'user',
              timestamp: ts,
              toolResults: [{ toolUseId: toolCallId, content: output, isError }],
              isToolResult: true,
              depth: 1,
              agentId: taskToolCallId,
            });

            const call = activeToolCalls.get(toolCallId);
            if (call) {
              toolExecutions.push({
                id: toolCallId,
                conversationId: '',
                toolUseMessageId: call.messageId,
                toolResultMessageId: uuid,
                toolUseId: toolCallId,
                toolName: call.name,
                inputSummary: call.input.slice(0, 500),
                outputSummary: output.slice(0, 500),
                displayData: rv.display && Array.isArray(rv.display) ? rv.display : undefined,
                isError,
                durationMs: ts > 0 && call.timestamp > 0 ? ts - call.timestamp : undefined,
                timestamp: call.timestamp,
              });
              activeToolCalls.delete(toolCallId);
            }
          } else if (subType === 'StatusUpdate') {
            // Subagent token usage
            const subStatus = subPayload as KimiStatusUpdatePayload;
            if (subStatus.token_usage) {
              const tu = subStatus.token_usage;
              tokenUsage.totalInputTokens += (tu.input_other || 0) + (tu.input_cache_read || 0) + (tu.input_cache_creation || 0);
              tokenUsage.totalOutputTokens += tu.output || 0;
              tokenUsage.totalCacheCreationTokens += tu.input_cache_creation || 0;
              tokenUsage.totalCacheReadTokens += tu.input_cache_read || 0;
            }
            if (subStatus.context_usage && subStatus.context_usage > peakContextUsage) {
              peakContextUsage = subStatus.context_usage;
            }
          } else if (subType === 'ContentPart') {
            // Subagent content → keep as message with depth=1
            const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;
            const subCp = subPayload as KimiContentPartPayload;
            if (subCp.type === 'think') {
              messages.push({
                uuid, type: 'assistant', role: 'assistant', timestamp: ts,
                contentThinking: subCp.think || '', isToolResult: false,
                depth: 1, agentId: taskToolCallId,
              });
            } else {
              messages.push({
                uuid, type: 'assistant', role: 'assistant', timestamp: ts,
                contentText: subCp.text || '', isToolResult: false,
                depth: 1, agentId: taskToolCallId,
              });
            }
          } else {
            // Other subagent events → progress
            const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;
            messages.push({
              uuid, type: 'progress', role: 'system', timestamp: ts,
              contentText: `[Subagent] ${subType || 'unknown'}`,
              isToolResult: false, depth: 1, agentId: taskToolCallId,
            });
          }
          break;
        }

        case 'ApprovalRequest': {
          const p = payload as KimiApprovalRequestPayload;
          const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;
          messages.push({
            uuid,
            type: 'system',
            role: 'system',
            timestamp: ts,
            contentText: `[Approval] ${p.action}: ${p.description || ''}`.slice(0, 500),
            isToolResult: false,
            depth: 0,
          });
          break;
        }

        case 'ApprovalResponse': {
          const p = payload as KimiApprovalResponsePayload;
          const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;
          messages.push({
            uuid,
            type: 'system',
            role: 'system',
            timestamp: ts,
            contentText: `[Approval] Response: ${p.response}`,
            isToolResult: false,
            depth: 0,
          });
          break;
        }

        case 'CompactionBegin': {
          compactionBeginTs = ts;
          const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;
          messages.push({
            uuid,
            type: 'system',
            role: 'system',
            timestamp: ts,
            contentText: '[Context Compaction] Begin',
            isToolResult: false,
            depth: 0,
          });
          break;
        }

        case 'CompactionEnd': {
          compactionSeq++;
          contextCompactions.push({
            sequence: compactionSeq,
            compactedAt: compactionBeginTs || ts,
            summary: (payload as any)?.summary,
          });
          compactionBeginTs = null;
          const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;
          messages.push({
            uuid,
            type: 'system',
            role: 'system',
            timestamp: ts,
            contentText: '[Context Compaction] End',
            isToolResult: false,
            depth: 0,
          });
          break;
        }

        // StepBegin, StepInterrupted, TurnEnd — skip (structural, not content)
        default:
          break;
      }
    }

    const timestamps = messages.filter(m => m.timestamp > 0).map(m => m.timestamp);
    const startTime = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
    const endTime = timestamps.length > 0 ? Math.max(...timestamps) : undefined;

    // Title from metadata or first user input
    let title = metadata.title || '';
    if (!title || title === 'Untitled') {
      const firstUser = messages.find(m => m.role === 'user' && !m.isToolResult && m.contentText);
      if (firstUser?.contentText) {
        title = firstUser.contentText.split('\n')[0].slice(0, 80);
      }
    }

    return {
      sessionId,
      platform: 'kimi-code',
      projectPath,
      model,
      messages,
      toolExecutions,
      subagents: [],
      tokenUsage,
      startTime,
      endTime,
      contextCompactions: contextCompactions.length > 0 ? contextCompactions : undefined,
      peakContextUsage: peakContextUsage > 0 ? peakContextUsage : undefined,
    };
  }
}
