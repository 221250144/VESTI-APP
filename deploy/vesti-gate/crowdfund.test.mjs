// 众筹「众筹码」兑换逻辑的 vitest 覆盖(根仓 vitest run 统一跑,node 环境)。
// server.mjs 只做 HTTP 接线,全部分支在这里通过注入依赖验证。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCrowdfundRedeemer,
  isValidCrowdfundCodeFormat,
  loadCrowdfundCodes,
  loadRedeemedCodes,
  normalizeCrowdfundCode,
  parseCrowdfundCodesConfig,
} from './crowdfund.mjs';
import { renderCrowdfundPage } from './crowdfund-page.mjs';

const TIERS = {
  warm: { credits: 6_000 },
  fellow: { credits: 20_000 },
  cocreate: { credits: 55_000 },
};

const VALID_CODE = 'VESTI-7K2M-9QXD-4TBN';
const FELLOW_CODE = 'VESTI-H8WZ-3R6P-GC2Y';

let workDir;
let codesPath;
let redeemDir;

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'vesti-crowdfund-'));
  codesPath = path.join(workDir, 'crowdfund-codes.json');
  redeemDir = path.join(workDir, 'redeem');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeCodes(table) {
  writeFileSync(codesPath, JSON.stringify({ codes: table }), 'utf8');
}

function makeRedeemer({ limit = 20 } = {}) {
  // 每 IP 每小时 ≤limit 次的滑窗,与 server.mjs 的 rateLimitOk 同语义。
  const hits = new Map();
  return createCrowdfundRedeemer({
    codesPath,
    redeemDir,
    tiers: TIERS,
    checkRateLimit: (ip) => {
      const count = hits.get(ip) || 0;
      if (count >= limit) return false;
      hits.set(ip, count + 1);
      return true;
    },
  });
}

describe('normalizeCrowdfundCode', () => {
  it('normalizes case, whitespace and unicode dashes', () => {
    expect(normalizeCrowdfundCode('  vesti-7k2m-9qxd-4tbn ')).toBe(VALID_CODE);
    expect(normalizeCrowdfundCode('VESTI-7K2M—9QXD–4TBN')).toBe(VALID_CODE);
    expect(normalizeCrowdfundCode('VESTI 7K2M 9QXD 4TBN')).toBe(VALID_CODE);
    expect(normalizeCrowdfundCode('VESTI7K2M9QXD4TBN')).toBe(VALID_CODE);
  });

  it('rejects non-strings and empty input', () => {
    expect(normalizeCrowdfundCode(undefined)).toBeNull();
    expect(normalizeCrowdfundCode(42)).toBeNull();
    expect(normalizeCrowdfundCode('   ')).toBeNull();
  });
});

describe('isValidCrowdfundCodeFormat', () => {
  it('accepts the VESTI-XXXX-XXXX-XXXX Crockford shape', () => {
    expect(isValidCrowdfundCodeFormat(VALID_CODE)).toBe(true);
  });

  it('rejects ambiguous letters (I/L/O/U) and malformed codes', () => {
    expect(isValidCrowdfundCodeFormat('VESTI-7K2M-9QXD-4TBI')).toBe(false); // I
    expect(isValidCrowdfundCodeFormat('VESTI-7K2M-9QXD-4TBL')).toBe(false); // L
    expect(isValidCrowdfundCodeFormat('VESTI-7K2M-9QXD-4TBO')).toBe(false); // O
    expect(isValidCrowdfundCodeFormat('VESTI-7K2M-9QXD-4TBU')).toBe(false); // U
    expect(isValidCrowdfundCodeFormat('VESTI-7K2M-9QXD')).toBe(false);
    expect(isValidCrowdfundCodeFormat('HELLO-7K2M-9QXD-4TBN')).toBe(false);
  });
});

describe('parseCrowdfundCodesConfig', () => {
  it('keeps only well-formed codes mapped to known tiers', () => {
    const codes = parseCrowdfundCodesConfig({
      codes: {
        [VALID_CODE]: 'warm',
        'vesti-h8wz-3r6p-gc2y': 'fellow', // 归一化后保留
        'VESTI-BAD!-9QXD-4TBN': 'warm',   // 格式非法 → 跳过
        'VESTI-AAAA-BBBB-CCCC': 'nope',   // 未知档位 → 跳过
      },
    }, TIERS);
    expect(codes.get(VALID_CODE)).toBe('warm');
    expect(codes.get(FELLOW_CODE)).toBe('fellow');
    expect(codes.size).toBe(2);
  });

  it('treats a non-object config as empty', () => {
    expect(parseCrowdfundCodesConfig(null, TIERS).size).toBe(0);
    expect(parseCrowdfundCodesConfig('junk', TIERS).size).toBe(0);
  });
});

describe('loadCrowdfundCodes', () => {
  it('returns an empty table when the config file is missing (pre-launch state)', () => {
    expect(loadCrowdfundCodes(codesPath, TIERS).size).toBe(0);
  });

  it('returns an empty table when the config file is corrupt', () => {
    writeFileSync(codesPath, '{ not json', 'utf8');
    expect(loadCrowdfundCodes(codesPath, TIERS).size).toBe(0);
  });
});

describe('createCrowdfundRedeemer', () => {
  it('redeems a valid code and pays out the tier credits', () => {
    writeCodes({ [VALID_CODE]: 'warm' });
    const redeemer = makeRedeemer();

    const result = redeemer.redeem({ code: 'vesti-7k2m-9qxd-4tbn', ip: '1.2.3.4' });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, tier: 'warm', credits: 6_000 });
    // 兑换记录落盘,含码/档位/积分/IP
    const recordFile = path.join(redeemDir, `redeem-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const record = JSON.parse(readFileSync(recordFile, 'utf8').trim());
    expect(record).toMatchObject({ code: VALID_CODE, tier: 'warm', credits: 6_000, ip: '1.2.3.4' });
  });

  it('rejects unknown codes with invalid_code', () => {
    writeCodes({ [VALID_CODE]: 'warm' });
    const redeemer = makeRedeemer();

    const result = redeemer.redeem({ code: FELLOW_CODE, ip: '1.2.3.4' });

    expect(result.status).toBe(400);
    expect(result.body.error.message).toBe('invalid_code');
  });

  it('rejects malformed codes with invalid_code without leaking details', () => {
    writeCodes({ [VALID_CODE]: 'warm' });
    const redeemer = makeRedeemer();

    for (const code of ['not-a-code', 'VESTI-OOOO-OOOO-OOOO', '', undefined]) {
      const result = redeemer.redeem({ code, ip: '1.2.3.4' });
      expect(result.status).toBe(400);
      expect(result.body.error.message).toBe('invalid_code');
    }
  });

  it('treats every code as invalid when the config file is missing', () => {
    const redeemer = makeRedeemer(); // codesPath 不存在
    const result = redeemer.redeem({ code: VALID_CODE, ip: '1.2.3.4' });
    expect(result.status).toBe(400);
    expect(result.body.error.message).toBe('invalid_code');
  });

  it('voids a code after redemption (already_redeemed), even across restarts', () => {
    writeCodes({ [VALID_CODE]: 'warm' });
    const first = makeRedeemer();
    expect(first.redeem({ code: VALID_CODE, ip: '1.2.3.4' }).status).toBe(200);

    // 同一进程内重复兑换
    const again = first.redeem({ code: VALID_CODE, ip: '5.6.7.8' });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe('already_redeemed');

    // 模拟重启:新兑换器从 JSONL 记录回放已兑换集合
    const restarted = makeRedeemer();
    const afterRestart = restarted.redeem({ code: VALID_CODE, ip: '5.6.7.8' });
    expect(afterRestart.status).toBe(409);
    expect(afterRestart.body.error.message).toBe('already_redeemed');

    // 同文件里的另一枚码不受影响
    writeCodes({ [VALID_CODE]: 'warm', [FELLOW_CODE]: 'fellow' });
    expect(restarted.redeem({ code: FELLOW_CODE, ip: '5.6.7.8' })).toMatchObject({
      status: 200,
      body: { ok: true, tier: 'fellow', credits: 20_000 },
    });
  });

  it('rate limits brute-force attempts (429 after the budget)', () => {
    writeCodes({ [VALID_CODE]: 'warm' });
    const redeemer = makeRedeemer({ limit: 20 });

    for (let i = 0; i < 20; i += 1) {
      const result = redeemer.redeem({ code: `VESTI-XXXX-XXXX-${String(i).padStart(4, '0')}`, ip: '9.9.9.9' });
      expect(result.status).toBe(400); // 预算内:照常判 invalid
    }
    const limited = redeemer.redeem({ code: VALID_CODE, ip: '9.9.9.9' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.message).toBe('rate_limited');
    // 其他 IP 不受影响
    expect(redeemer.redeem({ code: VALID_CODE, ip: '8.8.8.8' }).status).toBe(200);
  });
});

describe('loadRedeemedCodes', () => {
  it('returns an empty set when the redeem directory does not exist', () => {
    expect(loadRedeemedCodes(path.join(workDir, 'nope')).size).toBe(0);
  });
});

describe('renderCrowdfundPage', () => {
  it('renders a self-contained page with tiers, placeholder QR and redeem guide', () => {
    const html = renderCrowdfundPage(TIERS);
    expect(html).toContain('支持 Vesti 众筹');
    expect(html).toContain('收款码即将上线，敬请期待');
    expect(html).toContain('<svg'); // 占位收款码
    expect(html).not.toContain('<script');
    expect(html).toContain('暖心档');
    expect(html).toContain('同行档');
    expect(html).toContain('共创档');
    expect(html).toContain('¥19');
    expect(html).toContain('¥59');
    expect(html).toContain('¥129');
    // 积分数字来自档位映射
    expect(html).toContain('6,000');
    expect(html).toContain('20,000');
    expect(html).toContain('55,000');
    // 兑换指引:备注邮箱/ID → 众筹码 → App 内兑换
    expect(html).toContain('备注');
    expect(html).toContain('VESTI-XXXX-XXXX-XXXX');
    expect(html).toContain('支持众筹');
  });
});
