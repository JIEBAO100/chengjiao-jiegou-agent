/**
 * 页面主逻辑
 *
 * 流程：加载全量币种（可搜索）→ 建立逐笔滚雪球存储 → 每 2 秒轮询逐笔
 *      → 每 30 秒刷新行情与K线 → 实时计算成交结构拆解与主力行为研判
 *
 * 原则：只展示接口真实返回的数据；接口失败时明确提示真实原因，
 *       绝不用演示数据顶替；样本不足时明说「数据积累中」，不硬给结论；
 *       页面在后台时自动暂停采集。
 */

(function () {
  'use strict';

  /* ============================================================
   * 配置与全局状态
   * ============================================================ */

  // 周期档位：只列交易所真实支持的值，绝不本地合成不存在的周期
  const INTERVALS = {
    '1m': { ms: 60 * 1000, label: '1分钟' },
    '5m': { ms: 5 * 60 * 1000, label: '5分钟' },
    '15m': { ms: 15 * 60 * 1000, label: '15分钟' },
    '30m': { ms: 30 * 60 * 1000, label: '30分钟' },
    '1h': { ms: 60 * 60 * 1000, label: '1小时' },
    '4h': { ms: 4 * 60 * 60 * 1000, label: '4小时' },
  };

  const POLL_BASE_MS = 2000;       // 逐笔轮询基础间隔
  const POLL_MAX_MS = 30000;       // 失败退避的上限间隔
  const MARKET_REFRESH_MS = 30000; // 行情与K线刷新间隔
  const SAVE_EVERY_POLLS = 5;      // 每 N 次成功轮询落一次本地缓存
  const ANALYZE_MIN_GAP_MS = 900;  // 两次结构分析之间的最小间隔（防止高频重算）
  const SYMBOL_TOP = { perp: 1200, spot: 2500 }; // 取全量名单：永续约 980、现货约 2000
  const DROP_LIMIT = 80;           // 下拉建议最多显示多少条

  const state = {
    market: 'perp',
    symbol: 'BTC_USDT',
    interval: '1m',   // 默认 1 分钟：结构类结论需要若干个已完结的时间桶，1 分钟档约 6 分钟就能出结果，15 分钟档要等一个多小时
    windowBuckets: 32,
    running: false,      // 用户意图：开始 / 停止采集
    store: null,         // 逐笔滚雪球存储实例
    chart: null,
    structChart: null,
    candles: [],
    marketData: null,
    pollTimer: null,
    pollDelayMs: POLL_BASE_MS,
    pollCount: 0,
    failStreak: 0,
    marketTimer: null,
    marketLoading: false,
    channel: null,       // 逐笔当前通道：direct | proxy
    restored: false,
    errorKind: null,     // 当前错误框显示的错误类型（同类型成功后才清除）
    symbols: [],         // 全量币种名单（搜索用）
    dropCursor: -1,      // 下拉键盘光标位置
    dropItems: [],       // 当前下拉里展示的条目
    prevProfile: null,   // 上一轮分档阈值档案（EMA 平滑用）
    prevVerdict: null,   // 上一轮判定（迟滞防抖用）
    analysis: null,      // 最近一次分析结果
    lastAnalysisAt: 0,   // 上次分析时间戳
  };

  const $ = (id) => document.getElementById(id);

  /* ============================================================
   * 数字格式化
   * ============================================================ */

  function fmtPrice(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 10000) return v.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
    if (abs >= 100) return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    if (abs >= 1) return v.toFixed(4);
    if (abs >= 0.01) return v.toFixed(5);
    return v.toPrecision(4);
  }

  /** 大数字换算成万 / 亿，方便中文阅读 */
  function fmtCompact(v, unit) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    let out;
    if (abs >= 1e8) out = (v / 1e8).toFixed(2) + ' 亿';
    else if (abs >= 1e4) out = (v / 1e4).toFixed(2) + ' 万';
    else out = v.toFixed(2);
    return unit ? out + ' ' + unit : out;
  }

  function fmtSignedPercent(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  function fmtUsdCompact(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e8) return '$' + (v / 1e8).toFixed(2) + ' 亿';
    if (abs >= 1e4) return '$' + (v / 1e4).toFixed(2) + ' 万';
    if (abs >= 1) return '$' + v.toFixed(0);
    return '$' + v.toFixed(2);
  }

  /** 距今多长时间（用于「最近一笔」这类显示） */
  function fmtTimeAgo(ts) {
    if (!Number.isFinite(ts)) return '—';
    const diff = Math.max(0, Date.now() - ts);
    if (diff < 3000) return '刚刚';
    if (diff < 60000) return Math.floor(diff / 1000) + ' 秒前';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    return Math.floor(diff / 3600000) + ' 小时前';
  }

  function fmtBucketRange(t0, intervalMs) {
    const a = new Date(t0);
    const b = new Date(t0 + intervalMs);
    const p = (n) => String(n).padStart(2, '0');
    const mmdd = `${p(a.getMonth() + 1)}-${p(a.getDate())}`;
    return `${mmdd} ${p(a.getHours())}:${p(a.getMinutes())} ~ ${p(b.getHours())}:${p(b.getMinutes())}`;
  }

  /* ============================================================
   * 状态栏与错误提示
   * ============================================================ */

  function setStatus(type, text) {
    const dot = $('statusDot');
    dot.className = 'status-dot' + (type ? ' is-' + type : '');
    $('statusText').textContent = text;
  }

  /**
   * 显示错误提示
   * @param {string} kind 错误类型标记（同类型的数据恢复成功后才会自动清除提示）
   */
  function showError(title, msg, kind) {
    $('errorTitle').textContent = title || '出现错误';
    $('errorText').textContent = msg || '';
    $('errorBox').hidden = false;
    state.errorKind = kind || null;
  }

  function clearError(kind) {
    // 只清除同类错误：逐笔恢复了不该把行情错误也顺手抹掉，反之亦然
    if (state.errorKind && kind && state.errorKind !== kind) return;
    $('errorBox').hidden = true;
    state.errorKind = null;
  }

  /* ============================================================
   * 控件
   * ============================================================ */

  /** 通用分段按钮控制 */
  function bindSegment(containerId, onChange) {
    const box = $(containerId);
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn || btn.disabled) return;
      box.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      onChange(btn.dataset.value);
    });
  }

  function applyMarketNote() {
    $('marketNote').textContent =
      state.market === 'perp'
        ? '永续合约提供资金费率与持仓量数据；逐笔成交带主动买卖方向'
        : '现货无资金费率与持仓量；逐笔方向来自成交记录的买卖标记';
  }

  /** 加载全量币种名单（搜索要覆盖整个市场，不能只取前几十个） */
  async function loadSymbols() {
    const input = $('symbolInput');
    const meta = $('symbolMeta');
    meta.textContent = '正在加载币种…';
    if (input) input.disabled = true;

    try {
      const data = await window.ApiClient.fetchSymbols({
        market: state.market,
        top: SYMBOL_TOP[state.market] || 1200,
      });
      const list = data.list || [];
      if (!list.length) throw new Error('接口没有返回任何可交易币种');

      state.symbols = list;

      // 保持当前选择；如果当前币种不在新列表里，则回退到列表第一个
      const exists = list.some((i) => i.symbol === state.symbol);
      if (!exists) state.symbol = list[0].symbol;

      meta.textContent =
        `已加载 ${list.length} 个币种（全市场，按 24 小时成交额排序）· 当前 ${state.symbol.replace('_', '/')}`;
      if (input) {
        input.disabled = false;
        input.value = '';
        input.placeholder = `搜索币种：共 ${list.length} 个，输入代号或名称`;
      }
      renderSymbolDrop('');
      $('consoleHint').textContent = `已加载 ${list.length} 个币种（含全部可交易合约/交易对），可直接在搜索框输入代号快速定位`;
    } catch (err) {
      state.symbols = [];
      meta.textContent = '币种列表加载失败';
      showError('币种列表获取失败', err.message || '未能取到可分析的币种列表', 'symbols');
      throw err;
    }
  }

  /* ============================================================
   * 币种搜索（输入即筛选，回车或点击选中）
   * ============================================================ */

  /** 按关键词过滤全量名单：代号完全匹配优先，其次前缀命中，最后任意包含 */
  function matchSymbols(query) {
    const kw = String(query || '').trim().toUpperCase();
    const list = state.symbols || [];
    if (!kw) return list.slice(0, DROP_LIMIT);

    const exact = [];
    const starts = [];
    const contains = [];
    list.forEach((item) => {
      const base = String(item.base || '').toUpperCase();
      const disp = String(item.display || '').toUpperCase();
      if (base === kw || disp === kw) exact.push(item);
      else if (base.indexOf(kw) === 0 || disp.indexOf(kw) === 0) starts.push(item);
      else if (base.indexOf(kw) >= 0 || disp.indexOf(kw) >= 0) contains.push(item);
    });
    return exact.concat(starts, contains).slice(0, DROP_LIMIT);
  }

  /** 渲染下拉建议列表 */
  function renderSymbolDrop(query) {
    const drop = $('symbolDrop');
    const input = $('symbolInput');
    if (!drop || !input) return;

    if (!state.symbols.length) {
      drop.hidden = true;
      return;
    }

    const items = matchSymbols(query);
    state.dropItems = items;
    if (state.dropCursor >= items.length) state.dropCursor = items.length - 1;

    if (!items.length) {
      drop.innerHTML = `<div class="symbol-drop-empty">没有匹配「${escapeHtml(query)}」的币种</div>`;
      drop.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      return;
    }

    drop.innerHTML =
      items
        .map((item, i) => {
          const vol = item.quoteVolume24h !== null && item.quoteVolume24h !== undefined
            ? fmtCompact(item.quoteVolume24h) + ' USDT'
            : '成交额 —';
          const cls =
            'symbol-opt' +
            (i === state.dropCursor ? ' is-cursor' : '') +
            (item.symbol === state.symbol ? ' is-current' : '');
          return (
            `<div class="${cls}" role="option" data-symbol="${escapeHtml(item.symbol)}" data-idx="${i}">` +
            `<span class="symbol-opt-name">${escapeHtml(String(item.display || item.symbol))}</span>` +
            `<span class="symbol-opt-vol">24h ${vol}</span>` +
            `</div>`
          );
        })
        .join('') +
      (state.symbols.length > items.length && query
        ? `<div class="symbol-drop-more">仅显示前 ${DROP_LIMIT} 条匹配，继续输入可缩小范围</div>`
        : '');

    drop.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function closeSymbolDrop() {
    const drop = $('symbolDrop');
    const input = $('symbolInput');
    if (drop) drop.hidden = true;
    if (input) input.setAttribute('aria-expanded', 'false');
    state.dropCursor = -1;
  }

  /** 选定币种：关闭下拉、清空搜索词、重建存储并重启采集 */
  async function pickSymbol(symbol) {
    if (!symbol) return;
    closeSymbolDrop();
    const input = $('symbolInput');
    if (input) input.value = '';
    const clear = $('symbolClear');
    if (clear) clear.hidden = true;

    if (symbol === state.symbol) {
      $('symbolMeta').textContent = `当前已是 ${symbol.replace('_', '/')}，无需切换`;
      return;
    }

    state.symbol = symbol;
    state.prevProfile = null; // 换币种后分档尺子重新校准，不能沿用上一个币的阈值
    state.prevVerdict = null;
    state.analysis = null;
    $('symbolMeta').textContent =
      `已切换到 ${symbol.replace('_', '/')} · 正在重建逐笔样本（换币种后需重新积累）`;
    await onConfigChange(false);
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 搜索框与下拉的交互绑定 */
  function bindSymbolSearch() {
    const input = $('symbolInput');
    const clear = $('symbolClear');
    const drop = $('symbolDrop');
    if (!input || !drop) return;

    input.addEventListener('input', () => {
      state.dropCursor = -1;
      const v = input.value;
      if (clear) clear.hidden = !v;
      renderSymbolDrop(v);
    });

    input.addEventListener('focus', () => {
      state.dropCursor = -1;
      renderSymbolDrop(input.value);
    });

    // 键盘操作：上下键移动、回车选中、Esc 关闭
    input.addEventListener('keydown', (e) => {
      const items = state.dropItems || [];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        if (drop.hidden) renderSymbolDrop(input.value);
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        const len = state.dropItems.length;
        state.dropCursor = (state.dropCursor + dir + len) % len;
        renderSymbolDrop(input.value);
        const cursorEl = drop.querySelector('.is-cursor');
        if (cursorEl && cursorEl.scrollIntoView) cursorEl.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const kw = String(input.value || '').trim().toUpperCase();
        // 选择优先级：键盘光标选中的 > 与关键词完全同名的 > 唯一匹配
        // （例如输入 DOGE 时若还存在 DOGE_USDT 与其它同名前缀币，优先取完全同名的那一个）
        const exact = kw
          ? items.filter(
              (i) =>
                String(i.base || '').toUpperCase() === kw || String(i.display || '').toUpperCase() === kw,
            )
          : [];
        const pick =
          state.dropCursor >= 0 && items[state.dropCursor]
            ? items[state.dropCursor]
            : exact.length
              ? exact[0]
              : items.length === 1
                ? items[0]
                : null;
        if (pick) pickSymbol(pick.symbol);
        else if (items.length > 1) {
          $('symbolMeta').textContent = `匹配到 ${items.length} 个币种，用上下键选择后回车确认`;
        }
      } else if (e.key === 'Escape') {
        closeSymbolDrop();
      }
    });

    // 点击下拉条目即选中
    drop.addEventListener('mousedown', (e) => {
      const opt = e.target.closest('.symbol-opt');
      if (!opt) return;
      e.preventDefault(); // 防止输入框先失焦
      pickSymbol(opt.dataset.symbol);
    });

    if (clear) {
      clear.addEventListener('click', () => {
        input.value = '';
        clear.hidden = true;
        state.dropCursor = -1;
        input.focus();
        renderSymbolDrop('');
      });
    }

    // 点击页面其它地方关闭下拉
    document.addEventListener('click', (e) => {
      if (e.target === input || drop.contains(e.target)) return;
      closeSymbolDrop();
    });
  }

  /* ============================================================
   * 逐笔滚雪球：创建、轮询、暂停
   * ============================================================ */

  function createStore() {
    state.store = window.TradeStore.create({
      market: state.market,
      symbol: state.symbol,
      intervalMs: INTERVALS[state.interval].ms,
      maxTrades: 20000,
      maxBuckets: 240,
    });
    state.restored = state.store.restore();
    state.channel = null;
    state.failStreak = 0;
    state.pollDelayMs = POLL_BASE_MS;
    state.pollCount = 0;
  }

  function startPolling() {
    if (state.running) return;
    state.running = true;
    $('btnToggle').textContent = '停止采集';
    $('btnToggle').classList.remove('is-stopped');
    setStatus('live', '逐笔采集中');
    schedulePoll(300);
    renderCollect();
  }

  function stopPolling() {
    state.running = false;
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    // 停止前把已积累的数据落一次本地缓存
    if (state.store) state.store.save();
    $('btnToggle').textContent = '开始采集';
    $('btnToggle').classList.add('is-stopped');
    setStatus('paused', '采集已停止');
    renderCollect();
  }

  function schedulePoll(delay) {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(pollOnce, delay);
  }

  async function pollOnce() {
    if (!state.running) return;

    // 页面在后台时暂停轮询（省流量也省接口压力），回到前台自动继续
    if (document.hidden) {
      setStatus('paused', '后台已暂停采集');
      schedulePoll(1500);
      return;
    }

    try {
      const env = await window.ApiClient.fetchTrades({
        market: state.market,
        symbol: state.symbol,
        limit: 1000,
      });
      if (!state.running) return; // 等待期间用户可能已停止

      state.channel = env.via || null;
      const res = state.store.ingest(env.rows || [], env.meta || {});
      state.failStreak = 0;
      state.pollDelayMs = POLL_BASE_MS;
      state.pollCount += 1;

      // 周期性落本地缓存（页面刷新 / 关闭后可恢复）
      if (state.pollCount % SAVE_EVERY_POLLS === 0) state.store.save();

      if (res.gap) {
        // 有缺口：如实提示（数据不清空，继续积累，缺口桶会带标记）
        setStatus('error', `检测到采集缺口（漏 ${res.gap.missed} 笔），继续采集中`);
      } else if (!document.hidden) {
        setStatus('live', state.channel === 'proxy' ? '逐笔采集中 · 云端代理' : '逐笔采集中 · 浏览器直连');
      }
      clearError('trades');
      renderCollect();
      notifyUI(); // 通知分析区块重算（分析出错不影响采集主流程）
      scheduleAnalysis(false); // 每轮新数据都刷新结构与研判（内部有最小间隔节流）
    } catch (err) {
      state.failStreak += 1;
      // 指数退避：连续失败时把间隔翻倍，上限 30 秒，恢复成功后自动回到 2 秒
      state.pollDelayMs = Math.min(POLL_MAX_MS, state.pollDelayMs * 2);
      showError(
        '逐笔数据获取失败',
        (err.message || '未知错误') + `；已自动放慢到每 ${state.pollDelayMs / 1000} 秒重试一次`,
        'trades',
      );
      setStatus('error', '逐笔获取失败 · 自动重试中');
      renderCollect();
      notifyUI(); // 通知分析区块重算（分析出错不影响采集主流程）
    }

    schedulePoll(state.pollDelayMs);
  }

  /* ============================================================
   * 行情与K线刷新（低频，云端代理优先）
   * ============================================================ */

  async function refreshMarket() {
    if (state.marketLoading) return;
    state.marketLoading = true;
    try {
      // K线根数：覆盖观察窗 + 余量（覆盖率对账需要窗口内每根K线的成交额）
      const limit = Math.min(500, Math.max(160, state.windowBuckets + 40));
      const data = await window.ApiClient.fetchMarket({
        market: state.market,
        symbol: state.symbol,
        interval: state.interval,
        limit,
      });
      state.marketData = data;
      state.candles = data.candles || [];
      clearError('market');
      renderQuotes();
      renderChart();
      renderCollect();
      notifyUI(); // 通知分析区块重算（分析出错不影响采集主流程）
      // K线是覆盖率对账与区间涨跌的来源，刷新后要重算一次结构与研判
      scheduleAnalysis(true);
    } catch (err) {
      showError(
        '行情与K线刷新失败',
        (err.message || '未知错误') + '（逐笔采集不受影响，将继续自动重试）',
        'market',
      );
      setStatus('error', '行情刷新失败 · 自动重试中');
    } finally {
      state.marketLoading = false;
    }
  }

  /* ============================================================
   * 渲染：行情摘要卡
   * ============================================================ */

  function renderQuotes() {
    const data = state.marketData;
    if (!data || !data.ticker) return;
    const t = data.ticker;
    const changeCls =
      t.changePercent24h === null ? '' : t.changePercent24h >= 0 ? 'is-up' : 'is-down';

    const cards = [
      {
        label: `最新价（${data.display}）`,
        value: fmtPrice(t.last),
        cls: changeCls,
        sub: `${data.intervalLabel}周期 · ${data.market === 'perp' ? '永续合约' : '现货'}`,
      },
      {
        label: '24 小时涨跌',
        value: fmtSignedPercent(t.changePercent24h),
        cls: changeCls,
        sub: '相对 24 小时前价格',
      },
      {
        label: '24 小时成交额',
        value: fmtCompact(t.quoteVolume24h, 'USDT'),
        cls: '',
        sub: '计价币口径成交额',
      },
      {
        label: '持仓量（名义价值）',
        value: t.openInterestUsd === null ? '—' : fmtCompact(t.openInterestUsd, 'USDT'),
        cls: '',
        sub: t.openInterestUsd === null ? '现货市场不提供持仓量' : '未平仓合约名义规模',
      },
      {
        label: '资金费率（年化）',
        value: t.fundingAnnualized === null ? '—' : fmtSignedPercent(t.fundingAnnualized),
        cls: t.fundingAnnualized === null ? '' : t.fundingAnnualized >= 0 ? 'is-up' : 'is-down',
        sub: t.fundingIntervalLabel
          ? `原始结算周期 ${t.fundingIntervalLabel}，已换算年化`
          : '现货市场不提供资金费率',
      },
      {
        label: '标记价 / 指数价',
        value: fmtPrice(t.markPrice),
        cls: '',
        sub: '指数价 ' + fmtPrice(t.indexPrice),
      },
    ];

    $('quoteGrid').innerHTML = cards
      .map(
        (c) => `<div class="quote-card">
        <span class="quote-label">${c.label}</span>
        <span class="quote-value ${c.cls}">${c.value}</span>
        <span class="quote-sub">${c.sub}</span>
      </div>`,
      )
      .join('');

    $('candleChip').textContent =
      `K线：${data.candleCount} 根 · ${data.intervalLabel} · ` +
      `数据时间 ${new Date(data.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
    $('sourceChip').textContent =
      '数据源：' + data.sourceLabel + (data.via === 'direct' ? ' · 浏览器直连' : ' · 云端接口代理');
  }

  /* ============================================================
   * 渲染：采集状态卡（样本、覆盖率、缺口、通道、时间桶进度条）
   * ============================================================ */

  function renderCollect() {
    if (!state.store) return;
    const stats = state.store.getStats();
    const intervalMs = INTERVALS[state.interval].ms;

    // 累计样本
    $('statSamples').textContent = stats.totalIngested.toLocaleString('zh-CN');

    // 覆盖率（对账K线；只有完整跟踪过的已完结桶才计入）
    const cov = state.store.computeCoverage(state.candles);
    const covEl = $('statCoverage');
    if (cov.overall === null) {
      covEl.textContent = '积累中';
      covEl.className = 'collect-num is-warn';
    } else {
      const pct = Math.min(100, cov.overall * 100);
      covEl.textContent = pct.toFixed(1) + '%';
      covEl.className = 'collect-num ' + (pct >= 90 ? 'is-good' : pct >= 70 ? '' : 'is-warn');
    }

    // 当前桶进度
    const now = Date.now();
    const curT0 = Math.floor(now / intervalMs) * intervalMs;
    const progress = Math.min(1, (now - curT0) / intervalMs);
    $('bucketBar').style.width = (progress * 100).toFixed(1) + '%';
    $('bucketBarText').textContent =
      fmtBucketRange(curT0, intervalMs) + ` · 已进行 ${(progress * 100).toFixed(0)}%`;

    // 采集缺口
    $('statGaps').textContent =
      stats.gapCount === 0
        ? '无（每 2 秒轮询，无漏单）'
        : `${stats.gapCount} 次 · 共约 ${stats.totalMissed.toLocaleString('zh-CN')} 笔（已如实标记）`;

    // 数据通道
    $('statChannel').textContent =
      state.channel === 'direct'
        ? '浏览器直连（省云端额度）'
        : state.channel === 'proxy'
          ? '云端代理（直连失败自动切换）'
          : '等待首次成功…';

    // 轮询状态
    $('statPoll').textContent = state.running
      ? document.hidden
        ? '已暂停（页面在后台）'
        : state.failStreak > 0
          ? `退避中 · ${state.pollDelayMs / 1000} 秒/次`
          : `正常 · ${POLL_BASE_MS / 1000} 秒/次`
      : '已停止';

    // 最近一笔
    $('statLastTrade').textContent = stats.lastT ? fmtTimeAgo(stats.lastT) : '等待数据…';

    // 采集状态徽标
    const live = $('collectLive');
    if (state.running) {
      live.textContent = document.hidden ? '后台暂停中' : '采集中';
      live.className = 'collect-live';
    } else {
      live.textContent = '已停止';
      live.className = 'collect-live is-stopped';
    }

    renderStrip(cov);
  }

  /** 时间桶进度条：一个格子一个桶，最右侧是当前桶 */
  function renderStrip(cov) {
    const strip = $('bucketStrip');
    const intervalMs = INTERVALS[state.interval].ms;
    const now = Date.now();
    const curT0 = Math.floor(now / intervalMs) * intervalMs;

    // 桶起点 → 桶对象 的索引
    const bucketMap = new Map();
    state.store.getBuckets().forEach((b) => bucketMap.set(b.t0, b));

    const stats = state.store.getStats();
    const covMap = cov ? cov.perBucket : new Map();

    const cells = [];
    for (let i = state.windowBuckets - 1; i >= 0; i--) {
      const t0 = curT0 - i * intervalMs;
      const b = bucketMap.get(t0);
      const covVal = covMap.get(t0);
      const isForming = t0 === curT0;
      const isPre = stats.firstFullBucketT0 !== null && t0 < stats.firstFullBucketT0;

      // 类名
      let cls = 'bk-cell';
      if (isForming) cls += ' is-forming';
      if (isPre) cls += ' is-pre';
      if (b && b.partial) cls += ' is-partial';

      // 覆盖率上色：越红越完整
      let style = '';
      if (!isForming && covVal !== undefined) {
        const alpha =
          covVal >= 0.9 ? 0.85 : covVal >= 0.7 ? 0.55 : covVal >= 0.4 ? 0.32 : 0.16;
        style = `background:rgba(217,56,43,${alpha});`;
      }

      // 悬浮提示（原生 title，够用且零依赖）
      let title;
      if (isForming) {
        title = `${fmtBucketRange(t0, intervalMs)} · 当前桶，正在形成中`;
      } else if (isPre) {
        title = `${fmtBucketRange(t0, intervalMs)} · 开始跟踪前的半桶，不计入覆盖率`;
      } else if (b) {
        title =
          `${fmtBucketRange(t0, intervalMs)}` +
          (covVal !== undefined ? ` · 覆盖率 ${(Math.min(1, covVal) * 100).toFixed(0)}%` : ' · 覆盖率待对账') +
          ` · 主动买 ${fmtUsdCompact(b.buyNot)} / 主动卖 ${fmtUsdCompact(b.sellNot)}` +
          ` · ${b.buyCnt + b.sellCnt} 笔` +
          (b.partial ? ' · 期间有采集缺口' : '');
      } else {
        title = `${fmtBucketRange(t0, intervalMs)} · 暂无逐笔数据（未跟踪到该时段）`;
      }

      cells.push(`<div class="${cls}" style="${style}" title="${title}"></div>`);
    }
    strip.innerHTML = cells.join('');
  }

  /* ============================================================
   * 渲染：K线图（悬停显示明细）
   * ============================================================ */

  function renderChart() {
    const data = state.marketData;
    if (!data || !state.candles.length) return;

    if (!state.chart) {
      state.chart = window.KlineChart.createChart($('klineCanvas'), {
        interval: data.interval,
        onHover: (idx, x, y, candle) => {
          const tip = $('chartTip');
          if (idx < 0 || !candle) {
            tip.hidden = true;
            return;
          }
          const d = new Date(candle.t);
          const p = (n) => String(n).padStart(2, '0');
          const up = candle.c >= candle.o;
          tip.innerHTML =
            `<div><b>${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}</b></div>` +
            `<div>开盘 ${fmtPrice(candle.o)}　收盘 <b style="color:${up ? '#d9382b' : '#0e7a4f'}">${fmtPrice(candle.c)}</b></div>` +
            `<div>最高 ${fmtPrice(candle.h)}　最低 ${fmtPrice(candle.l)}</div>` +
            `<div>成交量 ${fmtCompact(candle.v)}　成交额 ${fmtUsdCompact(candle.sum)}</div>`;
          tip.hidden = false;
          // 提示框跟随鼠标，并避免超出容器右边界
          const wrap = tip.parentElement;
          const wrapW = wrap.clientWidth;
          const tipW = tip.offsetWidth;
          let left = x + 16;
          if (left + tipW > wrapW) left = Math.max(4, x - tipW - 16);
          tip.style.left = left + 'px';
          tip.style.top = Math.max(6, y - 60) + 'px';
        },
      });

      // 拿不到画布时给出明确说明，页面其余部分不受影响
      if (state.chart && state.chart.available === false) {
        $('chartHint').textContent = state.chart.reason;
        $('klineCanvas').hidden = true;
      }
    }

    // 只展示最后 160 根，保证K线实体足够清晰
    const showCount = Math.min(160, state.candles.length);
    const candles = state.candles.slice(state.candles.length - showCount);
    state.chart.setData(candles);
    // 画布不可用时保留说明文字，不要被这句覆盖掉
    if (state.chart.available !== false) {
      $('chartHint').textContent = `显示最近 ${showCount} 根K线 · 红涨绿跌 · 鼠标悬浮查看明细`;
    }
  }

  /* ============================================================
   * 分析管线：成交结构拆解 + 主力行为研判
   * ============================================================ */

  /** 触发一次分析（带最小间隔节流，避免高频轮询把主线程压满） */
  function scheduleAnalysis(force) {
    const now = Date.now();
    if (!force && now - state.lastAnalysisAt < ANALYZE_MIN_GAP_MS) return;
    state.lastAnalysisAt = now;
    runAnalysis();
  }

  /**
   * 跑一次完整分析
   * 输入是滚雪球积累的真实逐笔 + 同期K线；样本不足时引擎自己会返回「数据积累中」，
   * 这里不做任何补充或估算，如实把结果渲染出去。
   */
  function runAnalysis() {
    const store = state.store;
    if (!store || !window.VerdictEngine) return;

    const intervalMs = INTERVALS[state.interval].ms;
    store.flushRuns();
    const buckets = store.getBuckets();
    const trades = store
      .getRecentTrades(20000)
      .map((t) => ({ ts: t.t, price: t.price, notional: t.notional, dir: t.dir }));
    const cov = store.computeCoverage(state.candles);

    const res = window.VerdictEngine.analyze({
      trades,
      candles: state.candles,
      intervalMs,
      coverage: cov.overall,
      prevProfile: state.prevProfile,
      prevVerdict: state.prevVerdict,
    });

    // 阈值档案与判定结论要跨轮次记住：前者用于 EMA 平滑，后者用于迟滞防抖
    if (res.profile && res.profile.ready) state.prevProfile = res.profile;
    if (res.stage === 'ok') state.prevVerdict = res.verdict.key;

    // 桶级拆解复用同一把尺子（阈值直接取自上面的档案），两个面板的数字不会互相打架
    let structure = null;
    if (res.profile && res.profile.ready && window.TradeClassifier) {
      structure = window.TradeClassifier.aggregate(buckets, {
        ready: true,
        midThreshold: res.profile.mid,
        largeThreshold: res.profile.large,
      });
    }

    state.analysis = { res, structure, coverage: cov.overall, intervalMs, at: Date.now() };
    renderStructure();
    renderVerdict();
    renderStructureChart();
  }

  /** 取最近的已完结时间桶（正在形成的桶不参与展示，与覆盖率口径保持一致） */
  function closedBucketRows() {
    const a = state.analysis;
    if (!a || !a.structure || !a.structure.perBucket) return [];
    const now = Date.now();
    return a.structure.perBucket
      .filter((r) => Number.isFinite(r.t0) && r.t0 + a.intervalMs <= now)
      .slice(-state.windowBuckets);
  }

  /* ---------------- 成交结构拆解面板 ---------------- */

  function renderStructure() {
    const grid = $('structGrid');
    const chip = $('structSampleChip');
    const note = $('structNote');
    const bar = $('shareBar');
    const legend = $('shareLegend');
    if (!grid) return;

    const a = state.analysis;
    const res = a ? a.res : null;
    const st = a ? a.structure : null;
    const stats = state.store ? state.store.getStats() : null;
    const samples = stats ? stats.totalIngested : 0;
    const need = window.VerdictEngine ? window.VerdictEngine.MIN_TRADES : 300;

    // 卡片数字优先用「逐笔精确口径」（与研判打分的输入完全一致，不会有第二套数字）
    const tiersExact = res && res.stage === 'ok' && res.tiers ? res.tiers : null;
    // 逐笔缓冲被截断、但桶直方图里有历史数据时的兜底：用直方图口径顶上，并如实标注
    const useHistogram = !tiersExact && st && st.ready;

    if (!tiersExact && !useHistogram) {
      chip.textContent = `已采样 ${samples.toLocaleString('zh-CN')} 笔 / 需 ${need} 笔`;
      grid.innerHTML =
        `<div class="struct-pending">数据积累中：逐笔样本达到 ${need} 笔后才会给出分档拆解，` +
        `目前 ${samples.toLocaleString('zh-CN')} 笔。样本不足时给结论就是猜，页面不猜。</div>`;
      if (bar) bar.innerHTML = '';
      if (legend) legend.innerHTML = '';
      if (note) {
        note.textContent =
          '说明：大小单阈值必须由该币种自己的成交分布决定，所以要先积累足够样本才能划档。' +
          '页面每 2 秒自动采集一次，保持打开即可继续积累。';
      }
      return;
    }

    let totalNot;
    let midShare;
    let tiers;
    let thresholdNote;

    if (tiersExact) {
      totalNot = tiersExact.volume || 0;
      tiers = [
        { key: 'large', name: '大单', cls: 'is-large', d: tiersExact.large, share: tiersExact.large.share },
        { key: 'mid', name: '中单', cls: 'is-mid', d: tiersExact.mid, share: tiersExact.mid.share },
        { key: 'small', name: '小单', cls: 'is-small', d: tiersExact.small, share: tiersExact.small.share },
      ];
      thresholdNote =
        `分档尺子（跟随该币种自身分布，非固定金额）：中单线 ≥ ${fmtUsdCompact(res.profile.mid)}　` +
        `大单线 ≥ ${fmtUsdCompact(res.profile.large)}；` +
        `由 ${(res.meta ? res.meta.samples : samples).toLocaleString('zh-CN')} 笔真实成交的单笔金额中位数倍数 + 分位护栏得出，并做 EMA 平滑（避免每来一批数据就换线）。`;
    } else {
      totalNot = st.totalNotional || 0;
      midShare = Math.max(0, 1 - (st.largeShare || 0) - (st.smallShare || 0));
      const wrap = (d, share) => ({
        buy: d.buyNot, sell: d.sellNot, net: d.net, total: d.total, share,
        buyCount: d.buyCnt, sellCount: d.sellCnt,
      });
      tiers = [
        { key: 'large', name: '大单', cls: 'is-large', d: wrap(st.large, st.largeShare), share: st.largeShare },
        { key: 'mid', name: '中单', cls: 'is-mid', d: wrap(st.mid, midShare), share: midShare },
        { key: 'small', name: '小单', cls: 'is-small', d: wrap(st.small, st.smallShare), share: st.smallShare },
      ];
      thresholdNote =
        `分档尺子（跟随该币种自身分布，非固定金额）：中单线 ≥ ${fmtUsdCompact(st.thresholds.midThreshold)}　` +
        `大单线 ≥ ${fmtUsdCompact(st.thresholds.largeThreshold)}；当前逐笔缓冲不足，本卡改用「按桶直方图」口径统计（覆盖窗口内全部逐笔）。`;
    }

    grid.innerHTML = tiers
      .map((t) => {
        const net = t.d.net || 0;
        const netCls = net > 0 ? 'is-up' : net < 0 ? 'is-down' : '';
        const cnt = Math.round((t.d.buyCount || 0) + (t.d.sellCount || 0));
        return (
          `<div class="struct-item ${t.cls}">` +
          `<div class="struct-tier">` +
          `<span class="struct-tier-name">${t.name}</span>` +
          `<span class="struct-tier-share">占 ${fmtShare(t.share)}</span>` +
          `</div>` +
          `<span class="struct-amount">${fmtUsdCompact(t.d.total)}</span>` +
          `<div class="struct-rows">` +
          `<div class="struct-row"><span>主动买</span><b class="is-up">${fmtUsdCompact(t.d.buy)}</b></div>` +
          `<div class="struct-row"><span>主动卖</span><b class="is-down">${fmtUsdCompact(t.d.sell)}</b></div>` +
          `<div class="struct-row"><span>净额</span><b class="${netCls}">${net >= 0 ? '+' : ''}${fmtUsdCompact(net)}</b></div>` +
          `<div class="struct-row"><span>笔数</span><b>${cnt.toLocaleString('zh-CN')}</b></div>` +
          `</div></div>`
        );
      })
      .join('');

    if (bar) {
      bar.innerHTML = tiers
        .map(
          (t) =>
            `<div class="share-seg" style="width:${(Math.max(0, t.share || 0) * 100).toFixed(2)}%;background:${
              t.key === 'large'
                ? 'linear-gradient(180deg,#e45a48,#b52a1f)'
                : t.key === 'mid'
                  ? 'linear-gradient(180deg,#e8b95c,#c9921f)'
                  : 'linear-gradient(180deg,#c3ccd8,#9aa7b8)'
            }"></div>`,
        )
        .join('');
      bar.setAttribute('role', 'img');
      bar.setAttribute(
        'aria-label',
        '成交额构成：' +
          tiers.map((t) => `${t.name} ${fmtShare(t.share)}`).join('、') +
          `（${tiersExact ? '逐笔精确口径' : '按桶直方图口径'}）`,
      );
    }

    if (legend) {
      legend.innerHTML = tiers
        .map(
          (t) =>
            `<span><i style="background:${
              t.key === 'large' ? '#c02a1c' : t.key === 'mid' ? '#d9a13b' : '#9aa7b8'
            }"></i>${t.name} ${fmtShare(t.share)} · ${fmtUsdCompact(t.d.total)}</span>`,
        )
        .join('');
    }

    const closed = closedBucketRows();
    const shownSamples = res && res.meta ? res.meta.samples : samples;
    chip.textContent = `${closed.length} 个已完结桶 · 样本 ${shownSamples.toLocaleString('zh-CN')} 笔`;

    if (note) {
      note.innerHTML =
        thresholdNote +
        `本卡口径：${tiersExact ? '逐笔精确分档' : '按桶直方图汇总'}，窗口内合计成交额 ${fmtUsdCompact(totalNot)}。` +
        `下方时间轴按时间桶逐个拆解（覆盖窗口内全部逐笔），两者分档阈值完全相同；` +
        `时间轴为直方图口径，临界金额附近按对数均匀近似切分，与上方精确数字存在极小量化差异。` +
        `永续逐笔按「张数 × 合约乘数 × 成交价」换算成美元口径后再分档。`;
    }
  }

  function fmtShare(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    return (v * 100).toFixed(1) + '%';
  }

  /* ---------------- 主力行为研判面板 ---------------- */

  const VERDICT_TONE = { accum: 'accum', distrib: 'distrib', retail: 'retail', fuzzy: 'fuzzy', pending: 'pending' };

  function renderVerdict() {
    const badge = $('verdictBadge');
    const desc = $('verdictDesc');
    const confChip = $('verdictConfChip');
    const scoreList = $('scoreList');
    const supList = $('evidenceSupport');
    const agList = $('evidenceAgainst');
    const note = $('verdictNote');
    if (!badge) return;

    const a = state.analysis;
    const res = a ? a.res : null;
    const stats = state.store ? state.store.getStats() : null;

    if (!res) {
      badge.textContent = '数据积累中';
      badge.dataset.tone = 'pending';
      desc.textContent = '正在积累逐笔样本，样本足够后自动给出研判结论。';
      confChip.textContent = '置信度 —';
      scoreList.innerHTML = '';
      supList.innerHTML = '<li class="evidence-empty">暂无可列出的证据</li>';
      agList.innerHTML = '<li class="evidence-empty">暂无可列出的反证</li>';
      note.textContent = '—';
      return;
    }

    const v = res.verdict || {};
    badge.textContent = v.label || '数据积累中';
    badge.dataset.tone = VERDICT_TONE[v.key] || 'pending';
    desc.textContent = v.desc || '';

    confChip.textContent =
      res.stage === 'ok'
        ? `置信度 ${res.confidence}% · 领先优势 ${Math.round(v.margin || 0)} 分`
        : `置信度 — · 需 ${res.meta && res.meta.need ? res.meta.need : 300} 笔样本`;

    /* 三条行为分数条：主力吃货 / 主力出货 / 散户乱交易 */
    if (res.scores) {
      const leader = ['accum', 'distrib', 'retail'].sort((x, y) => res.scores[y] - res.scores[x])[0];
      const rows = [
        { key: 'accum', name: '主力吃货', cls: 'is-accum', val: res.scores.accum },
        { key: 'distrib', name: '主力出货', cls: 'is-distrib', val: res.scores.distrib },
        { key: 'retail', name: '散户乱交易', cls: 'is-retail', val: res.scores.retail },
      ];
      scoreList.innerHTML = rows
        .map(
          (r) =>
            `<div class="score-row ${r.cls}${r.key === leader ? ' is-leader' : ''}">` +
            `<span class="score-name">${r.name}</span>` +
            `<span class="score-track"><i style="width:${Math.max(1, Math.min(100, r.val))}%"></i></span>` +
            `<span class="score-val">${r.val}</span>` +
            `</div>`,
        )
        .join('');
    } else {
      // 样本不足时引擎不给分档打分，这里也不编造
      scoreList.innerHTML =
        '<div class="struct-pending">样本不足，暂不打分：三个行为分数需要足够逐笔样本才有意义。</div>';
    }

    const renderEvidence = (list, arr, cls, emptyText) => {
      if (!arr || !arr.length) {
        list.innerHTML = `<li class="evidence-empty">${emptyText}</li>`;
        list.className = 'evidence-list ' + cls;
        return;
      }
      list.className = 'evidence-list ' + cls;
      list.innerHTML = arr
        .map((e) => `<li>${e.label ? `<span class="evidence-tag">${escapeHtml(e.label)}</span>` : ''}${escapeHtml(e.text)}</li>`)
        .join('');
    };
    renderEvidence(supList, res.evidence.support, 'is-support', '暂无可列出的支持证据');
    renderEvidence(agList, res.evidence.against, 'is-against', '暂无可列出的反对证据');

    const meta = res.meta || {};
    const cov = meta.coverage === null || meta.coverage === undefined ? null : meta.coverage;
    note.textContent =
      `口径：逐笔样本 ${(meta.samples || 0).toLocaleString('zh-CN')} 笔 · ` +
      `已完结桶 ${meta.buckets || 0} 个 · ` +
      `覆盖率 ${cov === null ? '待对账' : (Math.min(1, cov) * 100).toFixed(1) + '%'} · ` +
      `区间涨跌 ${fmtSignedPercent(meta.returnPct)}` +
      (stats ? ` · 累计采集 ${stats.totalIngested.toLocaleString('zh-CN')} 笔` : '') +
      '。判定采用三态打分取最高分，咬得紧时给「结构模糊」；结论切换有迟滞机制，避免来回跳。';
  }

  /* ---------------- 成交结构时间轴 ---------------- */

  function renderStructureChart() {
    const canvas = $('structCanvas');
    if (!canvas) return;

    if (!state.structChart) {
      state.structChart = window.StructureChart.createChart(canvas, {
        onHover: (idx, x, y, row) => {
          const tip = $('structTip');
          if (!tip) return;
          if (idx < 0 || !row) {
            tip.hidden = true;
            return;
          }
          const total = (row.small || 0) + (row.mid || 0) + (row.large || 0);
          tip.innerHTML =
            `<div><b>${fmtBucketRange(row.t0, state.analysis ? state.analysis.intervalMs : 0)}</b></div>` +
            `<div>大单 ${fmtUsdCompact(row.largeBuy)} 买 / ${fmtUsdCompact(row.largeSell)} 卖</div>` +
            `<div>中单 ${fmtUsdCompact(row.midBuy)} 买 / ${fmtUsdCompact(row.midSell)} 卖</div>` +
            `<div>小单 ${fmtUsdCompact(row.smallBuy)} 买 / ${fmtUsdCompact(row.smallSell)} 卖</div>` +
            `<div>合计 ${fmtUsdCompact(total)}　大单净额 ${
              row.netLarge >= 0 ? '+' : ''
            }${fmtUsdCompact(row.netLarge)}</div>` +
            (row.partial ? '<div>该桶期间检测到采集缺口（数据不完整，已如实标注）</div>' : '');
          tip.hidden = false;
          const wrap = tip.parentElement;
          const wrapW = wrap.clientWidth;
          const tipW = tip.offsetWidth;
          let left = x + 16;
          if (left + tipW > wrapW) left = Math.max(4, x - tipW - 16);
          tip.style.left = left + 'px';
          tip.style.top = Math.max(6, y - 60) + 'px';
        },
      });
      if (state.structChart && state.structChart.available === false) {
        const hint = $('structHint');
        if (hint) hint.textContent = state.structChart.reason;
        canvas.hidden = true;
      }
    }

    const rows = closedBucketRows();
    const chip = $('structWindowChip');
    if (chip) {
      chip.textContent = rows.length
        ? `窗口内 ${rows.length} 个桶 · ${INTERVALS[state.interval].label}`
        : '等待足够的时间桶';
    }
    state.structChart.setData(rows);
  }

  /* ============================================================
   * 配置切换
   * ============================================================ */

  /** 市场或币种或周期变化：重建存储、重启轮询 */
  async function onConfigChange(reloadSymbols) {
    stopPolling();
    if (reloadSymbols) {
      try {
        await loadSymbols();
      } catch (e) {
        return; // 错误已在 loadSymbols 内提示
      }
      // 换了市场（永续 / 现货）：分档阈值与上一轮结论都不能沿用
      state.prevProfile = null;
      state.prevVerdict = null;
      state.analysis = null;
    }
    createStore();
    renderCollect();
    // 先按「数据积累中」渲染一次，避免切换后旧面板数字还挂在那里误导人
    renderStructure();
    renderVerdict();
    renderStructureChart();
    startPolling();
    await refreshMarket();
  }

  /* ============================================================
   * 事件绑定与启动
   * ============================================================ */

  function bindEvents() {
    bindSegment('segMarket', async (v) => {
      state.market = v;
      applyMarketNote();
      await onConfigChange(true);
    });

    bindSegment('segInterval', async () => {
      state.interval = document.querySelector('#segInterval .is-active').dataset.value;
      await onConfigChange(false);
    });

    bindSegment('segWindow', async (v) => {
      state.windowBuckets = Number(v) || 32;
      // 观察窗变了：K线根数需求变化，刷新行情并重绘状态与成交结构时间轴
      renderCollect();
      notifyUI(); // 通知分析区块重算（分析出错不影响采集主流程）
      renderStructureChart();
      refreshMarket();
    });

    $('btnToggle').addEventListener('click', () => {
      if (state.running) stopPolling();
      else startPolling();
    });

    // 币种搜索（输入即筛选、回车或点击选中）
    bindSymbolSearch();

    // 观察窗变化时也要重画成交结构时间轴（窗口大小变了）
    // 注：观察窗的段按钮已在上面绑定，这里补一次重绘即可

    // 后台暂停：切到后台时立即落一次缓存；回到前台后轮询自然恢复
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (state.store) state.store.save();
      }
      renderCollect();
      notifyUI(); // 通知分析区块重算（分析出错不影响采集主流程）
    });

    // 页面关闭 / 刷新前落缓存
    window.addEventListener('pagehide', () => {
      if (state.store) state.store.save();
    });

    // 窗口尺寸变化时重绘图表
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.chart) state.chart.redraw();
      }, 160);
    });
  }

  /** 每次成功渲染后喊一声，让分析区块跟着刷新；分析模块内部出错不能拖垮采集 */
  function notifyUI() {
    try {
      if (window.AnalysisUI && typeof window.AnalysisUI.update === "function") window.AnalysisUI.update();
    } catch (e) { /* 分析模块异常不影响主流程 */ }
  }

  /* 对外出口：只给只读状态，外部模块拿不到也不该拿到内部可变引用 */
  window.__APP_API__ = {
    getState() {
      return {
        market: state.market,
        symbol: state.symbol,
        interval: state.interval,
        intervalMs: INTERVALS[state.interval].ms,
        windowBuckets: state.windowBuckets,
        running: state.running,
        candles: state.candles,
        marketData: state.marketData,
        symbolList: state.symbolList || [],
      };
    },
    getStore() {
      return state.store;
    },
  };

  async function init() {
    bindEvents();
    applyMarketNote();
    $('resultArea').hidden = false; // 采集状态与K线先亮出来，数据边采边填

    // 新面板先以「数据积累中」占位，避免切换币种时残留上一个币的结论
    renderStructure();
    renderVerdict();
    renderStructureChart();

    try {
      await loadSymbols();
    } catch (e) {
      setStatus('error', '币种列表获取失败');
      return;
    }

    createStore();
    if (state.restored) {
      const n = state.store.getStats().bucketCount;
      $('consoleHint').textContent = `已从本地缓存恢复 ${n} 个时间桶（同一币种同一周期），继续滚雪球积累中`;
    }

    startPolling();
    await refreshMarket();
    scheduleAnalysis(true); // 恢复的缓存也能立刻出一次结构（若有足够样本）

    // 行情与K线定时刷新（后台时不刷，省请求）
    state.marketTimer = setInterval(() => {
      if (!document.hidden) refreshMarket();
    }, MARKET_REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
