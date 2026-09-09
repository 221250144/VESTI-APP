// Main-process user-facing strings (LLM test connection, BYOK validation,
// embedding status). The renderer localizes its own UI, but these messages are
// produced in the main process and cross IPC as plain text, so they are
// localized here against the UI language pref (`uiPrefs.get('language')`).
// Mirrors the renderer pattern: one complete Record per supported locale.

import type { AgentOutputLanguage } from '../shared/contracts';

export type MainLocale = 'zh' | 'en' | 'ja' | 'ko';

/**
 * Resolve the ui-prefs `language` value ({ locale, userOverridden }) or a raw
 * BCP-47 tag to a MainLocale. Unresolvable/absent values fall back to 'zh',
 * the legacy factory default (pre-i18n builds shipped Chinese copy); the
 * renderer's first-run detection rewrites the pref and the follow-up sync in
 * main.ts corrects any derived setting.
 */
export function resolveMainLocale(value: unknown): MainLocale {
  const raw = value && typeof value === 'object'
    ? (value as { locale?: unknown }).locale
    : value;
  const tag = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (tag.startsWith('zh')) return 'zh';
  if (tag.startsWith('ja')) return 'ja';
  if (tag.startsWith('ko')) return 'ko';
  if (tag.startsWith('en')) return 'en';
  return 'zh';
}

/** Agent output language matching a UI locale (default-follows-UI mapping). */
export function outputLanguageForLocale(locale: MainLocale): AgentOutputLanguage {
  switch (locale) {
    case 'en': return 'en-US';
    case 'ja': return 'ja-JP';
    case 'ko': return 'ko-KR';
    default: return 'zh-CN';
  }
}

/** Fill {placeholder}s in a string template; unknown placeholders pass through. */
export function formatMainString(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

// ---- LLM chat / test-connection path (agentService) ----

export interface MainLlmStrings {
  apiKeyMissing: string;
  /** {status} */
  requestFailedHttp: string;
  /** {id} */
  requestIdSuffix: string;
  tokenCapTruncated: string;
  emptyContent: string;
  noStreamBody: string;
  unknownNetworkReason: string;
  /** {reason} */
  networkDirect: string;
  /** {reason} {proxy} */
  networkProxied: string;
  /** {model} */
  testSuccess: string;
  testFailed: string;
  /** {reason} */
  hintFallbackReason: string;
  /** {provider} */
  hintProviderUsed: string;
}

const LLM_STRINGS: Record<MainLocale, MainLlmStrings> = {
  zh: {
    apiKeyMissing: '请先在设置中填写 API Key',
    requestFailedHttp: '模型请求失败（HTTP {status}）',
    requestIdSuffix: '（请求 ID：{id}）',
    tokenCapTruncated: '模型输出达到 Token 上限，回答被截断为空。请在设置中把「最大输出 Token」调大或设为 0（不限）',
    emptyContent: '模型没有返回可显示的内容',
    noStreamBody: '模型服务未返回流式响应体',
    unknownNetworkReason: '未知网络错误',
    networkDirect: '无法连接模型服务：{reason}。当前为直连网络，请检查防火墙、VPN 或在系统中配置可用代理。',
    networkProxied: '无法通过系统网络连接模型服务：{reason}。当前代理路径：{proxy}。请检查代理是否正在运行。',
    testSuccess: '连接成功：{model}',
    testFailed: '连接失败',
    hintFallbackReason: '主网关重试原因：{reason}',
    hintProviderUsed: '实际命中：{provider}',
  },
  en: {
    apiKeyMissing: 'Add your API key in Settings first',
    requestFailedHttp: 'The model request failed (HTTP {status})',
    requestIdSuffix: ' (Request ID: {id})',
    tokenCapTruncated: 'The model hit the output token cap and the answer was truncated to empty. Increase "Max output tokens" in Settings or set it to 0 (no limit)',
    emptyContent: 'The model returned no displayable content',
    noStreamBody: 'The model service returned no streaming response body',
    unknownNetworkReason: 'unknown network error',
    networkDirect: 'Could not reach the model service: {reason}. You are on a direct connection — check the firewall, VPN, or configure a working system proxy.',
    networkProxied: 'Could not reach the model service through the system network: {reason}. Current proxy route: {proxy}. Check that the proxy is running.',
    testSuccess: 'Connection successful: {model}',
    testFailed: 'Connection failed',
    hintFallbackReason: 'Primary gateway retry reason: {reason}',
    hintProviderUsed: 'Actually routed to: {provider}',
  },
  ja: {
    apiKeyMissing: '先に設定で API キーを入力してください',
    requestFailedHttp: 'モデルリクエストに失敗しました（HTTP {status}）',
    requestIdSuffix: '（リクエスト ID: {id}）',
    tokenCapTruncated: '出力トークン上限に達したため、回答が空に切り詰められました。設定の「最大出力トークン」を増やすか 0（制限なし）にしてください',
    emptyContent: 'モデルから表示できる内容が返されませんでした',
    noStreamBody: 'モデルサービスからストリーミング応答本文が返されませんでした',
    unknownNetworkReason: '不明なネットワークエラー',
    networkDirect: 'モデルサービスに接続できません：{reason}。現在直接接続のため、ファイアウォールや VPN を確認するか、利用可能なプロキシをシステムに設定してください。',
    networkProxied: 'システムネットワーク経由でモデルサービスに接続できません：{reason}。現在のプロキシ経路：{proxy}。プロキシが動作しているか確認してください。',
    testSuccess: '接続に成功しました：{model}',
    testFailed: '接続に失敗しました',
    hintFallbackReason: 'メインゲートウェイの再試行理由：{reason}',
    hintProviderUsed: '実際の振り分け先：{provider}',
  },
  ko: {
    apiKeyMissing: '먼저 설정에서 API 키를 입력하세요',
    requestFailedHttp: '모델 요청에 실패했습니다(HTTP {status})',
    requestIdSuffix: ' (요청 ID: {id})',
    tokenCapTruncated: '출력 토큰 상한에 도달하여 응답이 비워졌습니다. 설정에서 "최대 출력 토큰"을 늘리거나 0(제한 없음)으로 설정하세요',
    emptyContent: '모델이 표시할 수 있는 내용을 반환하지 않았습니다',
    noStreamBody: '모델 서비스가 스트리밍 응답 본문을 반환하지 않았습니다',
    unknownNetworkReason: '알 수 없는 네트워크 오류',
    networkDirect: '모델 서비스에 연결할 수 없습니다: {reason}. 현재 직접 연결 상태이므로 방화벽이나 VPN을 확인하거나 시스템에 사용 가능한 프록시를 구성하세요.',
    networkProxied: '시스템 네트워크를 통해 모델 서비스에 연결할 수 없습니다: {reason}. 현재 프록시 경로: {proxy}. 프록시가 실행 중인지 확인하세요.',
    testSuccess: '연결에 성공했습니다: {model}',
    testFailed: '연결에 실패했습니다',
    hintFallbackReason: '기본 게이트웨이 재시도 사유: {reason}',
    hintProviderUsed: '실제 라우팅: {provider}',
  },
};

export function llmStrings(locale: MainLocale): MainLlmStrings {
  return LLM_STRINGS[locale];
}

// ---- Embeddings path (embeddingService) ----

export interface MainEmbeddingStrings {
  unavailable: string;
  emptyInput: string;
  mixedModels: string;
  /** {reason} */
  networkError: string;
  /** {status} */
  requestFailedHttp: string;
  requestFailed: string;
  badResponse: string;
  mixedDimensions: string;
}

const EMBEDDING_STRINGS: Record<MainLocale, MainEmbeddingStrings> = {
  zh: {
    unavailable: 'Embedding 服务不可用',
    emptyInput: 'embedding 输入不能为空',
    mixedModels: 'embedding 批次使用了不同模型，已拒绝混合索引',
    networkError: '无法连接模型服务：{reason}',
    requestFailedHttp: 'embedding 请求失败（HTTP {status}）',
    requestFailed: 'embedding 请求失败',
    badResponse: 'embedding 响应格式异常',
    mixedDimensions: 'embedding 向量维度不一致',
  },
  en: {
    unavailable: 'The embedding service is unavailable',
    emptyInput: 'The embedding input cannot be empty',
    mixedModels: 'Embedding batches used different models; the mixed index was rejected',
    networkError: 'Could not reach the model service: {reason}',
    requestFailedHttp: 'The embedding request failed (HTTP {status})',
    requestFailed: 'The embedding request failed',
    badResponse: 'The embedding response was malformed',
    mixedDimensions: 'Embedding vector dimensions are inconsistent',
  },
  ja: {
    unavailable: '埋め込みサービスは利用できません',
    emptyInput: '埋め込み入力は空にできません',
    mixedModels: '埋め込みバッチで異なるモデルが使われたため、混合インデックスを拒否しました',
    networkError: 'モデルサービスに接続できません：{reason}',
    requestFailedHttp: '埋め込みリクエストに失敗しました（HTTP {status}）',
    requestFailed: '埋め込みリクエストに失敗しました',
    badResponse: '埋め込みレスポンスの形式が不正です',
    mixedDimensions: '埋め込みベクトルの次元が一致しません',
  },
  ko: {
    unavailable: '임베딩 서비스를 사용할 수 없습니다',
    emptyInput: '임베딩 입력은 비워 둘 수 없습니다',
    mixedModels: '임베딩 배치에서 서로 다른 모델이 사용되어 혼합 인덱스를 거부했습니다',
    networkError: '모델 서비스에 연결할 수 없습니다: {reason}',
    requestFailedHttp: '임베딩 요청에 실패했습니다(HTTP {status})',
    requestFailed: '임베딩 요청에 실패했습니다',
    badResponse: '임베딩 응답 형식이 올바르지 않습니다',
    mixedDimensions: '임베딩 벡터 차원이 일치하지 않습니다',
  },
};

export function embeddingStrings(locale: MainLocale): MainEmbeddingStrings {
  return EMBEDDING_STRINGS[locale];
}

// ---- Settings save validation (settingsService) ----

export interface MainSettingsStrings {
  byokBaseUrlRequired: string;
  modelIdRequired: string;
  modelUrlProtocol: string;
  safeStorageReadApiKey: string;
  safeStorageSaveApiKey: string;
}

const SETTINGS_STRINGS: Record<MainLocale, MainSettingsStrings> = {
  zh: {
    byokBaseUrlRequired: '使用自定义 / BYOK 时必须填写 Base URL。',
    modelIdRequired: '模型名称不能为空',
    modelUrlProtocol: '模型地址必须使用 HTTP 或 HTTPS',
    safeStorageReadApiKey: '系统安全存储当前不可用，无法读取 API Key',
    safeStorageSaveApiKey: '系统安全存储不可用，Vesti 不会以明文保存 API Key',
  },
  en: {
    byokBaseUrlRequired: 'A Base URL is required for Custom / BYOK mode.',
    modelIdRequired: 'The model name cannot be empty',
    modelUrlProtocol: 'The model endpoint must use HTTP or HTTPS',
    safeStorageReadApiKey: 'Secure storage is currently unavailable, so the API key cannot be read',
    safeStorageSaveApiKey: 'Secure storage is unavailable; Vesti will not store the API key in plain text',
  },
  ja: {
    byokBaseUrlRequired: 'カスタム / BYOK を使用するには Base URL が必要です。',
    modelIdRequired: 'モデル名は空にできません',
    modelUrlProtocol: 'モデルのアドレスは HTTP または HTTPS にしてください',
    safeStorageReadApiKey: 'OS の安全なストレージが現在利用できないため、API キーを読み取れません',
    safeStorageSaveApiKey: '安全なストレージが利用できないため、Vesti は API キーを平文で保存しません',
  },
  ko: {
    byokBaseUrlRequired: '사용자 지정 / BYOK 모드에는 Base URL이 필요합니다.',
    modelIdRequired: '모델 이름은 비워 둘 수 없습니다',
    modelUrlProtocol: '모델 주소는 HTTP 또는 HTTPS여야 합니다',
    safeStorageReadApiKey: 'OS 보안 저장소를 현재 사용할 수 없어 API 키를 읽을 수 없습니다',
    safeStorageSaveApiKey: '보안 저장소를 사용할 수 없어 Vesti는 API 키를 평문으로 저장하지 않습니다',
  },
};

export function settingsStrings(locale: MainLocale): MainSettingsStrings {
  return SETTINGS_STRINGS[locale];
}
