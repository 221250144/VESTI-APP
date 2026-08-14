// Vesti Gateway — 藏 key 的轻量流式代理
//
// 设计要点:
// - 上游 API key 只存在本服务器 (/opt/vesti-gate/.env, chmod 600),客户端只带
//   一个公开的 service token(薄滥用威慑,不是机密)。
// - SSE 流式透传:上游响应逐 chunk 即时转发,不缓冲完整响应 —— 1.6G 小服务器
//   也能扛住大量并发长连接,吞吐瓶颈只在上游生成速度,网关不成为瓶颈。
// - 无模型白名单:按 model 前缀路由供应商,model id 原样透传,新增模型零配置。
// - 用量被动计量(usage 日志)为会员积分体系打底,不侵入请求路径。

import http from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// ---- config ----------------------------------------------------------------

const envPath = new URL('./.env', import.meta.url).pathname;
const env = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
}

const LISTEN_HOST = env.LISTEN_HOST || '127.0.0.1';
const LISTEN_PORT = Number(env.LISTEN_PORT || 8787);
const CLIENT_TOKEN = env.VESTI_CLIENT_TOKEN || '';
const DEEPSEEK_KEY = env.DEEPSEEK_API_KEY || '';
const MOONSHOT_KEY = env.MOONSHOT_API_KEY || '';
const IMAGE147_KEY = env.IMAGE147_API_KEY || '';
const LOG_DIR = env.LOG_DIR || '/var/log/vesti-gate';
mkdirSync(LOG_DIR, { recursive: true });

const PROVIDERS = {
  deepseek: { base: 'https://api.deepseek.com/v1', key: DEEPSEEK_KEY },
  // kimi-for-coding 专用端点(api.moonshot.cn 通用端点不认 coding key);
  // 该端点只有一个模型,任何 kimi/moonshot 前缀的 model id 都映射过去
  moonshot: { base: 'https://api.kimi.com/coding/v1', key: MOONSHOT_KEY, forceModel: 'kimi-for-coding' },
  image147: { base: 'https://nn.147ai.com/v1', key: IMAGE147_KEY },
};

const CHAT_BODY_CAP = 4 * 1024 * 1024;      // 4 MB — chat payloads
const IMAGE_BODY_CAP = 32 * 1024 * 1024;    // 32 MB — multipart image edits
const COLLECT_BODY_CAP = 16 * 1024 * 1024;  // 16 MB — data-contribution batches
const UPSTREAM_CONNECT_TIMEOUT_MS = 20_000;
const IMAGE_UPSTREAM_TIMEOUT_MS = 150_000; // 绘图上游 30-120s 才回响应头
const COLLECT_DIR = env.COLLECT_DIR || '/var/lib/vesti-gate/collect';
mkdirSync(COLLECT_DIR, { recursive: true });

// 服务端 PII 复查(兜底;客户端已过滤一遍,这里再挡一层):
// 命中任一模式的会话整条丢弃,只收干净会话。
const PII_PATTERNS = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/,                          // 中国大陆手机号
  /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/,                     // 邮箱
  /(?<!\d)\d{17}[\dXx](?!\d)/,                         // 身份证号
  /(?<!\d)\d{16,19}(?!\d)/,                            // 银行卡号
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,                // 私钥块
  /AKIA[0-9A-Z]{16}/,                                  // AWS access key
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{16,}/,               // OpenAI 风格 API key
];
function containsPii(text) {
  if (!text) return false;
  return PII_PATTERNS.some((re) => re.test(text));
}

// 会话级复查:只扫正文文本字段(标题/摘要/消息正文/思考/工具输入输出),
// 与客户端 src/main/piiFilter.ts 的视野保持一致。不能 JSON.stringify 整个
// bundle 再扫——元数据里的 git_remote(git@github.com:... 形如邮箱)、
// project_path 等不是 PII,会误杀全部会话。
function sessionContainsPii(session) {
  if (!session || typeof session !== 'object') return true; // 畸形整条丢弃
  const conv = session.conversation;
  if (conv && typeof conv === 'object') {
    if (containsPii(conv.title) || containsPii(conv.snippet)) return true;
  }
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (containsPii(msg.content_text) || containsPii(msg._thinking)
      || containsPii(msg._tool_input) || containsPii(msg._tool_output)) return true;
  }
  return false;
}

// ---- usage metering (JSONL, best-effort) ------------------------------------

function logUsage(entry) {
  try {
    appendFileSync(`${LOG_DIR}/usage.jsonl`, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  } catch { /* metering never blocks the request path */ }
}

// ---- rate limiting (per-IP sliding window) ----------------------------------

const WINDOWS = new Map(); // key: `${ip}:${bucket}` -> number[] timestamps
function rateLimitOk(ip, bucket, limit, windowMs) {
  const now = Date.now();
  const key = `${ip}:${bucket}`;
  const arr = (WINDOWS.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) { WINDOWS.set(key, arr); return false; }
  arr.push(now);
  WINDOWS.set(key, arr);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of WINDOWS) {
    const kept = arr.filter((t) => now - t < 15 * 60_000);
    if (kept.length === 0) WINDOWS.delete(key); else WINDOWS.set(key, kept);
  }
}, 60_000).unref();

// ---- helpers -----------------------------------------------------------------

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function cors(res) {
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-vesti-service-token',
    'access-control-max-age': '86400',
  });
  res.end();
}

function routeProvider(model) {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('moonshot') || m.startsWith('kimi')) return 'moonshot';
  return 'deepseek'; // 无白名单:未知模型默认走 deepseek,model id 原样透传
}

function authorized(req) {
  if (!CLIENT_TOKEN) return true; // 未配置则不设防(部署初期)
  const header = req.headers['x-vesti-service-token'];
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
  return header === CLIENT_TOKEN || bearer === CLIENT_TOKEN;
}

// ---- upstream relay ------------------------------------------------------------

async function relay({ req, res, upstreamUrl, upstreamKey, body, route, model, ip, extraForwardHeaders = {}, connectTimeoutMs = UPSTREAM_CONNECT_TIMEOUT_MS }) {
  const requestId = randomUUID();
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(new Error('upstream_connect_timeout')), connectTimeoutMs);
  // 客户端断开后中止上游请求,不浪费上游额度
  res.on('close', () => { if (!res.writableFinished) controller.abort(new Error('client_gone')); });

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        authorization: `Bearer ${upstreamKey}`,
        'x-request-id': requestId,
        ...extraForwardHeaders,
      },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(connectTimer);
    const isTimeout = String(error?.message || '').includes('timeout');
    sendJson(res, isTimeout ? 504 : 502, {
      error: { message: isTimeout ? '上游连接超时' : '无法连接上游服务', requestId },
    }, { 'x-request-id': requestId });
    logUsage({ ip, route, model, status: isTimeout ? 504 : 502 });
    return;
  }
  clearTimeout(connectTimer);

  const headers = {
    'access-control-allow-origin': '*',
    'x-request-id': requestId,
    'x-proxy-provider-used': route.provider,
    'x-proxy-model-used': model || '',
  };
  const upstreamContentType = upstream.headers.get('content-type') || '';
  if (upstreamContentType) headers['content-type'] = upstreamContentType;
  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
    res.end();
    logUsage({ ip, route: route.name, model, provider: route.provider, status: upstream.status });
    return;
  }

  // 流式透传 + 被动 usage 扫描:chunk 即时转发,同时累积少量文本在流尾找 usage。
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let tail = '';
  let usage;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        res.write(Buffer.from(value));
        if (route.name === 'chat') {
          // 只保留流尾 64KB,usage 汇总 chunk 在流末尾
          tail += decoder.decode(value, { stream: true });
          if (tail.length > 64 * 1024) tail = tail.slice(-64 * 1024);
        }
      }
    }
    res.end();
  } catch {
    // 客户端中途断开:中止上游读取,正常收尾
    try { await reader.cancel(); } catch { /* noop */ }
    try { res.end(); } catch { /* noop */ }
  }
  if (route.name === 'chat' && tail) {
    const matches = [...tail.matchAll(/"usage"\s*:\s*(\{[^}]*\})/g)];
    if (matches.length > 0) {
      try { usage = JSON.parse(matches[matches.length - 1][1]); } catch { /* noop */ }
    }
  } else if (route.name !== 'chat') {
    // 非流式:images 不读 usage
  }
  logUsage({ ip, route: route.name, model, provider: route.provider, status: upstream.status, usage });
}

// ---- server -------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') { cors(res); return; }

  if (req.method === 'GET' && (path === '/health' || path === '/')) {
    sendJson(res, 200, {
      ok: true,
      service: 'vesti-gate',
      time: new Date().toISOString(),
      providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, Boolean(v.key)])),
    });
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { error: { message: 'unauthorized' } });
    return;
  }

  try {
    // OpenAI 兼容:对话补全(流式/非流式)
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/api/chat')) {
      if (!rateLimitOk(ip, 'chat', 600, 10 * 60_000)) {
        sendJson(res, 429, { error: { message: 'rate_limited', retryAfterSeconds: 600 } });
        return;
      }
      const raw = await readBody(req, CHAT_BODY_CAP);
      let parsed;
      try { parsed = JSON.parse(raw.toString('utf8')); } catch {
        sendJson(res, 400, { error: { message: 'invalid_json' } });
        return;
      }
      const model = typeof parsed.model === 'string' ? parsed.model : '';
      const providerName = routeProvider(model);
      const provider = PROVIDERS[providerName];
      if (!provider.key) {
        sendJson(res, 503, { error: { message: `provider ${providerName} 未配置` } });
        return;
      }
      if (path === '/api/chat') parsed.stream = false; // 旧协议固定非流式
      // 单模型端点(如 kimi-for-coding):model id 归一到端点实际模型
      if (provider.forceModel) parsed.model = provider.forceModel;
      // 让流式响应携带 usage 以便计量(上游支持时;客户端已设置则不动)
      if (parsed.stream === true && !parsed.stream_options) {
        parsed.stream_options = { include_usage: true };
      }
      await relay({
        req, res, ip,
        upstreamUrl: `${provider.base}/chat/completions`,
        upstreamKey: provider.key,
        body: JSON.stringify(parsed),
        route: { name: 'chat', provider: providerName },
        model,
      });
      return;
    }

    // 绘图接口(147ai 中转):原生图像生成/编辑,multipart 原样透传
    if (req.method === 'POST' && (path === '/v1/images/generations' || path === '/v1/images/edits')) {
      if (!rateLimitOk(ip, 'image', 60, 10 * 60_000)) {
        sendJson(res, 429, { error: { message: 'rate_limited', retryAfterSeconds: 600 } });
        return;
      }
      const provider = PROVIDERS.image147;
      if (!provider.key) {
        sendJson(res, 503, { error: { message: 'provider image147 未配置' } });
        return;
      }
      const raw = await readBody(req, IMAGE_BODY_CAP);
      const model = (() => {
        try { return JSON.parse(raw.toString('utf8')).model; } catch { return 'multipart'; }
      })();
      await relay({
        req, res, ip,
        upstreamUrl: `${provider.base}/${path.slice(4)}`, // /v1/images/* → {base}/images/*
        upstreamKey: provider.key,
        body: raw,
        route: { name: 'image', provider: 'image147' },
        model: typeof model === 'string' ? model : 'multipart',
        connectTimeoutMs: IMAGE_UPSTREAM_TIMEOUT_MS,
      });
      return;
    }

    // 数据贡献收集:agent/CLI 编码会话(RL 训练数据),用户注册会员时显式同意。
    // 客户端已排除浏览器端数据与含个人信息的会话;这里再做一道 PII 复查。
    if (req.method === 'POST' && path === '/v1/collect/sessions') {
      if (!rateLimitOk(ip, 'collect', 120, 10 * 60_000)) {
        sendJson(res, 429, { error: { message: 'rate_limited', retryAfterSeconds: 600 } });
        return;
      }
      const raw = await readBody(req, COLLECT_BODY_CAP);
      let parsed;
      try { parsed = JSON.parse(raw.toString('utf8')); } catch {
        sendJson(res, 400, { error: { message: 'invalid_json' } });
        return;
      }
      const contributorId = String(parsed?.contributorId || '');
      const sessions = parsed?.sessions;
      if (!/^[A-Za-z0-9-]{8,64}$/.test(contributorId) || !Array.isArray(sessions) || sessions.length === 0 || sessions.length > 50) {
        sendJson(res, 400, { error: { message: 'invalid_batch' } });
        return;
      }
      const clean = [];
      let filtered = 0;
      for (const session of sessions) {
        if (sessionContainsPii(session)) { filtered += 1; continue; }
        clean.push(session);
      }
      const day = new Date().toISOString().slice(0, 10);
      try {
        appendFileSync(
          `${COLLECT_DIR}/sessions-${day}.jsonl`,
          JSON.stringify({ receivedAt: Date.now(), contributorId, sessions: clean }) + '\n',
        );
      } catch {
        sendJson(res, 500, { error: { message: 'collect_store_error' } });
        return;
      }
      logUsage({ ip, route: 'collect', received: clean.length, filtered });
      sendJson(res, 200, { ok: true, received: clean.length, filtered });
      return;
    }

    // 模型清单(供客户端模型选择器)
    if (req.method === 'GET' && path === '/v1/models') {
      sendJson(res, 200, {
        object: 'list',
        data: [
          { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
          { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
          { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' },
          { id: 'kimi-for-coding', object: 'model', owned_by: 'moonshot' },
          { id: 'gpt-image-2-medium', object: 'model', owned_by: '147ai' },
          { id: 'gemini-3.1-flash-image-preview', object: 'model', owned_by: '147ai' },
        ],
      });
      return;
    }

    // 旧 embeddings 路由:聚合站接入前明确不可用(客户端会回落到旧网关)
    if (req.method === 'POST' && path === '/api/embeddings') {
      sendJson(res, 502, { error: { message: 'embeddings_unavailable_pending_aggregator' } });
      return;
    }

    sendJson(res, 404, { error: { message: 'not_found', path } });
  } catch (error) {
    if (String(error?.message) === 'body_too_large') {
      sendJson(res, 413, { error: { message: 'body_too_large' } });
      return;
    }
    sendJson(res, 500, { error: { message: 'gateway_internal_error' } });
  }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[vesti-gate] listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
});
