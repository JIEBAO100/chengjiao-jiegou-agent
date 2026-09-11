/**
 * 共用数据模块（云端版，运行在 Netlify Functions / 本地 dev-server）
 *
 * 作用：统一封装综合交易平台（Gate）的公开行情接口，只读取、不涉及任何交易权限。
 * 覆盖：K线（含计价成交额）、行情摘要、币种列表、合约信息（乘数等）、逐笔成交原始记录。
 *
 * 重要说明：
 * 1. 只调用公开行情接口，不需要 API Key，不保存任何私钥，不涉及下单。
 * 2. 逐笔成交在这里只做「原始记录透传 + 附带合约乘数」，
 *    换算成美元名义额的口径统一放在前端 trade-store.js 一处维护，
 *    这样浏览器直连通道和云端代理通道的口径永远一致。
 * 3. ⚠️ data-direct.js 是本模块的浏览器版本，取数与换算口径必须完全一致。
 *    修改其中一个时，务必同步修改另一个。
 */

const TIMEOUT_MS = 12000; // 单个请求最长等待时间，避免页面一直转圈

/**
 * 把交易所返回的英文错误码翻译成中文提示。
 * 交易所的报错是英文的，直接显示给用户会看不懂，所以统一在这里转换。
 * ⚠️ 此函数与 data-direct.js 中的同名函数必须保持一致。
 */
function describeUpstreamError(status, text) {
  const raw = String(text || '');
  const known = {
    CONTRACT_NOT_FOUND: '该合约在交易所不存在（可能是币种名写错，或该币种没有永续合约）',
    CURRENCY_PAIR_NOT_FOUND: '该交易对在交易所不存在（可能是币种名写错，或该币种没有现货）',
    INVALID_CURRENCY_PAIR: '交易对名称格式不正确，正确格式类似 BTC_USDT',
    INVALID_PARAM_VALUE: '请求参数不符合交易所要求（可能是周期不被支持）',
    TOO_MANY_REQUESTS: '请求过于频繁，被交易所限流，请稍后重试',
    FORBIDDEN: '交易所拒绝了这次请求（可能被限流或该地区不可访问）',
  };
  const hit = Object.keys(known).find((k) => raw.includes(k));
  if (hit) return known[hit];
  // 404 通常是币种或交易对不存在
  if (status === 404) return '交易所找不到这个币种或交易对';
  if (status === 429) return '请求过于频繁，被交易所限流，请稍后重试';
  if (status >= 500) return '交易所服务临时异常，请稍后重试';
  return `交易所接口返回了错误（状态码 ${status}）：${raw.slice(0, 120)}`;
}

/** 带超时的 fetch，返回 JSON；失败时抛出可读的中文错误 */
async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(describeUpstreamError(res.status, text));
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('交易所返回的内容无法解析，可能是接口临时调整');
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('交易所接口响应超时（超过 12 秒）');
    }
    // 网络层面的失败（断网、被拦截、DNS 解析失败）
    if (err.name === 'TypeError' || String(err.message || '').includes('fetch failed')) {
      throw new Error('网络无法连接交易所接口，请稍后重试');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 把数字安全转成 Number，失败返回 null，避免出现 NaN 污染前端 */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ============================================================
 * 周期定义：只保留交易所真实支持的档位，绝不本地合成不存在的周期
 * ============================================================ */

const INTERVALS = {
  '1m': { ms: 60 * 1000, label: '1分钟' },
  '5m': { ms: 5 * 60 * 1000, label: '5分钟' },
  '15m': { ms: 15 * 60 * 1000, label: '15分钟' },
  '30m': { ms: 30 * 60 * 1000, label: '30分钟' },
  '1h': { ms: 60 * 60 * 1000, label: '1小时' },
  '4h': { ms: 4 * 60 * 60 * 1000, label: '4小时' },
  '1d': { ms: 24 * 60 * 60 * 1000, label: '1天' },
};

function normalizeInterval(raw) {
  const key = String(raw || '15m').trim();
  return INTERVALS[key] ? key : '15m';
}

/* ============================================================
 * Gate 部分（主数据源）
 * ============================================================ */

const GATE_BASE = 'https://api.gateio.ws/api/v4';

/**
 * Gate 现货K线：返回数组套数组，字段顺序固定。
 * 字段顺序：[时间戳(秒), 计价成交额, 收盘, 最高, 最低, 开盘, 基础成交量, 是否收线]
 * 计价成交额（sum）保留下来，供前端做逐笔覆盖率对账。
 */
async function gateSpotCandles(pair, interval, limit) {
  const url = `${GATE_BASE}/spot/candlesticks?currency_pair=${encodeURIComponent(pair)}&interval=${interval}&limit=${limit}`;
  const rows = await fetchJson(url);
  if (!Array.isArray(rows)) {
    throw new Error('综合交易平台现货K线返回结构异常，请确认交易对是否存在');
  }
  return rows
    .map((r) => ({
      t: num(r[0]) !== null ? num(r[0]) * 1000 : null,
      sum: num(r[1]),
      c: num(r[2]),
      h: num(r[3]),
      l: num(r[4]),
      o: num(r[5]),
      v: num(r[6]),
    }))
    .filter((c) => c.t !== null && c.c !== null)
    .sort((a, b) => a.t - b.t)
    .slice(-limit);
}

/**
 * Gate 永续合约K线：返回对象数组。
 * sum 字段是计价货币（USDT）成交额，保留下来供逐笔覆盖率对账。
 */
async function gateFuturesCandles(contract, interval, limit) {
  const url = `${GATE_BASE}/futures/usdt/candlesticks?contract=${encodeURIComponent(contract)}&interval=${interval}&limit=${limit}`;
  const rows = await fetchJson(url);
  if (!Array.isArray(rows)) {
    throw new Error('综合交易平台永续K线返回结构异常，请确认合约是否存在');
  }
  return rows
    .map((r) => ({
      t: num(r.t) !== null ? num(r.t) * 1000 : null,
      o: num(r.o),
      h: num(r.h),
      l: num(r.l),
      c: num(r.c),
      v: num(r.v),
      sum: num(r.sum),
    }))
    .filter((c) => c.t !== null && c.c !== null)
    .sort((a, b) => a.t - b.t)
    .slice(-limit);
}

/** Gate 现货行情摘要 */
async function gateSpotTicker(pair) {
  const url = `${GATE_BASE}/spot/tickers?currency_pair=${encodeURIComponent(pair)}`;
  const rows = await fetchJson(url);
  const t = Array.isArray(rows) ? rows[0] : null;
  if (!t) throw new Error('综合交易平台现货行情返回为空，请确认交易对是否存在');
  return {
    last: num(t.last),
    changePercent24h: num(t.change_percentage),
    high24h: num(t.high_24h),
    low24h: num(t.low_24h),
    baseVolume24h: num(t.base_volume),
    quoteVolume24h: num(t.quote_volume),
    bestBid: num(t.highest_bid),
    bestAsk: num(t.lowest_ask),
    markPrice: null,
    indexPrice: null,
    openInterestUsd: null,
    fundingAnnualized: null,
    fundingRaw: null,
    fundingIntervalLabel: null,
  };
}

/** Gate 永续行情摘要；持仓量与资金费率需要额外换算口径 */
async function gateFuturesTicker(contract) {
  const url = `${GATE_BASE}/futures/usdt/tickers?contract=${encodeURIComponent(contract)}`;
  const rows = await fetchJson(url);
  const t = Array.isArray(rows) ? rows[0] : null;
  if (!t) throw new Error('综合交易平台永续行情返回为空，请确认合约是否存在');
  const markPrice = num(t.mark_price);
  // Gate 永续持仓量以「张」为单位，需要乘合约乘数再乘标记价换成美元
  const totalSize = num(t.total_size);
  const multiplier = num(t.quanto_multiplier);
  let openInterestUsd = null;
  if (totalSize !== null && multiplier !== null && markPrice !== null) {
    openInterestUsd = totalSize * multiplier * markPrice;
  }
  // Gate USDT 永续的资金费率按 8 小时结算；换算年化需 × 3 次/天 × 365 天
  const fundingRaw = num(t.funding_rate);
  return {
    last: num(t.last),
    changePercent24h: num(t.change_percentage),
    high24h: num(t.high_24h),
    low24h: num(t.low_24h),
    // volume_24h_base 为基础币成交额，volume_24h_quote 为计价币成交额
    baseVolume24h: num(t.volume_24h_base),
    quoteVolume24h: num(t.volume_24h_quote),
    bestBid: num(t.highest_bid),
    bestAsk: num(t.lowest_ask),
    markPrice,
    indexPrice: num(t.index_price),
    openInterestUsd,
    fundingRaw,
    fundingIntervalLabel: '8小时',
    fundingAnnualized: fundingRaw === null ? null : fundingRaw * 3 * 365,
  };
}

/** Gate 可交易币种列表，按 24 小时成交额排序取前 N 个 */
async function gateSymbols(market, topN) {
  if (market === 'perp') {
    const rows = await fetchJson(`${GATE_BASE}/futures/usdt/tickers`);
    return rows
      .filter((r) => String(r.contract || '').endsWith('_USDT'))
      .map((r) => ({
        symbol: r.contract,
        display: String(r.contract || '').replace('_USDT', '/USDT'),
        base: String(r.contract || '').replace('_USDT', ''),
        quoteVolume24h: num(r.volume_24h_quote),
        changePercent24h: num(r.change_percentage),
        last: num(r.last),
      }))
      .filter((s) => s.symbol && s.quoteVolume24h !== null)
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      .slice(0, topN);
  }
  const rows = await fetchJson(`${GATE_BASE}/spot/tickers`);
  return rows
    .filter((r) => String(r.currency_pair || '').endsWith('_USDT'))
    .map((r) => ({
      symbol: r.currency_pair,
      display: String(r.currency_pair || '').replace('_USDT', '/USDT'),
      base: String(r.currency_pair || '').replace('_USDT', ''),
      quoteVolume24h: num(r.quote_volume),
      changePercent24h: num(r.change_percentage),
      last: num(r.last),
    }))
    .filter((s) => s.symbol && s.quoteVolume24h !== null)
    .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
    .slice(0, topN);
}

/* ============================================================
 * 合约信息（逐笔换算必需的乘数来自这里）
 * ============================================================ */

// 合约乘数等基本信息几乎不变，缓存 10 分钟足够
const contractInfoCache = new Map();
const CONTRACT_INFO_TTL_MS = 10 * 60 * 1000;

/**
 * Gate 单个永续合约的详细信息（乘数、标记价、资金费率、持仓量等）。
 * 逐笔成交的「张数」必须乘上合约乘数才能换算成币量、再换算成美元名义额。
 */
async function gateFuturesContractInfo(contract) {
  const hit = contractInfoCache.get(contract);
  if (hit && Date.now() - hit.time < CONTRACT_INFO_TTL_MS) return hit.value;

  const url = `${GATE_BASE}/futures/usdt/contracts/${encodeURIComponent(contract)}`;
  const c = await fetchJson(url);
  if (!c || typeof c !== 'object') {
    throw new Error('综合交易平台合约信息返回结构异常');
  }
  const info = {
    quantoMultiplier: num(c.quanto_multiplier),
    markPrice: num(c.mark_price),
    fundingRate: num(c.funding_rate),
    fundingInterval: num(c.funding_interval),
    openInterest: num(c.open_interest),
  };
  if (info.quantoMultiplier === null || info.quantoMultiplier <= 0) {
    throw new Error('综合交易平台未返回该合约的乘数信息，无法换算逐笔成交金额');
  }
  contractInfoCache.set(contract, { time: Date.now(), value: info });
  return info;
}

/* ============================================================
 * 逐笔成交（原始记录透传，换算在前端统一做）
 * ============================================================ */

/**
 * Gate 永续逐笔成交：返回交易所原始记录。
 * 字段：{ id, create_time_ms, size（正=主动买、负=主动卖，单位：张）, price }
 * 公开接口只提供最近约 1000 条，没有历史翻页，历史靠前端滚雪球积累。
 */
async function gateFuturesTradesRaw(contract, limit) {
  const lim = Math.min(Math.max(Number(limit) || 1000, 1), 1000);
  const url = `${GATE_BASE}/futures/usdt/trades?contract=${encodeURIComponent(contract)}&limit=${lim}`;
  const rows = await fetchJson(url);
  if (!Array.isArray(rows)) {
    throw new Error('综合交易平台永续逐笔成交返回结构异常');
  }
  return rows;
}

/**
 * Gate 现货逐笔成交：返回交易所原始记录。
 * 字段：{ id, create_time_ms, side（buy/sell，主动方向）, amount, price }
 * 注意：现货方向记在 side 字段上，与永续的 size 正负号写法不同，
 * 两种口径的统一换算都在前端 trade-store.js 完成。
 */
async function gateSpotTradesRaw(pair, limit) {
  const lim = Math.min(Math.max(Number(limit) || 1000, 1), 1000);
  const url = `${GATE_BASE}/spot/trades?currency_pair=${encodeURIComponent(pair)}&limit=${lim}`;
  const rows = await fetchJson(url);
  if (!Array.isArray(rows)) {
    throw new Error('综合交易平台现货逐笔成交返回结构异常');
  }
  return rows;
}

/* ============================================================
 * 对外统一入口
 * ============================================================ */

/**
 * 取行情与K线（含逐笔对账所需的计价成交额 sum）
 * @param {string} market  spot | perp
 * @param {string} symbol  交易对 / 合约名，例如 BTC_USDT
 * @param {string} interval 周期
 * @param {number} limit    K线根数
 */
async function getMarket({ market, symbol, interval, limit = 300 }) {
  const iv = normalizeInterval(interval);
  const isPerp = market !== 'spot';
  const pair = String(symbol || 'BTC_USDT').toUpperCase();

  const ticker = isPerp ? await gateFuturesTicker(pair) : await gateSpotTicker(pair);
  const candles = isPerp
    ? await gateFuturesCandles(pair, iv, limit)
    : await gateSpotCandles(pair, iv, limit);
  if (candles.length < 30) {
    throw new Error(`综合交易平台返回的K线数量不足（只有 ${candles.length} 根），无法绘图`);
  }
  return {
    platform: 'gate',
    market: isPerp ? 'perp' : 'spot',
    symbol: pair,
    display: pair.replace('_USDT', '/USDT'),
    interval: iv,
    intervalLabel: INTERVALS[iv].label,
    sourceLabel: isPerp
      ? '综合交易平台公开行情接口（USDT 永续合约）'
      : '综合交易平台公开行情接口（现货）',
    ticker,
    candles,
  };
}

module.exports = {
  INTERVALS,
  normalizeInterval,
  getMarket,
  gateSymbols,
  gateFuturesContractInfo,
  gateFuturesTradesRaw,
  gateSpotTradesRaw,
};
