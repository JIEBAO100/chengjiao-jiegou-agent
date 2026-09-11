/**
 * Netlify Function：/api/trades
 *
 * 作用：逐笔成交代理。逐笔数据是本项目的生命线（大小单拆解全靠它）。
 *
 * 通道策略（重要）：
 *   前端默认「浏览器直连」交易所获取逐笔（约 2 秒一次的高频轮询），
 *   本接口只做直连失败时的兜底 —— 这样常规流量不消耗 Functions 免费额度。
 *
 * 缓存：TTL 2 秒。同一个合约在 2 秒内的重复轮询直接命中内存缓存，
 *       既保护交易所接口，也让多个访客共享同一次上游请求。
 *
 * 口径：返回「交易所原始逐笔记录 + 合约乘数」，美元名义额的换算
 *       统一在前端 trade-store.js 一处完成，保证直连 / 云端两条通道口径一致。
 */

const {
  gateFuturesTradesRaw,
  gateSpotTradesRaw,
  gateFuturesContractInfo,
} = require('./_data.cjs');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

const CACHE_TTL_MS = 2000;
const cache = new Map();
const CACHE_MAX = 100;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const q = event.queryStringParameters || {};
  const market = String(q.market || 'perp').toLowerCase() === 'spot' ? 'spot' : 'perp';
  const symbol = String(q.symbol || 'BTC_USDT').trim().toUpperCase();
  const limit = Math.min(Math.max(Number(q.limit) || 1000, 1), 1000);

  const cacheKey = `${market}|${symbol}|${limit}`;
  const item = cache.get(cacheKey);
  if (item && Date.now() - item.time < CACHE_TTL_MS) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ...item.value, cached: true }),
    };
  }

  try {
    let rows;
    let meta;

    if (market === 'perp') {
      // 永续：逐笔与合约信息并行取。乘数拿不到就无法换算金额，宁可整单失败并如实报错
      const [tradesRows, info] = await Promise.all([
        gateFuturesTradesRaw(symbol, limit),
        gateFuturesContractInfo(symbol),
      ]);
      rows = tradesRows;
      meta = { quantoMultiplier: info.quantoMultiplier, markPrice: info.markPrice };
    } else {
      // 现货：方向记在 side 字段上，不需要乘数
      rows = await gateSpotTradesRaw(symbol, limit);
      meta = {};
    }

    const payload = {
      ok: true,
      market,
      symbol,
      rows,
      meta,
      count: rows.length,
      fetchedAt: new Date().toISOString(),
      cached: false,
    };

    if (cache.size > CACHE_MAX) cache.clear();
    cache.set(cacheKey, { time: Date.now(), value: payload });
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(payload) };
  } catch (err) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        ok: false,
        error: err && err.message ? err.message : '逐笔成交接口获取失败',
        market,
        symbol,
        rows: [],
        count: 0,
        fetchedAt: new Date().toISOString(),
      }),
    };
  }
};
