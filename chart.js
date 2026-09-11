/**
 * 轻量K线图表（纯 Canvas 绘制）
 * 说明：不依赖任何外部图表库，避免线上 CDN 加载失败导致页面空白
 * 内容：价格K线 + 成交量柱 + 最新价标线 + 鼠标十字定位
 * 颜色：按中国习惯，上涨为红色，下跌为绿色
 */

(function () {
  const UP_COLOR = '#d9382b';
  const DOWN_COLOR = '#0e7a4f';
  const GRID_COLOR = 'rgba(125, 106, 72, 0.16)';
  const AXIS_TEXT = '#7d6a48';

  function createChart(canvas, options = {}) {
    const ctx2d = canvas.getContext && canvas.getContext('2d');

    // 极少数环境拿不到 2D 绘图上下文（浏览器禁用了画布、或环境不支持）。
    // 这种情况下返回一个什么都不做的空图表，让页面其余部分照常工作，
    // 而不是抛错导致整个分析结果都无法显示。
    if (!ctx2d) {
      return {
        available: false,
        reason: '当前浏览环境不支持画布绘图，K线图无法显示，其余分析结果不受影响。',
        setData() {},
        redraw() {},
      };
    }

    let state = { candles: [], hoverIndex: -1, layout: null };

    /* 计算绘图区域，把画布分成价格区和成交量区 */
    function computeLayout(w, h) {
      const padLeft = 8;
      const padRight = 66; // 右侧留给价格刻度
      const padTop = 14;
      const padBottom = 22; // 底部留给时间刻度
      const gap = 14;
      const volumeH = Math.max(48, Math.round((h - padTop - padBottom - gap) * 0.24));
      const priceTop = padTop;
      const priceBottom = h - padBottom - volumeH - gap;
      return {
        padLeft,
        padRight,
        padTop,
        padBottom,
        priceTop,
        priceBottom,
        volumeTop: priceBottom + gap,
        volumeBottom: h - padBottom,
        plotLeft: padLeft,
        plotRight: w - padRight,
      };
    }

    /* 价格取整到合适的显示精度，避免出现一长串小数 */
    function fmtPrice(v) {
      if (v === null || !Number.isFinite(v)) return '—';
      const abs = Math.abs(v);
      if (abs >= 10000) return v.toFixed(0);
      if (abs >= 100) return v.toFixed(2);
      if (abs >= 1) return v.toFixed(3);
      if (abs >= 0.01) return v.toFixed(5);
      return v.toPrecision(4);
    }

    function fmtTime(ts, interval) {
      const d = new Date(ts);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      // 1 小时以上的周期把日期带上，短周期只看时分就够了
      if (interval === '1h' || interval === '4h' || interval === '1d') {
        return `${mm}-${dd} ${hh}:${mi}`;
      }
      return `${mm}-${dd} ${hh}:${mi}`;
    }

    function render() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(rect.width, 240);
      const h = Math.max(rect.height, 200);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, w, h);

      const candles = state.candles;
      if (!candles || candles.length < 2) {        ctx2d.fillStyle = AXIS_TEXT;
        ctx2d.font = '13px system-ui, sans-serif';
        ctx2d.textAlign = 'center';
        ctx2d.fillText('暂无K线数据', w / 2, h / 2);
        return;
      }

      const L = computeLayout(w, h);
      state.layout = L;

      const plotW = L.plotRight - L.plotLeft;
      const priceH = L.priceBottom - L.priceTop;
      const volH = L.volumeBottom - L.volumeTop;

      /* 纵轴范围：以K线高低点为准 */
      let hi = -Infinity;
      let lo = Infinity;
      candles.forEach((c) => {
        if (c.h > hi) hi = c.h;
        if (c.l < lo) lo = c.l;
      });
      const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
      hi += pad;
      lo -= pad;
      const span = hi - lo || 1;

      let volMax = 0;
      candles.forEach((c) => {
        if (Number.isFinite(c.v) && c.v > volMax) volMax = c.v;
      });
      if (volMax <= 0) volMax = 1;

      const stepX = plotW / candles.length;
      const bodyW = Math.max(1.2, Math.min(stepX * 0.66, 11));
      const xOf = (i) => L.plotLeft + stepX * (i + 0.5);
      const yPrice = (v) => L.priceBottom - ((v - lo) / span) * priceH;
      const yVol = (v) => L.volumeBottom - (v / volMax) * volH;

      /* 横向网格与价格刻度 */
      ctx2d.font = '11px system-ui, sans-serif';
      ctx2d.textAlign = 'left';
      ctx2d.textBaseline = 'middle';
      const gridCount = 5;
      for (let g = 0; g <= gridCount; g++) {
        const y = L.priceTop + (priceH / gridCount) * g;
        ctx2d.strokeStyle = GRID_COLOR;
        ctx2d.lineWidth = 0.5;
        ctx2d.beginPath();
        ctx2d.moveTo(L.plotLeft, y);
        ctx2d.lineTo(L.plotRight, y);
        ctx2d.stroke();
        const value = hi - (span / gridCount) * g;
        ctx2d.fillStyle = AXIS_TEXT;
        ctx2d.fillText(fmtPrice(value), L.plotRight + 6, y);
      }

      /* 时间刻度：均匀取 5 个位置 */
      ctx2d.textAlign = 'center';
      ctx2d.textBaseline = 'top';
      const ticks = 5;
      for (let t = 0; t <= ticks; t++) {
        const idx = Math.min(candles.length - 1, Math.round(((candles.length - 1) / ticks) * t));
        const x = xOf(idx);
        ctx2d.strokeStyle = GRID_COLOR;
        ctx2d.beginPath();
        ctx2d.moveTo(x, L.priceTop);
        ctx2d.lineTo(x, L.volumeBottom);
        ctx2d.stroke();
        ctx2d.fillStyle = AXIS_TEXT;
        ctx2d.fillText(fmtTime(candles[idx].t, options.interval), x, L.volumeBottom + 5);
      }

      /* K线本体 */
      let lastX = null;
      let lastY = null;
      candles.forEach((c, i) => {
        const x = xOf(i);
        const up = c.c >= c.o;
        const color = up ? UP_COLOR : DOWN_COLOR;

        // 上下影线
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = 1;
        ctx2d.beginPath();
        ctx2d.moveTo(x, yPrice(c.h));
        ctx2d.lineTo(x, yPrice(c.l));
        ctx2d.stroke();

        // 实体
        const yo = yPrice(c.o);
        const yc = yPrice(c.c);
        const top = Math.min(yo, yc);
        const bh = Math.max(Math.abs(yc - yo), 1);
        ctx2d.fillStyle = up ? 'rgba(217, 56, 43, 0.92)' : 'rgba(14, 122, 79, 0.92)';
        ctx2d.fillRect(x - bodyW / 2, top, bodyW, bh);
        lastX = x;
        lastY = yc;
      });

      /* 最新价虚线与右侧价签 */
      if (lastY !== null) {
        ctx2d.strokeStyle = 'rgba(138, 24, 16, 0.5)';
        ctx2d.lineWidth = 0.8;
        ctx2d.setLineDash([5, 4]);
        ctx2d.beginPath();
        ctx2d.moveTo(L.plotLeft, lastY);
        ctx2d.lineTo(L.plotRight, lastY);
        ctx2d.stroke();
        ctx2d.setLineDash([]);

        const label = fmtPrice(candles[candles.length - 1].c);
        ctx2d.font = '11px system-ui, sans-serif';
        const tw = ctx2d.measureText(label).width + 10;
        ctx2d.fillStyle = '#8a1810';
        if (ctx2d.roundRect) {
          ctx2d.beginPath();
          ctx2d.roundRect(L.plotRight + 2, lastY - 9, tw, 18, 4);
          ctx2d.fill();
        } else {
          ctx2d.fillRect(L.plotRight + 2, lastY - 9, tw, 18);
        }
        ctx2d.fillStyle = '#fff8f0';
        ctx2d.textAlign = 'left';
        ctx2d.textBaseline = 'middle';
        ctx2d.fillText(label, L.plotRight + 7, lastY);
      }

      /* 成交量柱 */
      candles.forEach((c, i) => {
        const x = xOf(i);
        const up = c.c >= c.o;
        const v = Number.isFinite(c.v) ? c.v : 0;
        const y = yVol(v);
        ctx2d.fillStyle = up ? 'rgba(217, 56, 43, 0.45)' : 'rgba(14, 122, 79, 0.45)';
        ctx2d.fillRect(x - bodyW / 2, y, bodyW, L.volumeBottom - y);
      });
      ctx2d.strokeStyle = GRID_COLOR;
      ctx2d.lineWidth = 0.5;
      ctx2d.beginPath();
      ctx2d.moveTo(L.plotLeft, L.volumeBottom);
      ctx2d.lineTo(L.plotRight, L.volumeBottom);
      ctx2d.stroke();

      /* 十字定位 */
      const hi2 = state.hoverIndex;
      if (hi2 >= 0 && hi2 < candles.length) {
        const x = xOf(hi2);
        const c = candles[hi2];
        ctx2d.strokeStyle = 'rgba(138, 24, 16, 0.5)';
        ctx2d.lineWidth = 0.8;
        ctx2d.setLineDash([3, 3]);
        ctx2d.beginPath();
        ctx2d.moveTo(x, L.priceTop);
        ctx2d.lineTo(x, L.volumeBottom);
        ctx2d.stroke();
        const yc = yPrice(c.c);
        ctx2d.beginPath();
        ctx2d.moveTo(L.plotLeft, yc);
        ctx2d.lineTo(L.plotRight, yc);
        ctx2d.stroke();
        ctx2d.setLineDash([]);

        if (options.onHover) options.onHover(hi2, x, yc, c);
      }
    }

    /* 鼠标移动时定位到最近的K线 */
    canvas.addEventListener('mousemove', (e) => {
      const L = state.layout;
      if (!L || !state.candles.length) return;
      const rect = canvas.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      const plotW = L.plotRight - L.plotLeft;
      const stepX = plotW / state.candles.length;
      const idx = Math.floor((relX - L.plotLeft) / stepX);
      if (idx >= 0 && idx < state.candles.length && idx !== state.hoverIndex) {
        state.hoverIndex = idx;
        render();
      } else if (idx < 0 || idx >= state.candles.length) {
        if (state.hoverIndex !== -1) {
          state.hoverIndex = -1;
          if (options.onHover) options.onHover(-1);
          render();
        }
      }
    });

    canvas.addEventListener('mouseleave', () => {
      state.hoverIndex = -1;
      if (options.onHover) options.onHover(-1);
      render();
    });

    // 容器尺寸变化时重新绘制，保证手机和电脑都正常
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => render());
      ro.observe(canvas.parentElement || canvas);
    } else {
      window.addEventListener('resize', render);
    }

    return {
      available: true,
      setData(candles) {
        // 只接受四个价格字段都完整的K线：含 NaN 的K线会让坐标算成 NaN，
        // 画布不会报错，只会静默地把这段图形丢掉（自测里真实抓到过）
        state.candles = (candles || []).filter(
          (c) =>
            c &&
            Number.isFinite(c.t) &&
            Number.isFinite(c.o) &&
            Number.isFinite(c.h) &&
            Number.isFinite(c.l) &&
            Number.isFinite(c.c),
        );
        state.hoverIndex = -1;
        render();
      },
      redraw: render,
    };
  }

  window.KlineChart = { createChart };
})();

/* =========================================================================
 * 成交结构时间轴（纯 Canvas 绘制）
 * -------------------------------------------------------------------------
 * 每个时间桶画一根堆叠柱：自下而上依次为 小单 / 中单 / 大单 的成交额；
 * 再叠一条「大单净额」折线（零轴之上净买入、之下净卖出）。
 * 说明：不依赖任何外部图表库，配色沿用页面主题，涨跌与买卖遵循中国习惯。
 * ========================================================================= */

(function () {
  const TIER = [
    { key: 'small', color: 'rgba(154, 167, 184, 0.85)', legend: '小单' },
    { key: 'mid', color: 'rgba(217, 161, 59, 0.85)', legend: '中单' },
    { key: 'large', color: 'rgba(192, 42, 28, 0.9)', legend: '大单' },
  ];
  const AXIS_TEXT = '#7d6a48';
  const GRID_COLOR = 'rgba(125, 106, 72, 0.16)';
  const NET_UP = '#b52a1f';
  const NET_DOWN = '#0e7a4f';

  function createChart(canvas, options = {}) {
    const ctx2d = canvas.getContext && canvas.getContext('2d');

    // 拿不到绘图上下文时返回空图表：页面其余部分照常工作，不因为画不出图就整页报错
    if (!ctx2d) {
      return {
        available: false,
        reason: '当前浏览环境不支持画布绘图，成交结构时间轴无法显示，其余分析结果不受影响。',
        setData() {},
        redraw() {},
      };
    }

    let state = { rows: [], layout: null, hoverIndex: -1 };

    /**
     * 取某个桶里某一档的成交额，兼容两种数据形态：
     *   · 已汇总好的 { small, mid, large }
     *   · 分买卖明细的 { smallBuy, smallSell, midBuy, ... }（analysis 模块输出的原始形态）
     * 这里做兼容的原因：直方图拆解模块输出的是后者，图表不该强迫上游改结构，
     * 否则一旦字段对不上，柱子高度会全部算成 0 —— 图上一片空白却不报错（自测里真实踩过）。
     */
    function tierAmount(row, key) {
      const direct = row[key];
      if (Number.isFinite(direct)) return direct;
      const buy = Number.isFinite(row[key + 'Buy']) ? row[key + 'Buy'] : 0;
      const sell = Number.isFinite(row[key + 'Sell']) ? row[key + 'Sell'] : 0;
      return buy + sell;
    }

    function rowTotal(row) {
      return tierAmount(row, 'small') + tierAmount(row, 'mid') + tierAmount(row, 'large');
    }

    /** 金额刻度：自动切换 万 / 亿，避免出现一长串数字 */
    function fmtUsd(v) {
      if (!Number.isFinite(v) || v === 0) return '0';
      const abs = Math.abs(v);
      if (abs >= 1e8) return (v / 1e8).toFixed(1) + '亿';
      if (abs >= 1e4) return (v / 1e4).toFixed(1) + '万';
      return v.toFixed(0);
    }

    function fmtTime(ts) {
      const d = new Date(ts);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    function render() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(rect.width, 240);
      const h = Math.max(rect.height, 180);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, w, h);

      const rows = state.rows || [];
      if (rows.length < 1) {
        ctx2d.fillStyle = AXIS_TEXT;
        ctx2d.font = '13px system-ui, sans-serif';
        ctx2d.textAlign = 'center';
        ctx2d.fillText('暂无成交结构数据（样本积累中）', w / 2, h / 2);
        return;
      }

      const padLeft = 8;
      const padRight = 72;
      const padTop = 26; // 顶部留给图例
      const padBottom = 24;
      const plotLeft = padLeft;
      const plotRight = w - padRight;
      const plotTop = padTop;
      const plotBottom = h - padBottom;
      const plotW = plotRight - plotLeft;
      const plotH = plotBottom - plotTop;
      state.layout = { plotLeft, plotRight, plotTop, plotBottom };

      // 纵轴上限：取所有桶的总成交额最大值
      let maxTotal = 0;
      let maxAbsNet = 0;
      rows.forEach((r) => {
        const total = rowTotal(r);
        if (total > maxTotal) maxTotal = total;
        if (Math.abs(r.netLarge || 0) > maxAbsNet) maxAbsNet = Math.abs(r.netLarge || 0);
      });
      if (maxTotal <= 0) maxTotal = 1;
      if (maxAbsNet <= 0) maxAbsNet = 1;

      const stepX = plotW / rows.length;
      const barW = Math.max(1.5, Math.min(stepX * 0.68, 16));
      const xOf = (i) => plotLeft + stepX * (i + 0.5);
      // 大单净额折线有自己的量纲，单独缩放（与柱子的金额刻度不同，图例中已说明）
      const yNet = (v) => plotBottom - ((v + maxAbsNet) / (maxAbsNet * 2)) * plotH;

      /* ---- 横向网格 + 左侧金额刻度 ---- */
      ctx2d.font = '11px system-ui, sans-serif';
      ctx2d.textAlign = 'left';
      ctx2d.textBaseline = 'middle';
      const gridCount = 4;
      for (let g = 0; g <= gridCount; g += 1) {
        const y = plotTop + (plotH / gridCount) * g;
        ctx2d.strokeStyle = GRID_COLOR;
        ctx2d.lineWidth = 0.5;
        ctx2d.beginPath();
        ctx2d.moveTo(plotLeft, y);
        ctx2d.lineTo(plotRight, y);
        ctx2d.stroke();
        ctx2d.fillStyle = AXIS_TEXT;
        ctx2d.fillText(fmtUsd(maxTotal - (maxTotal / gridCount) * g), plotRight + 6, y);
      }

      /* ---- 时间刻度：均匀取 5 个位置 ---- */
      ctx2d.textAlign = 'center';
      ctx2d.textBaseline = 'top';
      const ticks = Math.min(5, rows.length - 1);
      for (let t = 0; t <= ticks; t += 1) {
        const idx = ticks === 0 ? 0 : Math.min(rows.length - 1, Math.round(((rows.length - 1) / ticks) * t));
        const x = xOf(idx);
        ctx2d.strokeStyle = GRID_COLOR;
        ctx2d.lineWidth = 0.5;
        ctx2d.beginPath();
        ctx2d.moveTo(x, plotTop);
        ctx2d.lineTo(x, plotBottom);
        ctx2d.stroke();
        ctx2d.fillStyle = AXIS_TEXT;
        ctx2d.fillText(fmtTime(rows[idx].t0), x, plotBottom + 6);
      }

      /* ---- 堆叠柱：自下而上依次画小单 / 中单 / 大单 ---- */
      rows.forEach((r, i) => {
        const x = xOf(i);
        let bottomY = plotBottom;
        TIER.forEach((tier) => {
          const v = tierAmount(r, tier.key);
          if (!(v > 0)) return;
          const height = Math.max(0.6, (v / maxTotal) * plotH);
          const y = bottomY - height;
          ctx2d.fillStyle = tier.color;
          ctx2d.fillRect(x - barW / 2, y, barW, height);
          bottomY = y;
        });
      });

      /* ---- 大单净额折线（含零轴） ---- */
      const zeroY = yNet(0);
      ctx2d.strokeStyle = 'rgba(125, 106, 72, 0.45)';
      ctx2d.lineWidth = 0.8;
      ctx2d.setLineDash([4, 4]);
      ctx2d.beginPath();
      ctx2d.moveTo(plotLeft, zeroY);
      ctx2d.lineTo(plotRight, zeroY);
      ctx2d.stroke();
      ctx2d.setLineDash([]);

      ctx2d.lineWidth = 1.6;
      for (let i = 0; i < rows.length; i += 1) {
        const x = xOf(i);
        const v = rows[i].netLarge || 0;
        const y = yNet(v);
        if (i > 0) {
          ctx2d.strokeStyle = v >= 0 ? NET_UP : NET_DOWN;
          ctx2d.beginPath();
          ctx2d.moveTo(xOf(i - 1), yNet(rows[i - 1].netLarge || 0));
          ctx2d.lineTo(x, y);
          ctx2d.stroke();
        }
        if (rows.length <= 96) {
          ctx2d.fillStyle = v >= 0 ? NET_UP : NET_DOWN;
          ctx2d.beginPath();
          ctx2d.arc(x, y, 1.6, 0, Math.PI * 2);
          ctx2d.fill();
        }
      }

      /* ---- 图例 ---- */
      let lx = plotLeft;
      ctx2d.textAlign = 'left';
      ctx2d.textBaseline = 'middle';
      ctx2d.font = '11px system-ui, sans-serif';
      TIER.forEach((tier) => {
        ctx2d.fillStyle = tier.color;
        ctx2d.fillRect(lx, padTop / 2 - 5, 10, 10);
        ctx2d.fillStyle = AXIS_TEXT;
        ctx2d.fillText(tier.legend, lx + 14, padTop / 2);
        lx += 14 + ctx2d.measureText(tier.legend).width + 14;
      });
      ctx2d.strokeStyle = NET_UP;
      ctx2d.lineWidth = 1.6;
      ctx2d.beginPath();
      ctx2d.moveTo(lx, padTop / 2);
      ctx2d.lineTo(lx + 16, padTop / 2);
      ctx2d.stroke();
      ctx2d.fillStyle = AXIS_TEXT;
      ctx2d.fillText('大单净额', lx + 20, padTop / 2);

      /* ---- 悬停定位 ---- */
      const hIdx = state.hoverIndex;
      if (hIdx >= 0 && hIdx < rows.length) {
        const x = xOf(hIdx);
        ctx2d.strokeStyle = 'rgba(138, 24, 16, 0.45)';
        ctx2d.lineWidth = 0.8;
        ctx2d.setLineDash([3, 3]);
        ctx2d.beginPath();
        ctx2d.moveTo(x, plotTop);
        ctx2d.lineTo(x, plotBottom);
        ctx2d.stroke();
        ctx2d.setLineDash([]);
        if (options.onHover) options.onHover(hIdx, x, yNet(rows[hIdx].netLarge || 0), rows[hIdx]);
      }
    }

    canvas.addEventListener('mousemove', (e) => {
      const L = state.layout;
      const rows = state.rows;
      if (!L || !rows.length) return;
      const rect = canvas.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      const stepX = (L.plotRight - L.plotLeft) / rows.length;
      const idx = Math.floor((relX - L.plotLeft) / stepX);
      if (idx >= 0 && idx < rows.length && idx !== state.hoverIndex) {
        state.hoverIndex = idx;
        render();
      } else if (idx < 0 || idx >= rows.length) {
        if (state.hoverIndex !== -1) {
          state.hoverIndex = -1;
          if (options.onHover) options.onHover(-1);
          render();
        }
      }
    });

    canvas.addEventListener('mouseleave', () => {
      state.hoverIndex = -1;
      if (options.onHover) options.onHover(-1);
      render();
    });

    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => render());
      ro.observe(canvas.parentElement || canvas);
    } else {
      window.addEventListener('resize', render);
    }

    return {
      available: true,
      setData(rows) {
        state.rows = rows || [];
        state.hoverIndex = -1;
        render();
      },
      redraw: render,
    };
  }

  window.StructureChart = { createChart };
})();
