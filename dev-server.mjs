/**
 * 本地测试服务器
 * 作用：在没有安装 Netlify 命令行工具的情况下，也能在本地完整测试页面和接口
 * 特点：静态文件与线上结构完全一致，/api 路由复用了 Netlify Functions 的同一份代码
 *       也就是说，本地测通的逻辑，部署到线上后行为一致
 *
 * 目录结构说明（扁平结构）：
 *   项目根目录里的 index.html、styles.css、各个 .js 就是网页本体，
 *   functions/ 里放云端接口（线上走 Netlify Functions，本地由本服务器直接调用）。
 *
 * 启动方式：node dev-server.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 8792;
const HOST = '127.0.0.1';

// 复用线上的接口代码，保证本地与线上行为一致
const marketFn = require('./functions/market.cjs');
const symbolsFn = require('./functions/symbols.cjs');
const tradesFn = require('./functions/trades.cjs');

// 静态文件根目录就是项目根目录（扁平结构）
const ROOT_DIR = __dirname;

// 路由映射：把 /api 请求交给对应的接口处理函数
const API_ROUTES = {
  '/api/market': marketFn.handler,
  '/api/symbols': symbolsFn.handler,
  '/api/trades': tradesFn.handler,
};

/**
 * 本地不需要暴露给浏览器的内容。
 * 线上部署时 Netlify 会把 functions/ 单独处理，文档类文件也没必要访问。
 */
const BLOCKED_DIRS = ['/.git', '/node_modules', '/functions'];
// 网页运行时不需要的开发者文件一律不对外提供（.json 只有 package.json 这类配置，
// 页面取数全部走 /api，不依赖任何本地 JSON 文件）
const BLOCKED_EXT = ['.md', '.toml', '.mjs', '.cjs', '.json'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  // 接口请求：转成 Netlify 的事件格式再交给同一份处理逻辑
  if (API_ROUTES[pathname]) {
    const query = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    try {
      const result = await API_ROUTES[pathname]({
        httpMethod: req.method,
        queryStringParameters: query,
        headers: req.headers,
        body: null,
        path: pathname,
      });
      res.writeHead(result.statusCode || 200, result.headers || {});
      res.end(result.body || '');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(err && err.message) }));
    }
    return;
  }

  // 目标文件路径
  let filePath = path.join(ROOT_DIR, decodeURIComponent(pathname));
  if (pathname === '/' || pathname === '') {
    filePath = path.join(ROOT_DIR, 'index.html');
  }

  const normalized = path.relative(ROOT_DIR, filePath).replace(/\\/g, '/');

  // 安全检查一：不允许越出项目根目录
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('禁止访问');
    return;
  }

  // 安全检查二：版本库、依赖目录、接口源码、文档类文件不通过网页暴露
  const blockedByDir = BLOCKED_DIRS.some((d) => ('/' + normalized).startsWith(d + '/') || '/' + normalized === d);
  const blockedByExt = BLOCKED_EXT.includes(path.extname(normalized).toLowerCase());
  // 以点开头的文件（.gitignore、.env 等）一律不对外提供
  const blockedByDot = normalized.startsWith('.') || normalized.includes('/.');
  if (blockedByDir || blockedByExt || blockedByDot) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('禁止访问');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    // 找不到文件时回到首页，模拟线上的单页兜底行为
    if (err || !stat.isFile()) {
      filePath = path.join(ROOT_DIR, 'index.html');
    }
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('未找到文件');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  成交结构拆解智能体 · 本地测试服务器已启动');
  console.log('  ------------------------------------------------');
  console.log(`  本地地址： http://${HOST}:${PORT}`);
  console.log('');
  console.log('  接口自检：');
  console.log(`  行情接口： http://${HOST}:${PORT}/api/market?market=perp&symbol=BTC_USDT&interval=15m`);
  console.log(`  币种接口： http://${HOST}:${PORT}/api/symbols?market=perp`);
  console.log(`  逐笔接口： http://${HOST}:${PORT}/api/trades?market=perp&symbol=BTC_USDT&limit=100`);
  console.log('');
  console.log('  关闭服务器：按 Ctrl + C');
  console.log('');
});
