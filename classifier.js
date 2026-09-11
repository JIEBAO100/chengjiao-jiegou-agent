/**
 * 大小单分类器：把成交量拆成大单 / 中单 / 小单
 *
 * 为什么不用写死的金额：
 *   1 万美元的 BTC 单是小单，但放在冷门币上就是巨单。
 *   所以阈值必须跟着「这个币种自己的成交分布」走，而不是拍一个绝对金额。
 *
 * 自适应阈值口径（必须与 verdict-engine.js 完全一致，否则两个面板的数字会打架）：
 *   中单线 = max(该币种近期单笔成交额中位数 × 3, P75)
 *   大单线 = max(该币种近期单笔成交额中位数 × 10, P95)
 *   两条线至少拉开 2 倍，防止中单被压成一条缝。
 *   阈值用 EMA 平滑（系数 0.2），避免每来一批数据就跳档。
 *
 * 为什么中单线取 P75 而不是更高分位：
 *   成交分布常见「海量碎单 + 少量大单」的双峰形态，中单线若用 P95 会被顶到大单量级，
 *   结果所有大单都掉进中单里，大单占比恒为 0（本项目自测中真实抓到这个缺陷）。
 *
 * 数据前提：只用已完结、已完整跟踪过的时间桶（继承「成交量只用已收线K线」的教训）。
 */

(function (root) {
  'use strict';

  const HIST_BINS = 28;
  const EMA_ALPHA = 0.2;        // 阈值平滑系数
  const MIN_SAMPLES = 300;      // 冷启动门槛：样本不足不给结论

  /** 中位数 */
  function median(sorted) {
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /** 分位数（线性插值） */
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /**
   * 用最近的真实逐笔样本，算出该币种的分档阈值
   * @param {Array<{notional:number}>} trades 最近逐笔（含真实成交额）
   * @param {object|null} prev 上一次的阈值档案（用于 EMA 平滑）
   * @returns {{ready:boolean, sample:number, midThreshold:number, largeThreshold:number, median:number}}
   */
  function buildProfile(trades, prev) {
    const notionals = []
      .concat(
        (trades || []).map((t) => (Number.isFinite(t.notional) && t.notional > 0 ? t.notional : null))
      )
      .filter((v) => v !== null)
      .sort((a, b) => a - b);

    const sample = notionals.length;
    if (sample < MIN_SAMPLES) {
      return { ready: false, sample, midThreshold: null, largeThreshold: null, median: null, p75: null, p95: null, p99: null };
    }

    const med = median(notionals);
    const p75 = quantile(notionals, 0.75);
    const p95 = quantile(notionals, 0.95);
    const p99 = quantile(notionals, 0.99);

    // 中位数为主、分位护栏为辅：取两者较大的那一个
    let mid = Math.max(med * 3, p75 || 0);
    let large = Math.max(med * 10, p95 || 0);

    // 两条线必须拉开至少 2 倍，否则中单会被压成一条缝
    if (large < mid * 2) large = mid * 2;

    // EMA 平滑：有旧档案就慢慢过渡，避免每批数据一进来就重新划线
    if (prev && Number.isFinite(prev.midThreshold) && Number.isFinite(prev.largeThreshold)) {
      mid = prev.midThreshold * (1 - EMA_ALPHA) + mid * EMA_ALPHA;
      large = prev.largeThreshold * (1 - EMA_ALPHA) + large * EMA_ALPHA;
      if (large < mid * 2) large = mid * 2;
    }

    return { ready: true, sample, midThreshold: mid, largeThreshold: large, median: med, p75, p95, p99 };
  }

  /** 金额对应的直方图箱号（与 trade-store 的口径严格一致） */
  function binOf(notional) {
    if (!Number.isFinite(notional) || notional <= 0) return 0;
    return Math.max(0, Math.min(HIST_BINS, Math.floor(Math.log10(notional) * 4)));
  }

  /** 箱号对应的金额下沿 */
  function binLower(bin) {
    return Math.pow(10, bin / 4);
  }

  function emptyTier() {
    return {
      buyNot: 0, sellNot: 0, buyCnt: 0, sellCnt: 0,
      ordBuyNot: 0, ordSellNot: 0, ordBuyCnt: 0, ordSellCnt: 0,
    };
  }

  /**
   * 求某个阈值在直方图上的切点
   *
   * 直方图的箱宽是 10^0.25 ≈ 1.78 倍，阈值通常落在某一箱的中间。
   * 如果按「整箱划线」处理，这一箱里的成交额会被整体划到低档，
   * 大单占比会被系统性低估（本项目自测实测：极端形态下大单占比会被压到 0）。
   * 所以这里在临界箱内按「对数均匀」假设做按比例切分：
   *   返回 { bin, frac }，frac 表示该箱中位于阈值之上的比例（划给高档）。
   */
  function cutAt(threshold) {
    if (!Number.isFinite(threshold) || threshold <= 0) return { bin: HIST_BINS + 1, frac: 0 };
    const bin = Math.min(HIST_BINS, Math.max(0, Math.floor(Math.log10(threshold) * 4)));
    const lower = Math.pow(10, bin / 4);
    const upper = Math.pow(10, (bin + 1) / 4);
    if (threshold <= lower) return { bin, frac: 1 };
    if (threshold >= upper) return { bin, frac: 0 };
    const span = Math.log10(upper) - Math.log10(lower);
    const frac = span > 0 ? (Math.log10(upper) - Math.log10(threshold)) / span : 0;
    return { bin, frac: Math.max(0, Math.min(1, frac)) };
  }

  /** 某箱中「属于该切点及以上档位」的比例 */
  function aboveWeight(bin, cut) {
    if (bin > cut.bin) return 1;
    if (bin < cut.bin) return 0;
    return cut.frac;
  }

  /**
   * 把一个时间桶拆成大 / 中 / 小三档
   * @param {object} b 时间桶（含逐笔直方图与订单级直方图）
   * @param {object} th buildProfile 的返回值（阈值必须与研判引擎共用同一把尺子）
   */
  function splitBucket(b, th) {
    const out = { t0: b.t0, partial: !!b.partial, small: emptyTier(), mid: emptyTier(), large: emptyTier() };
    if (!th || !th.ready) return out;

    const midCut = cutAt(th.midThreshold);
    const largeCut = cutAt(th.largeThreshold);

    for (let dir = 0; dir < 2; dir += 1) {
      const isBuy = dir === 0;
      for (let bin = 0; bin <= HIST_BINS; bin += 1) {
        const notion = b.notHist && b.notHist[dir] ? b.notHist[dir][bin] || 0 : 0;
        const cnt = b.cntHist && b.cntHist[dir] ? b.cntHist[dir][bin] || 0 : 0;
        const oNot = b.ordNotHist && b.ordNotHist[dir] ? b.ordNotHist[dir][bin] || 0 : 0;
        const oCnt = b.ordCntHist && b.ordCntHist[dir] ? b.ordCntHist[dir][bin] || 0 : 0;
        if (notion <= 0 && cnt <= 0 && oNot <= 0 && oCnt <= 0) continue;

        const wLarge = aboveWeight(bin, largeCut);
        const wMidUp = aboveWeight(bin, midCut);
        const wMid = Math.max(0, wMidUp - wLarge);
        const wSmall = Math.max(0, 1 - wMidUp);

        const put = (tier, w) => {
          if (w <= 0) return;
          if (isBuy) {
            tier.buyNot += notion * w;
            tier.buyCnt += cnt * w;
            tier.ordBuyNot += oNot * w;
            tier.ordBuyCnt += oCnt * w;
          } else {
            tier.sellNot += notion * w;
            tier.sellCnt += cnt * w;
            tier.ordSellNot += oNot * w;
            tier.ordSellCnt += oCnt * w;
          }
        };
        put(out.large, wLarge);
        put(out.mid, wMid);
        put(out.small, wSmall);
      }
    }
    return out;
  }

  /**
   * 把一批时间桶聚合成总量视图
   * @param {Array<object>} buckets 已经过筛选的桶（只要已完结 + 完整跟踪过的）
   * @param {object} th 阈值档案
   */
  function aggregate(buckets, th) {
    const sum = { small: emptyTier(), mid: emptyTier(), large: emptyTier() };
    const perBucket = [];
    let totalNot = 0;

    (buckets || []).forEach((b) => {
      const s = splitBucket(b, th);
      ['small', 'mid', 'large'].forEach((k) => {
        const t = sum[k];
        const x = s[k];
        t.buyNot += x.buyNot; t.sellNot += x.sellNot;
        t.buyCnt += x.buyCnt; t.sellCnt += x.sellCnt;
        t.ordBuyNot += x.ordBuyNot; t.ordSellNot += x.ordSellNot;
        t.ordBuyCnt += x.ordBuyCnt; t.ordSellCnt += x.ordSellCnt;
      });
      const bTotal = s.small.buyNot + s.small.sellNot + s.mid.buyNot + s.mid.sellNot + s.large.buyNot + s.large.sellNot;
      totalNot += bTotal;
      perBucket.push({
        t0: s.t0,
        partial: s.partial,
        total: bTotal,
        largeBuy: s.large.buyNot, largeSell: s.large.sellNot,
        midBuy: s.mid.buyNot, midSell: s.mid.sellNot,
        smallBuy: s.small.buyNot, smallSell: s.small.sellNot,
        netLarge: s.large.buyNot - s.large.sellNot,
        netTotal: (s.large.buyNot + s.mid.buyNot + s.small.buyNot) - (s.large.sellNot + s.mid.sellNot + s.small.sellNot),
      });
    });

    const wrap = (t) => ({
      buyNot: t.buyNot, sellNot: t.sellNot,
      total: t.buyNot + t.sellNot,
      net: t.buyNot - t.sellNot,
      buyCnt: t.buyCnt, sellCnt: t.sellCnt,
      ordBuyNot: t.ordBuyNot, ordSellNot: t.ordSellNot,
      ordBuyCnt: t.ordBuyCnt, ordSellCnt: t.ordSellCnt,
    });

    const totalW = Object.assign({}, sum);

    return {
      ready: !!(th && th.ready),
      thresholds: th,
      totalNotional: totalNot,
      small: wrap(sum.small),
      mid: wrap(sum.mid),
      large: wrap(sum.large),
      // 大单占总成交额的比例：主力参与度的最直观刻度
      largeShare: totalNot > 0 ? (sum.large.buyNot + sum.large.sellNot) / totalNot : null,
      smallShare: totalNot > 0 ? (sum.small.buyNot + sum.small.sellNot) / totalNot : null,
      perBucket,
      _raw: totalW,
    };
  }

  root.TradeClassifier = {
    HIST_BINS,
    MIN_SAMPLES,
    buildProfile,
    binOf,
    binLower,
    splitBucket,
    aggregate,
  };
})(typeof window !== 'undefined' ? window : globalThis);
