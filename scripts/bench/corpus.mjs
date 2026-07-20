/**
 * Bench corpus generator (Bench A input).
 *
 * Builds a synthetic session-history SQLite db that matches the capture-core
 * schema exactly (via DatabaseManager), plants K "needle" facts plus
 * knowledge-update pairs inside otherwise noisy sessions, and writes a
 * ground-truth JSON for the scorer.
 *
 * Run (from VESTI-APP root):
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/bench/corpus.mjs
 * Options: --sessions 60 --needles 12 --update-pairs 4 --seed 42
 *          --db <path> --truth <path>
 */
import path from 'node:path';
import fs from 'node:fs';
import {
  CACHE_DIR, CAPTURE_CORE_DIST, ensureDirs, makeRng, nextId,
  parseArgs, pick, randInt, shuffle, writeJson,
} from './common.mjs';

const { DatabaseManager } = await import(CAPTURE_CORE_DIST);

const args = parseArgs(process.argv, {
  sessions: 60,
  needles: 12,
  'update-pairs': 4,
  seed: 42,
  db: path.join(CACHE_DIR, 'bench-corpus.db'),
  truth: path.join(CACHE_DIR, 'bench-corpus-truth.json'),
});

const rng = makeRng(args.seed);
ensureDirs();

const PLATFORMS = ['kimi-code', 'claude-code', 'cursor', 'codex'];
const PROJECTS = [
  'C:/work/pay-service', 'C:/work/web-frontend', 'C:/work/data-pipeline', '/home/dev/api-gateway',
  '/home/dev/mobile-app', 'C:/work/infra-scripts', '/home/dev/search-service', 'C:/work/docs-site',
];
const DAY = 24 * 3600 * 1000;
const NOW = Date.now();

// ---------------------------------------------------------------------------
// Needle templates. Each generator returns { key, value, statement(user turn),
// confirm(assistant turn), query, inTitleTitle? }. Keys of single needles and
// update pairs are drawn from disjoint pools so ground truth never collides.
// ---------------------------------------------------------------------------
const NEEDLE_TEMPLATES = {
  config_value: {
    pool: [
      { file: 'settings.json', key: 'max_retries', value: '5', queryKey: 'settings.json 的 max_retries' },
      { file: 'app.toml', key: 'cache_size', value: '512mb', queryKey: 'app.toml 的 cache_size' },
      { file: 'nginx.conf', key: 'worker_processes', value: '8', queryKey: 'nginx.conf 的 worker_processes' },
      { file: 'app.toml', key: 'log_level', value: 'debug', queryKey: 'app.toml 的 log_level' },
    ],
    make(v) {
      return {
        key: `${v.file}#${v.key}`,
        value: v.value,
        statement: `顺手把 ${v.file} 里的 ${v.key} 改成了 ${v.value}，之前默认值太小，测试一直报错。`,
        confirm: `已确认，${v.file} 的 ${v.key} 现在设置为 ${v.value}，改动已保存。`,
        query: `${v.queryKey} 现在配置的是多少？`,
        title: `调整 ${v.file} 配置`,
      };
    },
  },
  file_state: {
    pool: [
      { file: 'src/auth-legacy.ts', action: '已删除', extra: '', queryKey: 'src/auth-legacy.ts' },
      { file: 'scripts/old-deploy.sh', action: '已重命名为 scripts/deploy-v2.sh', extra: '', queryKey: 'scripts/old-deploy.sh' },
      { file: 'docs/api-v1.md', action: '已归档到 docs/archive/ 目录', extra: '', queryKey: 'docs/api-v1.md' },
    ],
    make(v) {
      return {
        key: v.file,
        value: v.action,
        statement: `注意一下，${v.file} ${v.action}，后续不要再引用它。`,
        confirm: `明白，${v.file} ${v.action}，我会用新的位置。`,
        query: `${v.queryKey} 这个文件现在是什么状态？`,
        title: `清理 ${v.file}`,
      };
    },
  },
  decision: {
    pool: [
      { topic: '前端状态管理库', choice: 'Zustand', queryKey: '前端状态管理库' },
      { topic: 'CI 平台', choice: 'GitHub Actions', queryKey: 'CI 平台' },
      { topic: '日志方案', choice: 'pino', queryKey: '日志方案' },
    ],
    make(v) {
      return {
        key: v.topic,
        value: v.choice,
        statement: `讨论结论：${v.topic} 最终决定采用 ${v.choice}，团队里大多数人都同意。`,
        confirm: `好的，${v.topic} 确定为 ${v.choice}，我按这个方向继续。`,
        // CJK-tight variant: no spaces around the key — how people actually
        // write Chinese. FTS5 unicode61 keeps a CJK run as one token, so the
        // spaced query and tight statement share no token.
        tightStatement: `关于${v.topic}，团队最终决定用${v.choice}了，后续不再讨论。`,
        tightConfirm: '收到，结论已记录，按此执行。',
        query: `${v.queryKey} 最终选了什么方案？`,
        title: `${v.topic}选型讨论`,
      };
    },
  },
  owner: {
    pool: [
      { module: '数据看板', person: '王强', queryKey: '数据看板' },
      { module: '推送系统', person: '陈晨', queryKey: '推送系统' },
    ],
    make(v) {
      return {
        key: v.module,
        value: v.person,
        statement: `同步一下，${v.module} 的负责人从下周起改为 ${v.person}，相关评审都找他。`,
        confirm: `收到，${v.module} 负责人更新为 ${v.person}。`,
        tightStatement: `${v.module}的负责人下周起改为${v.person}，周会上已经同步过了。`,
        tightConfirm: '收到，知道了。',
        query: `${v.queryKey} 现在是谁负责？`,
        title: `${v.module} 交接`,
      };
    },
  },
  version: {
    pool: [
      { component: '移动端 App', version: 'v1.17.0', queryKey: '移动端 App' },
      { component: '内部 CLI 工具', version: 'v3.0.2', queryKey: '内部 CLI 工具' },
    ],
    make(v) {
      return {
        key: v.component,
        value: v.version,
        statement: `${v.component} 的 ${v.version} 已经发布上线了，changelog 我稍后补上。`,
        confirm: `了解，${v.component} 当前版本为 ${v.version}。`,
        tightStatement: `${v.component}今天发布了${v.version}，changelog 稍后补。`,
        tightConfirm: '好的，收到。',
        query: `${v.queryKey} 当前发布的版本号是多少？`,
        title: `发布 ${v.component}`,
      };
    },
  },
  deadline: {
    pool: [
      { milestone: '安全审计', date: '2026-09-01', queryKey: '安全审计' },
      { milestone: '文档整改', date: '2026-07-31', queryKey: '文档整改' },
    ],
    make(v) {
      return {
        key: v.milestone,
        value: v.date,
        statement: `${v.milestone} 的截止日期定为 ${v.date}，这个时间不能再拖了。`,
        confirm: `好的，${v.milestone} 截止日期记录为 ${v.date}。`,
        tightStatement: `${v.milestone}的截止日期定为${v.date}，不要再拖了。`,
        tightConfirm: '好的，记下了。',
        query: `${v.queryKey} 的截止日期是什么时候？`,
        title: `${v.milestone}排期`,
      };
    },
  },
  api_endpoint: {
    pool: [
      { service: '用户网关', url: 'https://api.internal.example.com/v2', queryKey: '用户网关' },
      { service: '订单服务', url: 'https://orders.gw.example.net/api', queryKey: '订单服务' },
    ],
    make(v) {
      return {
        key: v.service,
        value: v.url,
        statement: `${v.service} 的接口地址已经切换为 ${v.url}，旧地址月底下线。`,
        confirm: `确认，${v.service} 新地址为 ${v.url}。`,
        tightStatement: `${v.service}的接口地址已经切换为${v.url}，旧地址月底下线。`,
        tightConfirm: '确认，新地址已记录。',
        query: `${v.queryKey} 的接口地址是什么？`,
        title: `${v.service} 地址迁移`,
      };
    },
  },
  env_var: {
    pool: [
      { name: 'FEATURE_FLAG_SEARCH_V2', value: 'on', queryKey: 'FEATURE_FLAG_SEARCH_V2' },
      { name: 'LOG_LEVEL', value: 'verbose', queryKey: 'LOG_LEVEL' },
    ],
    make(v) {
      return {
        key: v.name,
        value: v.value,
        statement: `部署脚本里 ${v.name} 现在固定为 ${v.value}，不要在其他地方覆盖它。`,
        confirm: `明白，${v.name} 固定为 ${v.value}。`,
        query: `部署时 ${v.queryKey} 设置成了什么？`,
        title: `环境变量清理`,
      };
    },
  },
};

// Update pairs: same key stated twice in two sessions at different times.
const UPDATE_PAIR_POOL = [
  {
    type: 'config_value', key: 'config.yaml#timeout', queryKey: 'config.yaml 的 timeout',
    oldValue: '30s', newValue: '60s',
    oldStatement: '把 config.yaml 的 timeout 从默认值改成了 30s，先跑着看看。',
    newStatement: '30s 还是太短了，压测大量超时。决定把 config.yaml 的 timeout 最终定为 60s。',
    query: 'config.yaml 的 timeout 最终定为多少？',
  },
  {
    type: 'owner', key: '支付模块', queryKey: '支付模块',
    oldValue: '张伟', newValue: '李娜',
    oldStatement: '支付模块的负责人暂定为张伟，有问题先找他。',
    newStatement: '组织架构调整，支付模块的负责人正式改为李娜，张伟转到平台组。',
    query: '支付模块现在最终是谁负责？',
  },
  {
    type: 'version', key: '生产环境 API 服务', queryKey: '生产环境 API 服务',
    oldValue: 'v2.4.1', newValue: 'v2.5.0',
    oldStatement: '生产环境 API 服务刚发布了 v2.4.1。',
    newStatement: '紧急修复合入后，生产环境 API 服务版本升级到了 v2.5.0。',
    query: '生产环境 API 服务目前的版本号是多少？',
  },
  {
    type: 'deadline', key: 'M3 里程碑', queryKey: 'M3 里程碑',
    oldValue: '2026-08-15', newValue: '2026-08-29',
    oldStatement: 'M3 里程碑的截止日期定为 2026-08-15。',
    newStatement: '范围有变化，M3 里程碑的截止日期推迟到 2026-08-29，已同步全员。',
    query: 'M3 里程碑最终的截止日期是哪天？',
  },
];

// Refusal probes: attribute token exists only in a decoy with a different
// scope (or nowhere). A retrieval system with no abstention will still surface
// the decoy and look confident — that is what we measure.
const REFUSAL_PROBES = [
  {
    query: '生产环境 redis 的 maxmemory 配置成了多少？',
    attributeToken: 'maxmemory',
    decoy: '本地开发用的 redis 的 maxmemory 是 256mb，只是本地玩玩，别当真。',
  },
  {
    query: 'PostgreSQL 的 max_connections 被改成了多少？',
    attributeToken: 'max_connections',
    decoy: '本地 docker 里 postgres 的 max_connections 保持默认 100，没动过。',
  },
  {
    query: 'staging 环境的域名是什么？',
    attributeToken: 'staging.example.dev',
    decoy: '之前有人提过 staging.example.dev 这个域名，但后来确定没有 staging 环境，只有生产和本地。',
  },
  {
    query: 'kubernetes 集群里跑了几个 namespace？',
    attributeToken: 'namespace',
    decoy: null, // nothing about k8s anywhere — checks whether pure noise surfaces
  },
  {
    query: '王芳的工号是多少？',
    attributeToken: '工号',
    decoy: null,
  },
];

// ---------------------------------------------------------------------------
// Noise: plausible dev chatter + near-miss distractors. Near-misses reuse
// needle vocabulary with different keys/values to give FTS real competition.
// ---------------------------------------------------------------------------
const CHATTER_TOPICS = [
  {
    title: '调试登录页样式问题',
    user: ['登录页在移动端按钮错位了，帮我看看', '换了个思路还是不行', '先这样吧，回头再细看'],
    assistant: ['看了下是 flex 布局在窄屏下换行导致的，我给按钮容器加了 min-width。', '这次是缓存问题，硬刷新后样式正常。'],
  },
  {
    title: '优化列表接口性能',
    user: ['列表接口 800ms 太慢了', '加了索引好像没什么用', 'explain 结果发你了'],
    assistant: ['瓶颈在 N+1 查询，改成 join 预取。', '索引没命中是因为前导模糊匹配，建议走全文索引。'],
  },
  {
    title: '写单元测试',
    user: ['给订单模块补一下单测', '覆盖率到多少算够？'],
    assistant: ['先补核心路径：创建、取消、退款。', '行覆盖 80% 够用，分支覆盖重点看退款。'],
  },
  {
    title: '重构工具函数',
    user: ['utils.js 太乱了想拆一下', '拆完记得跑一遍引用检查'],
    assistant: ['按职责拆成了 date/string/number 三个文件。', '引用全部更新完毕，测试通过。'],
  },
  {
    title: '排查线上告警',
    user: ['昨晚 5xx 告警响了一次', '日志里看到一堆 connection reset'],
    assistant: ['是上游重启导致的瞬断，已加重试。', '告警阈值太敏感，我把持续时间窗口调大了。'],
  },
  {
    title: '整理项目文档',
    user: ['README 过时了，更新一下', '架构图也顺便画画'],
    assistant: ['README 已按最新目录结构重写。', '架构图用 mermaid 画好了，放在 docs/arch.md。'],
  },
];

// Near-miss distractor facts (never the needle keys/values themselves).
const NEAR_MISS = [
  { user: 'axios 请求的 timeout 我设置成 10s 了，前端请求别等太久。', assistant: '好的，axios 的 timeout 记为 10s。' },
  { user: 'jest 的 testTimeout 改成 20000ms，不然慢用例老挂。', assistant: '已把 jest 的 testTimeout 调为 20000ms。' },
  { user: '本地开发的 redis 最大内存限制是 256mb，够用了。', assistant: '本地 redis 内存限制 256mb，确认。' },
  { user: 'docker-compose 里 postgres 连接数上限保持默认 100。', assistant: 'postgres 默认连接数 100，不动。' },
  { user: 'beta 环境上周发了一版，版本号好像是 v0.9.3。', assistant: 'beta 环境当前 v0.9.3。' },
  { user: '文档站用的 Docusaurus，构建有点慢。', assistant: '可以开持久化缓存提速。' },
  { user: '这个接口的超时错误偶发，先加重试看看吧。', assistant: '已加指数退避重试，最多 3 次。' },
  { user: '网关这边老地址还在跑，月底才切。', assistant: '好的，切换窗口记下了。' },
];

const TOOL_CALLS = [
  { name: 'Read', input: 'src/index.ts', output: 'import { createApp } from "./app";\nconst app = createApp();\napp.listen(3000);' },
  { name: 'Bash', input: 'npm test', output: 'Test Suites: 12 passed, 12 total\nTests: 148 passed, 148 total' },
  { name: 'Edit', input: 'src/utils/date.ts', output: 'The file has been updated successfully.' },
  { name: 'Bash', input: 'git status', output: 'On branch main\nnothing to commit, working tree clean' },
  { name: 'Grep', input: 'pattern: "TODO"', output: 'src/app.ts:42: // TODO: handle retry\nsrc/cli.ts:7: // TODO: add flag' },
  { name: 'Read', input: 'package.json', output: '{ "name": "service", "version": "0.3.0", "private": true }' },
];

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------
function makeChatterMessages(sessionId, baseTs, pairs, withTools) {
  const messages = [];
  let ts = baseTs;
  let seq = 0;
  const push = (role, source, text, extra = {}) => {
    messages.push({
      id: nextId('msg'), sessionId, source, sequence: seq, role,
      contentText: text ?? null, timestamp: ts, createdAt: ts, ...extra,
    });
    seq += 1;
    ts += randInt(rng, 20_000, 180_000);
  };
  for (let i = 0; i < pairs.length; i += 1) {
    const [userText, assistantText] = pairs[i];
    push('user', 'user_input', userText);
    if (withTools && rng() < 0.45) {
      const tool = pick(rng, TOOL_CALLS);
      push('assistant', 'tool_request', null, {
        contentToolName: tool.name,
        contentToolInput: JSON.stringify({ input: tool.input }),
      });
      push('user', 'tool_result', null, { contentToolOutput: tool.output });
    }
    if (rng() < 0.3) {
      push('assistant', 'assistant_think', null, {
        contentThinking: pick(rng, [
          '用户的问题可能和最近的改动有关，先看看上下文。',
          '需要确认一下之前讨论过的方案再回答。',
          '这个问题不大，直接改就行。',
        ]),
      });
    }
    push('assistant', 'assistant_text', assistantText);
  }
  return { messages, endTs: ts };
}

function randomChatterPairs(count) {
  const pairs = [];
  for (let i = 0; i < count; i += 1) {
    if (rng() < 0.22) {
      const miss = pick(rng, NEAR_MISS);
      pairs.push([miss.user, miss.assistant]);
    } else {
      const topic = pick(rng, CHATTER_TOPICS);
      pairs.push([pick(rng, topic.user), pick(rng, topic.assistant)]);
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Corpus assembly
// ---------------------------------------------------------------------------
const truth = {
  params: { sessions: args.sessions, needles: args.needles, updatePairs: args['update-pairs'], seed: args.seed, generatedAt: new Date(NOW).toISOString() },
  needles: [],
  updatePairs: [],
  multiKeyQueries: [],
  refusalQueries: REFUSAL_PROBES.map(p => ({ query: p.query, attributeToken: p.attributeToken })),
  sessions: [],
};

// 1) Build the needle payloads.
const templateNames = Object.keys(NEEDLE_TEMPLATES);
const needlePayloads = [];
{
  const order = shuffle(rng, templateNames);
  let tightEligible = 0;
  for (let i = 0; i < args.needles; i += 1) {
    const templateName = order[i % order.length];
    const template = NEEDLE_TEMPLATES[templateName];
    const variant = template.pool[Math.floor(i / order.length) % template.pool.length];
    const built = template.make(variant);
    // Half of the tight-capable needles (CJK keys) use the unspaced form —
    // how people actually write Chinese. FTS5 unicode61 keeps a CJK run as
    // one token, so the spaced query and tight statement share no token.
    let useTight = false;
    if (built.tightStatement) {
      useTight = tightEligible % 2 === 0;
      tightEligible += 1;
    }
    needlePayloads.push({
      type: templateName,
      ...built,
      statement: useTight ? built.tightStatement : built.statement,
      confirm: useTight ? built.tightConfirm : built.confirm,
      tight: useTight,
    });
  }
}

// 2) Build update pairs (both halves).
const pairPayloads = UPDATE_PAIR_POOL.slice(0, args['update-pairs']);

// 3) Session plan: needle sessions, pair sessions (2 each), decoy sessions,
//    rest pure noise.
const sessionPlans = [];
needlePayloads.forEach((payload, i) => {
  sessionPlans.push({ kind: 'needle', payload, idx: i });
});
pairPayloads.forEach((pair, i) => {
  sessionPlans.push({ kind: 'pair_old', pair, idx: i });
  sessionPlans.push({ kind: 'pair_new', pair, idx: i });
});
REFUSAL_PROBES.filter(p => p.decoy).forEach(probe => {
  sessionPlans.push({ kind: 'decoy', probe });
});
while (sessionPlans.length < args.sessions) {
  sessionPlans.push({ kind: 'noise' });
}

// Shuffle plan order but keep deterministic platform/project assignment.
const plans = shuffle(rng, sessionPlans).slice(0, args.sessions);

// 4) Materialize sessions.
const dm = new DatabaseManager(args.db);
for (const ext of ['', '-wal', '-shm']) {
  try { fs.rmSync(args.db + ext); } catch { /* fresh db */ }
}
await dm.initialize();

plans.forEach((plan, sessionIdx) => {
  const platform = PLATFORMS[sessionIdx % PLATFORMS.length];
  const project = pick(rng, PROJECTS);
  const sessionId = nextId('bench-sess');
  let startedAt;
  if (plan.kind === 'pair_old') {
    startedAt = NOW - randInt(rng, 30, 45) * DAY; // old half clearly earlier
  } else if (plan.kind === 'pair_new') {
    startedAt = NOW - randInt(rng, 2, 8) * DAY; // new half recent
  } else {
    startedAt = NOW - randInt(rng, 1, 60) * DAY;
  }

  const isNeedleish = plan.kind === 'needle' || plan.kind === 'pair_old' || plan.kind === 'pair_new';
  const msgCount = isNeedleish ? randInt(rng, 16, 34) : randInt(rng, 8, 24);
  const pairs = randomChatterPairs(Math.max(2, Math.floor(msgCount / 2)));

  // Insert needle statement at a random middle position.
  let needleInsertAt = -1;
  if (plan.kind === 'needle') {
    needleInsertAt = randInt(rng, Math.floor(pairs.length * 0.25), Math.floor(pairs.length * 0.75));
    pairs.splice(needleInsertAt, 0, [plan.payload.statement, plan.payload.confirm]);
  } else if (plan.kind === 'pair_old') {
    needleInsertAt = randInt(rng, 1, Math.max(1, pairs.length - 2));
    pairs.splice(needleInsertAt, 0, [plan.pair.oldStatement, `好的，已记录：${plan.pair.queryKey} 为 ${plan.pair.oldValue}。`]);
  } else if (plan.kind === 'pair_new') {
    needleInsertAt = randInt(rng, 1, Math.max(1, pairs.length - 2));
    pairs.splice(needleInsertAt, 0, [plan.pair.newStatement, `确认，${plan.pair.queryKey} 最终为 ${plan.pair.newValue}。`]);
  } else if (plan.kind === 'decoy') {
    pairs.splice(randInt(rng, 1, Math.max(1, pairs.length - 2)), 0, [plan.probe.decoy, '了解，这个只作为参考。']);
  }

  const { messages, endTs } = makeChatterMessages(sessionId, startedAt, pairs, true);

  // Title: 25% of single needles leak into the title (realistic main-topic
  // sessions); everything else gets a topic-like title.
  let title;
  if (plan.kind === 'needle' && rng() < 0.25) {
    title = plan.payload.title;
  } else {
    title = pick(rng, CHATTER_TOPICS).title;
  }

  dm.upsertWorkSession({
    id: sessionId, sessionId, platform, projectPath: project,
    gitBranch: 'main', model: 'bench-model', title,
    status: 'completed',
    startedAt, endedAt: endTs, lastActivityAt: endTs, durationMs: endTs - startedAt,
    messageCount: messages.length, userInputCount: messages.filter(m => m.role === 'user').length,
    assistantMessageCount: messages.filter(m => m.role === 'assistant').length,
    toolCallCount: messages.filter(m => m.source === 'tool_request').length,
    turnCount: pairs.length,
    sessionType: 'conversation', createdAt: startedAt, updatedAt: endTs,
  });
  dm.insertSessionMessages(messages);

  // Synthetic digest mirroring the real pipeline's degraded shape
  // (embedding skipped). 40% of needle sessions get the needle in decisions.
  const digestDecisions = [];
  if (plan.kind === 'needle' && rng() < 0.4) digestDecisions.push(plan.payload.statement);
  if (plan.kind === 'pair_new' && rng() < 0.4) digestDecisions.push(plan.pair.newStatement);
  if (plan.kind === 'pair_old' && rng() < 0.4) digestDecisions.push(plan.pair.oldStatement);
  dm.upsertSessionDigest({
    sessionId, host: 'native', platform,
    projectKey: `${platform}:native:${project}`,
    oneLiner: `${title}（bench 合成摘要）`,
    keyTopics: [title], keyFiles: [], decisions: digestDecisions, openQuestions: [],
    embeddingStatus: 'skipped', digestVersion: 1,
    messageCount: messages.length, updatedAt: new Date(endTs).toISOString(),
  });

  truth.sessions.push({ sessionId, platform, project, kind: plan.kind, title, messageCount: messages.length, startedAt });

  // Ground truth records.
  if (plan.kind === 'needle') {
    truth.needles.push({
      id: `needle-${plan.idx}`, type: plan.payload.type, key: plan.payload.key, value: plan.payload.value,
      sessionId, platform, project, query: plan.payload.query, tight: plan.payload.tight ?? false,
      statement: plan.payload.statement,
    });
  } else if (plan.kind === 'pair_old') {
    const rec = truth.updatePairs[plan.idx] ?? { id: `pair-${plan.idx}`, type: plan.pair.type, key: plan.pair.key, query: plan.pair.query };
    rec.oldValue = plan.pair.oldValue; rec.oldSessionId = sessionId; rec.oldStartedAt = startedAt;
    truth.updatePairs[plan.idx] = rec;
  } else if (plan.kind === 'pair_new') {
    const rec = truth.updatePairs[plan.idx] ?? { id: `pair-${plan.idx}`, type: plan.pair.type, key: plan.pair.key, query: plan.pair.query };
    rec.newValue = plan.pair.newValue; rec.newSessionId = sessionId; rec.newStartedAt = startedAt;
    rec.platform = platform; rec.project = project;
    truth.updatePairs[plan.idx] = rec;
  }
});

// 5) Multi-key queries: combine pairs of single needles from different sessions.
{
  const usable = shuffle(rng, truth.needles);
  const keyText = key => key.replace('#', ' 的 ');
  for (let i = 0; i + 1 < usable.length && truth.multiKeyQueries.length < 4; i += 2) {
    const [a, b] = [usable[i], usable[i + 1]];
    truth.multiKeyQueries.push({
      id: `multi-${truth.multiKeyQueries.length}`,
      query: `${keyText(a.key)} 和 ${keyText(b.key)} 分别是什么？`,
      keys: [a.key, b.key],
      sessionIds: [a.sessionId, b.sessionId],
    });
  }
}

writeJson(args.truth, truth);
console.log(`[corpus] db: ${args.db}`);
console.log(`[corpus] truth: ${args.truth}`);
console.log(`[corpus] sessions=${truth.sessions.length} needles=${truth.needles.length} pairs=${truth.updatePairs.length} multi=${truth.multiKeyQueries.length} refusal=${truth.refusalQueries.length}`);
