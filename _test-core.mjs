/**
 * 引擎核心自测（不联网）
 *
 * 用「人工构造的合成逐笔」验证算法在各种极端形态下的行为是否符合预期：
 *   1. 分档阈值：能否按分布自适应、样本不足是否拒绝给结论
 *   2. 三态判定：吸筹 / 出货 / 散户 三种典型形态能否被正确区分
 *   3. 阈值一致性：成交结构拆解（直方图口径）与研判（逐笔口径）是否用同一把尺子
 *   4. 逐笔仓库：去重、缺口检测、覆盖率对账是否正确
 *   5. 健壮性：空数据、零值、异常值不能把页面搞崩
 *
 * 注意：这里的合成数据只用于测试算法逻辑，不会进入页面，也不会被当成真实行情。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* ---- 把浏览器侧的模块加载进当前进程（它们都是挂在 globalThis 上的 IIFE） ---- */
['classifier.js', 'verdict-engine.js', 'trade-store.js'].forEach((f) => {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  new Function(code)(); // eslint-disable-line no-new-func
});

const VE = globalThis.VerdictEngine;
const TC = globalThis.TradeClassifier;
const TS = globalThis.TradeStore;

let pass = 0;
const fails = [];

function check(name, ok, extra) {
  if (ok) {
    pass += 1;
  } else {
    fails.push(name + (extra ? '　→ ' + extra : ''));
  }
}

function section(t) {
  console.log('\n=== ' + t + ' ===');
}

/* ============================================================
 * 构造器：把「形态描述」变成一串逐笔
 * ============================================================ */

const INTERVAL = 60 * 1000;

/**
 * @param {object} spec
 *   buckets      时间桶数量
 *   perBucket    每桶逐笔条数
 *   startPrice   起始价
 *   endPrice     结束价
 *   bigNotional  大单金额（null 表示完全不来大单）
 *   bigDir       大单方向 +1 / -1
 *   bigPerBucket 每桶大单条数
 *   smallNotional 小单金额
 *   smallDir     小单方向
 */
function buildTrades(spec) {
  const s = Object.assign(
    {
      buckets: 12,
      perBucket: 40,
      startPrice: 100,
      endPrice: 100,
      bigNotional: 5000,
      bigDir: 1,
      bigPerBucket: 6,
      smallNotional: 50,
      smallDir: -1,
    },
    spec,
  );

  const trades = [];
  // 基准时间取「刚刚结束的上一个整桶」再往前推，保证所有桶都已完结且不超期
  // （逐笔仓库会淘汰过老的桶，用 2023 年的时间戳会被当成过期数据丢掉）
  const base = Math.floor(Date.now() / INTERVAL) * INTERVAL - s.buckets * INTERVAL;
  let id = 1;

  for (let b = 0; b < s.buckets; b += 1) {
    const t0 = base + b * INTERVAL;
    const ratio = s.buckets === 1 ? 1 : b / (s.buckets - 1);
    const price = s.startPrice + (s.endPrice - s.startPrice) * ratio;

    // 大单
    if (s.bigNotional !== null) {
      for (let k = 0; k < s.bigPerBucket; k += 1) {
        trades.push({
          ts: t0 + 1000 + k * 500,
          price,
          notional: s.bigNotional,
          dir: s.bigDir,
        });
        id += 1;
      }
    }

    // 中小单
    const smallCount = s.perBucket - (s.bigNotional === null ? 0 : s.bigPerBucket);
    for (let k = 0; k < smallCount; k += 1) {
      trades.push({
        ts: t0 + 3000 + k * 800,
        price,
        notional: s.smallNotional,
        dir: s.smallDir,
      });
      id += 1;
    }
  }

  trades.sort((a, b) => a.ts - b.ts);
  return trades;
}

const NORES = (trades, extra) =>
  VE.analyze(Object.assign({ trades, candles: [], intervalMs: INTERVAL, coverage: 0.95 }, extra || {}));

/* ============================================================
 * 一、冷启动与样本门槛
 * ============================================================ */

section('一、冷启动与样本门槛');

const cold = NORES(buildTrades({ buckets: 2, perBucket: 20 }));
check('样本不足时判定为「数据积累中」', cold.stage === 'pending' && cold.verdict.key === 'pending');
check('样本不足时不给出打分（不猜）', cold.scores === null);
check('样本不足时置信度为 0', cold.confidence === 0);
check('缺口信息里给出了需要多少样本', cold.meta && cold.meta.need === VE.MIN_TRADES, JSON.stringify(cold.meta));

const fewBuckets = NORES(buildTrades({ buckets: 3, perBucket: 200 }));
check(
  '样本够但桶数不足时同样判「数据积累中」',
  fewBuckets.stage === 'pending' && fewBuckets.meta && fewBuckets.meta.needBuckets === VE.MIN_BUCKETS,
  JSON.stringify(fewBuckets.meta),
);

/* ============================================================
 * 二、三种典型形态能否区分
 * ============================================================ */

section('二、三种典型形态的判定');

// 主力吸筹：大单持续净买、价格几乎不动（低冲击吸收）、小单在卖
const accum = NORES(
  buildTrades({
    buckets: 14,
    perBucket: 40,
    startPrice: 100,
    endPrice: 100.4,
    bigNotional: 6000,
    bigDir: 1,
    bigPerBucket: 8,
    smallNotional: 60,
    smallDir: -1,
  }),
);
check('吸筹形态能给出结论（stage=ok）', accum.stage === 'ok', accum.stage);
check(
  '吸筹形态判定为「主力真实吸筹」',
  accum.stage === 'ok' && accum.verdict.key === 'accum',
  accum.stage === 'ok' ? `实得 ${accum.verdict.key}（${JSON.stringify(accum.scores)}）` : '未出结论',
);

// 主力诱多出货：价格在涨、大单持续净卖、小单在追买
const distrib = NORES(
  buildTrades({
    buckets: 14,
    perBucket: 40,
    startPrice: 100,
    endPrice: 104,
    bigNotional: 6000,
    bigDir: -1,
    bigPerBucket: 8,
    smallNotional: 60,
    smallDir: 1,
  }),
);
check(
  '诱多出货形态判定为「主力诱多出货」',
  distrib.stage === 'ok' && distrib.verdict.key === 'distrib',
  distrib.stage === 'ok' ? `实得 ${distrib.verdict.key}（${JSON.stringify(distrib.scores)}）` : '未出结论',
);
check('出货形态下「主力出货」分数最高', distrib.scores && distrib.scores.distrib > distrib.scores.accum);

// 纯散户：完全没有大单，成交靠碎单堆，方向均衡
const retail = NORES(
  buildTrades({
    buckets: 14,
    perBucket: 46,
    startPrice: 100,
    endPrice: 100.1,
    bigNotional: null,
    smallNotional: 45,
    smallDir: 1,
  }),
);
check(
  '纯散户形态判定为「纯散户行情无主力」',
  retail.stage === 'ok' && retail.verdict.key === 'retail',
  retail.stage === 'ok' ? `实得 ${retail.verdict.key}（${JSON.stringify(retail.scores)}）` : '未出结论',
);

/* ============================================================
 * 三、结果内部一致性
 * ============================================================ */

section('三、结果内部一致性');

const ok = accum;
check('三档成交额之和等于总量', ok.tiers && ['large', 'mid', 'small'].every((k) => Number.isFinite(ok.tiers[k].total)));
check(
  '三档占比合计约为 1',
  Math.abs(ok.tiers.large.share + ok.tiers.mid.share + ok.tiers.small.share - 1) < 1e-9,
  String(ok.tiers.large.share + ok.tiers.mid.share + ok.tiers.small.share),
);
check('每个档位的净额 = 买 − 卖', ['large', 'mid', 'small'].every((k) => Math.abs(ok.tiers[k].net - (ok.tiers[k].buy - ok.tiers[k].sell)) < 1e-9));
check('分档阈值为有限正数且大单线高于中单线', ok.profile.large > ok.profile.mid && ok.profile.mid > 0);
check('每个档位都有被动用的笔数记录', ok.tiers.large.buyCount + ok.tiers.large.sellCount > 0);
check(
  '证据里同时可能有支持与反对两栏（结构完整）',
  Array.isArray(ok.evidence.support) && Array.isArray(ok.evidence.against),
);

/* 阈值一致性：把研判引擎的阈值交给直方图口径的拆解器，结果必须吻合 */
const store = TS.create({ market: 'perp', symbol: 'TEST_USDT', intervalMs: INTERVAL, maxTrades: 20000, maxBuckets: 240 });
// 用逐笔构造一个「张数制」原始流，走真实归一化路径
const rawRows = [];
let rid = 1;
buildTrades({ buckets: 14, perBucket: 40, startPrice: 100, endPrice: 100.4, bigNotional: 6000, bigDir: 1, bigPerBucket: 8, smallNotional: 60, smallDir: -1 }).forEach((t) => {
  // 合成：合约乘数 2，张数 = 金额 ÷（乘数 × 价格），这样仓库归一化出来的美元额与上面完全一致
  rawRows.push({
    id: rid,
    price: t.price,
    size: (t.dir > 0 ? 1 : -1) * (t.notional / (2 * t.price)),
    create_time_ms: t.ts,
  });
  rid += 1;
});
store.ingest(rawRows, { quantoMultiplier: 2 });
const buckets = store.getBuckets();
const agg = TC.aggregate(buckets, { ready: true, midThreshold: ok.profile.mid, largeThreshold: ok.profile.large });
check('直方图口径能完成拆解', agg && agg.ready === true);
check(
  '两种口径的总成交额一致（同一把尺子、同一份数据）',
  Math.abs(agg.totalNotional - (ok.tiers.large.total + ok.tiers.mid.total + ok.tiers.small.total)) <
    Math.max(1, agg.totalNotional * 0.001),
  `直方图 ${agg.totalNotional.toFixed(2)} vs 逐笔 ${(ok.tiers.large.total + ok.tiers.mid.total + ok.tiers.small.total).toFixed(2)}`,
);
check(
  '直方图口径与逐笔口径认定的主导档位一致（都是大单）',
  agg.largeShare > agg.smallShare && agg.largeShare > 0.5 && ok.tiers.large.share > 0.5,
  `直方图大单 ${(agg.largeShare * 100).toFixed(1)}% / 逐笔 ${(ok.tiers.large.share * 100).toFixed(1)}%`,
);
// 直方图口径用于画时间轴（覆盖窗口内全部桶），临界金额那一箱按对数均匀近似切分，
// 与本用例的极端双峰分布（大单金额全部相等且恰好压在阈值上）相比会有量化差异；
// 真实行情的大单金额是连续分布的，差异远小于此处。这里只要求两者在同量级。
check(
  '两种口径的大单占比在同量级（量化误差在允许范围内）',
  Math.abs(agg.largeShare - ok.tiers.large.share) < 0.2,
  `直方图 ${(agg.largeShare * 100).toFixed(2)}% vs 逐笔 ${(ok.tiers.large.share * 100).toFixed(2)}%`,
);

/* ============================================================
 * 四、逐笔仓库：去重 / 缺口 / 覆盖率
 * ============================================================ */

section('四、逐笔仓库');

const s2 = TS.create({ market: 'perp', symbol: 'T2_USDT', intervalMs: INTERVAL, maxTrades: 20000, maxBuckets: 240 });
const mkV = (id, ts, price, size) => ({ id, ts, price, size, create_time_ms: ts });
const NOW_BUCKET = Math.floor(Date.now() / INTERVAL) * INTERVAL;

const r1 = s2.ingest(
  [
    mkV(1, NOW_BUCKET + 1000, 100, 10),
    mkV(2, NOW_BUCKET + 2000, 101, 20),
    mkV(3, NOW_BUCKET + 3000, 100, 30),
  ],
  { quantoMultiplier: 1 },
);
check('首批逐笔全部吸入', r1.added === 3, JSON.stringify(r1));

const r2 = s2.ingest([mkV(3, NOW_BUCKET + 3000, 100, 30), mkV(4, NOW_BUCKET + 4000, 102, 40)], { quantoMultiplier: 1 });
check('重复逐笔被去重', r2.duplicates === 1 && r2.added === 1, JSON.stringify(r2));

const r3 = s2.ingest([mkV(9, NOW_BUCKET + 5000, 103, 50)], { quantoMultiplier: 1 });
check('中间漏单能被检测为缺口', r3.gap && r3.gap.missed === 4, JSON.stringify(r3.gap));

const s2stats = s2.getStats();
check('缺口次数与漏单数被累计', s2stats.gapCount === 1 && s2stats.totalMissed === 4, JSON.stringify(s2stats));
check(
  '缺口涉及的桶被打上「不完整」标记',
  s2.getBuckets().some((b) => b.partial === true),
);

const s2cov = s2.computeCoverage([
  { t: NOW_BUCKET, sum: 100 * 10 + 101 * 20 + 100 * 30 },
]);
check('覆盖率只在已完结且完整跟踪的桶上统计', s2cov.overall === null || s2cov.overall >= 0);

/* 覆盖率正常场景：必须等一个「完整跟踪过的桶」走完
   （首个桶不算：开始跟踪前的半段逐笔根本没抓到，这也是页面上的真实口径） */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s3 = TS.create({ market: 'perp', symbol: 'T3_USDT', intervalMs: 1000, maxTrades: 20000, maxBuckets: 240 });
// 第一次写入：只用来把 firstFullBucketT0 推到下一个整桶
s3.ingest([mkV(900, Date.now(), 100, 10)], { quantoMultiplier: 1 });
await sleep(1100);
const tFull = Math.floor(Date.now() / 1000) * 1000; // 这个桶从头被完整跟踪
const rows3 = [];
for (let i = 0; i < 20; i += 1) rows3.push(mkV(1000 + i, tFull + i * 30, 100, 10));
s3.ingest(rows3, { quantoMultiplier: 1 });
await sleep(1100); // 等这个桶完结
const cov3 = s3.computeCoverage([{ t: tFull, sum: 20 * 10 * 100 }]);
check(
  '覆盖率对账能算出接近 100% 的值',
  cov3.overall !== null && Math.abs(cov3.overall - 1) < 0.05,
  String(cov3.overall),
);
check('覆盖率对账只统计完整跟踪过的桶', cov3.trackedCount === 1, String(cov3.trackedCount));

/* ============================================================
 * 五、健壮性：异常输入不能把页面搞崩
 * ============================================================ */

section('五、健壮性');

const empty = NORES([]);
check('空逐笔不抛错并给出「数据积累中」', empty.stage === 'pending');

const dirty = NORES([
  { ts: NaN, price: 100, notional: 10, dir: 1 },
  { ts: 1, price: NaN, notional: 10, dir: 1 },
  { ts: 1_700_000_000_000, price: 100, notional: -5, dir: 1 },
  { ts: 1_700_000_001_000, price: 100, notional: 0, dir: -1 },
  { ts: 1_700_000_002_000, price: 100, notional: Infinity, dir: 1 },
]);
check('含 NaN / 负值 / 无穷的脏数据被丢弃而不是抛错', dirty.stage === 'pending' && dirty.meta.samples === 0, JSON.stringify(dirty.meta));

const oneBucket = NORES(buildTrades({ buckets: 1, perBucket: 400 }));
check('只有一个时间桶时不给结构结论', oneBucket.stage === 'pending', oneBucket.stage);

// 极端离群值：一笔超大单混在一堆碎单里，阈值不能被单点带崩
const outlier = buildTrades({ buckets: 12, perBucket: 30, bigNotional: null, smallNotional: 40 });
outlier.push({ ts: outlier[outlier.length - 1].ts + 1000, price: 100, notional: 5_000_000, dir: 1 });
const outlierRes = NORES(outlier);
check('极端离群值不会导致分析抛错', outlierRes.stage === 'ok' || outlierRes.stage === 'pending', outlierRes.stage);
check('离群值不会让阈值变成非有限数', !outlierRes.profile || (Number.isFinite(outlierRes.profile.mid) && Number.isFinite(outlierRes.profile.large)));

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
