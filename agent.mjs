#!/usr/bin/env node
/**
 * agent.mjs —— 成交结构拆解智能体的「Agent 命令行入口」
 *
 * 用途：让 AI Agent（Claude Code / OpenClaw 等）或任何脚本，用一行命令拿到
 *       某个币种的成交结构拆解与主力行为研判结论，不必打开网页。
 *
 * 两条数据通道（账号与密钥要求都是零）：
 *   ① 官方公开数据（默认推荐）：读取 Binance 官方开源的公开数据仓库
 *      （github.com/binance/binance-public-data → data.binance.vision）里的
 *      历史逐笔成交（aggTrades），按指定日期与时间窗分析。
 *      优点：历史数据现成，一条命令即可给出完整结论，不需要等待积累、不需要 API 密钥。
 *   ② 实时逐笔：读交易所公开接口最近约 1000 条逐笔，像网页一样按秒轮询「滚雪球」积累。
 *      适合看「此刻正在发生」的结构，但需要积累时间（默认 1 分钟档约 6 分钟）。
 *   ③ 官方技能（--skill）：直接调用官方技能市场（binance/binance-skills-hub）的
 *      binance 技能驱动的命令行工具 binance-cli（spot agg-trades 命令，免密钥行情）；
 *      未安装 binance-cli 时自动回退到 ④（同一 REST 端点）并给出官方安装命令。
 *   ④ 官方公开行情（--live）：按官方 spot API 文档接入行情专用入口
 *      data-api.binance.vision 的 aggTrades —— 与官方技能 agg-trades 命令同一端点。
 *
 * 用法：
 *   node agent.mjs BTC                                 实时通道，采集 30 秒
 *   node agent.mjs BTC 5m --seconds 420                 实时通道，采集 7 分钟
 *   node agent.mjs BTC --official                       官方公开数据，昨天 UTC 最后一小时
 *   node agent.mjs BTC --official --date 2026-09-11     指定日期
 *   node agent.mjs ETH --official --at 08:00 --window 30m   指定 UTC 结束时刻与窗口长度
 *   node agent.mjs "看看 SOL 现在的成交结构"              自然语言
 *   node agent.mjs BTC --json                           输出 JSON（给 Agent 解析）
 *   node agent.mjs --status / --reset                   查看 / 清空本地积累
 *
 * 说明：只读取公开数据，不涉及任何交易操作，不需要也不接受 API 密钥。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* ============================================================
 * 一、本地状态文件（实时通道用，作用等同于网页里的 localStorage）
 * ============================================================ */

const STATE_FILE = path.join(ROOT, '.cjx-agent-state.json');

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

const store0 = loadState();
let dirty = false;

globalThis.localStorage = {
  get length() {
    return Object.keys(store0).length;
  },
  key(i) {
    return Object.keys(store0)[i] || null;
  },
  getItem(k) {
    return Object.prototype.hasOwnProperty.call(store0, k) ? store0[k] : null;
  },
  setItem(k, v) {
    store0[k] = String(v);
    dirty = true;
  },
  removeItem(k) {
    delete store0[k];
    dirty = true;
  },
};

function persist() {
  if (!dirty) return;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(store0));
    dirty = false;
  } catch (e) {
    /* 写不进去不影响本次分析 */
  }
}

/* ============================================================
 * 二、加载与网页完全相同的引擎代码
 * ============================================================ */

['classifier.js', 'verdict-engine.js', 'trade-store.js'].forEach((f) => {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  new Function(code)(); // eslint-disable-next-line no-new-func
});

const data = require('./functions/_data.cjs');
const { VerdictEngine, TradeClassifier, TradeStore } = globalThis;

/* ============================================================
 * 二之二、币安官方公开行情入口（现货）
 *
 * 说明：币安在 binance-spot-api-docs 里为「仅需公开行情」的场景提供了
 *       data-api.binance.vision 这个入口 —— 只提供公开市场数据、不需要 API 密钥，
 *       也不会返回账户相关信息。本通道的 aggTrades / klines / ticker 都取自这里。
 * ============================================================ */

const BINANCE_PUBLIC_BASE = 'https://data-api.binance.vision/api/v3';

/** 现货交易对去掉下划线：BTC_USDT → BTCUSDT（币安官方命名不带下划线） */
const binancePair = (symbol) => String(symbol).replace('_', '');

async function binancePublicGet(pathAndQuery) {
  const res = await fetch(BINANCE_PUBLIC_BASE + pathAndQuery);
  if (!res.ok) {
    throw new Error('币安官方公开行情接口返回失败：HTTP ' + res.status);
  }
  return res.json();
}

/** 实时逐笔（官方 aggTrades，单次最多 1000 条） */
async function fetchBinanceLiveTrades(symbol, limit = 1000) {
  const rows = await binancePublicGet(
    '/aggTrades?symbol=' + binancePair(symbol) + '&limit=' + limit,
  );
  if (!Array.isArray(rows)) throw new Error('币安 aggTrades 返回结构异常');
  return rows.map((r) => ({
    id: Number(r.a),
    ts: Number(r.T),
    price: Number(r.p),
    notional: Number(r.p) * Number(r.q),
    // m = isBuyerMaker：买方是挂单方 → 主动方向是卖出
    dir: r.m === true ? -1 : 1,
  }));
}

/* ============================================================
 * 二之三、官方技能通道（Skills Hub 的 binance 技能 → binance-cli）
 *
 * 官方 binance 技能（github.com/binance/binance-skills-hub → skills/binance）
 * 的 references/spot.md 中，Market 区块（无需鉴权）提供 agg-trades、klines、
 * ticker24hr 等行情命令 —— 正是本技能所需的「市场情报」数据来源。
 *
 * 本通道优先调用官方技能驱动的命令行工具 binance-cli；未安装时回退到
 * --live 通道（同一 REST 端点 /api/v3/aggTrades，官方文档认可的行情专用域名），
 * 并如实打印官方安装命令，绝不假装调用过。
 * ============================================================ */

const BINANCE_CLI_INSTALL_CMD =
  "curl --proto '=https' --tlsv1.2 -LsSf " +
  'https://github.com/binance/binance-cli/releases/latest/download/binance-cli-installer.sh | sh';

/** 检测官方技能的命令行工具 binance-cli 是否可用 */
function binanceCliAvailable() {
  try {
    const r = spawnSync('binance-cli', ['--version'], { encoding: 'utf8', timeout: 8000 });
    return !r.error && r.status === 0;
  } catch (e) {
    return false;
  }
}

/**
 * 调用官方技能的 agg-trades 命令（Market 区块 · 免密钥行情）
 * 官方技能 references/spot.md：agg-trades，Key params：symbol [from-id start-time end-time limit]
 */
function binanceCliAggTrades(symbol, opts2 = {}) {
  const args = ['spot', 'agg-trades', '--symbol', binancePair(symbol), '--limit', String(opts2.limit || 1000)];
  if (opts2.fromId) args.push('--from-id', String(opts2.fromId));
  const r = spawnSync('binance-cli', args, {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error('binance-cli 调用失败：' + (r.error.message || r.error));
  if (r.status !== 0 && !String(r.stdout || '').trim()) {
    throw new Error('binance-cli 退出码 ' + r.status + '：' + String(r.stderr || '').slice(0, 160));
  }
  const out = String(r.stdout || '');
  const s = out.indexOf('[');
  const e = out.lastIndexOf(']');
  if (s < 0 || e <= s) throw new Error('binance-cli 输出里没有 JSON 数组：' + out.slice(0, 120));
  let rows;
  try {
    rows = JSON.parse(out.slice(s, e + 1));
  } catch (err) {
    throw new Error('binance-cli 输出解析失败：' + out.slice(s, s + 120));
  }
  if (!Array.isArray(rows)) throw new Error('binance-cli 返回的不是数组');
  // 官方 aggTrades 字段：a=成交编号 T=时间戳(毫秒) p=价格 q=数量 m=买方是否挂单方
  return rows
    .map((x) => ({
      id: Number(x.a),
      ts: Number(x.T),
      price: Number(x.p),
      notional: Number(x.p) * Number(x.q),
      dir: x.m === true ? -1 : 1,
    }))
    .filter((t) => Number.isFinite(t.id) && Number.isFinite(t.ts) && Number.isFinite(t.price));
}

/** 官方 K线 → 本项目统一结构 */
async function fetchBinanceKlines(symbol, interval, limit = 500) {
  const rows = await binancePublicGet(
    '/klines?symbol=' + binancePair(symbol) + '&interval=' + interval + '&limit=' + limit,
  );
  if (!Array.isArray(rows)) throw new Error('币安 klines 返回结构异常');
  return rows.map((k) => ({
    t: Number(k[0]),
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4]),
    v: Number(k[5]),
    sum: Number(k[7]),
  }));
}

/** 官方 24 小时行情 → 本项目统一的 market 结构 */
async function fetchBinanceQuote(symbol, interval, limit) {
  const [t, candles] = await Promise.all([
    binancePublicGet('/ticker/24hr?symbol=' + binancePair(symbol)),
    fetchBinanceKlines(symbol, interval, limit),
  ]);
  return {
    market: 'spot',
    display: String(symbol).replace('_', '/'),
    interval,
    intervalLabel: interval,
    candleCount: candles.length,
    candles,
    fetchedAt: Date.now(),
    via: 'official-rest',
    sourceLabel: '币安官方公开行情接口（data-api.binance.vision）',
    ticker: {
      last: Number(t.lastPrice),
      changePercent24h: Number(t.priceChangePercent),
      quoteVolume24h: Number(t.quoteVolume),
      openInterestUsd: null, // 现货不提供持仓量
      fundingAnnualized: null, // 现货不提供资金费率
      fundingIntervalLabel: null,
      markPrice: null,
      indexPrice: null,
    },
  };
}

/** 用K线成交额给自己算一次覆盖率（官方通道与官方实时通道都用它做自我校验） */
function coverageAgainstKlines(trades, candles, intervalMs) {
  if (!trades.length || !candles || !candles.length) return null;
  const first = trades[0].ts;
  const last = trades[trades.length - 1].ts;
  const sums = new Map();
  candles.forEach((c) => {
    if (Number.isFinite(c.sum) && c.sum > 0) sums.set(Math.floor(c.t / intervalMs) * intervalMs, c.sum);
  });
  let tradeSum = 0;
  let klineSum = 0;
  const startBucket = Math.floor(first / intervalMs) * intervalMs;
  const endBucket = Math.floor(last / intervalMs) * intervalMs;
  sums.forEach((sum, t0) => {
    if (t0 < startBucket || t0 > endBucket) return;
    klineSum += sum;
  });
  trades.forEach((t) => {
    tradeSum += t.notional;
  });
  // 两端不完整的桶不平摊，因此只做「量级是否合理」的参考值
  return klineSum > 0 ? tradeSum / klineSum : null;
}

/* ============================================================
 * 三、参数解析（支持自然语言）
 * ============================================================ */

const INTERVALS = {
  '1m': { ms: 60 * 1000, label: '1分钟' },
  '5m': { ms: 5 * 60 * 1000, label: '5分钟' },
  '15m': { ms: 15 * 60 * 1000, label: '15分钟' },
  '30m': { ms: 30 * 60 * 1000, label: '30分钟' },
  '1h': { ms: 60 * 60 * 1000, label: '1小时' },
  '4h': { ms: 4 * 60 * 60 * 1000, label: '4小时' },
};

const KNOWN_SYMBOLS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'TON',
  'SUI', 'APT', 'ARB', 'OP', 'PEPE', 'WIF', 'SHIB', 'LTC', 'DOT', 'TRX',
];

/** 把 60 / 30m / 2h 这类写法统一换算成分钟 */
function parseMinutes(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().toLowerCase();
  const m = s.match(/^(\d+)\s*(m|min|分钟)?$/);
  if (m) return Number(m[1]);
  const h = s.match(/^(\d+(?:\.\d+)?)\s*(h|hour|小时)$/);
  if (h) return Math.round(Number(h[1]) * 60);
  return null;
}

function parseArgs(argv) {
  const opts = {
    market: 'perp',
    symbol: null,
    interval: '1m',
    seconds: 30,
    source: 'realtime',
    date: null,
    dateExplicit: false,
    at: null,
    windowMin: 60,
    json: false,
    status: false,
    reset: false,
    help: false,
  };

  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--status') opts.status = true;
    else if (a === '--reset') opts.reset = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--spot') opts.market = 'spot';
    else if (a === '--perp') opts.market = 'perp';
    else if (a === '--official' || a === '--binance-data') opts.source = 'official';
    else if (a === '--live' || a === '--binance-live') opts.source = 'live';
    else if (a === '--skill' || a === '--binance-cli') opts.source = 'skill';
    else if (a === '--realtime') opts.source = 'realtime';
    else if (a === '--date') {
      const v = String(argv[i + 1] || '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        opts.date = v;
        opts.dateExplicit = true;
      }
      i += 1;
    } else if (a === '--at') {
      const v = String(argv[i + 1] || '');
      if (/^\d{1,2}:\d{2}$/.test(v)) opts.at = v;
      i += 1;
    } else if (a === '--window') {
      const min = parseMinutes(argv[i + 1]);
      if (min && min > 0) opts.windowMin = Math.min(min, 1440);
      i += 1;
    } else if (a === '--seconds' || a === '-s') {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) opts.seconds = Math.min(v, 1800);
      i += 1;
    } else rest.push(a);
  }

  // 把剩余参数拼起来当成一句自然语言来解析
  const text = rest.join(' ');
  if (text) {
    const iv = text.match(/\b(1m|5m|15m|30m|1h|4h)\b/i);
    if (iv) opts.interval = iv[1].toLowerCase();
    else {
      const zh = text.match(/(1|5|15|30)\s*分钟/);
      if (zh) opts.interval = zh[1] + 'm';
      else if (/1\s*小时|1h/i.test(text)) opts.interval = '1h';
      else if (/4\s*小时|4h/i.test(text)) opts.interval = '4h';
    }

    const pair = text.match(/([A-Za-z0-9]{2,12})[\/_](USDT|usdt)/);
    if (pair) opts.symbol = pair[1].toUpperCase() + '_USDT';
    if (!opts.symbol) {
      const upper = text.toUpperCase().match(/\b([A-Z0-9]{2,12})\b/g) || [];
      const hit = upper.find((t) => /^[A-Z0-9]{2,12}$/.test(t) && t !== 'USDT' && !/^\d+$/.test(t));
      if (hit) opts.symbol = hit + '_USDT';
    }
    if (!opts.symbol) {
      const upperText = text.toUpperCase();
      const known = KNOWN_SYMBOLS.find((s) => upperText.indexOf(s) >= 0);
      if (known) opts.symbol = known + '_USDT';
    }
    if (/现货|spot/i.test(text)) opts.market = 'spot';
    if (/官方技能|技能包|binance-cli/i.test(text)) opts.source = 'skill';
    if (/官方|公开数据|历史/i.test(text)) opts.source = 'official';
  }

  if (!opts.symbol) opts.symbol = 'BTC_USDT';

  // 币安官方公开行情入口（--live / --skill）只提供现货市场，选了永续就自动切到现货并说明
  if ((opts.source === 'live' || opts.source === 'skill') && opts.market !== 'spot') {
    opts.market = 'spot';
    opts.liveForcedSpot = true;
  }

  // 官方公开数据默认看「昨天（UTC）最后一小时」——当天文件通常还没发布
  if (opts.source === 'official') {
    if (!opts.date) {
      const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
      opts.date = d.toISOString().slice(0, 10);
    }
    if (!opts.at) opts.at = '23:59';
  }

  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log(`
成交结构拆解智能体 · 命令行入口

四条数据通道（都不需要 API 密钥）：
  官方技能    ：调用官方技能市场（Skills Hub）binance 技能的 binance-cli spot agg-trades 命令
  官方公开数据：读 Binance 官方开源的公开数据仓库（data.binance.vision）的历史逐笔文件
  官方公开行情：读 Binance 官方公开行情接口（data-api.binance.vision）的实时逐笔（现货）
  实时逐笔    ：读多平台公开接口最近约 1000 条逐笔，像网页一样轮询积累（支持永续与现货）

用法：
  node agent.mjs BTC --skill                            官方技能通道（未装 binance-cli 会自动回退并给安装命令）
  node agent.mjs BTC                                    实时逐笔（1 分钟档，采集 30 秒）
  node agent.mjs BTC 5m --seconds 420                    实时逐笔，采集 7 分钟
  node agent.mjs BTC --official                          官方公开数据（昨天 UTC 最后一小时）
  node agent.mjs BTC --official --date 2026-09-11        指定日期
  node agent.mjs ETH --official --at 08:00 --window 30m  指定 UTC 结束时刻与窗口长度
  node agent.mjs BTC --live                              币安官方公开行情接口（实时，现货）
  node agent.mjs "看看 SOL 现在的成交结构"                自然语言
  node agent.mjs BTC --spot                              现货（默认永续合约）
  node agent.mjs BTC --json                              输出 JSON，便于 Agent 解析
  node agent.mjs --status                                查看本地已积累的样本
  node agent.mjs --reset                                 清空本地积累

参数：
  --skill           官方技能通道：优先调用 binance-cli（官方 binance 技能驱动的 CLI，免密钥行情）；
                    未安装时自动回退到 --live（同一 REST 端点）并打印官方安装命令
  --official        官方公开数据通道（推荐，历史数据现成、一条命令出完整结论）
  --date YYYY-MM-DD 官方通道的分析日期（UTC），默认自动取最近已发布的日期
  --at HH:MM        官方通道窗口的结束时刻（UTC），默认 23:59
  --window 30m      官方通道窗口长度，默认 60m（可用 30m / 2h / 90 这类写法）
  --live            币安官方公开行情接口（实时，仅现货；会被自动切到现货市场）
  --seconds N       采集秒数（实时/技能通道用），默认 30，建议 400 以上拿到完整结论

提示：实时通道的积累会存在本地文件里，多次运行自动累加；换币种前可先 --reset。
`);
  process.exit(0);
}

if (opts.reset) {
  fs.writeFileSync(STATE_FILE, '{}');
  console.log('已清空本地积累：' + STATE_FILE);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const intervalMs = INTERVALS[opts.interval].ms;

/* ============================================================
 * 四、通道一：官方公开数据（Binance public data，无需密钥）
 * ============================================================ */

/**
 * 构造官方公开数据的下载地址
 * 目录规则（官方仓库 README 有说明）：
 *   现货   data/spot/daily/aggTrades/<交易对>/<交易对>-aggTrades-<日期>.zip
 *   永续   data/futures/um/daily/aggTrades/<交易对>/<交易对>-aggTrades-<日期>.zip
 * 注意：官方文件里的交易对是不带下划线的写法（SOLUSDT），本项目的内部约定是 SOL_USDT，
 *      所以这里要去掉下划线。
 */
function officialUrl(market, symbol, date) {
  const kind = market === 'spot' ? 'spot' : 'futures/um';
  const pair = symbol.replace('_', '');
  return (
    'https://data.binance.vision/data/' + kind + '/daily/aggTrades/' +
    pair + '/' + pair + '-aggTrades-' + date + '.zip'
  );
}

/**
 * 下载并流式解压官方逐笔文件，只保留时间窗内的成交。
 *
 * 为什么用流式：一天的 BTC 逐笔解压后有几百 MB，整包读进内存既慢又危险；
 * 官方文件里的记录是严格按时间升序的，所以一旦越过窗口右边界就可以直接掐断下载。
 */
async function fetchOfficialTrades({ market, symbol, date, windowStart, windowEnd, quiet }) {
  const url = officialUrl(market, symbol, date);
  const res = await fetch(url);
  if (!res.ok) {
    const hint =
      res.status === 404
        ? '（该日期或该币种没有官方数据文件：可能是当天文件还没发布，或该币种在该市场不存在）'
        : '';
    throw new Error('官方公开数据下载失败：HTTP ' + res.status + hint);
  }

  const total = Number(res.headers.get('content-length')) || 0;
  const nodeStream = Readable.fromWeb(res.body);
  const inflater = zlib.createInflateRaw();

  const trades = [];
  let rowCount = 0;
  let kept = 0;
  let bytes = 0;
  let textBuf = '';
  let headerParsed = false;
  let leftover = null;
  let finished = false;

  const progress = (msg) => {
    if (!quiet) process.stderr.write(msg);
  };

  const onLine = (line) => {
    if (finished) return;
    if (!line) return;
    rowCount += 1;
    const c = line.split(',');
    if (c.length < 7) return;
    const price = Number(c[1]);
    const qty = Number(c[2]);
    const ts = Number(c[5]);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || !Number.isFinite(ts)) return;
    if (ts < windowStart) return;
    if (ts > windowEnd) {
      // 记录按时间升序：越过右边界后面都不用看了
      finished = true;
      return;
    }
    // isBuyerMaker = true 表示买方是挂单方 → 主动方向是卖出
    const dir = String(c[6]).trim().toLowerCase() === 'true' ? -1 : 1;
    trades.push({ ts, price, notional: price * qty, dir });
    kept += 1;
  };

  const consume = (chunk) => {
    if (finished) return;
    textBuf += chunk;
    let idx = textBuf.indexOf('\n');
    while (idx >= 0) {
      const line = textBuf.slice(0, idx).replace(/\r$/, '');
      textBuf = textBuf.slice(idx + 1);
      onLine(line);
      if (finished) {
        textBuf = '';
        return;
      }
      idx = textBuf.indexOf('\n');
    }
  };

  inflater.on('data', (chunk) => consume(chunk.toString('utf8')));

  // 读取响应流：先解析 ZIP 本地文件头，算出真正的数据起点，再把余下字节喂给解压器
  const it = nodeStream[Symbol.asyncIterator]();
  let head = Buffer.alloc(0);

  while (!finished) {
    const { value, done } = await it.next();
    if (done) break;
    bytes += value.length;
    if (!headerParsed) {
      head = Buffer.concat([head, Buffer.from(value)]);
      if (head.length < 30) continue;
      const fnLen = head.readUInt16LE(26);
      const extraLen = head.readUInt16LE(28);
      const dataStart = 30 + fnLen + extraLen;
      if (head.length < dataStart) continue;
      headerParsed = true;
      leftover = head.slice(dataStart);
      head = null;
      if (total) progress('\r  已下载 ' + (bytes / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB');
      inflater.write(leftover);
      continue;
    }
    if (total && bytes % (4 * 1048576) < value.length) {
      progress('\r  已下载 ' + (bytes / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB');
    }
    const ok = inflater.write(Buffer.from(value));
    if (!ok) await new Promise((r) => inflater.once('drain', r));
  }

  if (finished) {
    try {
      nodeStream.destroy();
      inflater.destroy();
    } catch (e) {
      /* 提前掐断时的正常收尾 */
    }
  } else {
    inflater.end();
    await new Promise((r) => inflater.once('end', r));
  }
  if (textBuf) onLine(textBuf.replace(/\r$/, ''));
  progress('\r  下载与解析完成：' + (bytes / 1048576).toFixed(1) + ' MB\n');

  return { url, trades, rowCount, kept, bytes };
}

/* ============================================================
 * 五、通道二：实时逐笔（滚雪球积累）
 * ============================================================ */

const store = TradeStore.create({
  market: opts.market,
  symbol: opts.symbol,
  intervalMs,
  maxTrades: 60000,
  maxBuckets: 720,
});
store.restore();

if (opts.status) {
  const keys = Object.keys(store0).filter((k) => k.indexOf('cjx:v1:') === 0);
  console.log('本地积累状态（实时通道）');
  if (!keys.length) console.log('  （还没有积累任何数据，先跑一次：node agent.mjs BTC）');
  keys.forEach((k) => {
    const parts = k.split(':');
    const symbol = parts[3];
    const ms = Number(parts[4]);
    const label = Object.keys(INTERVALS).find((i) => INTERVALS[i].ms === ms) || ms + 'ms';
    let st = null;
    try {
      const p = JSON.parse(store0[k]);
      st = { ingested: p.totalIngested || 0, buckets: (p.buckets || []).length };
    } catch (e) {
      st = null;
    }
    console.log('  · ' + symbol.replace('_', '/') + '　' + (parts[2] === 'spot' ? '现货' : '永续') + '　' + label +
      (st ? '　累计 ' + st.ingested + ' 笔 · ' + st.buckets + ' 个桶' : ''));
  });
  console.log('');
  console.log('  提示：官方公开数据通道（--official）不需要本地积累，随时可跑');
  process.exit(0);
}

async function fetchTradesOnce() {
  if (opts.market === 'spot') {
    const rows = await data.gateSpotTradesRaw(opts.symbol, 1000);
    return { rows, meta: {} };
  }
  const info = await data.gateFuturesContractInfo(opts.symbol);
  const rows = await data.gateFuturesTradesRaw(opts.symbol, 1000);
  return { rows, meta: { quantoMultiplier: info.quantoMultiplier } };
}

async function fetchMarketQuote() {
  return data.getMarket({
    market: opts.market,
    symbol: opts.symbol,
    interval: opts.interval,
    limit: 500,
  });
}

/* ============================================================
 * 六、主线：取数 → 分析
 * ============================================================ */

/**
 * JSON 模式下所有「说明性输出」必须走 stderr，否则会污染 stdout 的 JSON，
 * 让 Agent 无法解析（这是自测里真实踩过的坑）。文本模式下照常输出到 stdout。
 */
const say = (s = '') => (opts.json ? process.stderr.write(String(s) + '\n') : console.log(s));
const progressInline = (s) => (opts.json ? process.stderr.write(s) : process.stdout.write(s));

let market = null;
let trades = [];
let candles = [];
let coverage = null;
let sourceInfo = null;
let newTrades = 0;
let elapsedSec = 0;

/* 官方技能通道的前置检查：binance-cli 未安装时回退到等价的 --live 通道（同一 REST 端点），
   并如实说明 —— 绝不假装调用过官方工具 */
if (opts.source === 'skill' && !binanceCliAvailable()) {
  say('提示：未检测到 binance-cli（官方 binance 技能驱动的命令行工具）。');
  say('      官方安装命令（来自官方技能 SKILL.md）：');
  say('        ' + BINANCE_CLI_INSTALL_CMD);
  say('      本次自动回退到等价通道：官方公开行情接口 /api/v3/aggTrades');
  say('      （与官方技能 spot agg-trades 命令是同一个端点，官方文档认可的行情专用域名）。');
  say('');
  opts.source = 'live';
  opts.skillFallback = true;
}

if (opts.source === 'official') {
  /* ---------- 通道一：官方公开数据（历史文件） ---------- */
  const [hh, mm] = opts.at.split(':').map(Number);

  // 默认日期取昨天（UTC）；官方文件通常有 1 天左右延迟，
  // 用户没有明确指定日期时，就自动往前找最近一个「文件已发布」的日期
  const candidates = opts.dateExplicit
    ? [opts.date]
    : [0, 1, 2, 3].map((back) =>
        new Date(Date.now() - (back + 1) * 24 * 3600 * 1000).toISOString().slice(0, 10),
      );

  let got = null;
  let usedDate = candidates[0];
  let lastError = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const date = candidates[i];
    const dayStart = Date.parse(date + 'T00:00:00Z');
    let windowEnd = dayStart + hh * 3600000 + mm * 60000;
    let windowStart = windowEnd - opts.windowMin * 60000;
    if (windowStart < dayStart) windowStart = dayStart;
    if (windowEnd > dayStart + 86400000) windowEnd = dayStart + 86400000;

    if (i === 0) {
      say('通道：官方公开数据（Binance public data · 无需密钥）');
      say('窗口：' + date + ' ' + new Date(windowStart).toISOString().slice(11, 16) +
        ' → ' + new Date(windowEnd).toISOString().slice(11, 16) + '（UTC，共 ' + opts.windowMin + ' 分钟）');
    }

    const t0 = Date.now();
    try {
      got = await fetchOfficialTrades({
        market: opts.market,
        symbol: opts.symbol,
        date,
        windowStart,
        windowEnd,
        quiet: i > 0,
      });
      usedDate = date;
      elapsedSec = Math.round((Date.now() - t0) / 1000);
      if (i > 0) {
        say('（' + candidates[0] + ' 的文件还没发布，已自动改用 ' + date + '）');
        say('窗口：' + date + ' ' + new Date(windowStart).toISOString().slice(11, 16) +
          ' → ' + new Date(windowEnd).toISOString().slice(11, 16) + '（UTC，共 ' + opts.windowMin + ' 分钟）');
      }
      sourceInfo = {
        kind: 'official',
        label: 'Binance 官方公开数据（aggTrades）',
        url: got.url,
        rowsScanned: got.rowCount,
        bytes: got.bytes,
        windowStart,
        windowEnd,
        date,
      };
      break;
    } catch (err) {
      lastError = err;
      if (opts.dateExplicit) break; // 用户指定的日期取不到就如实报错，不擅自换日期
      if (/HTTP 404/.test(String(err.message))) continue; // 文件未发布 → 往前找一天
      break;
    }
  }

  if (!got) throw lastError || new Error('官方公开数据获取失败');

  opts.date = usedDate;
  trades = got.trades;
  newTrades = trades.length;

  if (!trades.length) {
    console.error('该窗口内没有解析到任何逐笔成交：请换一个日期或时间窗（官方文件按 UTC 日期切分）。');
    process.exit(1);
  }
} else if (opts.source === 'live') {
  /* ---------- 通道二：币安官方公开行情接口（实时，现货） ---------- */
  const liveKey = 'cjx:live:v1:spot:' + opts.symbol + ':' + intervalMs;
  let persisted = { lastId: null, trades: [] };
  try {
    const raw = store0[liveKey];
    if (raw) persisted = Object.assign(persisted, JSON.parse(raw));
  } catch (e) {
    /* 缓存损坏就从头积累 */
  }

  const seen = new Map();
  (persisted.trades || []).forEach((a) => seen.set(a[0], { id: a[0], ts: a[1], price: a[2], notional: a[3], dir: a[4] }));
  let maxId = Number(persisted.lastId) || (seen.size ? Math.max.apply(null, Array.from(seen.keys())) : null);

  const before = seen.size;
  let gapMissed = 0;
  let gapCount = 0;

  say('通道：币安官方公开行情接口（data-api.binance.vision · 现货 · 无需密钥）');
  say('说明：该入口是币安为「仅需公开行情」场景提供的公开地址，不涉及账户信息；仅提供现货市场。');
  progressInline('正在轮询 aggTrades（' + opts.seconds + ' 秒）…');

  const tstart = Date.now();
  let rounds = 0;
  while (Date.now() - tstart < opts.seconds * 1000) {
    try {
      const rows = await fetchBinanceLiveTrades(opts.symbol, 1000);
      let added = 0;
      rows.forEach((r) => {
        if (!Number.isFinite(r.id)) return;
        if (maxId !== null && r.id <= maxId) return;
        if (seen.size && !seen.has(r.id)) {
          // 编号不连续 → 中间漏了成交（如实统计，不假装完整）
          const prev = seen.get(maxId);
          if (prev && r.id > prev.id + 1 && added === 0) {
            gapMissed += r.id - prev.id - 1;
            gapCount += 1;
          }
        }
        seen.set(r.id, r);
        added += 1;
      });
      if (rows.length) maxId = Math.max(maxId === null ? 0 : maxId, rows[rows.length - 1].id);
      rounds += 1;
      if (rounds % 5 === 0) progressInline('.');
      if (!market) {
        try {
          market = await fetchBinanceQuote(opts.symbol, opts.interval, 500);
        } catch (e) {
          /* 行情失败不影响逐笔积累 */
        }
      }
    } catch (err) {
      progressInline('!');
    }
    await sleep(2000);
  }
  progressInline(' 完成\n');

  if (!market) market = await fetchBinanceQuote(opts.symbol, opts.interval, 500);

  store0[liveKey] = JSON.stringify({
    lastId: maxId,
    trades: Array.from(seen.values())
      .sort((a, b) => a.id - b.id)
      .slice(-20000)
      .map((t) => [t.id, t.ts, t.price, t.notional, t.dir]),
  });
  dirty = true;
  persist();

  trades = Array.from(seen.values())
    .sort((a, b) => a.ts - b.ts)
    .map((t) => ({ ts: t.ts, price: t.price, notional: t.notional, dir: t.dir }));
  candles = market.candles || [];
  coverage = coverageAgainstKlines(trades, candles, intervalMs);
  newTrades = Math.max(0, seen.size - before);
  elapsedSec = Math.round((Date.now() - tstart) / 1000);
  sourceInfo = {
    kind: 'live',
    label: '币安官方公开行情接口（data-api.binance.vision）',
    url: BINANCE_PUBLIC_BASE + '/aggTrades?symbol=' + binancePair(opts.symbol),
    rowsScanned: rounds * 1000,
    bytes: 0,
    gaps: { count: gapCount, missed: gapMissed },
    windowStart: trades.length ? trades[0].ts : null,
    windowEnd: trades.length ? trades[trades.length - 1].ts : null,
  };
} else if (opts.source === 'skill') {
  /* ---------- 通道：官方技能（binance-cli · spot agg-trades · 免密钥行情） ---------- */
  say('通道：官方技能（Binance Skills Hub · binance 技能 → binance-cli spot agg-trades）');
  say('说明：官方技能 references/spot.md 的 Market 区块行情命令无需鉴权；本通道只读行情，不涉及账户与交易。');
  say('命令：binance-cli spot agg-trades --symbol ' + binancePair(opts.symbol) + ' [--from-id <上次进度>] --limit 1000');
  progressInline('正在调用官方技能（' + opts.seconds + ' 秒）…');

  // 与 --live 相同的本地积累结构：跨运行累加
  const liveKey = 'cjx:skill:v1:spot:' + opts.symbol + ':' + intervalMs;
  let persisted = { lastId: null, trades: [] };
  try {
    const raw = store0[liveKey];
    if (raw) persisted = Object.assign(persisted, JSON.parse(raw));
  } catch (e) {
    /* 缓存损坏就从头积累 */
  }
  const seen = new Map();
  (persisted.trades || []).forEach((a) => seen.set(a[0], { id: a[0], ts: a[1], price: a[2], notional: a[3], dir: a[4] }));
  let maxId = Number(persisted.lastId) || (seen.size ? Math.max.apply(null, Array.from(seen.keys())) : null);
  const before = seen.size;
  let gapMissed = 0;
  let gapCount = 0;
  let cliRounds = 0;

  const tstart = Date.now();
  while (Date.now() - tstart < opts.seconds * 1000) {
    let rows = [];
    try {
      rows = binanceCliAggTrades(opts.symbol, {
        limit: 1000,
        fromId: maxId !== null ? maxId + 1 : undefined,
      });
      cliRounds += 1;
      let added = 0;
      rows.forEach((r) => {
        if (maxId !== null && r.id <= maxId) return;
        if (seen.size && r.id > (maxId || 0) + 1 && added === 0) {
          gapMissed += r.id - (maxId || 0) - 1;
          gapCount += 1;
        }
        seen.set(r.id, r);
        added += 1;
      });
      if (rows.length) maxId = Math.max(maxId === null ? 0 : maxId, rows[rows.length - 1].id);
      // 一次拿满说明后面还有成交，立即继续翻页（不 sleep）
      if (rows.length >= 1000) continue;
      if (!market) {
        try {
          market = await fetchBinanceQuote(opts.symbol, opts.interval, 500);
        } catch (e) {
          /* 行情失败不影响逐笔积累 */
        }
      }
      progressInline('.');
    } catch (err) {
      progressInline('!');
    }
    await sleep(2000);
  }
  progressInline(' 完成\n');

  if (!market) market = await fetchBinanceQuote(opts.symbol, opts.interval, 500);

  store0[liveKey] = JSON.stringify({
    lastId: maxId,
    trades: Array.from(seen.values())
      .sort((a, b) => a.id - b.id)
      .slice(-20000)
      .map((t) => [t.id, t.ts, t.price, t.notional, t.dir]),
  });
  dirty = true;
  persist();

  trades = Array.from(seen.values())
    .sort((a, b) => a.ts - b.ts)
    .map((t) => ({ ts: t.ts, price: t.price, notional: t.notional, dir: t.dir }));
  candles = market.candles || [];
  coverage = coverageAgainstKlines(trades, candles, intervalMs);
  newTrades = Math.max(0, seen.size - before);
  elapsedSec = Math.round((Date.now() - tstart) / 1000);
  sourceInfo = {
    kind: 'skill',
    label: '官方技能 binance-cli（Skills Hub · spot agg-trades）',
    url: 'binance-cli spot agg-trades --symbol ' + binancePair(opts.symbol),
    rowsScanned: cliRounds * 1000,
    bytes: 0,
    gaps: { count: gapCount, missed: gapMissed },
    windowStart: trades.length ? trades[0].ts : null,
    windowEnd: trades.length ? trades[trades.length - 1].ts : null,
  };
} else {
  /* ---------- 通道三：实时逐笔（多平台公开接口，滚雪球积累） ---------- */
  let lastErr = null;
  progressInline('通道：实时逐笔（滚雪球积累 ' + opts.seconds + ' 秒）…');
  const t0 = Date.now();
  let rounds = 0;

  while (Date.now() - t0 < opts.seconds * 1000) {
    try {
      const env = await fetchTradesOnce();
      const res = store.ingest(env.rows || [], env.meta || {});
      newTrades += res.added;
      rounds += 1;
      if (rounds % 5 === 0) progressInline('.');
      if (!market) {
        try {
          market = await fetchMarketQuote();
        } catch (e) {
          /* 行情取失败不影响逐笔积累，下一轮再试 */
        }
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(2000);
  }
  progressInline(' 完成\n');
  store.save();
  persist();

  if (newTrades === 0 && lastErr) {
    console.error('取数失败：' + (lastErr.message || lastErr));
    process.exit(1);
  }

  if (!market) {
    try {
      market = await fetchMarketQuote();
    } catch (e) {
      market = null;
    }
  }

  trades = store.getRecentTrades(60000).map((t) => ({
    ts: t.t,
    price: t.price,
    notional: t.notional,
    dir: t.dir,
  }));
  candles = market && market.candles ? market.candles : [];
  coverage = store.computeCoverage(candles).overall;
}

const res = VerdictEngine.analyze({
  trades,
  candles,
  intervalMs,
  coverage,
  prevProfile: null,
  prevVerdict: null,
});

const bucketsSource = opts.source === 'official' ? null : store.getBuckets();
let structure = null;
if (res.profile && res.profile.ready) {
  if (bucketsSource) {
    structure = TradeClassifier.aggregate(bucketsSource, {
      ready: true,
      midThreshold: res.profile.mid,
      largeThreshold: res.profile.large,
    });
  } else {
    // 官方通道没有逐步的直方图桶，用逐笔直接聚合出「每档占比」做展示与对账
    const sum = { large: 0, mid: 0, small: 0 };
    let total = 0;
    trades.forEach((t) => {
      const tier = t.notional >= res.profile.large ? 'large' : t.notional >= res.profile.mid ? 'mid' : 'small';
      sum[tier] += t.notional;
      total += t.notional;
    });
    structure = {
      ready: true,
      totalNotional: total,
      largeShare: total > 0 ? sum.large / total : null,
      smallShare: total > 0 ? sum.small / total : null,
      perBucket: [],
    };
  }
}

const closedBuckets = structure && structure.perBucket.length
  ? structure.perBucket.filter((b) => Number.isFinite(b.t0) && b.t0 + intervalMs <= Date.now())
  : [];

const stats = store.getStats();

/* ============================================================
 * 七、输出
 * ============================================================ */

const payload = {
  ok: res.stage === 'ok',
  symbol: opts.symbol,
  market: opts.market,
  interval: opts.interval,
  source: sourceInfo ? sourceInfo.kind : 'realtime',
  requestedSource: opts.skillFallback ? 'skill' : null,
  dataUrl: sourceInfo ? sourceInfo.url : null,
  window:
    sourceInfo && Number.isFinite(sourceInfo.windowStart)
      ? {
          date: opts.source === 'official' ? opts.date : null,
          startUtc: new Date(sourceInfo.windowStart).toISOString(),
          endUtc: new Date(sourceInfo.windowEnd).toISOString(),
        }
      : null,
  collectedSeconds: elapsedSec,
  newTrades,
  samples: opts.source === 'realtime' ? stats.totalIngested : trades.length,
  bucketsClosed: closedBuckets.length,
  coverage,
  verdict: res.stage === 'ok' ? res.verdict.label : '数据积累中',
  verdictKey: res.verdict.key,
  confidence: res.confidence,
  scores: res.scores,
  tiers: res.stage === 'ok' ? res.tiers : null,
  thresholds: res.profile && res.profile.ready ? { mid: res.profile.mid, large: res.profile.large } : null,
  evidence: res.evidence,
  note:
    res.stage === 'ok'
      ? null
      : opts.source === 'official'
        ? '该窗口样本或时间桶不足：换更长的窗口（例如 --window 4h），或换更活跃的币种'
        : '样本或时间桶不足，继续积累后重新运行即可',
};

if (opts.json) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(res.stage === 'ok' ? 0 : 2);
}

const line = '─'.repeat(56);
console.log('');
console.log(line);
console.log('  成交结构拆解智能体 · ' + opts.symbol.replace('_', '/') +
  '（' + (opts.market === 'spot' ? '现货' : '永续合约') + ' · ' + INTERVALS[opts.interval].label + '）');
console.log(line);

if (market && market.ticker) {
  const t = market.ticker;
  console.log('  最新价        ' + (Number.isFinite(t.last) ? t.last : '—'));
  console.log('  24 小时涨跌   ' + (Number.isFinite(t.changePercent24h) ? (t.changePercent24h >= 0 ? '+' : '') + t.changePercent24h.toFixed(2) + '%' : '—'));
  if (Number.isFinite(t.quoteVolume24h)) console.log('  24 小时成交额 ' + t.quoteVolume24h.toLocaleString('zh-CN', { maximumFractionDigits: 0 }));
} else if (trades.length) {
  const first = trades[0];
  const last = trades[trades.length - 1];
  const sumNot = trades.reduce((a, t) => a + t.notional, 0);
  console.log('  窗口首价      ' + first.price);
  console.log('  窗口末价      ' + last.price +
    '（' + ((last.price / first.price - 1) * 100 >= 0 ? '+' : '') + ((last.price / first.price - 1) * 100).toFixed(2) + '%）');
  console.log('  窗口成交额    ' + sumNot.toLocaleString('zh-CN', { maximumFractionDigits: 0 }));
}

console.log('');
console.log('  数据质量');
if (opts.source === 'official') {
  console.log('    数据来源      Binance 官方公开数据仓库（aggTrades，无需密钥）');
  console.log('    覆盖区间      ' + opts.date + ' ' +
    new Date(sourceInfo.windowStart).toISOString().slice(11, 16) + ' → ' +
    new Date(sourceInfo.windowEnd).toISOString().slice(11, 16) + ' UTC');
  console.log('    解析逐笔      ' + trades.length.toLocaleString('zh-CN') + ' 笔（扫描 ' +
    sourceInfo.rowsScanned.toLocaleString('zh-CN') + ' 行）');
  console.log('    下载耗时      ' + elapsedSec + ' 秒（' + (sourceInfo.bytes / 1048576).toFixed(1) + ' MB）');
} else if (opts.source === 'live' || opts.source === 'skill') {
  const buckets = new Set(trades.map((t) => Math.floor(t.ts / intervalMs)));
  console.log('    数据来源      ' + (opts.source === 'skill'
    ? '官方技能 binance-cli · spot agg-trades（Binance Skills Hub，无需密钥）'
    : 'Binance 官方公开行情接口（aggTrades，无需密钥）' + (opts.skillFallback ? '［官方技能回退：未安装 binance-cli］' : '')));
  console.log('    累计逐笔样本  ' + trades.length.toLocaleString('zh-CN') + ' 笔（本次新增 ' + newTrades + ' 笔）');
  console.log('    覆盖时间桶    ' + buckets.size + ' 个' +
    (buckets.size < VerdictEngine.MIN_BUCKETS ? '（至少需要 ' + VerdictEngine.MIN_BUCKETS + ' 个已完结桶）' : ''));
  console.log('    覆盖率        ' + (coverage === null ? '待对账' : (Math.min(1, coverage) * 100).toFixed(1) + '%（与官方K线成交额对账）'));
  console.log('    采集缺口      ' + (sourceInfo.gaps.count === 0 ? '无' :
    sourceInfo.gaps.count + ' 次 · 共约 ' + sourceInfo.gaps.missed + ' 笔（已如实标记）'));
} else {
  console.log('    累计逐笔样本  ' + stats.totalIngested.toLocaleString('zh-CN') + ' 笔（本次新增 ' + newTrades + ' 笔）');
  console.log('    已完结时间桶  ' + closedBuckets.length + ' 个' +
    (closedBuckets.length < VerdictEngine.MIN_BUCKETS ? '（至少需要 ' + VerdictEngine.MIN_BUCKETS + ' 个）' : ''));
  console.log('    覆盖率        ' + (coverage === null ? '待对账' : (Math.min(1, coverage) * 100).toFixed(1) + '%'));
  console.log('    采集缺口      ' + (stats.gapCount === 0 ? '无' : stats.gapCount + ' 次，共约 ' + stats.totalMissed + ' 笔（已如实标记）'));
}

if (res.stage !== 'ok') {
  console.log('');
  console.log('  结论：数据积累中');
  console.log('    ' + payload.note);
  if (opts.source === 'official') {
    console.log('    建议：node agent.mjs ' + opts.symbol.split('_')[0] + ' --official --window 4h' +
      '（更长的窗口 = 更多的桶与样本）');
  } else if (opts.source === 'live' || opts.source === 'skill') {
    console.log('    建议：node agent.mjs ' + opts.symbol.split('_')[0] + ' --live --seconds 420' +
      '（官方公开行情接口，1 分钟档约 7 分钟出结论）');
    console.log('    想立刻拿到完整结论：node agent.mjs ' + opts.symbol.split('_')[0] + ' --official（官方历史数据）');
  } else {
    console.log('    建议：node agent.mjs ' + opts.symbol.split('_')[0] + ' ' + opts.interval + ' --seconds 420');
    console.log('    提醒：本地积累会保留，过一会儿再跑一次即可继续累加（换币种请先 --reset）');
  }
  console.log(line);
  console.log('');
  process.exit(2);
}

const fmtUsd = (v) => {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + ' 万';
  return v.toFixed(0);
};
const pct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '—');

console.log('');
console.log('  成交结构拆解（分档线：中单 ≥ ' + fmtUsd(res.profile.mid) + '　大单 ≥ ' + fmtUsd(res.profile.large) + '）');
console.log('    档位    成交额        占比     主动买        主动卖        净额');
[['大单', res.tiers.large], ['中单', res.tiers.mid], ['小单', res.tiers.small]].forEach(([name, t]) => {
  const pad = (s, n) => String(s).padEnd(n);
  console.log('    ' + pad(name, 6) + pad(fmtUsd(t.total), 13) + pad(pct(t.share), 8) +
    pad(fmtUsd(t.buy), 14) + pad(fmtUsd(t.sell), 14) + (t.net >= 0 ? '+' : '') + fmtUsd(t.net));
});

console.log('');
console.log('  主力行为研判');
console.log('    结论：' + res.verdict.label + '　（置信度 ' + res.confidence + '% · 领先优势 ' + Math.round(res.verdict.margin || 0) + ' 分）');
console.log('    ' + res.verdict.desc);
console.log('');
console.log('    主力吃货   ' + res.scores.accum);
console.log('    主力出货   ' + res.scores.distrib);
console.log('    散户乱交易 ' + res.scores.retail);

if (res.evidence.support.length) {
  console.log('');
  console.log('  支持证据');
  res.evidence.support.forEach((e) => console.log('    · ' + e.text));
}
if (res.evidence.against.length) {
  console.log('');
  console.log('  反对证据');
  res.evidence.against.forEach((e) => console.log('    · ' + e.text));
}

console.log('');
console.log('  说明：本结果基于公开逐笔成交的程序化统计，仅用于市场数据观测与结构分析，');
console.log('        不构成任何投资建议。');
console.log(line);
console.log('');
process.exit(0);
