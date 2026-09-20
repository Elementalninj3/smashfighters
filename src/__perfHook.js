// __perfHook.js — OPT-IN performance HUD. Loaded ONLY via ?perf query param
// (see main.js). NOT part of gameplay. Wraps requestAnimationFrame to measure
// per-frame cadence + per-frame JS (update/render) cost, wraps
// CanvasRenderingContext2D.prototype to count canvas ops, tracks JS heap, and
// renders an HUD: fps curve + frame-time graph + ops.
// Idempotent, never touches game code. Delete together with the main.js hook.
(function () {
  if (window.__PERF_HOOK_INSTALLED) return;
  window.__PERF_HOOK_INSTALLED = true;

  const perf = {
    frames: [],          // consecutive rAF deltas (ms)
    jsPerFrame: [],      // duration of the frame callback (JS update+render)
    second: [],          // raw avg frame-ms per 1s bucket (sparkline)
    heap: [],            // usedJSHeapSize samples
    opCounts: {},        // canvas op totals
    opSecond: {},        // canvas ops this second
    startedAt: performance.now(),
    frameCalls: 0,
    windowCount: 0,
    windowLong: 0,
  };
  window.__perf = perf;

  // ---- rAF wrap: per-frame cadence + per-frame JS cost ------------------
  const origRaf = window.requestAnimationFrame.bind(window);
  let framePrev = performance.now();
  window.requestAnimationFrame = function (cb) {
    return origRaf(function () {
      const now = performance.now();
      const dt = now - framePrev;
      framePrev = now;
      const t0 = performance.now();
      try { cb(now); } finally {
        const js = performance.now() - t0;
        push(perf.frames, dt);
        push(perf.jsPerFrame, js);
        perf.frameCalls++;
        perf.windowJS += js;
        if (dt > 16.7) perf.windowLong++;
      }
    });
  };
  function push(arr, v) {
    if (arr.length >= 900) arr.shift();
    arr.push(v);
  }

  // ---- Canvas2D op counting ---------------------------------------------
  const proto = CanvasRenderingContext2D.prototype;
  const METHODS = ['save','restore','translate','scale','rotate','setTransform','transform','clearRect',
    'fillRect','strokeRect','beginPath','closePath','moveTo','lineTo','arc','arcTo','ellipse','rect',
    'quadraticCurveTo','bezierCurveTo','clip','fill','stroke','fillText','strokeText','measureText','drawImage'];
  for (const m of METHODS) {
    if (typeof proto[m] !== 'function' || proto[m].__perfWrapped) continue;
    const orig = proto[m];
    const wrapped = function () {
      const k = m;
      if (perf.frameCalls > 0) {
        perf.opCounts[k] = (perf.opCounts[k] || 0) + 1;
        perf.opSecond[k] = (perf.opSecond[k] || 0) + 1;
      }
      return orig.apply(this, arguments);
    };
    wrapped.__perfWrapped = true;
    proto[m] = wrapped;
  }

  // ---- HUD ---------------------------------------------------------------
  const hud = document.createElement('div');
  hud.style.cssText =
    'position:fixed;top:8px;left:8px;z-index:99999;pointer-events:none;' +
    'background:rgba(0,0,0,0.78);color:#5fdc5f;font:11px/1.45 monospace;' +
    'padding:8px 10px;border:1px solid #333;border-radius:4px;white-space:pre;min-width:430px;';
  document.body.appendChild(hud);

  const graph = document.createElement('div');
  graph.style.cssText =
    'display:flex;align-items:flex-end;gap:1px;height:56px;margin-top:4px;' +
    'border-top:1px solid #333;padding-top:3px;overflow:hidden;';
  hud.appendChild(graph);

  const pre = document.createElement('div');
  hud.appendChild(pre);

  function bar(h) {
    const d = document.createElement('div');
    d.style.width = '2px';
    d.style.height = Math.max(1, Math.min(h, 50)) + 'px';
    d.style.background = h > 16.7 ? '#ff6b6b' : '#5fdc5f';
    return d;
  }

  function fmt(v) { return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v)); }
  function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
  function pct(a, q) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * q))];
  }
  function topOps(o) {
    return Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([k, v]) => k + ':' + fmt(v)).join('  ');
  }

  let startHeap = 0;
  function render() {
    const now = performance.now();
    const span = (now - perf.startedAt) / 1000;
    const heapNow = (performance.memory && performance.memory.usedJSHeapSize) || 0;
    perf.heap.push(heapNow);
    if (perf.heap.length > 900) perf.heap.shift();
    if (perf.windowCount === 0 && startHeap === 0) startHeap = heapNow;

    const win = perf.jsPerFrame.slice(-120);
    const jsAvg = win.length ? win.reduce((a, b) => a + b, 0) / win.length : 0;

    const lines = [
      'PERF HUD — ' + span.toFixed(0) + 's',
      'FPS      ' + Math.round(perf.frameCalls / (span || 1)),
      'frame ms avg ' + avg(perf.frames).toFixed(1) +
        '  p95 ' + pct(perf.frames, 0.95).toFixed(1) +
        '  p99 ' + pct(perf.frames, 0.99).toFixed(1) +
        '  max ' + (perf.frames.length ? Math.max(...perf.frames).toFixed(1) : 0),
      'JS ms/fr ' + jsAvg.toFixed(2) + ' (update+render+loop)',
      'long>16.7  ' + perf.windowLong + ' in last ' + (perf.windowCount || 1) + 's',
      'heap ' + (heapNow / 1048576).toFixed(1) + 'MB' +
        (startHeap ? ' (+' + ((heapNow - startHeap) / 1048576).toFixed(2) + ' since load)' : ''),
      'ops/s ' + fmt(Object.values(perf.opSecond).reduce((a, b) => a + b, 0)) +
        '  top ' + topOps(perf.opSecond),
    ];
    pre.textContent = lines.join('\n');

    const barVals = perf.second.slice(-60);
    if (!barVals.length) barVals.push(avg(perf.frames) || 0);
    graph.innerHTML = '';
    for (const v of barVals) graph.appendChild(bar(v));

    perf.windowCount++;
    perf.windowLong = 0;
    perf.opSecond = {};
  }

  // Feed the per-second frame-ms bucket into the sparkline + redraw HUD.
  const timer = setInterval(function () {
    if (perf.frames.length) {
      perf.second.push(avg(perf.frames.slice(-90)));
      if (perf.second.length > 120) perf.second.shift();
    }
    render();
  }, 1000);
  window.__perfStop = function () { clearInterval(timer); hud.remove(); };

  window.__perfSnapshot = function () {
    const win = perf.frames.slice(-300);
    return {
      runMs: performance.now() - perf.startedAt,
      totalFrames: perf.frameCalls,
      heapNow: (performance.memory && performance.memory.usedJSHeapSize) || 0,
      heapPeak: perf.heap.length ? Math.max(...perf.heap) : 0,
      heapStart: startHeap || 0,
      avgFrameMs: +avg(win).toFixed(2),
      p95FrameMs: +pct(win, 0.95).toFixed(2),
      p99FrameMs: +pct(win, 0.99).toFixed(2),
      maxFrameMs: win.length ? +(Math.max(...win)).toFixed(2) : 0,
      avgJsMs: +avg(perf.jsPerFrame.slice(-300)).toFixed(3),
      longFrames: win.filter(x => x > 16.7).length,
      opTotals: perf.opCounts,
    };
  };
})();