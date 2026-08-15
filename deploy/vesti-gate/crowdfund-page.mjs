// Vesti 众筹公开页 —— 自包含 HTML(内联样式、无外部资源),
// 由 server.mjs 以 GET /crowdfund/ 返回。积分数字来自 server.mjs 的
// CROWDFUND_TIERS,改档位映射时页面自动跟随。

function formatCredits(n) {
  return Number(n).toLocaleString('en-US');
}

export function renderCrowdfundPage(tiers) {
  const warm = formatCredits(tiers.warm.credits);
  const fellow = formatCredits(tiers.fellow.credits);
  const cocreate = formatCredits(tiers.cocreate.credits);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>支持 Vesti 众筹 —— 让它继续好好长大</title>
<style>
  :root {
    --bg: #faf8f5;
    --card: #ffffff;
    --ink: #2b2620;
    --ink-soft: #6b6357;
    --ink-faint: #9a9184;
    --line: #e8e2d8;
    --accent: #b4763a;
    --accent-soft: #f6ecdf;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--ink);
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
    line-height: 1.8;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 56px 24px 80px; }
  .eyebrow {
    font-size: 12px; letter-spacing: .28em; color: var(--accent);
    text-transform: uppercase; margin-bottom: 14px;
  }
  h1 { font-size: 30px; line-height: 1.4; font-weight: 700; margin-bottom: 18px; }
  h2 { font-size: 20px; margin: 48px 0 16px; }
  p { color: var(--ink-soft); margin-bottom: 14px; }
  .lead { font-size: 16px; }
  .tiers { display: grid; gap: 14px; margin-top: 24px; }
  .tier {
    background: var(--card); border: 1px solid var(--line); border-radius: 14px;
    padding: 20px 22px; display: flex; justify-content: space-between;
    align-items: baseline; gap: 16px; flex-wrap: wrap;
  }
  .tier .name { font-size: 17px; font-weight: 700; }
  .tier .name small { color: var(--ink-faint); font-weight: 400; margin-left: 8px; font-size: 13px; }
  .tier .perk { color: var(--ink-soft); font-size: 13.5px; width: 100%; margin-top: 6px; }
  .tier .price { font-size: 22px; font-weight: 700; color: var(--accent); white-space: nowrap; }
  .tier .price small { font-size: 13px; color: var(--ink-faint); font-weight: 400; }
  .qr {
    margin-top: 24px; background: var(--card); border: 1px dashed var(--line);
    border-radius: 14px; padding: 32px 24px; text-align: center;
  }
  .qr svg { width: 160px; height: 160px; }
  .qr p { margin: 14px 0 0; color: var(--ink-faint); font-size: 13.5px; }
  .steps { counter-reset: step; margin-top: 20px; }
  .steps li {
    list-style: none; position: relative; padding-left: 40px; margin-bottom: 14px;
    color: var(--ink-soft);
  }
  .steps li::before {
    counter-increment: step; content: counter(step);
    position: absolute; left: 0; top: 3px;
    width: 24px; height: 24px; border-radius: 50%;
    background: var(--accent-soft); color: var(--accent);
    font-size: 13px; font-weight: 700; text-align: center; line-height: 24px;
  }
  .code {
    font-family: ui-monospace, "SF Mono", Consolas, monospace;
    background: var(--accent-soft); color: var(--accent);
    border-radius: 6px; padding: 1px 7px; font-size: .92em;
  }
  .note { font-size: 13px; color: var(--ink-faint); margin-top: 40px; border-top: 1px solid var(--line); padding-top: 20px; }
</style>
</head>
<body>
<div class="wrap">
  <p class="eyebrow">VESTI CROWDFUND</p>
  <h1>支持 Vesti 众筹，<br>让它继续好好长大。</h1>

  <p class="lead">谢谢你点进这个页面。能写到这里，说明你已经用了一段时间 Vesti——这本身就是对我们最大的鼓励。</p>

  <h2>为什么众筹</h2>
  <p>Vesti 是一个小团队做的本地优先产品：你的对话库、记忆空间和账号都保存在你自己的设备上。我们想做一件长久的事——让每一次与 AI 的工作都沉淀成你自己的知识。但"长久"两个字背后，是很具体的开销：服务器要续费，模型调用要按 token 计费，每多一位用户，成本就真实地多一点。</p>
  <p>Beta 阶段我们一直坚持免费赠送会员，是希望先证明产品值得存在。现在，如果你愿意推我们一把，这笔钱会让这件事走得更稳、更远。</p>

  <h2>你的钱会用来做什么</h2>
  <p>三件很朴素的事：<strong>服务器</strong>，让网关稳定在线；<strong>模型额度</strong>，让积分体系撑得住日常用量；<strong>让更多人用上 Vesti</strong>，包括那些暂时不方便付费的用户。每一笔款项只用于这三件事，我们会定期公开去向。</p>

  <h2>三档支持方式</h2>
  <div class="tiers">
    <div class="tier">
      <div>
        <p class="name">暖心档<small>一杯咖啡的心意</small></p>
        <p class="perk">获赠 <strong>${warm}</strong> 积分，兑换后直接到账</p>
      </div>
      <p class="price">¥19</p>
    </div>
    <div class="tier">
      <div>
        <p class="name">同行档<small>与 Vesti 同行一程</small></p>
        <p class="perk">获赠 <strong>${fellow}</strong> 积分，兑换后直接到账</p>
      </div>
      <p class="price">¥59</p>
    </div>
    <div class="tier">
      <div>
        <p class="name">共创档<small>参与 Vesti 的长大</small></p>
        <p class="perk">获赠 <strong>${cocreate}</strong> 积分，兑换后直接到账；你的名字将写入致谢名单（可选）</p>
      </div>
      <p class="price">¥129</p>
    </div>
  </div>

  <div class="qr">
    <svg viewBox="0 0 160 160" role="img" aria-label="收款码占位图">
      <rect x="0" y="0" width="160" height="160" rx="12" fill="#f3eee6"/>
      <g fill="#c9bfae">
        <rect x="24" y="24" width="34" height="34" rx="4"/>
        <rect x="102" y="24" width="34" height="34" rx="4"/>
        <rect x="24" y="102" width="34" height="34" rx="4"/>
        <rect x="70" y="30" width="10" height="10"/>
        <rect x="86" y="46" width="10" height="10"/>
        <rect x="70" y="62" width="10" height="10"/>
        <rect x="102" y="70" width="10" height="10"/>
        <rect x="118" y="86" width="10" height="10"/>
        <rect x="86" y="102" width="10" height="10"/>
        <rect x="70" y="118" width="10" height="10"/>
        <rect x="102" y="118" width="18" height="18" rx="3"/>
        <rect x="38" y="70" width="10" height="10"/>
        <rect x="54" y="86" width="10" height="10"/>
      </g>
      <rect x="30" y="30" width="22" height="22" rx="3" fill="#f3eee6"/>
      <rect x="108" y="30" width="22" height="22" rx="3" fill="#f3eee6"/>
      <rect x="30" y="108" width="22" height="22" rx="3" fill="#f3eee6"/>
    </svg>
    <p>收款码即将上线，敬请期待</p>
  </div>

  <h2>支持之后，如何领取积分</h2>
  <ol class="steps">
    <li>扫码付款时，请在<strong>备注里留下你的注册邮箱或用户名</strong>，方便我们对上号。</li>
    <li>确认到账后，我们会把一枚一次性的<strong>「众筹码」</strong>发给你，形如 <span class="code">VESTI-XXXX-XXXX-XXXX</span>。</li>
    <li>打开 Vesti，进入<strong>设置 → 会员与账号 → 支持众筹</strong>，输入众筹码完成兑换，积分立即到账；每枚众筹码只能兑换一次。</li>
  </ol>

  <p class="note">众筹完全自愿，不支持也不会影响你现在的任何权益：免费版每日积分照常发放，本地数据始终属于你自己。谢谢你读到这里。</p>
</div>
</body>
</html>`;
}
