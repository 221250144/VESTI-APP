// Vesti 众筹「众筹码」兑换逻辑 —— 与 HTTP 无关的纯函数/可注入模块,
// server.mjs 只做接线;测试直接覆盖这里的全部分支。
//
// 机制:
// - 运营在线下收款后向支持者发放一次性「众筹码」,格式 VESTI-XXXX-XXXX-XXXX
//   (Crockford 风格大写无歧义字符:不含 I/L/O/U)。
// - 有效码清单是服务器上的配置文件(crowdfund-codes.json),{ codes: { 码: 档位 } }。
//   文件缺失/损坏 → 所有码一律 invalid_code(上线前不放真码)。
// - 档位 → 积分映射由调用方(server.mjs 的 CROWDFUND_TIERS const)注入,便于调整。
// - 兑换记录 JSONL 落盘 redeem-YYYY-MM-DD.jsonl;启动时回放为已兑换集合,
//   重复兑换返回 already_redeemed,兑换成功即作废。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';

/** Crockford 风格字母表:数字 + 大写字母,去掉易混淆的 I/L/O/U。 */
const CODE_ALPHABET = '0-9A-HJKMNP-TV-Z';
export const CROWDFUND_CODE_PATTERN = new RegExp(
  `^VESTI-[${CODE_ALPHABET}]{4}-[${CODE_ALPHABET}]{4}-[${CODE_ALPHABET}]{4}$`,
);

export const CROWDFUND_REDEEM_RATE_LIMIT = 20;          // 每 IP 每小时
export const CROWDFUND_REDEEM_RATE_WINDOW_MS = 60 * 60_000;

/**
 * 归一化用户输入的众筹码:去首尾空白、NFKC、全角/Unicode 破折号归一、
 * 去掉内部空白与连字符差异后重建标准形。非法输入返回 null。
 */
export function normalizeCrowdfundCode(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw.normalize('NFKC').trim().toUpperCase();
  if (!text) return null;
  // 各类 Unicode 破折号/连字符 → '-'
  text = text.replace(/[‐-―−]/g, '-');
  // 去掉所有空白(用户可能从聊天/邮件里复制出空格或换行)
  text = text.replace(/\s+/g, '');
  if (!text.startsWith('VESTI')) return text;
  const body = text.slice('VESTI'.length).replace(/^-/, '').replace(/-/g, '');
  if (body.length !== 12) return text; // 长度不对,交给格式校验判 invalid
  return `VESTI-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

export function isValidCrowdfundCodeFormat(code) {
  return typeof code === 'string' && CROWDFUND_CODE_PATTERN.test(code);
}

/**
 * 解析有效码配置文件内容(已 JSON.parse 的值)。返回 Map<标准码, 档位>。
 * 格式非法的码、未知档位的条目一律跳过(防御运营手误);整体不是对象则视为空。
 */
export function parseCrowdfundCodesConfig(value, tiers) {
  const codes = new Map();
  const table = value && typeof value === 'object' && !Array.isArray(value)
    ? (value.codes && typeof value.codes === 'object' && !Array.isArray(value.codes) ? value.codes : value)
    : {};
  for (const [rawCode, tier] of Object.entries(table)) {
    const code = normalizeCrowdfundCode(rawCode);
    if (!code || !isValidCrowdfundCodeFormat(code)) continue;
    if (typeof tier !== 'string' || !Object.hasOwn(tiers, tier)) continue;
    codes.set(code, tier);
  }
  return codes;
}

/**
 * 读取有效码清单。文件不存在或损坏 → 空 Map(所有码 invalid_code),
 * 这是上线前的默认状态:配置没投放时任何码都不可用。
 */
export function loadCrowdfundCodes(codesPath, tiers) {
  try {
    if (!existsSync(codesPath)) return new Map();
    return parseCrowdfundCodesConfig(JSON.parse(readFileSync(codesPath, 'utf8')), tiers);
  } catch {
    return new Map();
  }
}

/** 回放兑换记录目录,重建已兑换码集合(服务重启后重复兑换依然可识别)。 */
export function loadRedeemedCodes(redeemDir) {
  const redeemed = new Set();
  let files;
  try {
    files = readdirSync(redeemDir).filter((name) => /^redeem-.*\.jsonl$/.test(name));
  } catch {
    return redeemed; // 目录不存在 = 还没有任何兑换
  }
  for (const name of files) {
    let lines;
    try {
      lines = readFileSync(`${redeemDir}/${name}`, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (typeof record?.code === 'string' && isValidCrowdfundCodeFormat(record.code)) {
          redeemed.add(record.code);
        }
      } catch { /* 跳过坏行 */ }
    }
  }
  return redeemed;
}

/** 追加一条兑换记录到当日 JSONL;返回记录文件路径。 */
export function appendRedemptionRecord(redeemDir, record, now = Date.now()) {
  mkdirSync(redeemDir, { recursive: true });
  const day = new Date(now).toISOString().slice(0, 10);
  const file = `${redeemDir}/redeem-${day}.jsonl`;
  appendFileSync(file, JSON.stringify({ ts: now, ...record }) + '\n');
  return file;
}

/**
 * 构建兑换器。依赖全部注入:
 * - codesPath: 有效码配置文件路径(每次兑换重新读,运营投放新码无需重启)
 * - redeemDir: 兑换记录目录
 * - tiers:     档位 → { credits } 映射(server.mjs 的 CROWDFUND_TIERS)
 * - checkRateLimit(ip): 返回 false 表示超限
 */
export function createCrowdfundRedeemer({ codesPath, redeemDir, tiers, checkRateLimit, now = Date.now }) {
  const redeemed = loadRedeemedCodes(redeemDir);

  function redeem({ code: rawCode, ip }) {
    if (!checkRateLimit(ip)) {
      return {
        status: 429,
        body: { error: { message: 'rate_limited', retryAfterSeconds: Math.ceil(CROWDFUND_REDEEM_RATE_WINDOW_MS / 1000) } },
      };
    }
    const code = normalizeCrowdfundCode(rawCode);
    // 格式不对与查无此码统一按 invalid_code 处理,不向外泄露码表细节
    if (!code || !isValidCrowdfundCodeFormat(code)) {
      return { status: 400, body: { error: { message: 'invalid_code' } } };
    }
    const codes = loadCrowdfundCodes(codesPath, tiers);
    const tier = codes.get(code);
    if (!tier) {
      return { status: 400, body: { error: { message: 'invalid_code' } } };
    }
    if (redeemed.has(code)) {
      return { status: 409, body: { error: { message: 'already_redeemed' } } };
    }
    const credits = tiers[tier].credits;
    try {
      appendRedemptionRecord(redeemDir, { code, tier, credits, ip: ip || '' }, now());
    } catch {
      return { status: 500, body: { error: { message: 'redeem_store_error' } } };
    }
    redeemed.add(code); // 兑换即作废
    return { status: 200, body: { ok: true, tier, credits } };
  }

  return { redeem };
}
