// Vesti Gateway — 藏 key 的轻量流式代理
//
// 设计要点:
// - 上游 API key 只存在本服务器 (/opt/vesti-gate/.env, chmod 600),客户端只带
//   一个公开的 service token(薄滥用威慑,不是机密)。
// - 每个供应商一个 key 池:请求按轮询顺序起步,遇到连接失败/超时/401/403/408/429/5xx
//   自动 failover 到池内下一条 —— 单 key 失效或单上游抖动不再造成服务中断。
// - SSE 流式透传:上游响应逐 chunk 即时转发,不缓冲完整响应 —— 1.6G 小服务器
//   也能扛住大量并发长连接,吞吐瓶颈只在上游生成速度,网关不成为瓶颈。
// - 无模型白名单:按 model 前缀路由供应商,model id 原样透传;池内条目可声明
//   modelMap(如阿里百炼只认 deepseek-v4-flash-0731)做归一。
// - 用量被动计量(usage 日志)为会员积分体系打底,不侵入请求路径。

import http from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CROWDFUND_REDEEM_RATE_LIMIT,
  CROWDFUND_REDEEM_RATE_WINDOW_MS,
  createCrowdfundRedeemer,
} from './crowdfund.mjs';
import { renderCrowdfundPage } from './crowdfund-page.mjs';

// ---- config ----------------------------------------------------------------

const envPath = fileURLToPath(new URL('./.env', import.meta.url));
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
const LOG_DIR = env.LOG_DIR || '/var/log/vesti-gate';
mkdirSync(LOG_DIR, { recursive: true });

// 逗号分隔的 key 列表;单列变量(旧版)自动并入,方便直接往 .env 追加新 key。
function keyList(...vars) {
  return vars.flatMap((v) => String(v || '').split(',')).map((k) => k.trim()).filter(Boolean);
}

const DEEPSEEK_KEYS = keyList(env.DEEPSEEK_API_KEYS, env.DEEPSEEK_API_KEY);
const MOONSHOT_KEYS = keyList(env.MOONSHOT_API_KEYS, env.MOONSHOT_API_KEY);
const IMAGE147_KEYS = keyList(env.IMAGE147_API_KEYS, env.IMAGE147_API_KEY);
const ALI_CHAT_KEYS = keyList(env.ALI_BAILIAN_CHAT_KEYS, env.ALI_BAILIAN_CHAT_KEY);
const ALI_EMBED_KEYS = keyList(env.ALI_BAILIAN_EMBED_KEYS, env.ALI_BAILIAN_EMBED_KEY);

const EMBEDDING_MODEL = (env.VESTI_EMBEDDING_MODEL || 'text-embedding-v4').trim();

// 阿里百炼 token-plan 端点的模型命名与官方 deepseek 不同,做显式归一;
// 未列出的 model id 原样透传(端点上有的模型,如 deepseek-v4-pro,直接用)。
const ALI_CHAT_MODEL_MAP = {
  'deepseek-v4-flash': 'deepseek-v4-flash-0731',
  'deepseek-chat': 'deepseek-v4-flash-0731',
  'deepseek-reasoner': 'deepseek-v4-pro',
};

// provider -> 上游条目池。name 用于日志/响应头;modelMap/forceModel 在转发前改写 model。
const PROVIDERS = {
  deepseek: {
    pool: [
      ...DEEPSEEK_KEYS.map((key, i) => ({ name: `deepseek#${i + 1}`, base: 'https://api.deepseek.com/v1', key })),
      ...ALI_CHAT_KEYS.map((key, i) => ({
        name: `ali-bailian#${i + 1}`,
        base: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        key,
        modelMap: ALI_CHAT_MODEL_MAP,
      })),
    ],
  },
  // kimi-for-coding 专用端点(api.moonshot.cn 通用端点不认 coding key);
  // 该端点只有一个模型,任何 kimi/moonshot 前缀的 model id 都映射过去
  moonshot: {
    pool: MOONSHOT_KEYS.map((key, i) => ({
      name: `moonshot#${i + 1}`,
      base: 'https://api.kimi.com/coding/v1',
      key,
      forceModel: 'kimi-for-coding',
    })),
  },
  image147: {
    pool: IMAGE147_KEYS.map((key, i) => ({ name: `image147#${i + 1}`, base: 'https://nn.147ai.com/v1', key })),
  },
  embedding: {
    pool: ALI_EMBED_KEYS.map((key, i) => ({
      name: `ali-dashscope#${i + 1}`,
      base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      key,
      forceModel: EMBEDDING_MODEL,
    })),
  },
};

const CHAT_BODY_CAP = 4 * 1024 * 1024;      // 4 MB — chat payloads
const IMAGE_BODY_CAP = 32 * 1024 * 1024;    // 32 MB — multipart image edits
const EMBED_BODY_CAP = 4 * 1024 * 1024;     // 4 MB — embedding batches
const COLLECT_BODY_CAP = 16 * 1024 * 1024;  // 16 MB — data-contribution batches
const UPSTREAM_CONNECT_TIMEOUT_MS = 20_000;
const IMAGE_UPSTREAM_TIMEOUT_MS = 150_000; // 绘图上游 30-120s 才回响应头
const COLLECT_DIR = env.COLLECT_DIR || '/var/lib/vesti-gate/collect';
mkdirSync(COLLECT_DIR, { recursive: true });

// 这些状态码说明"这条 key/上游当前不可用",值得 failover 到池内下一条;
// 其余 4xx(如 400 参数错误)是请求本身的问题,原样转发给客户端。
const FAILOVER_STATUSES = new Set([401, 402, 403, 408, 429, 500, 502, 503, 504]);

// ---- 众筹「众筹码」配置 ------------------------------------------------------
// 档位 → 积分映射(改这里即可调档;公开页与兑换响应都从这里取数)。
const CROWDFUND_TIERS = {
  warm: { credits: 6_000 },      // 暖心档 ¥19
  fellow: { credits: 20_000 },   // 同行档 ¥59
  cocreate: { credits: 55_000 }, // 共创档 ¥129
};
// 有效码清单:上线前由运营投放,{ codes: { "VESTI-XXXX-XXXX-XXXX": "warm" } }。
// 文件不存在时所有码一律 invalid_code(见 crowdfund.mjs)。
const CROWDFUND_CODES_PATH = env.CROWDFUND_CODES_PATH || '/opt/vesti-gate/crowdfund-codes.json';
const CROWDFUND_DIR = env.CROWDFUND_DIR || '/var/lib/vesti-gate/crowdfund';
mkdirSync(CROWDFUND_DIR, { recursive: true });

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

// 众筹兑换器:每 IP 每小时 ≤20 次防爆破;码表每次兑换重读,投放新码无需重启。
const crowdfundRedeemer = createCrowdfundRedeemer({
  codesPath: CROWDFUND_CODES_PATH,
  redeemDir: CROWDFUND_DIR,
  tiers: CROWDFUND_TIERS,
  checkRateLimit: (ip) => rateLimitOk(ip, 'crowdfund', CROWDFUND_REDEEM_RATE_LIMIT, CROWDFUND_REDEEM_RATE_WINDOW_MS),
});

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

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=300',
  });
  res.end(html);
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
  return 'deepseek'; // 无白名单:未知模型默认走 deepseek 池,model id 原样透传
}

function authorized(req) {
  if (!CLIENT_TOKEN) return true; // 未配置则不设防(部署初期)
  const header = req.headers['x-vesti-service-token'];
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
  return header === CLIENT_TOKEN || bearer === CLIENT_TOKEN;
}

// ---- upstream relay ------------------------------------------------------------

// 池轮询游标:provider -> 下一个起始下标。请求从游标位置起步,依次尝试池内条目。
const RR_CURSORS = new Map();
function poolOrder(providerName) {
  const pool = (PROVIDERS[providerName]?.pool || []).filter((e) => e.key);
  if (pool.length === 0) return [];
  const start = (RR_CURSORS.get(providerName) || 0) % pool.length;
  RR_CURSORS.set(providerName, start + 1);
  return [...pool.slice(start), ...pool.slice(0, start)];
}

// 单条上游尝试。成功建立响应(无论状态码)返回 { upstream, entry };
// 连接级失败返回 { error }。调用方负责决定 failover 还是转发。
async function tryUpstream({ req, res, entry, upstreamUrl, body, connectTimeoutMs }) {
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(new Error('upstream_connect_timeout')), connectTimeoutMs);
  // 客户端断开后中止上游请求,不浪费上游额度
  res.on('close', () => { if (!res.writableFinished) controller.abort(new Error('client_gone')); });
  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        authorization: `Bearer ${entry.key}`,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(connectTimer);
    return { upstream, entry };
  } catch (error) {
    clearTimeout(connectTimer);
    return { error, entry };
  }
}

// 池化转发:按轮询顺序尝试,连接失败/超时或可 failover 的状态码自动跳下一条。
// 一旦决定转发即流式透传,之后的流中断不再 failover(客户端自行重试)。
async function relayPool({ req, res, providerName, pathSuffix, parsedBody, rawBody, routeName, model, ip, connectTimeoutMs = UPSTREAM_CONNECT_TIMEOUT_MS }) {
  const entries = poolOrder(providerName);
  if (entries.length === 0) {
    sendJson(res, 503, { error: { message: `provider ${providerName} 未配置` } });
    return;
  }

  const attempts = [];
  let chosen = null;
  for (const entry of entries) {
    // JSON 请求可按条目的模型命名(modelMap/forceModel)改写;rawBody(multipart 等)原样透传
    let body = rawBody;
    if (parsedBody && typeof parsedBody === 'object') {
      const mapped = { ...parsedBody };
      if (entry.forceModel) mapped.model = entry.forceModel;
      else if (entry.modelMap && typeof mapped.model === 'string') {
        mapped.model = entry.modelMap[mapped.model] || mapped.model;
      }
      body = JSON.stringify(mapped);
    }
    const result = await tryUpstream({
      req, res, entry, body,
      upstreamUrl: `${entry.base}/${pathSuffix}`,
      connectTimeoutMs,
    });
    if (result.error) {
      const isTimeout = String(result.error?.message || '').includes('timeout');
      attempts.push({ entry: entry.name, error: isTimeout ? 'connect_timeout' : 'connect_error' });
      logUsage({ ip, route: routeName, model, provider: entry.name, status: isTimeout ? 504 : 502, failover: true });
      continue;
    }
    if (FAILOVER_STATUSES.has(result.upstream.status)) {
      // 消耗掉错误响应体,然后试下一条
      try { await result.upstream.arrayBuffer(); } catch { /* noop */ }
      attempts.push({ entry: entry.name, status: result.upstream.status });
      logUsage({ ip, route: routeName, model, provider: entry.name, status: result.upstream.status, failover: true });
      continue;
    }
    chosen = result;
    break;
  }

  const requestId = randomUUID();
  if (!chosen) {
    sendJson(res, 502, {
      error: { message: '所有上游均不可用', attempts, requestId },
    }, { 'x-request-id': requestId });
    return;
  }

  const { upstream, entry } = chosen;
  const headers = {
    'access-control-allow-origin': '*',
    'x-request-id': requestId,
    'x-proxy-provider-used': entry.name,
    'x-proxy-model-used': entry.forceModel || (entry.modelMap?.[model] ?? model) || '',
  };
  if (attempts.length > 0) {
    headers['x-proxy-fallback-reason'] = attempts.map((a) => `${a.entry}:${a.status || a.error}`).join(',');
  }
  const upstreamContentType = upstream.headers.get('content-type') || '';
  if (upstreamContentType) headers['content-type'] = upstreamContentType;
  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
    res.end();
    logUsage({ ip, route: routeName, model, provider: entry.name, status: upstream.status });
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
        if (routeName === 'chat') {
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
  if (routeName === 'chat' && tail) {
    const matches = [...tail.matchAll(/"usage"\s*:\s*(\{[^}]*\})/g)];
    if (matches.length > 0) {
      try { usage = JSON.parse(matches[matches.length - 1][1]); } catch { /* noop */ }
    }
  }
  logUsage({ ip, route: routeName, model, provider: entry.name, status: upstream.status, usage });
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
      providers: Object.fromEntries(
        Object.entries(PROVIDERS).map(([k, v]) => [k, {
          keys: v.pool.filter((e) => e.key).length,
          endpoints: v.pool.filter((e) => e.key).map((e) => e.name.replace(/#.*/, '')),
        }]),
      ),
    });
    return;
  }

  // 众筹公开页:无需鉴权的自包含静态页(支持者们从任意浏览器打开)。
  if (req.method === 'GET' && path === '/crowdfund') {
    sendHtml(res, 200, renderCrowdfundPage(CROWDFUND_TIERS));
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
      if (path === '/api/chat') parsed.stream = false; // 旧协议固定非流式
      // 让流式响应携带 usage 以便计量(上游支持时;客户端已设置则不动)
      if (parsed.stream === true && !parsed.stream_options) {
        parsed.stream_options = { include_usage: true };
      }
      await relayPool({
        req, res, ip,
        providerName,
        pathSuffix: 'chat/completions',
        parsedBody: parsed,
        routeName: 'chat',
        model,
      });
      return;
    }

    // 向量嵌入:客户端(插件/App demo 模式)不指定 model,网关统一选型,
    // 通过 x-proxy-model-used 响应头告知实际模型,客户端按 (provider,model,dims)
    // 记索引版本。当前默认 text-embedding-v4(阿里百炼 DashScope)。
    if (req.method === 'POST' && (path === '/api/embeddings' || path === '/v1/embeddings')) {
      if (!rateLimitOk(ip, 'embed', 240, 10 * 60_000)) {
        sendJson(res, 429, { error: { message: 'rate_limited', retryAfterSeconds: 600 } });
        return;
      }
      const raw = await readBody(req, EMBED_BODY_CAP);
      let parsed;
      try { parsed = JSON.parse(raw.toString('utf8')); } catch {
        sendJson(res, 400, { error: { message: 'invalid_json' } });
        return;
      }
      if (!parsed || parsed.input === undefined) {
        sendJson(res, 400, { error: { message: 'missing_input' } });
        return;
      }
      // 服务端选型权威:忽略客户端 model 字段,统一走池内 forceModel
      delete parsed.model;
      await relayPool({
        req, res, ip,
        providerName: 'embedding',
        pathSuffix: 'embeddings',
        parsedBody: parsed,
        routeName: 'embed',
        model: EMBEDDING_MODEL,
      });
      return;
    }

    // 绘图接口(147ai 中转):原生图像生成/编辑,multipart 原样透传
    if (req.method === 'POST' && (path === '/v1/images/generations' || path === '/v1/images/edits')) {
      if (!rateLimitOk(ip, 'image', 60, 10 * 60_000)) {
        sendJson(res, 429, { error: { message: 'rate_limited', retryAfterSeconds: 600 } });
        return;
      }
      const raw = await readBody(req, IMAGE_BODY_CAP);
      const model = (() => {
        try { return JSON.parse(raw.toString('utf8')).model; } catch { return 'multipart'; }
      })();
      await relayPool({
        req, res, ip,
        providerName: 'image147',
        pathSuffix: path.slice(4), // /v1/images/* → images/*
        rawBody: raw,
        routeName: 'image',
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

    // 众筹「众筹码」兑换:用户付款后凭运营发放的一次性码换积分。
    // 码表在 CROWDFUND_CODES_PATH(缺失即全部 invalid_code),兑换记录 JSONL
    // 落盘 CROWDFUND_DIR;限流与作废逻辑在 crowdfund.mjs 的兑换器里。
    if (req.method === 'POST' && path === '/v1/crowdfund/redeem') {
      const raw = await readBody(req, 16 * 1024);
      let parsed;
      try { parsed = JSON.parse(raw.toString('utf8')); } catch {
        sendJson(res, 400, { error: { message: 'invalid_json' } });
        return;
      }
      const { status, body } = crowdfundRedeemer.redeem({ code: parsed?.code, ip });
      if (status === 200) logUsage({ ip, route: 'crowdfund-redeem', tier: body.tier, credits: body.credits });
      sendJson(res, status, body);
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
