/**
 * 盘面结构判定引擎（本项目的分析大脑）
 *
 * 输入：一段时间内的真实逐笔成交 + 同期K线
 * 输出：① 大/中/小单拆解结果  ② 三种资金行为的强弱打分  ③ 盘面三态判定 + 证据与反证
 *
 * 三条诚实的红线（跟 8p 一脉相承）：
 *   1. 样本不够就明说「数据积累中」，不硬猜，更不能用假数据凑结论；
 *   2. 每条结论都要同时列出支持证据与反对证据，不允许只报好听的；
 *   3. 三种资金行为是「打分排序」，不是非黑即白——咬得紧就判「结构模糊」。
 *
 * 全部用相对量（占比、分位、弹性），不写死金额，换任何一个币种都成立。
 */

(function (root) {
  'use strict';

  const MIN_TRADES = 300;   // 冷启动门槛：少于这个样本数不给分档结论
  const MIN_BUCKETS = 6;    // 至少观察这么多个时间桶才谈得上「趋势结构」
  const HYSTERESIS = 10;    // 换结论的迟滞：新结论要领先旧结论这么多才切换
  const MARGIN = 8;         // 领先优势下限，低于它判「结构模糊」

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  /** 饱和映射：把任意实数压到 0~1，防止某一维单独爆表绑架结论 */
  const S = (x, sat) => clamp(Math.abs(x) / (sat || 1), 0, 1);
  const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const safeDiv = (a, b) => (Math.abs(b) > 1e-12 ? a / b : 0);

  /* ============================================================
   * 一、自适应分档阈值（大小单的「尺子」）
   * ============================================================ */

  function percentile(sorted, q) {
    if (!sorted.length) return 0;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

/**
 * 用当前样本算出大单 / 中单 / 小单的金额门槛
 *
 * 口径（与 classifier.js 严格一致，两个面板必须用同一把尺子）：
 *   中单线 = max(单笔成交额中位数 × 3, P75)
 *   大单线 = max(单笔成交额中位数 × 10, P95)
 *   再用 EMA 平滑（系数 0.2），避免来一批新数据就翻脸。
 *
 * 为什么中单线用 P75 而不是更高的分位：
 *   币圈的成交分布常常是「海量碎单 + 少量大单」的双峰形态。如果中单线用 P95，
 *   中单线会被直接顶到大单量级，结果所有大单都被划进中单，大单占比恒为 0，
 *   吸筹 / 出货这类结论就永远出不来（这是自测里真实抓到过的缺陷）。
 *   P75 只圈走最小的四分之一，中单与大单各自都有落点。
 */
function buildProfile(trades, prev) {
  const amounts = []
    .concat(trades.map((t) => (Number.isFinite(t.notional) && t.notional > 0 ? t.notional : null)))
    .filter((v) => v !== null)
    .sort((a, b) => a - b);

  if (amounts.length < MIN_TRADES) {
    return { ready: false, sample: amounts.length, mid: null, large: null, median: null, p75: null, p95: null, p99: null };
  }

  const med = percentile(amounts, 0.5);
  const p75 = percentile(amounts, 0.75);
  const p95 = percentile(amounts, 0.95);
  const p99 = percentile(amounts, 0.99);

  let mid = Math.max(med * 3, p75);
  let large = Math.max(med * 10, p95);
  if (large < mid * 2) large = mid * 2;

  if (prev && Number.isFinite(prev.mid) && Number.isFinite(prev.large)) {
    mid = prev.mid * 0.8 + mid * 0.2;
    large = prev.large * 0.8 + large * 0.2;
    if (large < mid * 2) large = mid * 2;
  }

  return { ready: true, sample: amounts.length, mid, large, median: med, p75, p95, p99 };
}

  /* ============================================================
   * 二、成交拆解：每笔成交归入大 / 中 / 小三档
   * ============================================================ */

  function classifyTrades(trades, profile) {
    const tiers = {
      large: BuySell(),
      mid: BuySell(),
      small: BuySell(),
    };
    let volume = 0;
    trades.forEach((t) => {
      const notional = Number.isFinite(t.notional) ? t.notional : 0;
      if (notional <= 0) return;
      const tier = notional >= profile.large ? tiers.large : notional >= profile.mid ? tiers.mid : tiers.small;
      volume += notional;
      if (t.dir > 0) {
        tier.buy += notional;
        tier.buyCount += 1;
      } else {
        tier.sell += notional;
        tier.sellCount += 1;
      }
    });
    return { tiers, volume };
  }

  function BuySell() {
    return { buy: 0, sell: 0, buyCount: 0, sellCount: 0 };
  }

  /** 把逐笔按时间桶聚合：每桶的买卖额、均价、桶收益 */
  function aggregateBuckets(trades, intervalMs) {
    const map = new Map();
    trades.forEach((t) => {
      if (!Number.isFinite(t.ts) || !Number.isFinite(t.notional)) return;
      const key = Math.floor(t.ts / intervalMs) * intervalMs;
      let b = map.get(key);
      if (!b) {
        b = { t: key, buy: 0, sell: 0, open: t.price, close: t.price, high: t.price, low: t.price, count: 0 };
        map.set(key, b);
      }
      if (t.dir > 0) b.buy += t.notional;
      else b.sell += t.notional;
      b.count += 1;
      b.close = t.price;
      if (t.price > b.high) b.high = t.price;
      if (t.price < b.low) b.low = t.price;
    });
    return Array.from(map.values()).sort((a, b) => a.t - b.t);
  }

  /* ============================================================
   * 三、订单流十二个特征量
   * ============================================================ */

  function extractFeatures(tiers, buckets, candles) {
    const largeVolume = tiers.large.buy + tiers.large.sell;
    const smallVolume = tiers.small.buy + tiers.small.sell;
    const midVolume = tiers.mid.buy + tiers.mid.sell;
    const total = largeVolume + midVolume + smallVolume;

    const largeNet = tiers.large.buy - tiers.large.sell;
    const smallNet = tiers.small.buy - tiers.small.sell;
    const net = largeNet + (tiers.mid.buy - tiers.mid.sell) + smallNet;

    // ① NBI 大单净流入占比：主力站在哪一边，最直接的刻度
    const nbi = safeDiv(largeNet, total);

    // ② VOL 大单成交占比：主力在不在场
    const largeShare = safeDiv(largeVolume, total);

    // ③ PUR 主动方向纯度：全部资金的净方向有多一致
    const pur = safeDiv(net, total);

    // ④ λ 价格冲击弹性：单位净买盘推动了多少百分比的价格
    const retPct = computeReturn(buckets);
    const lambda = Math.abs(nbi) > 0.005 ? Math.abs(retPct) / Math.abs(nbi) : Math.abs(retPct) * 20;

    // ⑤ CON 时间集中度：大单在时间上是不是扎堆出现
    const con = concentration(buckets.map((b) => b.buy + b.sell));

    // ⑥ SLP 大单占比的漂移：后半段比前半段更活跃还是收敛
    const slp = shareDrift(buckets, largeVolume);

    // ⑦ DVG 大小单背离：大单往一边走、小单往另一边走的程度
    const dvg = sgn(largeNet) !== 0 && sgn(smallNet) !== 0 && sgn(largeNet) !== sgn(smallNet)
      ? 0.5 * (Math.abs(safeDiv(largeNet, total)) + Math.abs(safeDiv(smallNet, total)))
      : 0;

    // ⑧ CHA 散户追涨度：价格涨，小单也在净买（散户在追）
    const cha = sgn(retPct) !== 0 && sgn(smallNet) === sgn(retPct) ? Math.min(1, Math.abs(retPct) / 0.6) * Math.abs(safeDiv(smallNet, smallVolume || 1)) : 0;

    // ⑨ CVD 背离：累计资金净流方向与价格方向相反的程度
    const cvd = sgn(net) !== 0 && sgn(retPct) !== 0 && sgn(net) !== sgn(retPct) ? Math.min(1, Math.abs(retPct) / 0.8) : 0;

    // ⑩ RET 小单主导度：成交是不是主要靠碎单堆出来的
    const ret = safeDiv(smallVolume, total);

    // ⑪ CV 节奏稳定性：各桶成交量的变异（越小越均匀）
    const cv = variation(buckets.map((b) => b.buy + b.sell));

    // ⑫ MID 中单占比（参考量，不进打分，留作展示）
    const midShare = safeDiv(midVolume, total);

    return {
      nbi, largeShare, pur, lambda, con, slp, dvg, cha, cvd, ret, cv, midShare,
      retPct, net, largeNet, smallNet, candleCount: (candles || []).length,
    };
  }

  function computeReturn(buckets) {
    if (!buckets.length) return 0;
    const first = buckets[0].open;
    const last = buckets[buckets.length - 1].close;
    if (!Number.isFinite(first) || first === 0) return 0;
    return ((last - first) / first) * 100;
  }

  /** 时间集中度：最大值占总量的比例相对「均匀」的偏离程度 */
  function concentration(values) {
    const total = values.reduce((a, b) => a + b, 0);
    if (total <= 0 || values.length === 0) return 0;
    const max = Math.max.apply(null, values);
    return clamp((max / total - 1 / values.length) / (1 - 1 / values.length), 0, 1);
  }

  /** 变异系数（归一化到 0~1 的观感） */
  function variation(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    if (mean <= 0) return 0;
    const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
    return clamp(Math.sqrt(variance) / mean, 0, 1);
  }

  /** 前后半段的大单占比之差 */
  function shareDrift(buckets, largeVolume) {
    if (buckets.length < 4) return 0;
    const half = Math.floor(buckets.length / 2);
    const sumOf = (arr) => arr.reduce((a, b) => a + b.buy + b.sell, 0);
    const front = sumOf(buckets.slice(0, half));
    const back = sumOf(buckets.slice(half));
    if (front + back <= 0) return 0;
    return safeDiv(largeVolume * (back / (front + back)) - largeVolume * (front / (front + back)), largeVolume || 1);
  }

  /* ============================================================
   * 四、三种资金行为打分（各 0~100）
   * ============================================================ */

  function score(f) {
    const evidence = [];

    /* —— 主力吃货：大单净买、低冲击、集中度高的吸收 —— */
    let accum = 0;
    if (f.nbi > 0) {
      accum += 26 * S(f.nbi, 0.5);
      evidence.push({ side: 'accum', tone: 'support', text: '大单呈净买入，主动资金站在买方（大单净流入占比 ' + (f.nbi * 100).toFixed(1) + '%）' });
    } else {
      evidence.push({ side: 'accum', tone: 'against', text: '大单净方向为卖出，不具备吸筹的资金特征' });
    }
    if (f.nbi > 0 && f.lambda < 0.8) {
      accum += 18 * (1 - S(f.lambda, 0.8));
      evidence.push({ side: 'accum', tone: 'support', text: '买盘吸收顺畅：较大成交只推动很小的价格变化（低冲击弹性，典型隐蔽吸筹）' });
    } else if (f.lambda >= 1.5) {
      evidence.push({ side: 'accum', tone: 'against', text: '价格冲击弹性偏高，同等成交撬动的价格波动偏大' });
    }
    if (f.con > 0.35) {
      accum += 12 * S(f.con - 0.35, 0.4);
      evidence.push({ side: 'accum', tone: 'support', text: '资金在时间上扎堆出现（集中度 ' + (f.con * 100).toFixed(0) + '%），有明确的大资金节奏' });
    }
    if (f.dvg > 0.02 && f.nbi > 0) {
      accum += 14 * S(f.dvg, 0.15);
      evidence.push({ side: 'accum', tone: 'support', text: '大单在吸、小单在抛，筹码由散户流向大资金' });
    }
    accum -= 10 * S(f.ret - 0.5, 0.4);
    accum += 8 * (1 - S(f.cv, 0.8));

    /* —— 主力出货：大单净卖却把价格往上抬（诱多） —— */
    let distrib = 0;
    if (f.nbi < 0) {
      distrib += 26 * S(f.nbi, 0.5);
      evidence.push({ side: 'distrib', tone: 'support', text: '大单呈净卖出，主动资金站在卖方（大单净流出占比 ' + (Math.abs(f.nbi) * 100).toFixed(1) + '%）' });
    } else {
      evidence.push({ side: 'distrib', tone: 'against', text: '大单并非净卖出，缺少派发的直接证据' });
    }
    if (f.nbi < 0 && f.retPct > 0) {
      distrib += 20 * S(f.retPct, 1.2);
      evidence.push({ side: 'distrib', tone: 'support', text: '价格在涨，大单却在净卖出 —— 拉抬中派发的典型形态' });
    }
    if (f.cha > 0.15) {
      distrib += 14 * S(f.cha, 0.5);
      evidence.push({ side: 'distrib', tone: 'support', text: '散户追涨明显：价格上涨同时小单持续净买入' });
    }
    if (f.dvg > 0.02 && f.nbi < 0) {
      distrib += 14 * S(f.dvg, 0.15);
      evidence.push({ side: 'distrib', tone: 'support', text: '大单在派发、小单在接，筹码由大资金流向散户' });
    }
    if (f.slp < -0.05) {
      distrib += 8 * S(f.slp, 0.3);
      evidence.push({ side: 'distrib', tone: 'support', text: '大单活跃度在后半段收敛，出货接近尾声的常见迹象' });
    }
    if (f.lambda > 1.5) {
      distrib += 10 * S(f.lambda - 1.5, 3);
      evidence.push({ side: 'distrib', tone: 'support', text: '少量资金就能撬动价格，盘口偏薄，容易被拉抬' });
    }
    distrib -= 12 * (1 - S(f.largeShare, 0.25));

    /* —— 散户乱交易：大单缺席，成交靠碎单堆 —— */
    let retail = 0;
    retail += 30 * (1 - S(f.largeShare, 0.25));
    retail += 22 * S(f.ret - 0.45, 0.35);
    retail += 14 * (1 - S(f.nbi, 0.5));
    retail += 10 * (1 - S(f.con, 0.35));
    if (f.largeShare < 0.25) {
      evidence.push({ side: 'retail', tone: 'support', text: '大单成交占比不足 ' + (f.largeShare * 100).toFixed(0) + '%，主力级资金明显缺席' });
    } else {
      evidence.push({ side: 'retail', tone: 'against', text: '大单占比不低，确实有大资金参与，不能说是无主力行情' });
    }
    if (f.ret > 0.5) {
      evidence.push({ side: 'retail', tone: 'support', text: '成交额主要来自小额成交，典型散户盘' });
    }
    if (Math.abs(f.nbi) < 0.08) {
      evidence.push({ side: 'retail', tone: 'support', text: '大单买卖基本均衡，没有清晰的主力方向' });
    } else {
      evidence.push({ side: 'retail', tone: 'against', text: '大单存在明确方向性，不是纯粹的随机撮合' });
    }

    return {
      accum: clamp(Math.round(accum), 0, 100),
      distrib: clamp(Math.round(distrib), 0, 100),
      retail: clamp(Math.round(retail), 0, 100),
      evidence,
    };
  }

  /* ============================================================
   * 五、三态判定（含滞后与兜底）
   * ============================================================ */

  const VERDICTS = {
    accum: { label: '主力真实吸筹', tone: 'bull', desc: '大单持续站在买方，价格却没有同步走强，说明卖压被资金默默吸收，具备主力吸筹特征。' },
    distrib: { label: '主力诱多出货', tone: 'bear', desc: '大单站在卖方而价格仍在走强，筹码正由主力流向散户，具备诱多出货特征。' },
    retail: { label: '纯散户行情无主力', tone: 'flat', desc: '成交以小额成交为主，缺乏主力级资金的持续痕迹，更像散户自发交易推动的盘面。' },
    pending: { label: '数据积累中', tone: 'flat', desc: '正在积累逐笔样本，样本足够后才会给出分档与判定。此刻给结论就是猜，页面不猜。' },
    fuzzy: { label: '结构模糊', tone: 'flat', desc: '三种资金行为的分数咬得很紧，盘面没有清晰指向。宁可说不知道，也不硬给结论。' },
  };

  /**
   * @param {object} input
   *   trades        已归一化的逐笔明细（含 id / ts / price / notional / dir）
   *   candles       同期K线
   *   intervalMs    时间桶宽度
   *   coverage      采集覆盖率（0~1，来自K线成交额对账）
   *   prevProfile   上一轮的阈值档案（用于 EMA 平滑）
   *   prevVerdict   上一轮的判定 key（用于滞后防抖）
   * @returns {object} 完整分析结果
   */
function analyze(input) {
  // 只接受完整可用的逐笔：时间、价格、金额三者都必须是有限正数
  // （脏数据放进来会污染价格序列与分档统计，宁可丢掉也不能带偏结论）
  const trades = (input.trades || []).filter(
    (t) =>
      Number.isFinite(t.notional) &&
      t.notional > 0 &&
      Number.isFinite(t.ts) &&
      Number.isFinite(t.price) &&
      t.price > 0,
  );
    const tradesSorted = trades.slice().sort((a, b) => a.ts - b.ts);
    const coverage = Number.isFinite(input.coverage) ? input.coverage : null;

    // 兜底一：样本不足 —— 明确说「数据积累中」，绝不拿半截数据硬凑
    if (tradesSorted.length < MIN_TRADES) {
      return {
        stage: 'pending',
        ready: false,
        profile: buildProfile(tradesSorted, input.prevProfile),
        verdict: Object.assign({ key: 'pending' }, VERDICTS.pending),
        confidence: 0,
        scores: null,
        features: null,
        tiers: null,
        buckets: [],
        evidence: { support: [], against: [] },
        meta: { samples: tradesSorted.length, need: MIN_TRADES, buckets: 0, coverage },
      };
    }

    const profile = buildProfile(tradesSorted, input.prevProfile);
    if (!profile.ready || !Number.isFinite(profile.mid) || !Number.isFinite(profile.large)) {
      return {
        stage: 'pending',
        ready: false,
        profile,
        verdict: Object.assign({ key: 'pending' }, VERDICTS.pending),
        confidence: 0,
        scores: null,
        features: null,
        tiers: null,
        buckets: [],
        evidence: { support: [], against: [] },
        meta: { samples: tradesSorted.length, need: MIN_TRADES, buckets: 0, coverage },
      };
    }

    // 拆解 + 分桶
    // 拆解 + 分桶
    const { tiers, volume } = classifyTrades(tradesSorted, profile);
    const buckets = aggregateBuckets(tradesSorted, input.intervalMs || 60000);

    // 兜底二：完整跟踪过的桶不够 —— 结构类结论需要时间维度
    // 注意：最后一个桶还在形成中，按「只用已收线数据」的规矩剔除
    const closedBuckets = buckets.slice(0, Math.max(0, buckets.length - 1));
    const usableBuckets = closedBuckets.slice(-Math.min(closedBuckets.length, 48));

    if (usableBuckets.length < MIN_BUCKETS) {
      return {
        stage: 'pending',
        ready: false,
        profile,
        tiers,
        volume,
        buckets: usableBuckets,
        verdict: Object.assign({ key: 'pending' }, VERDICTS.pending),
        confidence: 0,
        scores: null,
        features: null,
        evidence: { support: [], against: [] },
        meta: { samples: tradesSorted.length, need: MIN_TRADES, buckets: usableBuckets.length, needBuckets: MIN_BUCKETS, coverage },
      };
    }

    const features = extractFeatures(tiers, usableBuckets, input.candles || []);
    const scored = score(features);

    // 选出最高分，并算领先第二名的优势
    const ranked = [['accum', scored.accum], ['distrib', scored.distrib], ['retail', scored.retail]]
      .sort((a, b) => b[1] - a[1]);
    const leader = ranked[0];
    const margin = leader[1] - ranked[1][1];

    let key = leader[0];
    // 迟滞：上一次的结论有惯性，新结论要领先够多才切换，避免页面结论来回跳
    const prev = input.prevVerdict;
    if (prev && VERDICTS[prev] && prev !== leader[0] && prev !== 'pending' && prev !== 'fuzzy') {
      if (scored[leader[0]] < scored[prev] + HYSTERESIS) key = prev;
    }
    // 领先不明显 → 结构模糊（不硬判）
    if (margin < MARGIN) key = 'fuzzy';

    const support = [];
    const against = [];
    scored.evidence.forEach((e) => {
      const line = { text: e.text, side: e.side, label: VERDICTS[e.side] ? VERDICTS[e.side].label : '' };
      if (key === 'fuzzy' || key === 'pending') {
        support.push(line);
      } else if (e.side === key && e.tone === 'support') {
        support.push(line);
      } else if (e.side === key && e.tone === 'against') {
        against.push(line);
      } else if (e.side !== key && e.tone === 'support') {
        against.push(line);
      }
    });

    // 置信度 = 一半看样本积累进度，一半看采集质量（覆盖率）
    const progress = clamp(tradesSorted.length / Math.max(MIN_TRADES * 3, 1), 0, 1);
    const quality = coverage === null ? 0.6 : clamp(coverage, 0, 1);
    const confidence = Math.round((progress * 0.5 + quality * 0.5) * 100);

    const tierOf = (t) => ({
      buy: t.buy,
      sell: t.sell,
      net: t.buy - t.sell,
      total: t.buy + t.sell,
      buyCount: t.buyCount,
      sellCount: t.sellCount,
      share: volume > 0 ? t.buy + t.sell ? (t.buy + t.sell) / volume : 0 : 0,
    });

    return {
      stage: 'ok',
      ready: true,
      profile,
      features,
      scores: { accum: scored.accum, distrib: scored.distrib, retail: scored.retail },
      tiers: {
        large: tierOf(tiers.large),
        mid: tierOf(tiers.mid),
        small: tierOf(tiers.small),
        volume,
      },
      buckets: usableBuckets,
      verdict: Object.assign({ key }, VERDICTS[key], { margin }),
      confidence,
      evidence: { support: support.slice(0, 6), against: against.slice(0, 6) },
      meta: { samples: tradesSorted.length, buckets: usableBuckets.length, coverage, returnPct: features.retPct },
    };
  }

  root.VerdictEngine = {
    MIN_TRADES,
    MIN_BUCKETS,
    buildProfile,
    analyze,
  };
})(typeof window !== 'undefined' ? window : globalThis);
