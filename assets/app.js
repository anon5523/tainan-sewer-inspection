/* ══════════════════════════════════════════════════════════════
   下水道開孔抽樣巡檢覆蓋率 — 前端應用
   資料來源：data/manifest.json → network/*.json + years/*.json
   離線單檔版由 build.py --inline 產生，資料掛在 window.__BUNDLE__
   ══════════════════════════════════════════════════════════════ */
'use strict';

/* ── 色彩 ── */
const C = {
  st:   ['#38E1B0', '#FF6B5B', '#7C8FB0', '#FFC857', '#FF9E7A'],
  cnt:  ['#3E5568', '#4C8FD4', '#9B7BE0', '#F06CB0'],
  month:['#4DD4C4','#46C8E0','#4FA8E8','#6C8FEA','#8E7BE6','#AE6FDD',
         '#C96BCB','#E06BAE','#ED7490','#F58A76','#F5A65F','#E8C455'],
  mh:   ['#38E1B0', '#FF6B5B', '#FFC857'],
  mute: '#2C3D4C'
};
const STN  = ['已巡檢', '列管人孔未開孔', '無人孔(虛接點/分岔)', '端點編號缺漏', '實人孔未列管'];
const CNTN = ['未巡檢', '1 次', '2 次', '3 次以上'];
const MN   = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const km = v => v.toFixed(2);
const $  = id => document.getElementById(id);
const isPhone = () => window.matchMedia('(max-width:899px)').matches;

/* ── 狀態 ── */
const S = {
  mode: 0, month: null, cum: 1, playing: 0, gran: 'month', day: 0,
  f: { dists: new Set(), st: new Set(), cnt: new Set(), minLen: 0 },
  onlyGap: false, myLL: null, gapSort: 'len', sortKey: 'gap', snapIdx: 0
};
let MF = null, NET = null, YR = null, SEG = [], ALL = null, VIS = [];
let BND = null, infoPos = null, infoClosed = false;
let AGG = null, DAYMON = [], ND = 0;

/* ══════════════ 載入 ══════════════ */
async function grab(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(path + ' → ' + r.status);
  return r.json();
}
async function boot() {
  try {
    if (window.__BUNDLE__) {
      MF = window.__BUNDLE__.manifest;
    } else {
      $('bootTxt').textContent = '載入年度清單…';
      MF = await grab('data/manifest.json');
    }
    document.title = MF.title || document.title;
    await loadYear(MF.defaultYear);
    loadBoundaries();
    $('boot').hidden = true;
    initOnce();
  } catch (e) {
    $('boot').innerHTML =
      `<div style="max-width:300px;text-align:center;line-height:1.9;font-size:13px">
        <b style="color:#FF6B5B">資料載入失敗</b><br>${e.message}<br>
        <span style="color:#657F92">若是在本機直接開啟檔案，請改用
        <code>python -m http.server</code> 啟動，或使用 standalone.html 離線單檔版。</span></div>`;
  }
}
async function loadBoundaries() {
  try {
    BND = window.__BUNDLE__ ? window.__BUNDLE__.boundaries
        : MF.boundaries ? await grab('data/' + MF.boundaries.file) : null;
    if (BND) drawBoundary();
  } catch (e) { BND = null; }
}

async function loadYear(yid) {
  const y = MF.years.find(v => v.id === yid) || MF.years[0];
  $('bootTxt').textContent = `載入 ${y.label} 資料…`;
  const B = window.__BUNDLE__;
  if (!NET || NET.id !== y.network)
    NET = B ? B.networks[y.network] : await grab('data/' + MF.networks[y.network].file);
  YR = B ? B.years[y.id] : await grab('data/' + y.file);
  YR.meta = y;
  buildSeg();
  $('yearTxt').textContent = y.label;
}

/* 把欄式資料展開成物件陣列，並預存 bbox 供命中測試 */
function buildSeg() {
  const U = NET.units, n = U.len.length;
  SEG = new Array(n);
  for (let i = 0; i < n; i++) {
    const g = U.geom[i];
    let a = 90, b = -90, c = 180, d = -180;
    for (const q of g) {
      if (q[1] < a) a = q[1]; if (q[1] > b) b = q[1];
      if (q[0] < c) c = q[0]; if (q[0] > d) d = q[0];
    }
    const blocked = U.blocked[i], cnt = YR.cnt[i] || 0;
    SEG[i] = {
      i, dist: U.d[i], len: U.len[i], node: U.node[i], pinum: U.pinum[i],
      ll: g.map(q => [q[1], q[0]]), bb: [a, b, c, d],
      cnt, m: YR.m[i] || 0,
      st: blocked === 1 ? 2 : blocked === 2 ? 3 : cnt > 0 ? 0 : (YR.listed[i] ? 1 : 4)
    };
    SEG[i].first = SEG[i].m ? 32 - Math.clz32(SEG[i].m & -SEG[i].m) : 0;
    const dd = (YR.dd && YR.dd[i]) || [];
    SEG[i].dd = dd;
    SEG[i].fd = dd.length ? dd[0] : -1;      // 首次巡檢的檢查日索引
  }
  ALL = L.latLngBounds(SEG.flatMap(s => [[s.bb[0], s.bb[2]], [s.bb[1], s.bb[3]]]));
  const ms = YR.meta.months;
  S.month = ms[ms.length - 1];
  DAYMON = (YR.dates || []).map(d => +d.slice(5, 7));
  ND = DAYMON.length;
  S.day = Math.max(0, ND - 1);
}
const dLabel = i => {
  const d = YR.dates[i];
  return d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : '—';
};

/* ══════════════ 地圖 ══════════════ */
const map = L.map('map', {
  zoomControl: false, attributionControl: true, preferCanvas: true,
  minZoom: 8, maxZoom: 20, zoomSnap: 0.5, zoomDelta: 0.5,
  dragging: true, touchZoom: true, doubleClickZoom: true,
  bounceAtZoomLimits: false, tap: true
});
L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
  { attribution: '&copy; OSM、CARTO｜圖資：台南市政府', maxZoom: 20 }).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
  { maxZoom: 20, pane: 'shadowPane', opacity: 0.78 }).addTo(map);

const rend = L.canvas({ padding: 0.35 });
const gLayer = L.layerGroup().addTo(map);
const mhLayer = L.layerGroup();
const locLayer = L.layerGroup().addTo(map);
const bndLayer = L.layerGroup().addTo(map);

/* 行政區界：不搶眼但看得見的虛線 */
function drawBoundary() {
  bndLayer.clearLayers();
  if (!BND || !S.f.dists.size) return;
  for (const di of S.f.dists) {
    const rings = BND.areas[NET.dists[di]];
    if (!rings) continue;
    for (const r of rings) {
      const ll = r.map(p => [p[1], p[0]]);
      L.polygon(ll, { color: '#93AEC4', weight: 1.3, opacity: 0.68,
        dashArray: '7 6', fill: true, fillColor: '#93AEC4', fillOpacity: 0.045,
        interactive: false }).addTo(bndLayer);
    }
  }
}

/* ── 篩選判定 ── */
function pass(s) {
  const f = S.f;
  if (f.dists.size && !f.dists.has(s.dist)) return false;
  if (f.st.size && !f.st.has(s.st)) return false;
  if (f.cnt.size && !f.cnt.has(Math.min(s.cnt, 3))) return false;
  if (s.len < f.minLen) return false;
  if (S.onlyGap && s.st === 0) return false;
  return true;
}
/* ── 著色分組鍵 ── */
function keyOf(s) {
  if (S.mode === 0) return 's' + s.st;
  if (S.mode === 1) return 'c' + Math.min(s.cnt, 3);
  if (S.gran === 'day') {
    if (S.cum) return (s.fd >= 0 && s.fd <= S.day) ? 'm' + DAYMON[s.fd] : 'x';
    return s.dd.indexOf(S.day) >= 0 ? 'm' + DAYMON[S.day] : 'x';
  }
  const hit = S.cum ? (s.first > 0 && s.first <= S.month) : (s.m >> (S.month - 1) & 1);
  return hit ? 'm' + (S.cum ? s.first : S.month) : 'x';
}
function styleOf(k) {
  if (k === 'x') return { color: C.mute, weight: 1.5, opacity: 0.42 };
  const n = +k.slice(1);
  if (k[0] === 's') return { color: C.st[n], weight: n === 0 ? 2.2 : 3, opacity: n === 0 ? 0.75 : 0.96 };
  if (k[0] === 'c') return { color: C.cnt[n], weight: n === 0 ? 1.8 : 1.9 + n * 1.3, opacity: n === 0 ? 0.5 : 0.96 };
  return { color: C.month[n - 1], weight: 3, opacity: 0.97 };
}
/* 繪製順序：底層先畫 */
function order() {
  if (S.mode === 0) return ['s0', 's2', 's3', 's4', 's1'];
  if (S.mode === 1) return ['c0', 'c1', 'c2', 'c3'];
  return ['x'].concat(MN.map((_, i) => 'm' + (i + 1)));
}

let TL = null;                     // 時間模式的分層快取
function render() {
  VIS = SEG.filter(pass);
  TL = null;                       // 可見集合變了，時間圖層要重建
  paint();
}
/* 只重畫，不重算可見集合與統計（播放動畫時每幀只做這個） */
function paint() {
  if (S.mode === 2) return paintTime();
  TL = null;
  const bk = new Map();
  for (const s of VIS) {
    const k = keyOf(s);
    let arr = bk.get(k); if (!arr) bk.set(k, arr = []);
    arr.push(s.ll);
  }
  gLayer.clearLayers();
  for (const k of order())
    if (bk.has(k))
      L.polyline(bk.get(k), Object.assign({ renderer: rend, interactive: false,
        lineCap: 'round', lineJoin: 'round' }, styleOf(k))).addTo(gLayer);
}

/* 時間模式：底圖固定，只更新會變動的那一層。
   這讓播放動畫每幀只重新投影少量線段，而不是全部 17,446 條。 */
function buildTL() {
  gLayer.clearLayers();
  const base = L.polyline(VIS.map(s => s.ll), { renderer: rend, interactive: false,
    color: C.mute, weight: 1.5, opacity: 0.42, lineCap: 'round' }).addTo(gLayer);
  const tops = [];
  if (S.cum) {
    const g = Array.from({ length: 13 }, () => []);
    for (const s of VIS) {
      const m = S.gran === 'day' ? (s.fd >= 0 ? DAYMON[s.fd] : 0) : s.first;
      if (m) g[m].push(s);
    }
    if (S.gran === 'day') for (let m = 1; m <= 12; m++) g[m].sort((a, b) => a.fd - b.fd);
    for (let m = 1; m <= 12; m++) {
      const t = L.polyline([], { renderer: rend, interactive: false,
        color: C.month[m - 1], weight: 3, opacity: 0.97,
        lineCap: 'round', lineJoin: 'round' }).addTo(gLayer);
      t._segs = g[m]; t._n = -1;
      tops[m] = t;
    }
  } else {
    tops[0] = L.polyline([], { renderer: rend, interactive: false, weight: 3,
      opacity: 0.97, lineCap: 'round', lineJoin: 'round' }).addTo(gLayer);
    tops[0]._n = -1;
  }
  TL = { base, tops };
}
function paintTime() {
  if (!TL || (S.cum ? !TL.tops[1] : !TL.tops[0])) buildTL();
  if (S.cum) {
    const upto = S.gran === 'day' ? (DAYMON[S.day] || 0) : S.month;
    for (let m = 1; m <= 12; m++) {
      const t = TL.tops[m], segs = t._segs;
      let n;
      if (m < upto) n = segs.length;
      else if (m > upto) n = 0;
      else if (S.gran === 'day') {           // 二分搜尋：首次巡檢日 <= 目前日期的筆數
        let lo = 0, hi = segs.length;
        while (lo < hi) { const md = (lo + hi) >> 1; if (segs[md].fd <= S.day) lo = md + 1; else hi = md; }
        n = lo;
      } else n = segs.length;
      if (n !== t._n) { t._n = n; t.setLatLngs(segs.slice(0, n).map(x => x.ll)); }
    }
  } else {
    const t = TL.tops[0];
    const sel = S.gran === 'day'
      ? VIS.filter(x => x.dd.indexOf(S.day) >= 0)
      : VIS.filter(x => x.m >> (S.month - 1) & 1);
    const mo = (S.gran === 'day' ? DAYMON[S.day] : S.month) || 1;
    t.setStyle({ color: C.month[mo - 1] });
    t.setLatLngs(sel.map(x => x.ll));
  }
}

/* ══════════════ 命中測試（觸控容差大） ══════════════ */
function d2seg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = a.x + t * dx - p.x, ey = a.y + t * dy - p.y;
  return Math.sqrt(ex * ex + ey * ey);
}
map.on('click', e => {
  const TOL = isPhone() ? 22 : 11, c = e.latlng, cp = map.latLngToContainerPoint(c);
  const q = map.containerPointToLatLng(cp.add(L.point(TOL, TOL)));
  const pLa = Math.abs(q.lat - c.lat), pLn = Math.abs(q.lng - c.lng);
  let best = null, bd = TOL;
  for (const s of VIS) {
    if (c.lat < s.bb[0] - pLa || c.lat > s.bb[1] + pLa ||
        c.lng < s.bb[2] - pLn || c.lng > s.bb[3] + pLn) continue;
    const pts = s.ll.map(p => map.latLngToContainerPoint(p));
    for (let j = 0; j < pts.length - 1; j++) {
      const d = d2seg(cp, pts[j], pts[j + 1]);
      if (d < bd) { bd = d; best = s; }
    }
  }
  if (best) popup(best, c);
});
function monthList(s) {
  const out = [];
  for (let i = 0; i < 12; i++) if (s.m >> i & 1) out.push(i + 1);
  return out;
}
function popup(s, at) {
  const col = S.mode === 1 ? C.cnt[Math.min(s.cnt, 3)]
            : S.mode === 2 && s.first ? C.month[s.first - 1] : C.st[s.st];
  const ms = monthList(s);
  L.popup({ maxWidth: 300, autoPanPadding: [24, 96] })
    .setLatLng(at || s.ll[Math.floor(s.ll.length / 2)])
    .setContent(`<div class="pop"><b>${NET.dists[s.dist]}　${s.len.toFixed(1)} m</b><table>
      <tr><td>巡檢狀態</td><td><span class="pill" style="background:${col}">${STN[s.st]}</span></td></tr>
      <tr><td>巡檢次數</td><td>${s.cnt} 次</td></tr>
      <tr><td>巡檢月份</td><td>${ms.length ? `<span class="mchips">${ms.map(m =>
        `<span style="background:${C.month[m - 1]}">${m}月</span>`).join('')}</span>` : '—'}</td></tr>
      <tr><td>受檢人孔</td><td>${s.node || '—'}</td></tr>
      <tr><td>所屬管段</td><td>${s.pinum || '—'}</td></tr></table></div>`)
    .openOn(map);
}

/* ══════════════ 統計 ══════════════ */
function agg(list) {
  const o = { tot: 0, cov: 0, st: Array(5).fill(0), cnt: Array(4).fill(0),
              mo: Array(13).fill(0), cumo: Array(13).fill(0), first: Array(13).fill(0),
              dOne: new Float64Array(ND), dCum: new Float64Array(ND) };
  for (const s of list) {
    o.tot += s.len; o.st[s.st] += s.len; o.cnt[Math.min(s.cnt, 3)] += s.len;
    if (s.st === 0) o.cov += s.len;
    if (s.first) o.first[s.first] += s.len;
    for (let m = 1; m <= 12; m++) if (s.m >> (m - 1) & 1) o.mo[m] += s.len;
    if (s.fd >= 0) o.dCum[s.fd] += s.len;           // 先放首次巡檢日，稍後做前綴和
    for (let k = 0; k < s.dd.length; k++) o.dOne[s.dd[k]] += s.len;
  }
  let run = 0;
  for (let m = 1; m <= 12; m++) { run += o.first[m]; o.cumo[m] = run; }
  run = 0;
  for (let i = 0; i < ND; i++) { run += o.dCum[i]; o.dCum[i] = run; }
  return o;
}
/* 目前時間點的巡檢長度（依粒度與單期／累積） */
function timeVal(A) {
  if (S.gran === 'day') return S.cum ? (A.dCum[S.day] || 0) : (A.dOne[S.day] || 0);
  return S.cum ? A.cumo[S.month] : A.mo[S.month];
}
function timeLabel() {
  if (S.gran === 'day')
    return S.cum ? `${dLabel(0)}–${dLabel(S.day)} 累積` : `${dLabel(S.day)}`;
  return S.cum ? `1–${S.month} 月累積` : `${S.month} 月`;
}

/* ══════════════ 摘要（peek） ══════════════ */
function drawPeek() {
  const A = AGG || (AGG = agg(VIS)), tot = A.tot || 1;
  const fd = S.f.dists;
  $('scopeName').textContent = fd.size === 0 ? '台南市'
    : fd.size === 1 ? NET.dists[[...fd][0]] : `已選 ${fd.size} 個行政區`;
  $('scopeSub').textContent = `${km(A.tot / 1000)} km 管線・資料至 ${YR.meta.dataThrough}`;

  let rows, pct, lab, right;
  if (S.mode === 2) {
    const v = timeVal(A), isD = S.gran === 'day';
    pct = (v / tot * 100);
    lab = timeLabel() + '巡檢';
    right = `${S.cum ? '累積' : (isD ? '當日' : '當月')} <b>${km(v / 1000)}</b> km<br>總管線 <b>${km(A.tot / 1000)}</b> km`;
    if (S.cum) {
      const upto = isD ? DAYMON[S.day] : S.month;
      rows = MN.map((n, i) => {
        if (i + 1 > upto) return [n, 0, C.month[i]];
        if (!isD || i + 1 < upto) return [n, A.first[i + 1], C.month[i]];
        // 當月只計到選定日期為止
        let part = 0;
        for (let k = 0; k <= S.day; k++) if (DAYMON[k] === upto) part += A.dCum[k] - (k ? A.dCum[k - 1] : 0);
        return [n, part, C.month[i]];
      }).filter(r => r[1] > 0.5).concat([['尚未巡檢', tot - v, C.mute]]);
    } else {
      rows = [[isD ? dLabel(S.day) : `${S.month} 月`, v, C.month[(isD ? DAYMON[S.day] : S.month) - 1]],
              ['其他時段已巡檢', A.cov - v > 0 ? A.cov - v : 0, C.mute],
              ['未巡檢', tot - A.cov, '#1F2D3A']];
    }
  } else if (S.mode === 1) {
    pct = A.cov / tot * 100; lab = '已巡檢比例';
    right = `巡檢 <b>${km((A.cnt[1] + A.cnt[2] + A.cnt[3]) / 1000)}</b> km<br>重複 <b>${km((A.cnt[2] + A.cnt[3]) / 1000)}</b> km`;
    rows = CNTN.map((n, i) => [n, A.cnt[i], C.cnt[i]]);
  } else {
    pct = A.cov / tot * 100; lab = '已巡檢比例';
    right = `已巡檢 <b>${km(A.cov / 1000)}</b> km<br>未巡檢 <b>${km((A.tot - A.cov) / 1000)}</b> km`;
    rows = STN.map((n, i) => [n, A.st[i], C.st[i]]);
  }
  $('pct').innerHTML = (isFinite(pct) ? pct.toFixed(1) : '0.0') + '<small>%</small>';
  $('pctLab').textContent = lab;
  $('lens').innerHTML = right;
  const vis = rows.filter(r => r[1] > 0.5);
  $('ruler').innerHTML = vis.map(r => `<i style="width:0;background:${r[2]}"></i>`).join('');
  requestAnimationFrame(() => [...$('ruler').children].forEach((el, i) =>
    el.style.width = (vis[i][1] / tot * 100) + '%'));
  $('rkeys').innerHTML = vis.slice(0, 7).map(r =>
    `<span><b style="background:${r[2]}"></b>${r[0]} ${km(r[1] / 1000)}</span>`).join('');
}

/* ══════════════ 分頁 0：總覽（含月份圖） ══════════════ */
function monthChart(A) {
  const ms = YR.meta.months, W = 300, H = 92, pad = 16;
  const vals = ms.map(m => (S.cum ? A.cumo[m] : A.mo[m]) / 1000);
  const mx = Math.max(...vals, 1), bw = (W - pad) / ms.length;
  const bars = ms.map((m, i) => {
    const h = vals[i] / mx * (H - 22), x = pad + i * bw, y = H - 20 - h;
    const on = m === S.month;
    return `<rect x="${x + 2}" y="${y}" width="${bw - 5}" height="${Math.max(h, 1.5)}" rx="2"
       fill="${C.month[m - 1]}" opacity="${on ? 1 : 0.55}"/>
      ${on ? `<text x="${x + bw / 2}" y="${y - 4}" text-anchor="middle" fill="#DDE9F1"
        style="font-size:9.5px;font-weight:600">${vals[i].toFixed(1)}</text>` : ''}
      <text x="${x + bw / 2}" y="${H - 7}" text-anchor="middle"
        ${on ? 'fill="#DDE9F1"' : ''}>${m}</text>
      <rect class="hit" data-m="${m}" x="${x}" y="0" width="${bw}" height="${H}"/>`;
  }).join('');
  return `<div class="chartWrap"><svg viewBox="0 0 ${W} ${H}">
     <line x1="${pad - 3}" y1="${H - 20}" x2="${W}" y2="${H - 20}" stroke="#2A4355"/>
     <text x="0" y="${H - 17}" style="font-size:8.5px">km</text>${bars}</svg></div>`;
}
function dayChart(A) {
  const W = 300, H = 92, pad = 16, right = W - 2;
  const mx = Math.max(A.dCum[ND - 1] || 0, ...Array.from(A.dOne), 1);
  const scale = S.cum ? (A.dCum[ND - 1] || 1) : mx;
  const X = i => pad + (ND < 2 ? 0 : i / (ND - 1)) * (right - pad);
  const Y = v => H - 20 - (v / scale) * (H - 30);
  let body;
  if (S.cum) {
    let d = `M${X(0)},${H - 20}`;
    for (let i = 0; i < ND; i++) d += `L${X(i).toFixed(1)},${Y(A.dCum[i]).toFixed(1)}`;
    d += `L${X(ND - 1)},${H - 20}Z`;
    body = `<path d="${d}" fill="url(#gCum)" stroke="none"/>
      <path d="${d.replace(/^M[\d.]+,[\d.]+/, 'M' + X(0) + ',' + Y(A.dCum[0]))
        .replace(/L[\d.]+,${H - 20}Z$/, '')}" fill="none" stroke="#4FA8E8" stroke-width="1.6"/>`;
  } else {
    body = '';
    for (let i = 0; i < ND; i++) {
      if (!A.dOne[i]) continue;
      const h = Math.max((A.dOne[i] / scale) * (H - 30), 1);
      body += `<rect x="${(X(i) - 1).toFixed(1)}" y="${(H - 20 - h).toFixed(1)}" width="2"
        height="${h.toFixed(1)}" rx="1" fill="${C.month[DAYMON[i] - 1]}" opacity=".85"/>`;
    }
  }
  // 月份分隔
  let seps = '', seen = new Set();
  for (let i = 0; i < ND; i++) {
    const m = DAYMON[i];
    if (seen.has(m)) continue; seen.add(m);
    seps += `<line x1="${X(i).toFixed(1)}" y1="6" x2="${X(i).toFixed(1)}" y2="${H - 20}"
      stroke="var(--line)" stroke-dasharray="2 3" opacity=".5"/>
      <text x="${(X(i) + 2).toFixed(1)}" y="${H - 9}" style="font-size:8.5px">${m}</text>`;
  }
  const cx = X(S.day);
  return `<div class="chartWrap"><svg viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="gCum" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4FA8E8" stop-opacity=".55"/>
      <stop offset="1" stop-color="#4FA8E8" stop-opacity=".06"/></linearGradient></defs>
    ${seps}${body}
    <line x1="${cx.toFixed(1)}" y1="2" x2="${cx.toFixed(1)}" y2="${H - 20}"
      stroke="var(--ok)" stroke-width="1.4"/>
    <circle cx="${cx.toFixed(1)}" cy="${Y(S.cum ? A.dCum[S.day] : A.dOne[S.day]).toFixed(1)}"
      r="3" fill="var(--ok)" stroke="var(--ink1)" stroke-width="1.5"/>
    <line x1="${pad}" y1="${H - 20}" x2="${right}" y2="${H - 20}" stroke="#2A4355"/>
    <text x="0" y="${H - 17}" style="font-size:8.5px">km</text>
    <rect class="hit" data-day="1" x="0" y="0" width="${W}" height="${H}"/></svg></div>`;
}
function drawP0() {
  const A = AGG || (AGG = agg(VIS)), tot = A.tot || 1;
  const ms = YR.meta.months;
  const isD = S.gran === 'day', v = timeVal(A);
  $('p0').innerHTML = `
  <div class="card"><h3>${S.cum ? '累積' : (isD ? '逐日' : '各月')}巡檢長度</h3>
    ${isD ? dayChart(A) : monthChart(A)}
    <p style="margin-top:9px">${S.cum
      ? `到 ${isD ? YR.dates[S.day] : S.month + ' 月'} 為止累積巡檢 ${km(v / 1000)} km，占 ${(v / tot * 100).toFixed(1)}%。累積以「首次巡檢時間」計算，同段重複巡檢不重複累加。`
      : (isD
        ? `${YR.dates[S.day]} 當日巡檢 ${km(v / 1000)} km。全年 ${ND} 個檢查日，單日最多 ${km(Math.max(...Array.from(A.dOne)) / 1000)} km。`
        : `${S.month} 月巡檢 ${km(A.mo[S.month] / 1000)} km。各月加總 ${km(ms.reduce((a, m) => a + A.mo[m], 0) / 1000)} km 大於累積值，差額即為同段重複巡檢的部分。`)}
      點圖表可切換${isD ? '日期' : '月份'}。</p></div>
  <div class="card"><h3>巡檢狀態組成</h3>
    ${STN.map((s, i) => `<div class="srow"><b style="background:${C.st[i]}"></b>
      <span class="l">${s}</span><span class="v num">${km(A.st[i] / 1000)}</span>
      <span class="p num">${(A.st[i] / tot * 100).toFixed(1)}%</span></div>`).join('')}</div>
  <div class="card"><h3>同一管段的巡檢次數</h3>
    ${CNTN.map((s, i) => `<div class="srow"><b style="background:${C.cnt[i]}"></b>
      <span class="l">${s}</span><span class="v num">${km(A.cnt[i] / 1000)}</span>
      <span class="p num">${(A.cnt[i] / tot * 100).toFixed(1)}%</span></div>`).join('')}
    <p style="margin-top:10px">重複巡檢 ${km((A.cnt[2] + A.cnt[3]) / 1000)} km，
      與可補足的未巡檢 ${km(A.st[1] / 1000)} km 相當，是抽樣分配可調整的空間。</p></div>
  <div class="card"><h3>統計邏輯</h3>
    <p>一座人孔開孔一次，代表巡檢了它與上下游鄰孔之間各一半的距離。若某一側沒有人孔（管線末端或分岔於轉折點），
       該側整段皆計入巡檢；兩端都沒有可開孔人孔的管段，無論如何都巡不到。<br><br>
       圖資中的「虛人孔」為管線轉折點而非真實人孔，計算時已自動穿越合併，不會被誤判為受檢端點。
       所有受檢單元長度總和等於管線圖資總長 ${NET.totalLengthKm.toLocaleString()} km。</p></div>`;
  $('p0').querySelectorAll('rect.hit').forEach(r => {
    if (r.dataset.day) {
      r.onclick = e => {
        const bb = r.getBoundingClientRect();
        const f = (e.clientX - bb.left) / bb.width;
        setDay(Math.round(((f * 300) - 16) / (298 - 16) * (ND - 1)));
      };
    } else r.onclick = () => setMonth(+r.dataset.m);
  });
}

/* ══════════════ 分頁 1：行政區 ══════════════ */
function drawP1() {
  const base = SEG.filter(s => {
    const f = S.f;
    if (f.st.size && !f.st.has(s.st)) return false;
    if (f.cnt.size && !f.cnt.has(Math.min(s.cnt, 3))) return false;
    if (s.len < f.minLen) return false;
    return true;
  });
  const by = new Map();
  for (const s of base) {
    let o = by.get(s.dist);
    if (!o) by.set(s.dist, o = { tot: 0, cov: 0, st: Array(5).fill(0) });
    o.tot += s.len; o.st[s.st] += s.len; if (s.st === 0) o.cov += s.len;
  }
  let list = [...by.entries()].map(([d, o]) =>
    ({ d, o, rate: o.tot ? o.cov / o.tot * 100 : 0, gap: o.tot - o.cov }));
  list.sort((a, b) => S.sortKey === 'rate' ? a.rate - b.rate
    : S.sortKey === 'len' ? b.o.tot - a.o.tot : b.gap - a.gap);

  $('p1').innerHTML = `<div class="sortbar">
      <button data-s="gap" aria-pressed="${S.sortKey === 'gap'}">未巡檢最長</button>
      <button data-s="rate" aria-pressed="${S.sortKey === 'rate'}">覆蓋率最低</button>
      <button data-s="len" aria-pressed="${S.sortKey === 'len'}">管線最長</button></div>
    <div class="dhead"><span>行政區</span><span>已巡檢 ／ 未巡檢</span><span>覆蓋率</span></div>`
    + list.map(r => {
      const T = r.o.tot || 1;
      return `<div class="drow" data-i="${r.d}" aria-selected="${S.f.dists.has(r.d)}">
        <span class="nm">${NET.dists[r.d]}</span><span class="bar">
        ${[0, 1, 2, 3, 4].map(k => `<i style="width:${r.o.st[k] / T * 100}%;background:${C.st[k]}"></i>`).join('')}
        </span><span class="pc num">${r.rate.toFixed(0)}%</span></div>`;
    }).join('');
  $('p1').querySelectorAll('.sortbar button').forEach(b =>
    b.onclick = () => { S.sortKey = b.dataset.s; drawP1(); });
  $('p1').querySelectorAll('.drow').forEach(r =>
    r.onclick = () => pickDist(+r.dataset.i));
}

/* ══════════════ 分頁 2：待補缺口 ══════════════ */
function hav(a, b) {
  const R = 6371000, t = Math.PI / 180;
  const dl = (b[0] - a[0]) * t, dg = (b[1] - a[1]) * t;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function drawP2() {
  let pool = VIS.filter(s => s.st !== 0);
  const near = S.gapSort === 'near' && S.myLL;
  pool = near
    ? pool.map(s => ({ s, d: hav(S.myLL, s.ll[0]) })).sort((a, b) => a.d - b.d).slice(0, 150)
    : pool.sort((a, b) => b.len - a.len).slice(0, 150).map(s => ({ s, d: null }));
  const tot = pool.reduce((a, o) => a + o.s.len, 0);
  const sug = { 1: '排入開孔計畫即可補足', 2: '無孔可開，需增設人孔或改用其他檢測',
                3: '先補正端點編號與人孔圖資對應', 4: '評估納入列管人孔名冊' };
  $('p2').innerHTML = `<div class="sortbar">
      <button data-g="len" aria-pressed="${!near}">最長優先</button>
      <button data-g="near" aria-pressed="${near}">離我最近</button></div>`
    + (pool.length ? `<div class="card"><h3>未巡檢管段 ${pool.length} 筆</h3>
        <p>合計 ${km(tot / 1000)} km，點選可於地圖定位。
        標為<span style="color:${C.st[1]}">未開孔</span>者排入開孔即可補上；
        標為<span style="color:${C.st[2]}">無人孔</span>者需增設人孔或改用其他檢測方式。</p></div>`
        + pool.map(o => `<div class="gap" data-i="${o.s.i}" style="border-left-color:${C.st[o.s.st]}">
          <div class="t"><b>${NET.dists[o.s.dist]}　${o.s.pinum ? o.s.pinum.split('、')[0] : '—'}</b>
            <span class="num">${o.s.len.toFixed(0)} m</span></div>
          <div class="s">${STN[o.s.st]}｜${o.d != null
            ? '距離約 ' + (o.d < 1000 ? o.d.toFixed(0) + ' m' : (o.d / 1000).toFixed(1) + ' km')
            : sug[o.s.st]}</div></div>`).join('')
      : `<div class="empty">目前篩選條件下<br>沒有未巡檢的管段</div>`);
  $('p2').querySelectorAll('.sortbar button').forEach(b => b.onclick = () => {
    if (b.dataset.g === 'near' && !S.myLL) { locate(true); return; }
    S.gapSort = b.dataset.g; drawP2();
  });
  $('p2').querySelectorAll('.gap').forEach(g => g.onclick = () => {
    const s = SEG[+g.dataset.i], b = L.latLngBounds(s.ll);
    snap(0); map.fitBounds(b, { maxZoom: 18, padding: [50, 80] });
    setTimeout(() => popup(s, b.getCenter()), 380);
  });
}

const refresh = () => {
  render();                       // 先算出 VIS
  AGG = agg(VIS);
  drawBoundary(); drawTime(); drawPeek(); drawP0(); drawP1(); drawP2();
  legend(); drawInfo();
};
/* 播放時只更新必要部分，維持流暢 */
const refreshLight = () => { paint(); drawTimeVal(); drawPeek(); legendRamp(); };

/* ══════════════ 行政區聚焦 ══════════════ */
function pickDist(i) {
  const f = S.f.dists;
  if (f.size === 1 && f.has(i)) f.clear(); else { f.clear(); f.add(i); infoClosed = false; }
  refresh(); updateFCount(); snap(0);
  setTimeout(() => zoomToSelection(), 340);
}

/* 選取範圍的視野：管線 + 行政區界，讓整個區界都看得到 */
function selectionBounds() {
  const f = S.f.dists;
  if (!f.size) return ALL;
  const b = L.latLngBounds([]);
  SEG.forEach(s => { if (f.has(s.dist)) b.extend([[s.bb[0], s.bb[2]], [s.bb[1], s.bb[3]]]); });
  if (BND) for (const di of f) {
    const rings = BND.areas[NET.dists[di]];
    if (rings) for (const r of rings) for (const p of r) b.extend([p[1], p[0]]);
  }
  return b.isValid() ? b : ALL;
}
function zoomToSelection() {
  map.fitBounds(selectionBounds(), { padding: isPhone() ? [24, 24] : [34, 34] });
}

/* ══════════════ 模式與月份 ══════════════ */
function setMode(m) {
  S.mode = m; TL = null;
  document.querySelectorAll('#modeBar button').forEach(b =>
    b.setAttribute('aria-pressed', +b.dataset.m === m));
  $('timeBar').hidden = m !== 2;
  if (m !== 2) stopPlay();
  refresh();
}
function setMonth(m) {
  S.month = m; S.gran = 'month';
  if (S.mode !== 2) { setMode(2); return; }
  refresh();
}
function setDay(i) {
  S.day = Math.max(0, Math.min(ND - 1, i));
  S.month = DAYMON[S.day] || S.month;
  if (S.mode !== 2) { setMode(2); return; }
  refresh();
}
function setGran(g) {
  S.gran = g; TL = null;
  document.querySelectorAll('#granSw button').forEach(b =>
    b.setAttribute('aria-pressed', b.dataset.g === g));
  document.querySelectorAll('#cumSw button').forEach(b =>
    b.textContent = +b.dataset.c ? '累積' : (g === 'day' ? '單日' : '單月'));
  // 兩種粒度互相對齊：切到日就跳到該月最後一個檢查日，切到月就取當日所屬月
  if (g === 'day') {
    let last = -1;
    for (let i = 0; i < ND; i++) if (DAYMON[i] <= S.month) last = i;
    if (last >= 0) S.day = last;
  } else S.month = DAYMON[S.day] || S.month;
  stopPlay(); refresh();
}
/* 只更新時間列上的數值，播放時用 */
function drawTimeVal() {
  const A = AGG || (AGG = agg(VIS));
  $('timeVal').innerHTML = S.gran === 'day'
    ? `${S.cum ? `自 ${dLabel(0)} 累積` : '當日巡檢'} <b>${km(timeVal(A) / 1000)}</b> km`
    : `${timeLabel()} <b>${km(timeVal(A) / 1000)}</b> km`;
  if (S.gran === 'day') {
    $('dayRange').value = S.day;
    $('dayNow').textContent = YR.dates[S.day] || '';
  } else {
    document.querySelectorAll('#months button').forEach(b => {
      const m = +b.dataset.m;
      b.setAttribute('aria-pressed', m === S.month);
      b.classList.toggle('inrange', S.cum ? m <= S.month : m === S.month);
    });
  }
}
function drawTime() {
  const A = AGG || (AGG = agg(VIS));
  const dayMode = S.gran === 'day';
  $('months').hidden = dayMode;
  $('dayWrap').hidden = !dayMode;

  if (dayMode) {
    const r = $('dayRange');
    r.min = 0; r.max = Math.max(0, ND - 1); r.value = S.day;
    $('dayNow').textContent = YR.dates[S.day] || '';
    $('dayEnds').innerHTML = `<span>${YR.dates[0] || ''}</span><span>${YR.dates[ND - 1] || ''}</span>`;
    // 月份刻度
    let ticks = '', seen = new Set();
    for (let i = 0; i < ND; i++) {
      const m = DAYMON[i];
      if (seen.has(m)) continue;
      seen.add(m);
      ticks += `<i style="left:${i / Math.max(1, ND - 1) * 100}%;background:${C.month[m - 1]}"
        title="${m} 月"></i>`;
    }
    $('dayTicks').innerHTML = ticks;
  } else {
    const ms = new Set(YR.meta.months);
    const mx = Math.max(...YR.meta.months.map(m => A.mo[m]), 1);
    $('months').innerHTML = MN.map((n, i) => {
      const m = i + 1, has = ms.has(m), inr = S.cum ? m <= S.month : m === S.month;
      return `<button data-m="${m}" ${has ? '' : 'disabled'} class="${inr ? 'inrange' : ''}"
        aria-pressed="${m === S.month}">${m}
        <i style="background:${has && inr ? C.month[i] : '#2E3D4A'};
          opacity:${has ? Math.max(0.35, A.mo[m] / mx) : 0.2}"></i></button>`;
    }).join('');
    $('months').querySelectorAll('button').forEach(b =>
      b.onclick = () => { if (!b.disabled) setMonth(+b.dataset.m); });
  }
  drawTimeVal();
}
let playT = null;
function stopPlay() {
  clearInterval(playT); playT = null; S.playing = 0;
  $('btnPlay').setAttribute('aria-pressed', false);
}
function play() {
  if (playT) return stopPlay();
  S.playing = 1; $('btnPlay').setAttribute('aria-pressed', true);
  if (S.gran === 'day') {
    // 逐日播放：累積模式從頭掃過整年，單日模式逐日跳
    let k = S.cum ? 0 : S.day;
    if (S.cum) { S.day = 0; }
    playT = setInterval(() => {
      k++;
      if (k >= ND) { S.day = ND - 1; refreshLight(); return stopPlay(); }
      S.day = k; S.month = DAYMON[k];
      refreshLight();
    }, 110);
  } else {
    const ms = YR.meta.months;
    let k = S.cum ? -1 : ms.indexOf(S.month);
    playT = setInterval(() => {
      k++;
      if (k >= ms.length) { S.month = ms[ms.length - 1]; refreshLight(); return stopPlay(); }
      S.month = ms[k]; refreshLight();
    }, 760);
  }
}

/* ══════════════ 篩選面板 ══════════════ */
function optBtn(on, color, label, sub, data) {
  return `<button class="opt" aria-pressed="${on}" ${data}>
    ${color ? `<i style="background:${color}"></i>` : ''}${label}
    ${sub ? `<small>${sub}</small>` : ''}</button>`;
}
function openFilter() {
  const A = agg(SEG);
  const dcount = new Map();
  SEG.forEach(s => dcount.set(s.dist, (dcount.get(s.dist) || 0) + s.len));
  $('fBody').innerHTML = `
   <div class="fGroup"><h4>年度<button data-act="none" hidden></button></h4>
     <div class="opts">${MF.years.map(y =>
       optBtn(y.id === YR.meta.id, '', y.label, `資料至 ${y.dataThrough}`,
         `data-y="${y.id}"`)).join('')}</div></div>
   <div class="fGroup"><h4>行政區<button data-act="alld">${S.f.dists.size ? '全選' : '全部'}</button></h4>
     <div class="opts">${NET.dists.map((d, i) =>
       optBtn(S.f.dists.has(i), '', d, ((dcount.get(i) || 0) / 1000).toFixed(0) + 'km',
         `data-d="${i}"`)).join('')}</div></div>
   <div class="fGroup"><h4>巡檢狀態<button data-act="allst">全部</button></h4>
     <div class="opts">${STN.map((s, i) =>
       optBtn(S.f.st.has(i), C.st[i], s, km(A.st[i] / 1000) + 'km', `data-st="${i}"`)).join('')}</div></div>
   <div class="fGroup"><h4>巡檢次數<button data-act="allcnt">全部</button></h4>
     <div class="opts">${CNTN.map((s, i) =>
       optBtn(S.f.cnt.has(i), C.cnt[i], s, km(A.cnt[i] / 1000) + 'km', `data-c="${i}"`)).join('')}</div></div>
   <div class="fGroup"><h4>最短管段長度</h4>
     <div class="rng"><input type="range" id="fLen" min="0" max="300" step="10" value="${S.f.minLen}">
       <output id="fLenV">${S.f.minLen ? '≥ ' + S.f.minLen + ' m' : '不限'}</output></div></div>`;

  $('fBody').querySelectorAll('.opt').forEach(b => b.onclick = async () => {
    const d = b.dataset;
    if (d.y) { stopPlay(); $('boot').hidden = false; await loadYear(d.y); $('boot').hidden = true;
               refresh(); openFilter(); return; }
    const set = d.d !== undefined ? S.f.dists : d.st !== undefined ? S.f.st
              : d.c !== undefined ? S.f.cnt : null;
    const v = +(d.d ?? d.st ?? d.c);
    if (!set) return;
    set.has(v) ? set.delete(v) : set.add(v);
    b.setAttribute('aria-pressed', set.has(v));
    previewCount();
  });
  $('fBody').querySelectorAll('h4 button').forEach(b => b.onclick = () => {
    if (b.dataset.act === 'alld') S.f.dists.clear();
    if (b.dataset.act === 'allst') S.f.st.clear();
    if (b.dataset.act === 'allcnt') S.f.cnt.clear();
    openFilter();
  });
  const sl = $('fLen');
  sl.oninput = () => { S.f.minLen = +sl.value;
    $('fLenV').textContent = S.f.minLen ? '≥ ' + S.f.minLen + ' m' : '不限'; previewCount(); };
  previewCount();
  $('fMask').hidden = false; $('fPanel').hidden = false;
}
function previewCount() { $('fNum').textContent = SEG.filter(pass).length.toLocaleString(); }
function closeFilter() { $('fMask').hidden = true; $('fPanel').hidden = true; }
function updateFCount() {
  const n = S.f.dists.size + S.f.st.size + S.f.cnt.size + (S.f.minLen ? 1 : 0);
  $('fCount').hidden = !n; $('fCount').textContent = n;
}

/* ══════════════ 縮放條 ══════════════ */
function syncZoom() {
  const z = map.getZoom(), mn = map.getMinZoom(), mx = map.getMaxZoom();
  const p = Math.max(0, Math.min(1, (z - mn) / (mx - mn)));
  $('zFill').style.height = (p * 100) + '%';
  $('zKnob').style.bottom = `calc(${p * 100}% - 7px)`;
  $('zTrack').setAttribute('aria-valuenow', z.toFixed(1));
}
function zoomFromY(clientY) {
  const r = $('zTrack').getBoundingClientRect();
  const p = Math.max(0, Math.min(1, (r.bottom - clientY) / r.height));
  const mn = map.getMinZoom(), mx = map.getMaxZoom();
  map.setZoom(Math.round((mn + p * (mx - mn)) * 2) / 2);
}

/* ══════════════ 定位 ══════════════ */
function locate(thenNear) {
  if (!navigator.geolocation) return toast('此裝置不支援定位');
  toast('定位中…');
  navigator.geolocation.getCurrentPosition(p => {
    S.myLL = [p.coords.latitude, p.coords.longitude];
    locLayer.clearLayers();
    L.circleMarker(S.myLL, { radius: 8, color: '#fff', weight: 2.5,
      fillColor: '#38E1B0', fillOpacity: 1 }).addTo(locLayer);
    L.circle(S.myLL, { radius: Math.max(p.coords.accuracy, 25), color: '#38E1B0',
      weight: 1, fillColor: '#38E1B0', fillOpacity: 0.1 }).addTo(locLayer);
    $('btnLoc').classList.add('on');
    if (!ALL.pad(0.15).contains(S.myLL)) toast('目前位置不在圖資範圍內');
    else { map.setView(S.myLL, 17); toast('已定位'); }
    if (thenNear) { S.gapSort = 'near'; drawP2(); }
  }, e => toast(e.code === 1 ? '定位權限未開啟' : '無法取得位置'),
     { enableHighAccuracy: true, timeout: 9000, maximumAge: 30000 });
}
let tt;
function toast(m) {
  const el = $('toast'); el.textContent = m; el.classList.add('show');
  clearTimeout(tt); tt = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ══════════════ 圖例 ══════════════ */
function legendRamp() {
  if (S.mode !== 2 || !S.cum) return;
  const el = $('lgd').querySelector('.ramp');
  if (!el) return legend();
  const upto = S.gran === 'day' ? DAYMON[S.day] : S.month;
  const want = YR.meta.months.filter(m => m <= upto);
  if (el.children.length !== want.length) legend();
}
function legend() {
  const el = $('lgd');
  let title, body;
  if (S.mode === 0) {
    title = '管段巡檢狀態';
    body = STN.map((s, i) => `<div><i style="background:${C.st[i]}"></i>${s}</div>`).join('');
  } else if (S.mode === 1) {
    title = '巡檢次數';
    body = CNTN.map((s, i) =>
      `<div><i style="background:${C.cnt[i]};height:${i ? 1.9 + i * 1.3 : 1.8}px"></i>${s}</div>`).join('');
  } else {
    title = S.cum ? `首次巡檢月份（${timeLabel().replace('累積', '')}）` : `${timeLabel()}巡檢`;
    body = (S.cum
      ? (() => { const upto = S.gran === 'day' ? DAYMON[S.day] : S.month;
           return `<div class="ramp">${YR.meta.months.filter(m => m <= upto).map(m =>
             `<i style="background:${C.month[m - 1]}" title="${m}月"></i>`).join('')}</div>
             <div class="note">左 ${YR.meta.months[0]} 月 → 右 ${upto} 月</div>`; })()
      : `<div><i style="background:${C.month[(S.gran === 'day' ? DAYMON[S.day] : S.month) - 1]}"></i>${timeLabel()}巡檢</div>`)
      + `<div><i style="background:${C.mute}"></i>${S.cum ? '尚未巡檢' : (S.gran === 'day' ? '非當日' : '非本月')}</div>`;
  }
  if (mhLayer._map)
    body += '<h4 style="margin-top:7px">人孔</h4>' + ['已開孔', '未開孔', '未列管'].map((s, i) =>
      `<div><i class="dot" style="background:${C.mh[i]}"></i>${s}</div>`).join('');
  el.innerHTML = `<h4>${title}<button class="tg" aria-label="收合圖例">${el.classList.contains('min') ? '＋' : '−'}</button></h4>
    <div class="lgBody">${body}</div>`;
  el.querySelector('.tg').onclick = () => { el.classList.toggle('min'); legend(); };
}


/* ══════════════ 浮動資訊視窗 ══════════════ */
function placeInfo() {
  const el = $('info');
  if (infoPos) { el.style.left = infoPos.x + 'px'; el.style.top = infoPos.y + 'px'; return; }
  const side = isPhone() ? 11 : 396;
  const top = (isPhone() ? 240 : 150) + (parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--sat')) || 0);
  el.style.left = side + 'px';
  el.style.top = top + 'px';
  if (isPhone()) el.style.width = Math.min(268, innerWidth - 22) + 'px';
}
function clampInfo() {
  const el = $('info'), r = el.getBoundingClientRect();
  const x = Math.max(4, Math.min(innerWidth - r.width - 4, r.left));
  const y = Math.max(4, Math.min(innerHeight - 42, r.top));
  el.style.left = x + 'px'; el.style.top = y + 'px';
  infoPos = { x, y };
}
function drawInfo() {
  const el = $('info'), f = S.f.dists;
  if (!f.size || infoClosed) { el.hidden = true; return; }
  el.hidden = false; placeInfo();

  const A = AGG || (AGG = agg(VIS)), tot = A.tot || 1;
  $('infoTitle').textContent = f.size === 1 ? NET.dists[[...f][0]] : `已選 ${f.size} 個行政區`;

  let big, lab, rows, hint;
  if (S.mode === 2) {
    const v = timeVal(A), isD = S.gran === 'day';
    big = (v / tot * 100).toFixed(1); lab = timeLabel() + '巡檢';
    rows = S.cum
      ? MN.map((n, i) => [n, i + 1 <= (isD ? DAYMON[S.day] : S.month) ? A.first[i + 1] : 0, C.month[i]])
          .filter(r => r[1] > 0.5).concat([['尚未巡檢', tot - v, C.mute]])
      : (isD ? [[dLabel(S.day), v, C.month[DAYMON[S.day] - 1]]]
             : YR.meta.months.map(m => [MN[m - 1], A.mo[m], C.month[m - 1]]).filter(r => r[1] > 0.5));
    hint = S.cum ? '累積以首次巡檢時間計算，重複巡檢不重複累加。'
                 : (isD ? '只顯示當日巡檢的管段。' : '各月加總大於累積值，差額為重複巡檢。');
  } else if (S.mode === 1) {
    big = (A.cov / tot * 100).toFixed(1); lab = '已巡檢比例';
    rows = CNTN.map((n, i) => [n, A.cnt[i], C.cnt[i]]);
    hint = `重複巡檢 ${km((A.cnt[2] + A.cnt[3]) / 1000)} km。`;
  } else {
    big = (A.cov / tot * 100).toFixed(1); lab = '已巡檢比例';
    rows = STN.map((n, i) => [n, A.st[i], C.st[i]]);
    hint = A.st[1] > 0.5
      ? `其中 ${km(A.st[1] / 1000)} km 只要排入開孔即可補足。`
      : '此範圍內沒有「有孔未開」的管段。';
  }
  const vis = rows.filter(r => r[1] > 0.5);
  $('infoBody').innerHTML =
    `<div class="iTop"><span class="big num">${big}<span style="font-size:12px;font-weight:400">%</span></span>
       <span class="lb">${lab}</span></div>
     <div class="ruler">${vis.map(r =>
       `<i style="width:${r[1] / tot * 100}%;background:${r[2]}"></i>`).join('')}</div>
     <div style="margin-top:9px">${vis.map(r =>
       `<div class="iRow"><b style="background:${r[2]}"></b>
         <span class="l">${r[0]}</span>
         <span class="v num">${km(r[1] / 1000)} km</span></div>`).join('')}
       <div class="iRow"><b style="background:transparent"></b>
         <span class="l">管線總長</span><span class="v num">${km(A.tot / 1000)} km</span></div></div>
     <div class="iHint">${hint}</div>`;
}
function initInfo() {
  const el = $('info');
  let dx = 0, dy = 0, drg = false, rsz = false, sw = 0, sh = 0, sx = 0, sy = 0;
  $('infoBar').addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    drg = true; const r = el.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top;
    $('infoBar').setPointerCapture(e.pointerId);
  });
  $('infoGrip').addEventListener('pointerdown', e => {
    rsz = true; const r = el.getBoundingClientRect();
    sw = r.width; sh = r.height; sx = e.clientX; sy = e.clientY;
    $('infoGrip').setPointerCapture(e.pointerId); e.preventDefault();
  });
  addEventListener('pointermove', e => {
    if (drg) {
      infoPos = { x: e.clientX - dx, y: e.clientY - dy };
      el.style.left = infoPos.x + 'px'; el.style.top = infoPos.y + 'px';
    } else if (rsz) {
      el.style.width = Math.max(212, Math.min(innerWidth - 20, sw + e.clientX - sx)) + 'px';
      el.style.height = Math.max(132, Math.min(innerHeight - 60, sh + e.clientY - sy)) + 'px';
    }
  });
  addEventListener('pointerup', () => {
    if (drg || rsz) clampInfo();
    drg = rsz = false;
  });
  $('infoClose').onclick = () => { infoClosed = true; $('info').hidden = true; };
  $('infoMin').onclick = () => {
    el.classList.toggle('min');
    $('infoMin').textContent = el.classList.contains('min') ? '＋' : '−';
    clampInfo();
  };
  addEventListener('resize', () => { if (!el.hidden) clampInfo(); });
}

/* ══════════════ 底部面板拖曳 ══════════════ */
let SNAPS = [170, 0, 0];
function calcSnaps() {
  SNAPS = [Math.min(190, innerHeight * 0.26), innerHeight * 0.56, innerHeight * 0.88];
  document.documentElement.style.setProperty('--peekH', SNAPS[0] + 'px');
}
function snap(i) {
  if (!isPhone()) return;
  S.snapIdx = Math.max(0, Math.min(2, i));
  $('sheet').style.setProperty('--peek', SNAPS[S.snapIdx] + 'px');
  setTimeout(() => map.invalidateSize({ pan: false }), 340);
}

/* ══════════════ 初始化 ══════════════ */
function initOnce() {
  calcSnaps(); snap(0);
  addEventListener('resize', () => { calcSnaps(); snap(S.snapIdx); });

  document.querySelectorAll('#modeBar button').forEach(b =>
    b.onclick = () => setMode(+b.dataset.m));
  document.querySelectorAll('#cumSw button').forEach(b => b.onclick = () => {
    S.cum = +b.dataset.c; TL = null;
    document.querySelectorAll('#cumSw button').forEach(x =>
      x.setAttribute('aria-pressed', +x.dataset.c === S.cum));
    stopPlay(); refresh();
  });
  document.querySelectorAll('#granSw button').forEach(b =>
    b.onclick = () => setGran(b.dataset.g));
  $('dayRange').addEventListener('input', () => {
    stopPlay(); S.day = +$('dayRange').value; S.month = DAYMON[S.day] || S.month;
    paint(); drawTimeVal(); drawPeek(); legendRamp(); drawInfo();
  });
  $('dayRange').addEventListener('change', () => { drawP0(); drawP2(); });
  $('btnPlay').onclick = play;
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#tabs button').forEach(x => x.setAttribute('aria-pressed', x === b));
    [0, 1, 2].forEach(i => $('p' + i).hidden = (+b.dataset.t !== i));
    if (S.snapIdx === 0) snap(1);
  });
  $('btnGap').onclick = () => {
    S.onlyGap = !S.onlyGap;
    $('btnGap').setAttribute('aria-pressed', S.onlyGap);
    refresh(); toast(S.onlyGap ? '只顯示未巡檢管段' : '顯示全部管段');
  };
  $('btnMH').onclick = () => {
    if (!mhLayer.getLayers().length) buildMH();
    const on = mhLayer._map == null;
    on ? mhLayer.addTo(map) : map.removeLayer(mhLayer);
    $('btnMH').setAttribute('aria-pressed', on); legend();
    if (on && map.getZoom() < 14) toast('放大地圖可看清人孔點位');
  };
  $('btnLoc').onclick = () => locate(false);
  $('btnYear').onclick = $('btnFilter').onclick = openFilter;
  $('fClose').onclick = $('fMask').onclick = () => { closeFilter(); refresh(); updateFCount(); };
  $('fApply').onclick = () => {
    closeFilter(); infoClosed = false; refresh(); updateFCount();
    if (S.f.dists.size) setTimeout(zoomToSelection, 60);
  };
  $('fReset').onclick = () => {
    S.f = { dists: new Set(), st: new Set(), cnt: new Set(), minLen: 0 };
    S.onlyGap = false; $('btnGap').setAttribute('aria-pressed', false);
    openFilter(); refresh(); updateFCount();
  };

  // 縮放條
  $('zIn').onclick = () => map.zoomIn();
  $('zOut').onclick = () => map.zoomOut();
  const tr = $('zTrack');
  let zd = false;
  const dn = e => { zd = true; zoomFromY((e.touches ? e.touches[0] : e).clientY); };
  const mv = e => { if (zd) { zoomFromY((e.touches ? e.touches[0] : e).clientY); e.preventDefault(); } };
  const up = () => zd = false;
  tr.addEventListener('pointerdown', dn);
  addEventListener('pointermove', mv, { passive: false });
  addEventListener('pointerup', up);
  tr.addEventListener('touchstart', dn, { passive: true });
  tr.addEventListener('touchmove', mv, { passive: false });
  tr.addEventListener('touchend', up);
  tr.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp') { map.zoomIn(); e.preventDefault(); }
    if (e.key === 'ArrowDown') { map.zoomOut(); e.preventDefault(); }
  });
  map.on('zoom zoomend', syncZoom);

  // 面板拖曳
  const grab = $('grab');
  let sy = 0, sp = 0, drag = false;
  const start = y => { if (!isPhone()) return; drag = true; sy = y;
    sp = parseFloat(getComputedStyle($('sheet')).getPropertyValue('--peek'));
    $('sheet').classList.add('dragging'); };
  const move = y => { if (!drag) return;
    const np = Math.max(60, Math.min(innerHeight * 0.88, sp + (sy - y)));
    $('sheet').style.setProperty('--peek', np + 'px'); };
  const end = () => { if (!drag) return; drag = false; $('sheet').classList.remove('dragging');
    const cur = parseFloat(getComputedStyle($('sheet')).getPropertyValue('--peek'));
    let bi = 0, bd = 1e9;
    SNAPS.forEach((v, i) => { const d = Math.abs(v - cur); if (d < bd) { bd = d; bi = i; } });
    snap(bi); };
  grab.addEventListener('touchstart', e => start(e.touches[0].clientY), { passive: true });
  grab.addEventListener('touchmove', e => { move(e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  grab.addEventListener('touchend', end);
  grab.addEventListener('click', () => { if (!drag) snap(S.snapIdx === 0 ? 1 : 0); });
  $('peek').addEventListener('click', e => {
    if (isPhone() && S.snapIdx === 0 && !e.target.closest('button')) snap(1);
  });

  initInfo();
  map.fitBounds(ALL, { padding: [28, 28] });
  refresh(); syncZoom(); updateFCount();
  setTimeout(() => map.invalidateSize({ pan: false }), 120);
}

function buildMH() {
  // 人孔點位由管網單元推得（受檢端點），避免另外傳輸圖層
  const seen = new Map();
  for (const s of SEG) {
    if (!s.node) continue;
    const k = s.dist + '|' + s.node;
    if (!seen.has(k)) seen.set(k, s);
  }
  const rr = L.canvas({ padding: 0.3 });
  for (const [k, s] of seen) {
    const st = s.cnt > 0 ? 0 : (s.st === 4 ? 2 : 1);
    const p = s.ll[0];
    L.circleMarker(p, { renderer: rr, radius: 4, weight: 1.2, color: '#0B161F',
      fillColor: C.mh[st], fillOpacity: 0.95 })
      .bindTooltip(`${NET.dists[s.dist]} ${s.node}｜${['已開孔', '未開孔', '未列管'][st]}`
        + (s.cnt ? `（${s.cnt} 次）` : ''), { direction: 'top' })
      .addTo(mhLayer);
  }
}

boot();
