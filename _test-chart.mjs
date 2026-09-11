/**
 * 图表绘制专项自测（不联网、不依赖真实浏览器）
 *
 * 为什么需要这一层：
 *   jsdom 没有画布实现（getContext 返回 null），所以它只能验证「拿不到画布时不崩」这条兜底路径，
 *   验证不了「真的画出来了」。而画布最常见的隐形故障是：
 *     · 某个坐标算出 NaN 或 Infinity → 整段图形静默不画，页面看着像空白，也不报错
 *     · 柱子数量、K线数量与数据对不上 → 图和数据不一致
 *   这里给图表模块喂一个「记录型 2D 上下文」，把每一次绘制调用都记下来，
 *   再逐项核对：调用次数是否与数据规模匹配、坐标是否全部有限、缩放是否正确。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const fails = [];
function check(name, ok, extra) {
  if (ok) pass += 1;
  else fails.push(name + (extra ? '　→ ' + extra : ''));
}
function section(t) {
  console.log('\n=== ' + t + ' ===');
}

/* ============================================================
 * 造一个记录型画布环境
 * ============================================================ */

function makeRecorder() {
  const calls = [];
  const badCoords = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    args.forEach((a) => {
      if (typeof a === 'number' && !Number.isFinite(a)) badCoords.push(`${name}(${args.join(',')})`);
    });
  };
  const ctx = {
    // 状态属性（赋值即记录，便于检查是否设置了颜色）
    set fillStyle(v) {
      calls.push({ name: 'fillStyle=', args: [String(v)] });
    },
    set strokeStyle(v) {
      calls.push({ name: 'strokeStyle=', args: [String(v)] });
    },
    set lineWidth(v) {
      if (!Number.isFinite(v)) badCoords.push('lineWidth ' + v);
    },
    set font(v) {},
    set textAlign(v) {},
    set textBaseline(v) {},
    set globalAlpha(v) {},
    setTransform: record('setTransform'),
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    stroke: record('stroke'),
    fill: record('fill'),
    fillText: record('fillText'),
    setLineDash: record('setLineDash'),
    roundRect: record('roundRect'),
    measureText: (t) => ({ width: String(t).length * 6 }),
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
  };
  return { ctx, calls, badCoords };
}

function makeCanvas(w = 900, h = 420) {
  const rec = makeRecorder();
  const listeners = {};
  const canvas = {
    width: 0,
    height: 0,
    hidden: false,
    parentElement: null,
    style: {},
    getContext: () => rec.ctx,
    getBoundingClientRect: () => ({ width: w, height: h, left: 0, top: 0 }),
    addEventListener: (ev, fn) => {
      listeners[ev] = fn;
    },
    _listeners: listeners,
  };
  return { canvas, rec };
}

/* 让图表模块以为自己在浏览器里 */
globalThis.window = globalThis;
globalThis.window.devicePixelRatio = 2;
globalThis.window.addEventListener = () => {};
globalThis.window.ResizeObserver = undefined;

['chart.js'].forEach((f) => {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  new Function(code)();
});
const { KlineChart, StructureChart } = globalThis.window;

/* ============================================================
 * 一、K线图
 * ============================================================ */

section('一、K线图绘制');

function mkCandles(n) {
  const base = Math.floor(Date.now() / 60000) * 60000 - n * 60000;
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const o = price;
    const c = price * (1 + (i % 5 === 0 ? 0.004 : -0.002));
    out.push({
      t: base + i * 60000,
      o,
      h: Math.max(o, c) * 1.001,
      l: Math.min(o, c) * 0.999,
      c,
      v: 1000 + (i % 7) * 250,
      sum: (1000 + (i % 7) * 250) * price,
    });
    price = c;
  }
  return out;
}

const { canvas: kCanvas, rec: kRec } = makeCanvas();
const kchart = KlineChart.createChart(kCanvas, { interval: '1m', onHover: () => {} });
check('K线图在有画布时可用', kchart.available === true);

const candles = mkCandles(60);
kchart.setData(candles);
check('画布尺寸按设备像素比设置', kCanvas.width === 1800 && kCanvas.height === 840, `${kCanvas.width}x${kCanvas.height}`);

const kFillRects = kRec.calls.filter((c) => c.name === 'fillRect');
const kLines = kRec.calls.filter((c) => c.name === 'lineTo');
const kTexts = kRec.calls.filter((c) => c.name === 'fillText');
check('K线坐标没有 NaN / Infinity', kRec.badCoords.length === 0, kRec.badCoords.slice(0, 3).join(' | '));
check('K线实体按根数绘制（60 根 → 至少 60 个矩形，另加成交量柱）', kFillRects.length >= 120, String(kFillRects.length));
check('绘制了影线与网格（有大量 lineTo 调用）', kLines.length > 60, String(kLines.length));
check('绘制了价格与时间刻度文字', kTexts.length >= 8, String(kTexts.length));
check('成交量柱也画出来了（矩形数明显多于 K 线根数）', kFillRects.length >= 120);

/* 空数据与单点数据不能崩 */
const { canvas: kCanvas2, rec: kRec2 } = makeCanvas();
const kchart2 = KlineChart.createChart(kCanvas2, { interval: '1m' });
kchart2.setData([]);
check('空K线数据时给出提示而不是崩', kRec2.calls.some((c) => c.name === 'fillText' && /暂无/.test(String(c.args[0]))));
kchart2.setData([candles[0]]);
check('只有一根K线时不崩', kRec2.badCoords.length === 0);

/* 异常值不能污染坐标 */
const { canvas: kCanvas3, rec: kRec3 } = makeCanvas();
const kchart3 = KlineChart.createChart(kCanvas3, { interval: '1m' });
kchart3.setData([
  { t: candles[0].t, o: 100, h: 101, l: 99, c: 100.5, v: 10, sum: 1000 },
  { t: candles[1].t, o: NaN, h: NaN, l: NaN, c: NaN, v: NaN, sum: NaN },
  { t: candles[2].t, o: 100, h: 102, l: 98, c: 101, v: 12, sum: 1200 },
]);
check('含 NaN 的K线不会画出非法坐标', kRec3.badCoords.length === 0, kRec3.badCoords.slice(0, 3).join(' | '));

/* ============================================================
 * 二、成交结构时间轴
 * ============================================================ */

section('二、成交结构时间轴绘制');

const { canvas: sCanvas, rec: sRec } = makeCanvas();
const schart = StructureChart.createChart(sCanvas, { onHover: () => {} });
check('时间轴在有画布时可用', schart.available === true);

const rows = [];
const t0 = Math.floor(Date.now() / 60000) * 60000 - 20 * 60000;
for (let i = 0; i < 20; i += 1) {
  rows.push({
    t0: t0 + i * 60000,
    partial: i === 7,
    total: 1_000_000 + i * 20_000,
    largeBuy: 300_000 + i * 5_000,
    largeSell: 200_000 + (i % 3) * 10_000,
    midBuy: 150_000,
    midSell: 140_000,
    smallBuy: 90_000,
    smallSell: 95_000,
    netLarge: 100_000 + (i % 4) * 30_000,
  });
}
schart.setData(rows);

const sFill = sRec.calls.filter((c) => c.name === 'fillRect');
const sText = sRec.calls.filter((c) => c.name === 'fillText');
const sLineTo = sRec.calls.filter((c) => c.name === 'lineTo');
check('时间轴坐标没有 NaN / Infinity', sRec.badCoords.length === 0, sRec.badCoords.slice(0, 3).join(' | '));
check('每个桶都画了三档堆叠柱（20 桶 → 至少 60 个矩形）', sFill.length >= 60, String(sFill.length));
check('大单净额折线已绘制', sLineTo.length >= rows.length, String(sLineTo.length));
check('图例文字已绘制（小单 / 中单 / 大单 / 大单净额）', ['小单', '中单', '大单', '大单净额'].every((k) => sText.some((c) => String(c.args[0]).indexOf(k) >= 0)), sText.map((c) => String(c.args[0])).slice(0, 6).join('|'));
check('金额刻度已绘制', sRec.calls.filter((c) => c.name === 'fillText').some((c) => /万|亿/.test(String(c.args[0]))));

/* 全部为负的大单净额：折线要画在零轴下方，不能把坐标算成非法值 */
const { canvas: sCanvas2, rec: sRec2 } = makeCanvas();
const schart2 = StructureChart.createChart(sCanvas2, { onHover: () => {} });
schart2.setData(rows.map((r) => Object.assign({}, r, { netLarge: -Math.abs(r.netLarge) })));
check('大单净额为负时坐标依然合法', sRec2.badCoords.length === 0, sRec2.badCoords.slice(0, 3).join(' | '));

/* 空数据 */
const { canvas: sCanvas3, rec: sRec3 } = makeCanvas();
const schart3 = StructureChart.createChart(sCanvas3, { onHover: () => {} });
schart3.setData([]);
check('时间轴无数据时给出提示而不是崩', sRec3.calls.some((c) => c.name === 'fillText' && /暂无/.test(String(c.args[0]))));

/* 全零数据：不能出现除以零导致的 NaN */
const { canvas: sCanvas4, rec: sRec4 } = makeCanvas();
const schart4 = StructureChart.createChart(sCanvas4, { onHover: () => {} });
schart4.setData([
  { t0: t0, largeBuy: 0, largeSell: 0, midBuy: 0, midSell: 0, smallBuy: 0, smallSell: 0, netLarge: 0 },
  { t0: t0 + 60000, largeBuy: 0, largeSell: 0, midBuy: 0, midSell: 0, smallBuy: 0, smallSell: 0, netLarge: 0 },
]);
check('全零数据不会产生 NaN 坐标', sRec4.badCoords.length === 0, sRec4.badCoords.slice(0, 3).join(' | '));

/* 单个桶也不能崩 */
schart4.setData([rows[0]]);
check('只有一个时间桶时也能绘制', sRec4.badCoords.length === 0);

/* ============================================================
 * 三、拿不到画布时的兜底（与 jsdom 环境一致）
 * ============================================================ */

section('三、无画布环境的兜底');

const deadCanvas = {
  getContext: () => null,
  getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0 }),
  addEventListener: () => {},
  parentElement: null,
  style: {},
};
const kDead = KlineChart.createChart(deadCanvas, {});
check('无画布时 K 线图返回不可用标记并给出原因', kDead.available === false && typeof kDead.reason === 'string' && kDead.reason.length > 0);
check('无画布时调用 setData 不抛错', (() => { try { kDead.setData([{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }]); return true; } catch (e) { return false; } })());

const sDead = StructureChart.createChart(deadCanvas, {});
check('无画布时时间轴返回不可用标记并给出原因', sDead.available === false && typeof sDead.reason === 'string' && sDead.reason.length > 0);
check('无画布时调用 setData 不抛错', (() => { try { sDead.setData([{ t0: 1 }]); return true; } catch (e) { return false; } })());

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
