// P4a AI relay: handoff pack → Markdown serialization, in the style of the
// P3 conversation markdownSerializer (deterministic pure function, no IO).
// Shared by the RelayPanel (copy/export) and the desktop storage layer
// (CLI-launch file, extension outbox delivery).
//
// Schema v2: normalizeRelayPackPayload upgrades any stored payload (including
// v1 packs without completed/in_progress/git_state/failed_paths/verification/
// confidence) to the full v2 shape, so both the panel and this serializer
// render old and new packs through one code path.

import type {
  RelayPack,
  RelayPackConfidence,
  RelayPackExtractedFile,
  RelayPackFailedPath,
  RelayPackGitState,
  RelayPackKeyFile,
  RelayPackPayload,
  RelayPackVerification,
} from "../types";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalDateTime(value: number): string {
  const d = new Date(value);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function toIsoWithOffset(value: number): string {
  const d = new Date(value);
  const tzOffsetMinutes = -d.getTimezoneOffset();
  const sign = tzOffsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(tzOffsetMinutes);
  return `${toLocalDateTime(value).slice(0, 10)}T${toLocalDateTime(value).slice(11)}${sign}${pad2(Math.floor(absOffset / 60))}:${pad2(absOffset % 60)}`;
}

/** YAML-safe scalar: plain when harmless, JSON double-quoted otherwise. */
function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(value) ? value : JSON.stringify(value);
}

function bulletList(items: string[]): string {
  if (items.length === 0) return "无";
  return items.map((item) => `- ${item}`).join("\n");
}

function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

function keyFilesTable(files: RelayPackKeyFile[]): string {
  if (files.length === 0) return "无";
  const rows = files.map(
    (file) => `| ${tableCell(file.path)} | ${tableCell(file.why)} | ${tableCell(file.last_state)} |`
  );
  return ["| 文件 | 作用 | 当前状态 |", "| --- | --- | --- |", ...rows].join("\n");
}

// ---- v1 → v2 payload normalization -----------------------------------------

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeKeyFiles(value: unknown): RelayPackKeyFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      path: asString(item.path),
      why: asString(item.why),
      last_state: asString(item.last_state),
    }))
    .filter((file) => file.path);
}

function normalizeGitState(value: unknown): RelayPackGitState {
  const entry = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const branch = asString(entry.branch);
  return {
    ...(branch ? { branch } : {}),
    dirty_files: asStringList(entry.dirty_files),
    last_commits: asStringList(entry.last_commits),
  };
}

function normalizeFailedPaths(value: unknown): RelayPackFailedPath[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      approach: asString(item.approach),
      why_failed: asString(item.why_failed),
    }))
    .filter((path) => path.approach);
}

function normalizeVerification(value: unknown): RelayPackVerification {
  const entry = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    commands: asStringList(entry.commands),
    last_results: asStringList(entry.last_results),
  };
}

function normalizeConfidence(value: unknown): RelayPackConfidence | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.overall !== "number" || !Number.isFinite(entry.overall)) return undefined;
  return {
    overall: Math.min(1, Math.max(0, entry.overall)),
    low_areas: asStringList(entry.low_areas),
  };
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0
  );
}

function normalizeExtractedFiles(value: unknown): RelayPackExtractedFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      path: asString(item.path),
      touches: asNumber(item.touches),
      lastTouchedAt: asNumber(item.lastTouchedAt),
      conversationIds: asIdList(item.conversationIds),
    }))
    .filter((file) => file.path);
}

/**
 * Separator/case-folded path key — the same folding the deterministic
 * extractor dedupes with, so the panel can match a key_files row against the
 * extracted anchors regardless of spelling differences.
 */
export function relayPathKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Find the extracted anchor backing a key_files row, if any. */
export function findExtractedFileAnchor(
  path: string,
  extracted: RelayPackExtractedFile[] | undefined
): RelayPackExtractedFile | null {
  if (!extracted || extracted.length === 0) return null;
  const key = relayPathKey(path);
  if (!key) return null;
  return extracted.find((file) => relayPathKey(file.path) === key) ?? null;
}

/**
 * Upgrade any stored relay payload to the full schema-v2 shape. v1 packs keep
 * their current_state and get empty defaults for every v2 field (confidence
 * stays absent); garbage input degrades to an empty pack instead of throwing.
 */
export function normalizeRelayPackPayload(raw: unknown): RelayPackPayload {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const confidence = normalizeConfidence(source.confidence);
  const extractedKeyFiles = normalizeExtractedFiles(source.extracted_key_files);
  const verifyFirst = asStringList(source.verify_first);
  return {
    title: asString(source.title),
    goal: asString(source.goal),
    current_state: asString(source.current_state),
    completed: asStringList(source.completed),
    in_progress: asStringList(source.in_progress),
    git_state: normalizeGitState(source.git_state),
    key_decisions: asStringList(source.key_decisions),
    key_files: normalizeKeyFiles(source.key_files),
    failed_paths: normalizeFailedPaths(source.failed_paths),
    open_issues: asStringList(source.open_issues),
    verification: normalizeVerification(source.verification),
    next_steps: asStringList(source.next_steps),
    ...(confidence ? { confidence } : {}),
    ...(verifyFirst.length > 0 ? { verify_first: verifyFirst } : {}),
    ...(extractedKeyFiles.length > 0 ? { extracted_key_files: extractedKeyFiles } : {}),
    suggested_prompt: asString(source.suggested_prompt),
  };
}

/** A v2 section is worth rendering only when it carries content. */
function hasGitContent(git: RelayPackGitState): boolean {
  return Boolean(git.branch) || git.dirty_files.length > 0 || git.last_commits.length > 0;
}

function hasVerificationContent(verification: RelayPackVerification): boolean {
  return verification.commands.length > 0 || verification.last_results.length > 0;
}

function gitStateBlock(git: RelayPackGitState): string {
  const lines: string[] = [];
  if (git.branch) lines.push(`- 分支：${git.branch}`);
  if (git.dirty_files.length > 0) lines.push(`- 未提交改动：${git.dirty_files.join("、")}`);
  if (git.last_commits.length > 0) {
    lines.push("- 最近提交：");
    lines.push(git.last_commits.map((commit) => `  - ${commit}`).join("\n"));
  }
  return lines.join("\n");
}

function failedPathsBlock(paths: RelayPackFailedPath[]): string {
  return paths
    .map((path) => `- ${path.approach}${path.why_failed ? ` — 失败原因：${path.why_failed}` : ""}`)
    .join("\n");
}

function verificationBlock(verification: RelayPackVerification): string {
  const lines: string[] = [];
  if (verification.commands.length > 0) {
    lines.push("验证命令：");
    lines.push(verification.commands.map((command) => `- \`${command}\``).join("\n"));
  }
  if (verification.last_results.length > 0) {
    lines.push("最近结果：");
    lines.push(bulletList(verification.last_results));
  }
  return lines.join("\n");
}

function confidenceBlock(confidence: RelayPackConfidence): string {
  const percent = Math.round(confidence.overall * 100);
  const lines = [`整体置信度：${percent}%`];
  if (confidence.low_areas.length > 0) {
    lines.push(`低置信区域：${confidence.low_areas.join("、")}`);
  }
  return lines.join("\n");
}

function section(title: string, body: string): string[] {
  return [`## ${title}`, "", body, ""];
}

export function serializeRelayPackMarkdown(pack: RelayPack): string {
  const payload = normalizeRelayPackPayload(pack.pack);
  const parts: string[] = [
    [
      "---",
      `relay_id: ${pack.id}`,
      `title: ${yamlScalar(pack.title)}`,
      `created: ${yamlScalar(toIsoWithOffset(pack.createdAt))}`,
      `source: ${pack.source}`,
      `conversations: ${pack.conversationIds.length}`,
      "---",
    ].join("\n"),
    "",
    `# 交接包：${pack.title}`,
    "",
    `> **生成时间：**${toLocalDateTime(pack.createdAt)} · **来源会话：**${pack.conversationIds.length} 个`,
    "",
    ...section("目标", payload.goal || "无"),
  ];
  // v1 field: only rendered when the pack actually carries it.
  if (payload.current_state) {
    parts.push(...section("当前状态", payload.current_state));
  }
  if (payload.completed.length > 0) {
    parts.push(...section("已完成", bulletList(payload.completed)));
  }
  if (payload.in_progress.length > 0) {
    parts.push(...section("进行中", bulletList(payload.in_progress)));
  }
  if (hasGitContent(payload.git_state)) {
    parts.push(...section("Git 状态", gitStateBlock(payload.git_state)));
  }
  parts.push(...section("关键决策", bulletList(payload.key_decisions)));
  parts.push(...section("关键文件", keyFilesTable(payload.key_files)));
  if (payload.failed_paths.length > 0) {
    parts.push(...section("失败死路", failedPathsBlock(payload.failed_paths)));
  }
  parts.push(...section("未决问题", bulletList(payload.open_issues)));
  if (hasVerificationContent(payload.verification)) {
    parts.push(...section("验证", verificationBlock(payload.verification)));
  }
  // Schema v2 additive: the verify-before-acting checklist for the receiver.
  if (payload.verify_first && payload.verify_first.length > 0) {
    parts.push(
      ...section(
        "接手先验证",
        payload.verify_first.map((item, index) => `${index + 1}. ${item}`).join("\n")
      )
    );
  }
  parts.push(
    ...section(
      "下一步",
      payload.next_steps.length === 0
        ? "无"
        : payload.next_steps.map((step, index) => `${index + 1}. ${step}`).join("\n")
    )
  );
  if (payload.confidence) {
    parts.push(...section("置信度", confidenceBlock(payload.confidence)));
  }
  parts.push(...section("建议提示词", ["```text", pack.suggestedPrompt, "```"].join("\n")));
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
