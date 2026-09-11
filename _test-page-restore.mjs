/**
 * 页面端到端自测（下半场）：本地缓存恢复 → 立即给出真实结论
 *
 * 为什么单独测这一条：
 *   结构类结论需要 6 个以上「已完结」的时间桶，靠实时采集要等好几分钟，
 *   测试里等不起。而本项目本来就支持把逐笔与时间桶存进浏览器本地存储、
 *   刷新后恢复继续算 —— 这里直接把一份「已积累好」的缓存塞进 localStorage，
 *   让页面走真实的恢复路径，验证：
 *     ① 恢复功能本身可用（刷新不丢数据）
 *     ② 恢复后能不能立刻算出分档与三态结论（也就是页面上那两块面板真的会出数）
 *     ③ 结论与分数是否落在合法范围内
 *
 * 前置条件：本地服务器已在 8792 端口运行
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8792';
const INTERVAL_MS = 60000; // 与页面默认的 1 分钟档一致
const SYMBOL = 'BTC_USDT';

let pass = 0;
const fails = [];
function check(name, ok, extra) {
  if (ok) pass += 1;
  else fails.push(name + (extra ? '　→ ' + extra : ''));
}
function section(t) {
  console.log('\n=== ' + t + ' ===');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 25000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (fn()) return true;
    } catch (e) {
      /* 元素还没出现，继续等 */
    }
    await sleep(step);
  }
  return false;
}

/* ============================================================
 * 造一份「已经积累好」的本地缓存
 * ============================================================ */

function buildPayload() {
  // 时间对齐：取最近若干个已完结的整分钟桶
  const nowBucket = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS;
  const bucketCount = 10;
  const tradesFirstT0 = nowBucket - bucketCount * INTERVAL_MS;

  const trades = [];
  const buckets = [];
  let id = 100000;
  let price = 60000;

  for (let b = 0; b < bucketCount; b += 1) {
    const t0 = tradesFirstT0 + b * INTERVAL_MS;

    // 每桶：大单净买（吸筹形态）+ 一批中小单
    const bigCount = 6;
    const smallCount = 190;
    let buyNot = 0;
    let sellNot = 0;
    let buyCnt = 0;
    let sellCnt = 0;
    const cntHist = [new Array(29).fill(0), new Array(29).fill(0)];
    const notHist = [new Array(29).fill(0), new Array(29).fill(0)];

    const binOf = (n) => Math.max(0, Math.min(28, Math.floor(Math.log10(n) * 4)));

    for (let k = 0; k < bigCount + smallCount; k += 1) {
      const isBig = k < bigCount;
      const notional = isBig ? 250000 + (k % 3) * 40000 : 800 + (k % 7) * 120;
      const dir = isBig ? 1 : k % 3 === 0 ? 1 : -1; // 大单净买，小单偏卖
      price *= 1 + (dir > 0 ? 0.00002 : -0.00001);
      const ts = t0 + Math.floor((k / (bigCount + smallCount)) * (INTERVAL_MS - 500));
      trades.push({ id: id++, ts, price, size: dir * (notional / (2 * price)), create_time_ms: ts });

      const di = dir > 0 ? 0 : 1;
      const bin = binOf(notional);
      cntHist[di][bin] += 1;
      notHist[di][bin] += notional;
      if (dir > 0) {
        buyNot += notional;
        buyCnt += 1;
      } else {
        sellNot += notional;
        sellCnt += 1;
      }
    }

    buckets.push({
      t0,
      buyNot,
      sellNot,
      buyCnt,
      sellCnt,
      cntHist,
      notHist,
      ordCntHist: [new Array(29).fill(0), new Array(29).fill(0)],
      ordNotHist: [new Array(29).fill(0), new Array(29).fill(0)],
      ordBuyNot: buyNot * 0.7,
      ordSellNot: sellNot * 0.7,
      ordBuyCnt: Math.round(buyCnt * 0.7),
      ordSellCnt: Math.round(sellCnt * 0.7),
      partial: false,
    });
  }

  // 只留最近 2000 条逐笔（与真实保存逻辑一致）
  const kept = trades.slice(-2000);

  return {
    key: `cjx:v1:perp:${SYMBOL}:${INTERVAL_MS}`,
    payload: {
      savedAt: Date.now(),
      options: { market: 'perp', symbol: SYMBOL, intervalMs: INTERVAL_MS },
      lastId: kept[kept.length - 1].id,
      lastT: kept[kept.length - 1].ts,
      startedAt: tradesFirstT0,
      firstFullBucketT0: tradesFirstT0,
      totalIngested: trades.length,
      totalMissed: 0,
      gapCount: 0,
      buckets,
      trades: kept.map((t) => [t.id, t.ts, t.price, t.notional !== undefined ? t.notional : 0, 0]).map((a, i) => {
        // trades 里存的是 [id, ts, price, notional, dir]，这里按真实格式重算 notional 与 dir
        const t = kept[i];
        const notional = Math.abs(t.size) * 2 * t.price;
        return [t.id, t.ts, t.price, notional, t.size > 0 ? 1 : -1];
      }),
    },
  };
}

const { key, payload } = buildPayload();
console.log(`准备缓存：${payload.buckets.length} 个时间桶、${payload.trades.length} 条逐笔`);

/* ============================================================
 * 加载页面（在页面脚本执行前写入缓存）
 * ============================================================ */

const dom = await JSDOM.fromURL(BASE + '/', {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = (...args) => fetch(...args);
    if (!window.AbortController) window.AbortController = AbortController;
    try {
      window.localStorage.setItem(key, JSON.stringify(payload));
    } catch (e) {
      console.log('写入本地缓存失败：' + e.message);
    }
  },
});

const { window } = dom;
const doc = window.document;
const $ = (id) => doc.getElementById(id);
const text = (id) => ($(id) ? $(id).textContent : '');
const html = (id) => ($(id) ? $(id).innerHTML : '');

section('一、缓存恢复');

const restored = await waitFor(() => /已从本地缓存恢复/.test(text('consoleHint')), 25000);
check('页面提示已从本地缓存恢复（刷新不丢数据）', restored, text('consoleHint').slice(0, 60));
check('恢复后累计样本数不为 0', Number(text('statSamples').replace(/[^\d]/g, '') || 0) > 0, text('statSamples'));

section('二、成交结构拆解面板出数');

const structReady = await waitFor(() => /大单/.test(html('structGrid')) && /中单/.test(html('structGrid')), 25000);
const structText = $('structGrid').textContent;
check('三档拆解已渲染出真实数字', structReady, structText.slice(0, 80));
check('大单金额已显示（不是占位符）', /大单[\s\S]*?\$/.test(structText) || /\$/.test(structText), structText.slice(0, 60));
check('展示了主动买 / 主动卖 / 净额 / 笔数', ['主动买', '主动卖', '净额', '笔数'].every((k) => structText.indexOf(k) >= 0));
check('写明了分档尺子（中单线与大单线）', /中单线/.test(text('structNote')) && /大单线/.test(text('structNote')), text('structNote').slice(0, 80));
check('标注了本卡口径', /逐笔精确分档|按桶直方图/.test(text('structNote')), text('structNote').slice(-60));

/* 占比条：三段，宽度合计约 100% */
const segs = $('shareBar').querySelectorAll('.share-seg');
check('占比条渲染成三段', segs.length === 3, String(segs.length));
const widths = Array.from(segs).map((s) => Number((s.getAttribute('style').match(/width:([\d.]+)%/) || [0, 0])[1]));
const sumW = widths.reduce((a, b) => a + b, 0);
check('三段占比合计约为 100%（±1%）', Math.abs(sumW - 100) < 1, widths.join(' + ') + ' = ' + sumW.toFixed(2));
check('大单占比明显大于 0（吸筹形态应有大单）', widths[0] > 5, String(widths[0]));

section('三、主力行为研判面板出数');

const verdictReady = await waitFor(
  () => /主力真实吸筹|主力诱多出货|纯散户行情无主力|结构模糊/.test(text('verdictBadge')),
  25000,
);
check('三态结论已给出（不再是数据积累中）', verdictReady, text('verdictBadge'));
check('结论为大单持续净买对应的「主力真实吸筹」', /主力真实吸筹/.test(text('verdictBadge')), text('verdictBadge'));

/* 三条分数条 */
const scoreRows = $('scoreList').querySelectorAll('.score-row');
check('三个行为分数条都渲染出来了', scoreRows.length === 3, String(scoreRows.length));
const scoreVals = Array.from($('scoreList').querySelectorAll('.score-val')).map((n) => Number(n.textContent));
check('三个分数都在 0–100 之间', scoreVals.every((v) => Number.isFinite(v) && v >= 0 && v <= 100), scoreVals.join(','));
check('吸筹形态下「主力吃货」分数最高', scoreVals[0] > scoreVals[1] && scoreVals[0] > scoreVals[2], scoreVals.join(' / '));
check('最高分的行带上了领先标记', $('scoreList').querySelectorAll('.score-row.is-leader').length === 1);

/* 证据两栏 */
check('支持证据栏有内容', $('evidenceSupport').querySelectorAll('li').length > 0);
check('支持证据里至少有一条非空说明', $('evidenceSupport').textContent.trim().length > 8, $('evidenceSupport').textContent.slice(0, 60));
check('反对证据栏位存在（没有证据时给出明确空态）', $('evidenceAgainst').querySelectorAll('li').length >= 1, $('evidenceAgainst').textContent.slice(0, 60));

/* 置信度与口径脚注 */
check('给出了置信度', /置信度\s*\d+%/.test(text('verdictConfChip')), text('verdictConfChip'));
check('口径脚注写明样本与桶数', /逐笔样本/.test(text('verdictNote')) && /已完结桶/.test(text('verdictNote')), text('verdictNote').slice(0, 80));
check('口径脚注写明覆盖率或待对账', /覆盖率/.test(text('verdictNote')));

section('四、时间轴与统计');

check('时间轴窗口说明显示桶数', /\d+\s*个桶/.test(text('structWindowChip')), text('structWindowChip'));
check('采集状态显示无缺口（造的缓存是完整的）', /无（每 2 秒轮询，无漏单）|无/.test(text('statGaps')), text('statGaps'));
const dataArea = doc.querySelector('.result-area').textContent;
check('数据展示区没有出现「演示数据」类字样', !/演示数据|模拟数据|示例数据/.test(dataArea));

/* 收尾：先停掉采集再关窗口，避免页面在窗口销毁后仍有一次轮询回调（测试环境特有） */
const toggle = $('btnToggle');
if (toggle && /停止采集/.test(toggle.textContent)) {
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(400);
}

console.log('\n' + '='.repeat(60));
if (fails.length === 0) {
  console.log(`  通过 ${pass} 项，失败 0 项`);
} else {
  console.log(`  通过 ${pass} 项，失败 ${fails.length} 项`);
  console.log('  失败清单：');
  fails.forEach((f) => console.log('    · ' + f));
}
console.log('='.repeat(60));

window.close();
process.exitCode = fails.length ? 1 : 0;
