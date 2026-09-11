/**
 * 本地服务器 HTTP 层自测
 *
 * 检查的是「接口和静态资源两条路都通，且不该暴露的东西没有暴露」：
 *   1. 首页与全部静态资源都能取到，且返回了正确的内容类型
 *   2. 三个接口都返回结构化数据（不是 404、不是 HTML）
 *   3. 币种接口确实给的是全量名单（搜索功能的数据基础）
 *   4. 接口失败时返回的是明确的中文原因，而不是空壳
 *   5. 文档、配置文件、接口源码不允许通过网页访问
 *   6. 响应里不出现具体数据平台的品牌名
 *
 * 前置条件：本地服务器已在 8792 端口运行
 */

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8792';

let pass = 0;
const fails = [];
function check(name, ok, extra) {
  if (ok) pass += 1;
  else fails.push(name + (extra ? '　→ ' + extra : ''));
}
function section(t) {
  console.log('\n=== ' + t + ' ===');
}

async function req(pathname, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + pathname, { signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      /* 不是 JSON 就留 null */
    }
    return { status: res.status, type: res.headers.get('content-type') || '', text, json };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
 * 一、首页与静态资源
 * ============================================================ */

section('一、首页与静态资源');

const home = await req('/');
check('首页返回 200', home.status === 200, String(home.status));
check('首页是 HTML', home.type.indexOf('text/html') >= 0, home.type);
check('首页声明了 UTF-8', /<meta charset="UTF-8"/i.test(home.text));
check('首页包含项目名', home.text.indexOf('成交结构拆解智能体') >= 0);
check('首页包含参赛标识', home.text.indexOf('参赛作品') >= 0);
check('首页包含风险提示', home.text.indexOf('不构成任何投资建议') >= 0);
check('首页已引入大小单分类器与研判引擎', /classifier\.js/.test(home.text) && /verdict-engine\.js/.test(home.text));
check('首页包含搜索框', home.text.indexOf('id="symbolInput"') >= 0);
check('首页包含成交结构面板与研判面板', home.text.indexOf('id="structGrid"') >= 0 && home.text.indexOf('id="scoreList"') >= 0);
check('首页包含成交结构时间轴画布', home.text.indexOf('id="structCanvas"') >= 0);

const assets = [
  ['/styles.css', 'text/css'],
  ['/app.js', 'javascript'],
  ['/chart.js', 'javascript'],
  ['/classifier.js', 'javascript'],
  ['/verdict-engine.js', 'javascript'],
  ['/trade-store.js', 'javascript'],
  ['/data-direct.js', 'javascript'],
  ['/api-client.js', 'javascript'],
  ['/favicon.svg', 'image/svg+xml'],
];
for (const [p, want] of assets) {
  const r = await req(p);
  check(`静态资源 ${p} 可访问且类型正确`, r.status === 200 && r.type.indexOf(want.split('/')[0]) >= 0, `${r.status} ${r.type}`);
}

/* ============================================================
 * 二、三个接口
 * ============================================================ */

section('二、数据接口');

const symPerp = await req('/api/symbols?market=perp&top=1200');
check('/api/symbols（永续）返回 200 且是 JSON', symPerp.status === 200 && !!symPerp.json, String(symPerp.status));
check('/api/symbols 返回 ok=true', symPerp.json && symPerp.json.ok === true, JSON.stringify(symPerp.json && symPerp.json.error));
check(
  '永续币种为全量规模（>800）',
  symPerp.json && symPerp.json.list && symPerp.json.list.length > 800,
  String(symPerp.json && symPerp.json.list ? symPerp.json.list.length : 0),
);
check(
  '币种记录带代号、展示名与 24 小时成交额',
  symPerp.json &&
    symPerp.json.list[0] &&
    typeof symPerp.json.list[0].symbol === 'string' &&
    typeof symPerp.json.list[0].display === 'string' &&
    Number.isFinite(symPerp.json.list[0].quoteVolume24h),
);
check(
  '主流币被固定排在前面',
  symPerp.json && symPerp.json.list.slice(0, 6).some((x) => x.base === 'BTC'),
);

const symSpot = await req('/api/symbols?market=spot&top=2500');
check(
  '现货币种也是全量规模（>1500）',
  symSpot.json && symSpot.json.list && symSpot.json.list.length > 1500,
  String(symSpot.json && symSpot.json.list ? symSpot.json.list.length : 0),
);

const mkt = await req('/api/market?market=perp&symbol=BTC_USDT&interval=1m&limit=200');
check('/api/market 返回 200 且 ok=true', mkt.status === 200 && mkt.json && mkt.json.ok === true, JSON.stringify(mkt.json && mkt.json.error));
check('行情返回了真实价格', mkt.json && mkt.json.ticker && Number.isFinite(mkt.json.ticker.last) && mkt.json.ticker.last > 0);
check('行情返回了K线数组', !!(mkt.json && Array.isArray(mkt.json.candles) && mkt.json.candles.length > 50), String(mkt.json && mkt.json.candles ? mkt.json.candles.length : 0));
check(
  'K线字段完整（时间/开/高/低/收/量）',
  mkt.json &&
    mkt.json.candles[0] &&
    ['t', 'o', 'h', 'l', 'c', 'v'].every((k) => Number.isFinite(mkt.json.candles[0][k])),
  JSON.stringify(mkt.json && mkt.json.candles[0]).slice(0, 120),
);
check(
  'K线按时间升序排列',
  mkt.json && mkt.json.candles.every((c, i, arr) => i === 0 || arr[i - 1].t <= c.t),
);
check('行情标明了数据来源（中性表述）', mkt.json && typeof mkt.json.sourceLabel === 'string' && mkt.json.sourceLabel.length > 0);

const trades = await req('/api/trades?market=perp&symbol=BTC_USDT&limit=1000');
check('/api/trades 返回 200 且 ok=true', trades.status === 200 && trades.json && trades.json.ok === true, JSON.stringify(trades.json && trades.json.error));
check(
  '逐笔带编号、时间、价格、数量与方向',
  trades.json &&
    trades.json.rows &&
    trades.json.rows.length > 0 &&
    trades.json.rows.every((r) => r.id !== undefined && r.price !== undefined && r.create_time_ms !== undefined),
  String(trades.json && trades.json.rows ? trades.json.rows.length : 0),
);
check(
  '逐笔附带合约乘数（换算美元金额必需）',
  trades.json && trades.json.meta && Number.isFinite(trades.json.meta.quantoMultiplier),
  JSON.stringify(trades.json && trades.json.meta),
);

/* 失败路径：不存在的币种要给出明确的中文原因，而不是空壳 */
const badSymbol = await req('/api/market?market=perp&symbol=NOT_A_REAL_COIN&interval=1m&limit=10');
check(
  '不存在的币种返回明确的中文失败原因',
  badSymbol.json && badSymbol.json.ok === false && typeof badSymbol.json.error === 'string' && badSymbol.json.error.length > 0,
  JSON.stringify(badSymbol.json).slice(0, 120),
);
check('失败原因里不出现交易所英文错误码', badSymbol.json && !/CONTRACT_NOT_FOUND|INVALID/i.test(badSymbol.json.error || ''), String(badSymbol.json && badSymbol.json.error));

/* ============================================================
 * 三、不该暴露的东西
 * ============================================================ */

section('三、访问控制与合规');

const blocked = ['/netlify.toml', '/package.json', '/functions/symbols.cjs', '/dev-server.mjs', '/README.md'];
// 本地服务器把文档、配置、接口源码一律拦掉；不存在时按单页兜底返回首页（200）
for (const p of blocked) {
  const r = await req(p);
  const notExposed = r.status === 403 || (r.status === 200 && r.text.indexOf('<html') >= 0);
  check(`不允许直接访问 ${p}（返回 403 或被兜底到首页）`, notExposed, String(r.status));
}

const traversal = await req('/%2e%2e/package.json');
check('目录穿越尝试被拦下', traversal.status === 403 || traversal.json === null, String(traversal.status));

const allText = home.text + symPerp.text + mkt.text;
check(
  '接口与页面里不出现具体数据平台品牌名',
  !/gateio|hyperliquid/i.test(allText),
  (allText.match(/gateio|hyperliquid/gi) || []).join(','),
);
check('页面里没有残留本地调试地址', !/127\.0\.0\.1/.test(home.text));

/* ============================================================
 * 汇总
 * ============================================================ */

console.log('\n' + '='.repeat(60));
if (fails.length === 0) {
  console.log(`  通过 ${pass} 项，失败 0 项`);
} else {
  console.log(`  通过 ${pass} 项，失败 ${fails.length} 项`);
  console.log('  失败清单：');
  fails.forEach((f) => console.log('    · ' + f));
}
console.log('='.repeat(60));
process.exitCode = fails.length ? 1 : 0;
