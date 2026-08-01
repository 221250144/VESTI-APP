/**
 * Agent MCP registry — one-click wiring of the vesti-mcp server into the MCP
 * client configs of the agents installed on this machine.
 *
 * Supported targets (all local stdio configs):
 *   kimi-code    ~/.kimi-code/mcp.json    JSON  { "mcpServers": { "vesti": … } }
 *   claude-code  ~/.claude.json           JSON  { "mcpServers": { "vesti": … } } (user scope)
 *   codex        ~/.codex/config.toml     TOML  [mcp_servers.vesti]
 *   cursor       ~/.cursor/mcp.json       JSON  { "mcpServers": { "vesti": … } }
 *
 * Write rules:
 *   - merge-only: every other server and every unrelated config key survives;
 *   - idempotent: content that already matches is left untouched (and a
 *     second register call reports changed=false);
 *   - safe: the original file is copied to `<config>.vesti-bak-<timestamp>`
 *     before the first change, and malformed JSON is reported, never
 *     clobbered.
 *
 * The class is pure filesystem logic with an injectable home directory, so
 * tests run against a temp HOME; main.ts wires the real one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentMcpTargetId, AgentMcpTargetStatus, AgentMcpWriteResult } from '../shared/contracts';

const SERVER_NAME = 'vesti';

type TargetKind = 'json-mcp-servers' | 'toml-codex';

interface AgentMcpTarget {
  id: AgentMcpTargetId;
  label: string;
  kind: TargetKind;
  configPath: (home: string) => string;
  /** Any of these existing marks the agent as installed. */
  detectPaths: (home: string) => string[];
}

const TARGETS: AgentMcpTarget[] = [
  {
    id: 'kimi-code',
    label: 'Kimi Code',
    kind: 'json-mcp-servers',
    configPath: home => path.join(home, '.kimi-code', 'mcp.json'),
    detectPaths: home => [path.join(home, '.kimi-code')],
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    kind: 'json-mcp-servers',
    configPath: home => path.join(home, '.claude.json'),
    detectPaths: home => [path.join(home, '.claude.json'), path.join(home, '.claude')],
  },
  {
    id: 'codex',
    label: 'Codex',
    kind: 'toml-codex',
    configPath: home => path.join(home, '.codex', 'config.toml'),
    detectPaths: home => [path.join(home, '.codex')],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'json-mcp-servers',
    configPath: home => path.join(home, '.cursor', 'mcp.json'),
    detectPaths: home => [path.join(home, '.cursor')],
  },
];

export function resolveAgentMcpTargetId(value: unknown): AgentMcpTargetId | null {
  return TARGETS.some(target => target.id === value) ? (value as AgentMcpTargetId) : null;
}

/**
 * Where the runnable vesti-mcp entry can live, in priority order:
 * an explicit env override, the dev workspace build, then the packaged
 * resources copy.
 */
export function defaultServerEntryCandidates(
  appPath: string,
  resourcesPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const override = env.VESTI_MCP_SERVER_PATH?.trim();
  return [
    ...(override ? [override] : []),
    path.join(appPath, 'packages', 'vesti-mcp', 'dist', 'cli.js'),
    path.join(resourcesPath, 'vesti-mcp', 'cli.js'),
  ];
}

export function resolveServerEntry(candidates: string[]): string | null {
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

/** Node and MCP configs both accept forward slashes on Windows; using them
 * keeps JSON/TOML free of backslash escaping. */
function slash(value: string): string {
  return value.replace(/\\/g, '/');
}

function backupPathFor(configPath: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${configPath}.vesti-bak-${stamp}`;
}

// ---------- JSON targets ({ "mcpServers": { … } }) ----------

interface JsonServerEntry {
  command: string;
  args: string[];
}

function readJsonConfig(configPath: string): { config: Record<string, unknown> } | { error: string } {
  if (!fs.existsSync(configPath)) return { config: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'config file is not a JSON object' };
    }
    return { config: parsed as Record<string, unknown> };
  } catch {
    return { error: 'config file is not valid JSON' };
  }
}

function jsonVestiEntry(config: Record<string, unknown>): JsonServerEntry | null {
  const servers = config.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null;
  const entry = (servers as Record<string, unknown>)[SERVER_NAME];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  return {
    command: typeof record.command === 'string' ? record.command : '',
    args: Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === 'string') : [],
  };
}

// ---------- TOML target (codex [mcp_servers.vesti]) ----------

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

function desiredTomlBlock(command: string, entry: string): string[] {
  return [`[mcp_servers.${SERVER_NAME}]`, `command = ${tomlString(command)}`, `args = [${tomlString(entry)}]`];
}

const TOML_SECTION_HEADER = /^\s*\[[^\]]+\]\s*$/;
const TOML_VESTI_HEADER = /^\s*\[mcp_servers\.vesti\]\s*$/;

/** Replace (or append) the [mcp_servers.vesti] section; null removes it. */
function writeTomlSection(content: string, block: string[] | null): string {
  const lines = content.split('\n');
  const start = lines.findIndex(line => TOML_VESTI_HEADER.test(line));
  if (start === -1) {
    if (!block) return content;
    const trimmed = content.replace(/\s*$/, '');
    return `${trimmed}${trimmed ? '\n\n' : ''}${block.join('\n')}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (TOML_SECTION_HEADER.test(lines[i])) {
      end = i;
      break;
    }
  }
  const next = [
    ...lines.slice(0, start),
    ...(block ?? []),
    ...lines.slice(end),
  ];
  // Removing a middle section can leave doubled blank lines; collapse them.
  // Preserve the file's trailing-newline convention so a no-op rewrite is
  // byte-identical (register idempotency compares raw content).
  let out = next.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  if (content.endsWith('\n') && !out.endsWith('\n')) out += '\n';
  return out;
}

function readTomlVestiBlock(content: string): string[] | null {
  const lines = content.split('\n');
  const start = lines.findIndex(line => TOML_VESTI_HEADER.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (TOML_SECTION_HEADER.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).map(line => line.trimEnd()).filter(line => line.trim() !== '');
}

// ---------- the registry ----------

export interface AgentMcpRegistryOptions {
  homeDir: string;
  /** Absolute path to the built vesti-mcp entry (dist/cli.js); null when the
   * server has not been built — registration then fails with guidance. */
  serverEntry: string | null;
  nodeCommand?: string;
}

export class AgentMcpRegistry {
  private readonly nodeCommand: string;

  constructor(private readonly options: AgentMcpRegistryOptions) {
    this.nodeCommand = options.nodeCommand ?? 'node';
  }

  listStatus(): AgentMcpTargetStatus[] {
    return TARGETS.map(target => this.statusOf(target));
  }

  register(id: AgentMcpTargetId): AgentMcpWriteResult {
    const target = this.targetOf(id);
    if (!this.options.serverEntry) {
      return {
        ok: false,
        changed: false,
        backupPath: null,
        error: 'vesti-mcp server entry not found — build it first (pnpm mcp:build).',
      };
    }
    return this.write(target, true);
  }

  unregister(id: AgentMcpTargetId): AgentMcpWriteResult {
    return this.write(this.targetOf(id), false);
  }

  private targetOf(id: AgentMcpTargetId): AgentMcpTarget {
    const target = TARGETS.find(candidate => candidate.id === id);
    if (!target) throw new Error(`unknown agent target: ${id}`);
    return target;
  }

  private desiredEntry(): JsonServerEntry | null {
    const entry = this.options.serverEntry;
    return entry ? { command: this.nodeCommand, args: [slash(entry)] } : null;
  }

  private statusOf(target: AgentMcpTarget): AgentMcpTargetStatus {
    const home = this.options.homeDir;
    const configPath = target.configPath(home);
    const status: AgentMcpTargetStatus = {
      id: target.id,
      label: target.label,
      configPath,
      detected: target.detectPaths(home).some(candidate => fs.existsSync(candidate)),
      registered: false,
      upToDate: false,
      serverAvailable: this.options.serverEntry !== null,
      serverEntry: this.options.serverEntry ? slash(this.options.serverEntry) : null,
    };
    if (!fs.existsSync(configPath)) return status;

    if (target.kind === 'json-mcp-servers') {
      const read = readJsonConfig(configPath);
      if ('error' in read) {
        status.error = read.error;
        return status;
      }
      const entry = jsonVestiEntry(read.config);
      status.registered = entry !== null;
      const desired = this.desiredEntry();
      status.upToDate = entry !== null && desired !== null
        && entry.command === desired.command
        && entry.args.join('') === desired.args.join('');
    } else {
      try {
        const block = readTomlVestiBlock(fs.readFileSync(configPath, 'utf8'));
        status.registered = block !== null;
        const desired = this.options.serverEntry
          ? desiredTomlBlock(this.nodeCommand, this.options.serverEntry)
          : null;
        status.upToDate = block !== null && desired !== null && block.join('\n') === desired.join('\n');
      } catch { /* unreadable config — report as not registered */ }
    }
    return status;
  }

  private write(target: AgentMcpTarget, install: boolean): AgentMcpWriteResult {
    const configPath = target.configPath(this.options.homeDir);
    try {
      if (target.kind === 'json-mcp-servers') return this.writeJson(configPath, install);
      return this.writeToml(configPath, install);
    } catch (error) {
      return {
        ok: false,
        changed: false,
        backupPath: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Backup + write helper: returns the changed flag and backup path. */
  private persist(configPath: string, next: string, previous: string | null): { changed: boolean; backupPath: string | null } {
    if (previous !== null && previous === next) return { changed: false, backupPath: null };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    let backupPath: string | null = null;
    if (previous !== null) {
      backupPath = backupPathFor(configPath);
      fs.copyFileSync(configPath, backupPath);
    }
    fs.writeFileSync(configPath, next, 'utf8');
    return { changed: true, backupPath };
  }

  private writeJson(configPath: string, install: boolean): AgentMcpWriteResult {
    const exists = fs.existsSync(configPath);
    const read = readJsonConfig(configPath);
    if ('error' in read) return { ok: false, changed: false, backupPath: null, error: read.error };
    const config = read.config;
    const servers = (
      config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
        ? { ...(config.mcpServers as Record<string, unknown>) }
        : {}
    );
    if (install) {
      const desired = this.desiredEntry();
      if (!desired) return { ok: false, changed: false, backupPath: null, error: 'server entry unavailable' };
      servers[SERVER_NAME] = { command: desired.command, args: desired.args };
    } else {
      if (!(SERVER_NAME in servers)) return { ok: true, changed: false, backupPath: null };
      delete servers[SERVER_NAME];
    }
    const next = `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`;
    const { changed, backupPath } = this.persist(
      configPath,
      next,
      exists ? fs.readFileSync(configPath, 'utf8') : null,
    );
    return { ok: true, changed, backupPath };
  }

  private writeToml(configPath: string, install: boolean): AgentMcpWriteResult {
    const exists = fs.existsSync(configPath);
    const previous = exists ? fs.readFileSync(configPath, 'utf8') : '';
    const block = install && this.options.serverEntry
      ? desiredTomlBlock(this.nodeCommand, this.options.serverEntry)
      : null;
    if (install && !block) {
      return { ok: false, changed: false, backupPath: null, error: 'server entry unavailable' };
    }
    const next = writeTomlSection(previous, block);
    const { changed, backupPath } = this.persist(configPath, next, exists ? previous : null);
    return { ok: true, changed, backupPath };
  }
}

/** Convenience factory for main.ts: real HOME + resolved server entry. */
export function createAgentMcpRegistry(appPath: string, resourcesPath: string): AgentMcpRegistry {
  return new AgentMcpRegistry({
    homeDir: os.homedir(),
    serverEntry: resolveServerEntry(defaultServerEntryCandidates(appPath, resourcesPath)),
  });
}
