/**
 * Path Resolver
 * Multi-root home abstraction: a native home (os.homedir()) plus zero or
 * more WSL distro user homes exposed over UNC paths. Adapters enumerate
 * these roots instead of a single home so sessions living inside WSL are
 * captured too. Host tags flow into work_sessions.host and session ids.
 */

import os from 'os';

export interface HomeRoot {
  /** 'native' for the host OS home, 'wsl:<distro>' for a WSL user home */
  host: string;
  /** Native: os.homedir(). WSL: UNC path like \\wsl$\Ubuntu\home\alice */
  homeDir: string;
}

export function nativeHomeRoot(): HomeRoot {
  return { host: 'native', homeDir: os.homedir() };
}

/**
 * Derive the host tag for a session file path. UNC paths under
 * \\wsl$\\<distro>\ or \\wsl.localhost\<distro>\ map to 'wsl:<distro>';
 * everything else is 'native'. The distro segment is lowercased because
 * Windows tooling returns UNC roots in varying case (glob uppercases
 * them) while the UNC namespace itself is case-insensitive — the tag
 * must not depend on which code path produced the path.
 */
export function hostFromPath(filePath: string): string {
  const segments = filePath.split(/[\\/]+/).filter(Boolean);
  const share = segments[0]?.toLowerCase();
  if ((share === 'wsl$' || share === 'wsl.localhost') && segments[1]) {
    return `wsl:${segments[1].toLowerCase()}`;
  }
  return 'native';
}

/**
 * Deterministic session-id rewrite for WSL sources. A session that exists
 * both natively and inside WSL keeps distinct WorkSession ids: native
 * stays {platform}:{sessionId}, WSL becomes
 * {platform}:wsl-<distro>-{sessionId}.
 */
export function rewriteSessionIdForHost(sessionId: string, host: string): string {
  if (!host.startsWith('wsl:')) return sessionId;
  const distro = host.slice('wsl:'.length).replace(/[^\w.-]+/g, '-');
  return `wsl-${distro}-${sessionId}`;
}
