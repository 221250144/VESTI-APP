const STORAGE_KEY = "vesti_notion_settings";
const PROXY_OVERRIDE_KEY = "vesti_notion_oauth_proxy_base";
const DEFAULT_OAUTH_PROXY_BASE = "https://vesti-proxy.vercel.app/api/notion/oauth";
const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const DATABASE_ID_PATTERN =
  /[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

export type NotionAuthMode = "disconnected" | "oauth_public" | "legacy_manual";

export interface NotionSettings {
  authMode: NotionAuthMode;
  accessToken: string;
  workspaceId: string;
  workspaceName: string;
  selectedDatabaseId: string;
  selectedDatabaseTitle: string;
  updatedAt: number;
}

export interface NotionDatabaseOption {
  id: string;
  title: string;
  url?: string;
}

export function formatNotionErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Notion request failed.";

  switch (raw) {
    case "NOTION_EXTENSION_ONLY":
    case "NOTION_OAUTH_UNAVAILABLE":
      return "Official Notion login is available only inside the extension build.";
    case "NOTION_OAUTH_CANCELLED":
    case "access_denied":
      return "Notion connection was cancelled.";
    case "NOTION_OAUTH_NO_RESPONSE":
    case "NOTION_OAUTH_SESSION_MISSING":
    case "NOTION_OAUTH_404":
    case "NOTION_SESSION_NOT_FOUND":
      return "The Notion login session expired. Start the connection flow again.";
    case "NOTION_RECONNECT_REQUIRED":
      return "Your Notion session expired. Reconnect and try again.";
    case "NOTION_OAUTH_NOT_CONFIGURED":
      return "Notion OAuth is not configured on the proxy yet.";
    case "INVALID_EXTENSION_REDIRECT":
      return "The extension redirect URL is invalid for Notion OAuth.";
    default:
      if (typeof raw === "string" && raw.trim()) {
        return raw;
      }
      return "Notion request failed.";
  }
}

type NotionOAuthSessionPayload = {
  accessToken: string;
  workspaceId?: string;
  workspaceName?: string;
};

type NotionProxyErrorPayload = {
  error?: {
    code?: string;
    message?: string;
  };
};

type ChromeStorageLike = Pick<
  chrome.storage.StorageArea,
  "get" | "set" | "remove"
>;

function buildDefaultNotionSettings(): NotionSettings {
  return {
    authMode: "disconnected",
    accessToken: "",
    workspaceId: "",
    workspaceName: "",
    selectedDatabaseId: "",
    selectedDatabaseTitle: "",
    updatedAt: 0,
  };
}

function getStorage(): ChromeStorageLike | null {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return null;
  }
  return chrome.storage.local;
}

function getIdentityApi(): typeof chrome.identity | null {
  if (typeof chrome === "undefined" || !chrome.identity) {
    return null;
  }
  return chrome.identity;
}

function extractDatabaseId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const match = trimmed.match(DATABASE_ID_PATTERN);
  return match ? match[0] : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeNotionSettings(value: unknown): NotionSettings {
  if (!isRecord(value)) {
    return buildDefaultNotionSettings();
  }

  const accessToken =
    typeof value.accessToken === "string"
      ? value.accessToken.trim()
      : typeof value.notionToken === "string"
        ? value.notionToken.trim()
        : "";
  const selectedDatabaseRaw =
    typeof value.selectedDatabaseId === "string"
      ? value.selectedDatabaseId
      : typeof value.notionDatabaseId === "string"
        ? value.notionDatabaseId
        : "";
  const selectedDatabaseId = extractDatabaseId(selectedDatabaseRaw);
  const selectedDatabaseTitle =
    typeof value.selectedDatabaseTitle === "string"
      ? value.selectedDatabaseTitle.trim()
      : "";
  const workspaceId =
    typeof value.workspaceId === "string" ? value.workspaceId.trim() : "";
  const workspaceName =
    typeof value.workspaceName === "string" ? value.workspaceName.trim() : "";
  const updatedAt =
    typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : 0;

  let authMode: NotionAuthMode = "disconnected";
  if (typeof value.authMode === "string") {
    if (
      value.authMode === "oauth_public" ||
      value.authMode === "legacy_manual" ||
      value.authMode === "disconnected"
    ) {
      authMode = value.authMode;
    }
  } else if (accessToken) {
    authMode = workspaceId || workspaceName ? "oauth_public" : "legacy_manual";
  }

  return {
    authMode,
    accessToken,
    workspaceId,
    workspaceName,
    selectedDatabaseId,
    selectedDatabaseTitle,
    updatedAt,
  };
}

function persistNotionSettings(settings: NotionSettings): Promise<NotionSettings> {
  const storage = getStorage();
  if (!storage) {
    throw new Error("NOTION_EXTENSION_ONLY");
  }

  return new Promise((resolve, reject) => {
    storage.set({ [STORAGE_KEY]: settings }, () => {
      const err = chrome.runtime?.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(settings);
    });
  });
}

async function readProxyBaseOverride(): Promise<string> {
  const storage = getStorage();
  if (!storage) {
    return DEFAULT_OAUTH_PROXY_BASE;
  }

  return new Promise((resolve) => {
    storage.get([PROXY_OVERRIDE_KEY], (result) => {
      const raw = result?.[PROXY_OVERRIDE_KEY];
      if (typeof raw === "string" && raw.trim()) {
        resolve(raw.trim().replace(/\/+$/, ""));
        return;
      }
      resolve(DEFAULT_OAUTH_PROXY_BASE);
    });
  });
}

function buildNotionHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_VERSION,
  };
}

function getPlainTextTitle(title: unknown): string {
  if (!Array.isArray(title)) {
    return "Untitled database";
  }

  const text = title
    .map((part) => {
      if (!isRecord(part)) return "";
      const plainText = part.plain_text;
      return typeof plainText === "string" ? plainText : "";
    })
    .join("")
    .trim();

  return text || "Untitled database";
}

async function notionJsonRequest<T>(
  input: string,
  init: RequestInit,
  accessToken: string
): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      ...buildNotionHeaders(accessToken),
      ...(init.headers ?? {}),
    },
  });

  const payload = (await response.json().catch(() => null)) as
    | { message?: string }
    | null;

  if (!response.ok) {
    const message = payload?.message || `NOTION_${response.status}`;
    if (response.status === 401) {
      await disconnectNotion();
      throw new Error("NOTION_RECONNECT_REQUIRED");
    }
    throw new Error(message);
  }

  return payload as T;
}

function parseSessionTokenRedirect(redirectUrl: string): { sessionId?: string; error?: string } {
  const url = new URL(redirectUrl);
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  return {
    sessionId: url.searchParams.get("session") || hashParams.get("session") || undefined,
    error:
      url.searchParams.get("error") ||
      hashParams.get("error") ||
      url.searchParams.get("error_description") ||
      hashParams.get("error_description") ||
      undefined,
  };
}

export function isNotionExportConfigured(settings: NotionSettings | null | undefined): boolean {
  return Boolean(settings?.accessToken?.trim() && settings?.selectedDatabaseId?.trim());
}

export function isNotionConnected(settings: NotionSettings | null | undefined): boolean {
  return Boolean(settings?.accessToken?.trim());
}

export async function getNotionSettings(): Promise<NotionSettings> {
  const storage = getStorage();
  if (!storage) {
    return buildDefaultNotionSettings();
  }

  return new Promise((resolve, reject) => {
    storage.get([STORAGE_KEY], (result) => {
      const err = chrome.runtime?.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(normalizeNotionSettings(result?.[STORAGE_KEY]));
    });
  });
}

export async function setNotionSettings(
  settings: Partial<NotionSettings>
): Promise<NotionSettings> {
  const current = await getNotionSettings();
  const next = normalizeNotionSettings({
    ...current,
    ...settings,
    updatedAt: Date.now(),
  });
  return persistNotionSettings(next);
}

export async function disconnectNotion(): Promise<NotionSettings> {
  const next = buildDefaultNotionSettings();
  next.updatedAt = Date.now();
  return persistNotionSettings(next);
}

export async function connectToNotion(): Promise<NotionSettings> {
  const identity = getIdentityApi();
  if (!identity?.launchWebAuthFlow || !identity.getRedirectURL) {
    throw new Error("NOTION_OAUTH_UNAVAILABLE");
  }

  const proxyBase = await readProxyBaseOverride();
  const extensionRedirectUri = identity.getRedirectURL("notion");
  const startUrl = new URL(`${proxyBase}/start`);
  startUrl.searchParams.set("extension_redirect_uri", extensionRedirectUri);

  const redirectUrl = await new Promise<string>((resolve, reject) => {
    identity.launchWebAuthFlow(
      {
        url: startUrl.toString(),
        interactive: true,
      },
      (responseUrl) => {
        const err = chrome.runtime?.lastError;
        if (err) {
          reject(new Error("NOTION_OAUTH_CANCELLED"));
          return;
        }
        if (!responseUrl) {
          reject(new Error("NOTION_OAUTH_NO_RESPONSE"));
          return;
        }
        resolve(responseUrl);
      }
    );
  });

  const { sessionId, error } = parseSessionTokenRedirect(redirectUrl);
  if (error) {
    throw new Error(error);
  }
  if (!sessionId) {
    throw new Error("NOTION_OAUTH_SESSION_MISSING");
  }

  const payload = await fetch(`${proxyBase}/session/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    headers: {
      "Cache-Control": "no-store",
    },
  }).then(async (response) => {
    const data = (await response.json().catch(() => null)) as
      | (NotionOAuthSessionPayload & NotionProxyErrorPayload)
      | null;

    if (!response.ok || !data?.accessToken) {
      throw new Error(
        data?.error?.code ||
          data?.error?.message ||
          `NOTION_OAUTH_${response.status}`
      );
    }

    return data;
  });

  return setNotionSettings({
    authMode: "oauth_public",
    accessToken: payload.accessToken,
    workspaceId: payload.workspaceId ?? "",
    workspaceName: payload.workspaceName ?? "",
    selectedDatabaseId: "",
    selectedDatabaseTitle: "",
  });
}

export async function listNotionDatabases(
  query = ""
): Promise<NotionDatabaseOption[]> {
  const settings = await getNotionSettings();
  if (!settings.accessToken.trim()) {
    throw new Error("NOTION_RECONNECT_REQUIRED");
  }

  const payload = await notionJsonRequest<{
    results?: Array<{
      object?: string;
      id?: string;
      url?: string;
      title?: unknown;
    }>;
  }>(
    `${NOTION_API_BASE}/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query: query.trim(),
        filter: {
          property: "object",
          value: "database",
        },
        page_size: 50,
      }),
    },
    settings.accessToken
  );

  return (payload.results ?? [])
    .filter((item) => item?.object === "database" && typeof item?.id === "string")
    .map((item) => ({
      id: item.id as string,
      title: getPlainTextTitle(item.title),
      url: typeof item.url === "string" ? item.url : undefined,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export async function selectNotionDatabase(
  database: Pick<NotionDatabaseOption, "id" | "title">
): Promise<NotionSettings> {
  return setNotionSettings({
    selectedDatabaseId: extractDatabaseId(database.id),
    selectedDatabaseTitle: database.title.trim(),
  });
}
