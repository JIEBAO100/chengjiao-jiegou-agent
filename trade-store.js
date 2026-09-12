/**
 * 逐笔成交滚雪球存储（trade-store.js）
 *
 * 核心问题：交易所公开接口只给「最近约 1000 条」逐笔成交，没有历史翻页，
 * 所以历史要靠页面自己「滚雪球」积累：每隔约 2 秒拉一次最新逐笔，
 * 按成交编号去重后不断累加，页面开着的过程就是数据积累的过程。
 *
 * 职责：
 * 1. 归一化：把两条通道（浏览器直连 / 云端代理）返回的原始逐笔，
 *    统一换成 { id, t, price, notional(美元名义额), dir(+1主动买/-1主动卖) }：
 *    永续 notional = |size(张)| × 合约乘数 × 成交价；现货 notional = 数量 × 成交价。
 *    归一化口径只在这一处维护，两条通道永远一致。
 * 2. 时间桶：按 K 线周期对齐切桶（桶起点 = 周期整数倍），只把「已完结桶」用于分析。
 * 3. 策略单聚合：同一方向、相邻 3 秒内、价差 0.05% 以内的连续逐笔合并成一「单」，
 *    防止算法拆单把一笔大单伪装成几百笔小单（订单级直方图记录在 ordHist）。
 * 4. 缺口检测：两次轮询之间漏了成交（间隔内成交超过单次上限会漏）时，
 *    如实记录缺口数量并给相关桶打 partial 标记，绝不假装完整。
 * 5. 环形缓冲：最多保留 maxTrades 条逐笔 + maxBuckets 个时间桶。
 * 6. 覆盖率对账：逐笔累计名义额 ÷ 同期K线计价成交额，自我校验采集质量。
 * 7. localStorage 持久化：刷新页面后从本地恢复，恢复不了的部分靠缺口检测如实补记。
 *
 * 说明：只处理公开行情数据，不涉及任何交易操作。
 */

(function (root) {
  'use strict';

  /* ============================================================
   * 常量
   * ============================================================ */

  const RUN_GAP_MS = 3000;      // 策略单聚合：相邻逐笔时间间隔上限（3 秒）
  const RUN_PRICE_TOL = 0.0005; // 策略单聚合：价格偏离锚点上限（0.05%）
  const HIST_BINS = 28;         // 名义额对数直方图桶数：1 美元到约 1000 万美元，每桶约 1.78 倍宽
  const SAVE_PREFIX = 'cjx:v1'; // localStorage 键前缀（成交结构 v1）
  const KEEP_CONFIGS = 3;       // 最多保留最近几份「币种+周期」的本地缓存
  const SAVE_FRESH_MS = 24 * 60 * 60 * 1000; // 本地缓存最长保留 24 小时，超时不恢复

  /** 名义额 → 对数直方图桶号（每桶宽度 10^0.25 ≈ 1.78 倍） */
  function notionalBin(notional) {
    if (!Number.isFinite(notional) || notional <= 0) return 0;
    const b = Math.floor(Math.log10(notional) * 4);
    return Math.max(0, Math.min(HIST_BINS, b));
  }

  /** 桶号 → 桶下沿金额（分档基准卡用它还原阈值在分布里的位置） */
  function binLower(bin) {
    return Math.pow(10, bin / 4);
  }

  /** 把数字安全转成 Number，失败返回 null */
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * 时间口径统一：交易所个别接口返回「秒」或字符串毫秒，这里统一换算成毫秒。
   * 判断标准：数值大于 1e11（1000 亿）的按毫秒算，否则按秒 ×1000。
   */
  function parseMs(v) {
    const n = num(v);
    if (n === null || n <= 0) return null;
    return n > 1e11 ? n : Math.round(n * 1000);
  }

  /**
   * 原始逐笔 → 统一口径。
   * 永续：size 带正负号（正=主动买、负=主动卖，单位：张），金额 = |size| × 乘数 × 价格
   * 现货：side=buy/sell 记在字段上（主动方向），金额 = 数量 × 价格
   * 拿不到乘数的永续逐笔宁可跳过（宁缺毋滥，不猜金额）。
   */
  function normalizeRows(rows, meta, market) {
    if (!Array.isArray(rows)) return [];
    const mult = meta ? num(meta.quantoMultiplier) : null;
    const multiplier = mult !== null && mult > 0 ? mult : null;

    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const id = num(r.id);
      const price = num(r.price);
      const t = parseMs(r.create_time_ms !== undefined ? r.create_time_ms : r.time);
      if (id === null || price === null || t === null) continue;

      let dir;
      let notional;
      if (market === 'spot') {
        const amount = num(r.amount);
        if (amount === null) continue;
        dir = String(r.side) === 'buy' ? 1 : -1;
        notional = amount * price;
      } else {
        const size = num(r.size);
        if (size === null) continue;
        if (multiplier === null) continue; // 无乘数不换算，防御分支（上游层会先抛错）
        dir = size > 0 ? 1 : -1;
        notional = Math.abs(size) * multiplier * price;
      }
      out.push({ id, t, price, notional, dir });
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  /* ============================================================
   * 创建存储实例
   * ============================================================ */

  /**
   * @param {object} opts
   *   market: 'perp' | 'spot'
   *   symbol: 合约 / 交易对，例如 BTC_USDT
   *   intervalMs: 时间桶宽度（与K线周期一致，毫秒）
   *   maxTrades: 逐笔环形缓冲上限（默认 2 万条）
   *   maxBuckets: 时间桶上限（默认 240 个）
   */
  function create(opts) {
    const options = {
      market: opts && opts.market === 'spot' ? 'spot' : 'perp',
      symbol: String((opts && opts.symbol) || 'BTC_USDT'),
      intervalMs: Math.max(1000, Number(opts && opts.intervalMs) || 900000),
      maxTrades: Math.min(Math.max(Number(opts && opts.maxTrades) || 20000, 2000), 60000),
      maxBuckets: Math.min(Math.max(Number(opts && opts.maxBuckets) || 240, 16), 720),
    };

    // 实例状态（全部集中在 store 对象上，方便序列化与调试）
    const store = {
      options,
      buckets: new Map(), // t0(桶起点毫秒) → bucket
      trades: [],         // 归一化逐笔（新的在尾部，超限从头裁剪）
      run: null,          // 进行中的策略单（尚未落桶）
      lastId: null,       // 已见过的最大成交编号
      lastT: null,        // 最近一笔成交时间
      startedAt: null,    // 第一次 ingest 的本地时间
      firstFullBucketT0: null, // 第一个「从头完整跟踪」的桶起点（覆盖率只统计这之后的桶）
      totalIngested: 0,   // 累计新吸入的逐笔数
      totalMissed: 0,     // 缺口检测累计漏掉的逐笔数
      gapCount: 0,        // 缺口次数
      gapTail: [],        // 最近几次缺口记录（展示用）
    };

    /* ---------- 内部工具 ---------- */

    function lsKey() {
      return `${SAVE_PREFIX}:${options.market}:${options.symbol}:${options.intervalMs}`;
    }

    /** 取桶，不存在则创建（两个方向的直方图各 HIST_BINS+1 个计数器） */
    function ensureBucket(t0) {
      let b = store.buckets.get(t0);
      if (!b) {
        const zeros = () => [new Array(HIST_BINS + 1).fill(0), new Array(HIST_BINS + 1).fill(0)];
        b = {
          t0,
          // 逐笔级（精确总额 + 逐笔金额分布）
          buyNot: 0, sellNot: 0, buyCnt: 0, sellCnt: 0,
          cntHist: zeros(), notHist: zeros(),
          // 订单级（策略单聚合后的分布，防拆单）
          ordCntHist: zeros(), ordNotHist: zeros(),
          ordBuyNot: 0, ordSellNot: 0, ordBuyCnt: 0, ordSellCnt: 0,
          partial: false, // 该桶期间出现过采集缺口，分析时可降权
        };
        store.buckets.set(t0, b);
      }
      return b;
    }

    /** 把进行中的策略单落到它起始桶的订单级直方图里 */
    function commitRun() {
      const run = store.run;
      if (!run) return;
      const b = ensureBucket(run.t0);
      const di = run.dir > 0 ? 0 : 1;
      const bin = notionalBin(run.notional);
      b.ordCntHist[di][bin] += 1;
      b.ordNotHist[di][bin] += run.notional;
      if (run.dir > 0) {
        b.ordBuyNot += run.notional;
        b.ordBuyCnt += 1;
      } else {
        b.ordSellNot += run.notional;
        b.ordSellCnt += 1;
      }
      store.run = null;
    }

    /** 单笔逐笔入桶：更新精确总额、逐笔直方图，并推进策略单聚合 */
    function applyTrade(tr) {
      store.trades.push(tr);

      const t0 = Math.floor(tr.t / options.intervalMs) * options.intervalMs;
      const b = ensureBucket(t0);
      const di = tr.dir > 0 ? 0 : 1;

      // 逐笔级统计
      if (tr.dir > 0) {
        b.buyNot += tr.notional;
        b.buyCnt += 1;
      } else {
        b.sellNot += tr.notional;
        b.sellCnt += 1;
      }
      const bin = notionalBin(tr.notional);
      b.cntHist[di][bin] += 1;
      b.notHist[di][bin] += tr.notional;

      // 策略单流式聚合：同向 + 3 秒内 + 价格贴着锚点 → 并入同一单
      const run = store.run;
      if (
        run &&
        run.dir === tr.dir &&
        tr.t - run.lastT <= RUN_GAP_MS &&
        Math.abs(tr.price / run.anchor - 1) <= RUN_PRICE_TOL
      ) {
        run.notional += tr.notional;
        run.count += 1;
        run.lastT = tr.t;
      } else {
        commitRun();
        store.run = {
          dir: tr.dir,
          t0,
          anchor: tr.price,
          startT: tr.t,
          lastT: tr.t,
          notional: tr.notional,
          count: 1,
        };
      }
    }

    /** 给缺口跨到的时间桶打「不完整」标记（上限 2000 个桶，防御异常时间跨度） */
    function markPartial(fromT, toT) {
      if (fromT === null || toT === null) return;
      const lo = Math.floor(fromT / options.intervalMs);
      const hi = Math.floor(toT / options.intervalMs);
      const span = Math.min(hi - lo + 1, 2000);
      for (let k = 0; k < span; k++) {
        const b = store.buckets.get((lo + k) * options.intervalMs);
        if (b) b.partial = true;
      }
    }

    /** 淘汰超出上限的旧桶（环形缓冲语义） */
    function evictBuckets(now) {
      const cutoff =
        Math.floor(now / options.intervalMs) * options.intervalMs -
        (options.maxBuckets - 1) * options.intervalMs;
      store.buckets.forEach((b, t0) => {
        if (t0 < cutoff) store.buckets.delete(t0);
      });
    }

    /* ---------- 对外方法 ---------- */

    /**
     * 吸入一批原始逐笔（rows + meta 来自 api-client.fetchTrades）
     * @returns {{added:number, duplicates:number, gap:object|null}}
     */
    function ingest(rows, meta) {
      const norm = normalizeRows(rows, meta, options.market);
      const result = { added: 0, duplicates: 0, gap: null };
      if (!norm.length) return result;

      const now = Date.now();
      if (store.startedAt === null) {
        store.startedAt = now;
        // 首批最多 1000 条，很可能只是当前桶的后半段：这个桶不算「完整跟踪」，
        // 完整统计从下一个整桶开始（firstFullBucketT0）。
        store.firstFullBucketT0 = Math.ceil(now / options.intervalMs) * options.intervalMs;
      }

      // 去重：只保留比已见过的编号更新的逐笔（接口每次都返回最近一批）
      let fresh = norm;
      if (store.lastId !== null) {
        fresh = norm.filter((tr) => tr.id > store.lastId);
        result.duplicates = norm.length - fresh.length;
      }

      // 缺口检测：新一批的最小编号不紧挨上一批的最大编号 → 中间漏了成交
      if (store.lastId !== null && fresh.length > 0) {
        const minNewId = fresh[0].id;
        if (minNewId > store.lastId + 1) {
          const missed = minNewId - store.lastId - 1;
          store.totalMissed += missed;
          store.gapCount += 1;
          const gap = {
            fromId: store.lastId,
            toId: minNewId,
            missed,
            fromT: store.lastT,
            toT: fresh[0].t,
          };
          store.gapTail.push(gap);
          if (store.gapTail.length > 8) store.gapTail.shift();
          result.gap = gap;
          markPartial(store.lastT, fresh[0].t);
        }
      }

      if (fresh.length > 0) {
        for (let i = 0; i < fresh.length; i++) applyTrade(fresh[i]);
        store.lastId = fresh[fresh.length - 1].id;
        store.lastT = fresh[fresh.length - 1].t;
        store.totalIngested += fresh.length;
        result.added = fresh.length;

        // 逐笔环形缓冲：超限后从头部裁剪（留 10% 余量，分批裁减少数组复制）
        if (store.trades.length > options.maxTrades + 2000) {
          store.trades = store.trades.slice(-options.maxTrades);
        }
        evictBuckets(now);
      }
      return result;
    }

    /** 所有桶按时间升序返回（会先收起进行中的策略单，保证订单级数据是最新的） */
    function getBuckets() {
      commitRun();
      return Array.from(store.buckets.values()).sort((a, b) => a.t0 - b.t0);
    }

    /** 最近 n 条归一化逐笔（大单流水等展示用） */
    function getRecentTrades(n) {
      const cnt = Math.min(Math.max(Number(n) || 50, 1), store.trades.length);
      return store.trades.slice(-cnt);
    }

    /** 采集状态汇总 */
    function getStats() {
      return {
        totalIngested: store.totalIngested,
        totalMissed: store.totalMissed,
        gapCount: store.gapCount,
        gapTail: store.gapTail.slice(),
        lastId: store.lastId,
        lastT: store.lastT,
        startedAt: store.startedAt,
        firstFullBucketT0: store.firstFullBucketT0,
        bucketCount: store.buckets.size,
        tradeBufferCount: store.trades.length,
      };
    }

    /**
     * 覆盖率对账：逐笔累计名义额 ÷ 同期K线计价成交额。
     * 只统计「完整跟踪过」且「已完结」的桶：
     *   - 开始跟踪前的半桶不算（那半段逐笔根本没抓到）
     *   - 当前正在形成的桶不算（还没走完）
     *   - K线没有对应 sum 的桶不算（K线还没刷新到）
     * @param {Array<{t:number, sum:number}>} candles K线（含计价成交额 sum）
     * @returns {{overall:number|null, perBucket:Map, trackedCount:number}}
     */
    function computeCoverage(candles) {
      const now = Date.now();
      const sums = new Map();
      (candles || []).forEach((c) => {
        if (Number.isFinite(c.sum) && c.sum > 0 && Number.isFinite(c.t)) {
          sums.set(Math.floor(c.t / options.intervalMs) * options.intervalMs, c.sum);
        }
      });

      let bucketNot = 0;
      let klineSum = 0;
      const perBucket = new Map();

      store.buckets.forEach((b, t0) => {
        if (store.firstFullBucketT0 !== null && t0 < store.firstFullBucketT0) return;
        if (t0 + options.intervalMs > now) return; // 未完结桶
        const ksum = sums.get(t0);
        if (!ksum) return;
        const not = b.buyNot + b.sellNot;
        bucketNot += not;
        klineSum += ksum;
        perBucket.set(t0, ksum > 0 ? not / ksum : 1);
      });

      return {
        overall: klineSum > 0 ? bucketNot / klineSum : null,
        perBucket,
        trackedCount: perBucket.size,
      };
    }

    /** 手动收起进行中的策略单（读订单级统计前调用一次即可） */
    function flushRuns() {
      commitRun();
    }

    /** 落本地缓存。写入失败（隐私模式 / 存储满）不影响采集，只是重启后要重新积累 */
    function save() {
      const hasLS = typeof localStorage !== 'undefined';
      if (!hasLS) return false;
      try {
        commitRun(); // 先收起进行中的策略单，否则这一单会丢
        const key = lsKey();
        const payload = {
          savedAt: Date.now(),
          options: {
            market: options.market,
            symbol: options.symbol,
            intervalMs: options.intervalMs,
          },
          lastId: store.lastId,
          lastT: store.lastT,
          startedAt: store.startedAt,
          firstFullBucketT0: store.firstFullBucketT0,
          totalIngested: store.totalIngested,
          totalMissed: store.totalMissed,
          gapCount: store.gapCount,
          buckets: getBuckets(),
          // 只留最近 2000 条逐笔（大单流水与分档校准用），避免超出本地存储上限
          trades: store.trades.slice(-2000).map((tr) => [tr.id, tr.t, tr.price, tr.notional, tr.dir]),
        };
        localStorage.setItem(key, JSON.stringify(payload));

        // 只保留最近 KEEP_CONFIGS 份配置的缓存：
        //   · 浏览器里避免本地存储无限膨胀
        //   · 命令行下允许同时分析多个币种（早先的实现会把别的币种直接删掉，
        //     导致「分析完 BTC 再分析 ETH，BTC 的积累就没了」）
        const others = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (!k || k === key || k.indexOf(SAVE_PREFIX + ':') !== 0) continue;
          let at = 0;
          try {
            at = Number(JSON.parse(localStorage.getItem(k)).savedAt) || 0;
          } catch (e) {
            at = 0;
          }
          others.push({ k, at });
        }
        others.sort((a, b) => b.at - a.at);
        others.slice(KEEP_CONFIGS - 1).forEach((o) => localStorage.removeItem(o.k));
        return true;
      } catch (e) {
        return false;
      }
    }

    /** 恢复本地缓存（配置必须完全一致，过期或对不上就放弃，从零开始积累） */
    function restore() {
      const hasLS = typeof localStorage !== 'undefined';
      if (!hasLS) return false;
      try {
        const raw = localStorage.getItem(lsKey());
        if (!raw) return false;
        const p = JSON.parse(raw);
        if (!p || !Number.isFinite(p.savedAt)) return false;
        if (Date.now() - p.savedAt > SAVE_FRESH_MS) return false;
        if (
          !p.options ||
          p.options.market !== options.market ||
          p.options.symbol !== options.symbol ||
          Number(p.options.intervalMs) !== options.intervalMs
        ) {
          return false;
        }

        const now = Date.now();
        const cutoff =
          Math.floor(now / options.intervalMs) * options.intervalMs -
          (options.maxBuckets - 1) * options.intervalMs;
        (p.buckets || []).forEach((b) => {
          if (Number.isFinite(b && b.t0) && b.t0 >= cutoff) store.buckets.set(b.t0, b);
        });
        store.trades = (p.trades || []).map((a) => ({
          id: a[0],
          t: a[1],
          price: a[2],
          notional: a[3],
          dir: a[4],
        }));
        store.lastId = p.lastId !== undefined ? p.lastId : null;
        store.lastT = p.lastT !== undefined ? p.lastT : null;
        store.startedAt = p.startedAt !== undefined ? p.startedAt : null;
        store.firstFullBucketT0 = p.firstFullBucketT0 !== undefined ? p.firstFullBucketT0 : null;
        store.totalIngested = p.totalIngested || 0;
        store.totalMissed = p.totalMissed || 0;
        store.gapCount = p.gapCount || 0;
        store.run = null; // 进行中的策略单不跨会话恢复
        return store.buckets.size > 0 || store.trades.length > 0;
      } catch (e) {
        return false;
      }
    }

    /** 清掉本配置的本地缓存 */
    function clearPersist() {
      const hasLS = typeof localStorage !== 'undefined';
      if (!hasLS) return;
      try {
        localStorage.removeItem(lsKey());
      } catch (e) {
        /* 清理失败不影响主流程 */
      }
    }

    return {
      options,
      ingest,
      getBuckets,
      getRecentTrades,
      getStats,
      computeCoverage,
      flushRuns,
      save,
      restore,
      clearPersist,
    };
  }

  /* 挂载：浏览器挂 window，脚本环境挂 globalThis（便于本地自测） */
  root.TradeStore = { create, notionalBin, binLower, HIST_BINS, RUN_GAP_MS, RUN_PRICE_TOL };
})(typeof window !== 'undefined' ? window : globalThis);
