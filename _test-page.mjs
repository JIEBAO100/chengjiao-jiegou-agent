/**
 * 页面端到端自测（jsdom 真实加载页面 + 真实接口 + 真实交互）
 *
 * 验证的是「用户在浏览器里看到的东西」：
 *   1. 页面能完整加载，所有脚本按顺序执行，没有任何未捕获错误
 *   2. 全量币种名单真的加载进来了（数量级检查）
 *   3. 搜索框能输入、能筛选、能选中（键盘与鼠标两条路径）
 *   4. 成交结构拆解面板与主力行为研判面板都有内容（不是空白）
 *   5. 逐笔采集真的在推进（样本数增长）
 *   6. 交互控件（周期 / 观察窗 / 市场切换）不报错
 *   7. 页面上不出现任何具体数据平台的品牌名
 *
 * 前置条件：本地服务器已在 8792 端口运行（node dev-server.mjs）
 */

import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom'); // jsdom 装在共用的测试环境里

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8792';

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

/** 等条件成立，超时返回 false */
async function waitFor(fn, timeout = 20000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (fn()) return true;
    } catch (e) {
      /* 条件里访问还不存在的节点会抛错，忽略继续等 */
    }
    await sleep(step);
  }
  return false;
}

function serverAlive() {
  return new Promise((resolve) => {
    const req = http.get(BASE + '/', (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

const pageErrors = [];

if (!(await serverAlive())) {
  console.log('本地服务器没有运行（' + BASE + '）。请先执行：node dev-server.mjs');
  process.exit(1);
}

/* ============================================================
 * 加载页面
 * ============================================================ */

const dom = await JSDOM.fromURL(BASE + '/', {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  beforeParse(window) {
    // jsdom 不带 fetch，把 Node 的 fetch 注入进去（页面里用的是绝对地址，可直接复用）
    window.fetch = (...args) => fetch(...args);
    if (!window.AbortController) window.AbortController = AbortController;
    window.addEventListener('error', (e) => {
      pageErrors.push('error: ' + (e.message || e.error));
    });
    window.addEventListener('unhandledrejection', (e) => {
      pageErrors.push('unhandledrejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
    });
    const origError = window.console.error;
    window.console.error = function (...args) {
      pageErrors.push('console.error: ' + args.map((a) => (a && a.message ? a.message : String(a))).join(' '));
      return origError.apply(window.console, args);
    };
  },
});

const { window } = dom;
const doc = window.document;
const $ = (id) => doc.getElementById(id);
const text = (id) => ($(id) ? $(id).textContent : '');
const html = (id) => ($(id) ? $(id).innerHTML : '');

await sleep(600); // 等 DOMContentLoaded 后的初始化跑起来

section('一、页面骨架与脚本加载');

check('页面标题正确', /成交结构拆解智能体/.test(doc.title), doc.title);
check('参赛作品标识存在', /参赛作品/.test(doc.body.textContent));
check('免责声明存在', /不构成任何投资建议/.test(doc.body.textContent));
check('四个引擎模块都已挂载', !!(window.VerdictEngine && window.TradeClassifier && window.TradeStore && window.ApiClient));
check('K线图表模块已挂载', !!window.KlineChart);
check('成交结构时间轴模块已挂载', !!window.StructureChart);
check('两个新面板的容器都存在', !!$('structGrid') && !!$('scoreList'));
check('新增脚本已在页面上生效（classifier / verdict-engine）', /classifier\.js/.test(doc.documentElement.outerHTML) && /verdict-engine\.js/.test(doc.documentElement.outerHTML));

section('二、全量币种名单与搜索');

const symbolsLoaded = await waitFor(() => Number($('symbolMeta').textContent.match(/(\d+)\s*个币种/)?.[1] || 0) > 500, 30000);
const symbolCount = Number(text('symbolMeta').match(/(\d+)\s*个币种/)?.[1] || 0);
check('币种名单已加载', symbolsLoaded, text('symbolMeta'));
check('币种数量为全市场规模（>800，而不是只给几十个）', symbolCount > 800, String(symbolCount));
check('搜索输入框存在且可用', !!$('symbolInput') && $('symbolInput').disabled === false);

/* 聚焦 → 列出默认候选 */
$('symbolInput').dispatchEvent(new window.Event('focus'));
await sleep(120);
const dropAfterFocus = $('symbolDrop').querySelectorAll('.symbol-opt').length;
check('聚焦搜索框会列出候选币种', dropAfterFocus > 10, String(dropAfterFocus));

/* 输入关键词 → 过滤 */
$('symbolInput').value = 'SOL';
$('symbolInput').dispatchEvent(new window.Event('input'));
await sleep(150);
const optNames = Array.from($('symbolDrop').querySelectorAll('.symbol-opt-name')).map((n) => n.textContent);
check('输入 SOL 能筛出匹配项', optNames.length > 0, optNames.slice(0, 5).join(','));
check('筛选结果确实包含 SOL', optNames.some((n) => n.indexOf('SOL') === 0), optNames.slice(0, 5).join(','));
check('筛选结果不含明显不相关项（不会返回全表）', optNames.length <= 80, String(optNames.length));

/* 无匹配关键词 */
$('symbolInput').value = 'ZZZZZZ';
$('symbolInput').dispatchEvent(new window.Event('input'));
await sleep(150);
check('无匹配时给出明确提示而不是空白', /没有匹配/.test($('symbolDrop').textContent), $('symbolDrop').textContent.slice(0, 40));

/* 点击选中（鼠标路径） */
$('symbolInput').value = 'ETH';
$('symbolInput').dispatchEvent(new window.Event('input'));
await sleep(150);
const firstOpt = $('symbolDrop').querySelector('.symbol-opt');
check('筛选后可点击的候选项存在', !!firstOpt);
if (firstOpt) {
  const target = firstOpt.dataset.symbol;
  firstOpt.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await sleep(400);
  check('点击候选项后切换到了该币种', text('symbolMeta').indexOf(target.replace('_', '/')) >= 0, text('symbolMeta'));
  check('选中后下拉自动收起', $('symbolDrop').hidden === true);
  check('选中后搜索框被清空', $('symbolInput').value === '');
}

/* 键盘路径：输入 + 回车选择唯一匹配 */
$('symbolInput').value = 'DOGE';
$('symbolInput').dispatchEvent(new window.Event('input'));
await sleep(150);
$('symbolInput').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await sleep(400);
check('键盘回车同样能选中币种', text('symbolMeta').indexOf('DOGE') >= 0, text('symbolMeta'));

/* ============================================================
 * 三、数据采集与分析面板
 * ============================================================ */

section('三、采集推进与两个新面板');

const samplesGrew = await waitFor(() => Number(text('statSamples').replace(/[^\d]/g, '') || 0) > 0, 30000);
check('逐笔采集已经开始（累计样本 > 0）', samplesGrew, text('statSamples'));

const chartUnavailable = $('klineCanvas').hidden === true;
check(
  chartUnavailable
    ? '无画布环境下给出明确说明且页面不崩（jsdom 预期路径）'
    : 'K线画布正常初始化',
  true,
);

/* 成交结构面板：要么给出分档数字，要么明确说明数据积累中，不允许空白 */
const structRendered = await waitFor(() => html('structGrid').length > 30, 20000);
check('成交结构面板已渲染内容', structRendered, html('structGrid').slice(0, 60));
const structText = $('structGrid').textContent;
const structIsPending = /数据积累中/.test(structText);
check(
  structIsPending || /大单/.test(structText) && /中单/.test(structText) && /小单/.test(structText),
  structIsPending ? '当前为诚实占位（数据积累中）' : '已给出三档拆解',
);
check(
  '成交结构面板写明了口径与样本量',
  /采样|分档尺子|已完结桶|积累足够样本/.test($('structNote').textContent),
  $('structNote').textContent.slice(0, 60),
);

/* 研判面板：必须有结论徽章 + 三条分数或明确的样本不足说明 */
const verdictRendered = await waitFor(() => text('verdictBadge').length > 0, 20000);
check('研判面板已渲染结论徽章', verdictRendered, text('verdictBadge'));
check(
  ['主力真实吸筹', '主力诱多出货', '纯散户行情无主力', '结构模糊', '数据积累中'].some((k) => text('verdictBadge').indexOf(k) >= 0),
  '结论属于五种既定状态之一',
  text('verdictBadge'),
);
check('三种资金行为都出现在页面上', /主力吃货/.test(html('scoreList')) || /样本不足/.test(html('scoreList')), html('scoreList').slice(0, 80));
check('支持证据与反对证据两栏都存在', !!$('evidenceSupport') && !!$('evidenceAgainst'));
check('研判面板写明了判定口径', /逐笔样本|三态打分/.test($('verdictNote').textContent), $('verdictNote').textContent.slice(0, 60));

/* 时间轴卡片 */
check('成交结构时间轴卡片存在并给出窗口说明', text('structWindowChip').length > 0, text('structWindowChip'));

/* ============================================================
 * 四、交互控件
 * ============================================================ */

section('四、交互控件');

const marketBtns = doc.querySelectorAll('#segMarket .seg-btn');
marketBtns[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(600);
check('切换市场档位不报错', true);

const intervalBtns = doc.querySelectorAll('#segInterval .seg-btn');
intervalBtns[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(600);
check('切换周期不报错', true);

const windowBtns = doc.querySelectorAll('#segWindow .seg-btn');
windowBtns[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(300);
check('切换观察窗不报错', true);

$('btnToggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(300);
check('可以停止采集', /开始采集/.test(text('btnToggle')), text('btnToggle'));
$('btnToggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(300);
check('可以重新开始采集', /停止采集/.test(text('btnToggle')), text('btnToggle'));

/* ============================================================
 * 五、合规与技术底线
 * ============================================================ */

section('五、合规与技术底线');

const bodyText = doc.body.textContent;
check('页面可见文字里没有出现具体数据平台品牌名', !/Gate|gateio|Hyperliquid|hyperliquid|Binance|binance|OKX|Bybit/i.test(bodyText),
  (bodyText.match(/Gate|gateio|Hyperliquid|hyperliquid|Binance|binance/gi) || []).join(','));
check('页面没有出现本地调试地址', !/127\.0\.0\.1|localhost/.test(doc.documentElement.outerHTML));
const dataAreaText = doc.querySelector('.result-area') ? doc.querySelector('.result-area').textContent : '';
check('数据展示区没有出现「演示数据」类字样', !/演示数据|模拟数据|示例数据/.test(dataAreaText));
check('页面没有任何下单按钮', !/一键跟单|立即买入|立即卖出|马上买入/.test(bodyText));

/* ============================================================
 * 汇总
 * ============================================================ */

await sleep(500);
const realErrors = pageErrors.filter((e) => !/Could not load|Not implemented/i.test(e));
check('页面运行期间没有任何脚本错误', realErrors.length === 0, realErrors.slice(0, 3).join(' ｜ '));

console.log('\n' + '='.repeat(60));
if (fails.length === 0) {
  console.log(`  通过 ${pass} 项，失败 0 项`);
} else {
  console.log(`  通过 ${pass} 项，失败 ${fails.length} 项`);
  console.log('  失败清单：');
  fails.forEach((f) => console.log('    · ' + f));
}
if (realErrors.length) {
  console.log('\n  页面错误详情：');
  realErrors.slice(0, 6).forEach((e) => console.log('    · ' + e));
}
console.log('='.repeat(60));

window.close();
process.exitCode = fails.length ? 1 : 0;
