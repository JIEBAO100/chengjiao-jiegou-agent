/**
 * 接口调用层（通道调度）
 *
 * 统一请求行情数据，按数据类型选择通道策略：
 *
 *   K线 / 币种列表（低频，约 30 秒一次）：
 *     通道一（优先）：同域名下的 /api 云端接口代理（Netlify Functions / 本地 dev-server）
 *     通道二（兜底）：浏览器直连交易所公开接口
 *
 *   逐笔成交（高频，约 2 秒一次）：
 *     通道一（优先）：浏览器直连交易所公开接口
 *     通道二（兜底）：同域名下的 /api 云端接口代理
 *     —— 逐笔轮询如果走云端，免费额度很快会被耗尽，所以反过来优先直连
 *
 * 说明：两条通道取到的都是交易所公开接口的真实数据，口径完全一致
 * （逐笔的美元换算统一在 trade-store.js 一处完成）；
 * 接口失败时明确提示真实原因，不会用任何演示数据顶替。
 */

const API_BASE = ''; // 留空代表同域名下的 /api，本地和线上都适用

/**
 * 请求 /api 接口
 * @returns {Promise<{available:boolean, data:object|null, reason:string}>}
 *   available=false 表示「这个页面上根本没有部署云端函数」，需要走浏览器直连兜底
 */
async function requestViaProxy(path, params, timeoutMs = 20000) {
  let url;
  try {
    url = new URL(API_BASE + path, window.location.origin);
  } catch (e) {
    return { available: false, data: null, reason: '页面地址异常，无法拼接接口地址' };
  }
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });

    // 404 说明这个地址没有对应的云端函数（例如纯静态部署）
    if (res.status === 404) {
      return { available: false, data: null, reason: '页面上没有部署云端接口（404）' };
    }

    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();

    // 返回的是网页而不是 JSON，说明请求被前端的单页兜底规则接走了，同样视为没有云端接口
    if (!contentType.includes('json')) {
      return {
        available: false,
        data: null,
        reason: '接口地址返回的不是数据（被页面兜底规则接管）',
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { available: false, data: null, reason: '接口返回内容无法解析' };
    }

    // 缺少 ok 字段说明这不是我们的接口，不能当成有效数据使用
    if (!parsed || typeof parsed.ok !== 'boolean') {
      return { available: false, data: null, reason: '接口返回结构不符合预期' };
    }

    return { available: true, data: parsed, reason: '' };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { available: false, data: null, reason: '接口请求超时' };
    }
    return { available: false, data: null, reason: '无法连接接口地址' };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
 * K线 / 币种列表：云端代理优先，直连兜底
 * ============================================================ */

/**
 * 统一的取数入口
 * @param {'market'|'symbols'} kind
 */
async function loadData(kind, params) {
  const path = kind === 'market' ? '/api/market' : '/api/symbols';

  // ---------- 通道一：云端接口代理 ----------
  const proxy = await requestViaProxy(path, params);

  if (proxy.available) {
    if (proxy.data.ok === true) {
      return { ...proxy.data, via: 'proxy' };
    }
    // 云端接口本身是通的，但上游交易所取数失败。
    // 这种情况再试一次浏览器直连：两者的出口网络不同，直连有可能成功。
    const direct = await loadDirect(kind, params);
    if (direct && direct.ok === true) return direct;
    // 两条通道都失败，如实汇报云端返回的失败原因
    throw new Error(proxy.data.error || '行情接口返回失败');
  }

  // ---------- 通道二：浏览器直连兜底 ----------
  const direct = await loadDirect(kind, params);
  if (direct) return direct;

  throw new Error(
    '无法获取行情数据。请确认网络可以访问交易所公开接口后重试。' + (proxy.reason ? `（${proxy.reason}）` : ''),
  );
}

/** 调用浏览器直连模块，模块缺失时返回 null 由上层抛错 */
async function loadDirect(kind, params) {
  if (!window.DataDirect) return null;
  try {
    if (kind === 'market') {
      return await window.DataDirect.fetchMarketEnvelope(params);
    }
    return await window.DataDirect.fetchSymbolsEnvelope(params);
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : '浏览器直连取数失败',
      via: 'direct',
      list: [],
    };
  }
}

/** 取行情与K线 */
async function fetchMarket({ market, symbol, interval, limit }) {
  const data = await loadData('market', { market, symbol, interval, limit });
  if (!data || data.ok !== true) {
    throw new Error((data && data.error) || '行情接口返回失败');
  }
  return data;
}

/** 取币种列表 */
async function fetchSymbols({ market, top }) {
  const data = await loadData('symbols', { market, top });
  if (!data || data.ok !== true) {
    throw new Error((data && data.error) || '币种列表返回失败');
  }
  return data;
}

/* ============================================================
 * 逐笔成交：浏览器直连优先，云端代理兜底（与上面的顺序相反）
 * ============================================================ */

async function fetchTrades({ market, symbol, limit }) {
  // ---------- 通道一：浏览器直连 ----------
  // 逐笔是 2 秒级高频轮询，默认直连，不消耗云端函数免费额度
  let directFailReason = '';
  if (window.DataDirect) {
    try {
      const d = await window.DataDirect.fetchTradesEnvelope({ market, symbol, limit });
      if (d && d.ok === true) return d;
      directFailReason = (d && d.error) || '浏览器直连返回失败';
    } catch (err) {
      directFailReason = err && err.message ? err.message : '浏览器直连取数失败';
    }
  } else {
    directFailReason = '页面未加载直连模块';
  }

  // ---------- 通道二：云端接口代理兜底 ----------
  // 直连失败的常见原因：网络策略限制、跨域被拒、交易所临时不可达
  const proxy = await requestViaProxy('/api/trades', { market, symbol, limit });
  if (proxy.available) {
    if (proxy.data.ok === true) {
      return { ...proxy.data, via: 'proxy' };
    }
    // 云端也失败了：如实返回上游的真实原因
    throw new Error(proxy.data.error || '逐笔成交接口返回失败');
  }

  throw new Error(
    '无法获取逐笔成交数据。浏览器直连失败：' +
      directFailReason +
      '；云端代理不可用：' +
      (proxy.reason || '未知原因'),
  );
}

window.ApiClient = { fetchMarket, fetchSymbols, fetchTrades };
