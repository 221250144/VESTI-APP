/**
 * Aider Adapter (stub)
 * Aider markdown history support — to be implemented
 */

import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../../types/agent.js';

export class AiderAdapter implements AgentAdapter {
  readonly platform = 'aider' as const;
  readonly name = 'Aider';

  async detect(): Promise<AgentDetectResult> {
    return { installed: false };
  }

  async parseSession(_filePath: string): Promise<ParsedSession> {
    throw new Error('Aider adapter not yet implemented');
  }

  async getSessionFiles(): Promise<string[]> {
    return [];
  }

  getWatchPatterns(): string[] {
    return [];
  }
}
