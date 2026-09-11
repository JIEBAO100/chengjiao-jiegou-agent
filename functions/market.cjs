/**
 * Netlify Function：/api/market
 * 作用：行情摘要 + K线代理（K线带计价成交额 sum，供前端做逐笔覆盖率对账）
 * 说明：数据来自综合交易平台的公开行情接口，真实数据，不做任何人工编造
 */

const { getMarket } = require('./_data.cjs');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

// 行情变化快，缓存 6 秒：同一批用户短时间内的重复请求直接命中，减少对交易所的请求
const CACHE_TTL_MS = 6000;
const cache = new Map();
const CACHE_MAX = 200; // 缓存条目上限，防止内存无限增长

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const q = event.queryStringParameters || {};
  const market = String(q.market || 'perp').toLowerCase() === 'spot' ? 'spot' : 'perp';
  const symbol = String(q.symbol || 'BTC_USDT').trim().toUpperCase();
  const interval = String(q.interval || '15m').trim();
  const limit = Math.min(Math.max(Number(q.limit) || 300, 60), 500);

  const cacheKey = `${market}|${symbol}|${interval}|${limit}`;
  const item = cache.get(cacheKey);
  if (item && Date.now() - item.time < CACHE_TTL_MS) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ...item.value, cached: true }),
    };
  }

  try {
    const data = await getMarket({ market, symbol, interval, limit });

    const payload = {
      ok: true,
      ...data,
      candleCount: data.candles.length,
      fetchedAt: new Date().toISOString(),
      cached: false,
    };

    if (cache.size > CACHE_MAX) cache.clear();
    cache.set(cacheKey, { time: Date.now(), value: payload });
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(payload) };
  } catch (err) {
    // 失败时如实返回原因，绝不用演示数据顶替
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        ok: false,
        error: err && err.message ? err.message : '行情接口获取失败',
        market,
        symbol,
        interval,
        fetchedAt: new Date().toISOString(),
      }),
    };
  }
};
