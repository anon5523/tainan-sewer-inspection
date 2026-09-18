#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
下水道開孔抽樣巡檢覆蓋率 —— 資料建置管線
=========================================
用法：
    python tools/build.py                 # 依 tools/config.json 重建 data/
    python tools/build.py --inline        # 另外輸出單檔離線版 standalone.html

新增年度只需三步：
    1. 把該年度的 Excel 放進 source/
    2. 在 tools/config.json 的 "years" 加一筆
    3. 重新執行本程式

輸出結構：
    data/manifest.json              年度與圖資清單（前端進入點）
    data/network/<id>.json          管網幾何與拓樸（同一份圖資可被多個年度共用）
    data/years/<id>.json            該年度的開孔結果（很小，約 100 KB）

統計邏輯
--------
一座人孔開孔一次，代表巡檢了它與上下游鄰孔之間「各一半」的距離；
若某一側沒有人孔（管線末端，或分岔於無人孔的轉折點），該側整段計入。
兩端皆無可開孔人孔者永遠無法巡檢。所有受檢單元長度總和 == 管線圖資總長。
"""
import argparse, heapq, json, math, re, sys
from collections import defaultdict, Counter
from pathlib import Path

import numpy as np
import pandas as pd
import pyproj
import shapefile

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / 'tools' / 'config.json').read_text(encoding='utf-8'))
SNAP_TOL = CFG.get('snap_tolerance_m', 1.0)
COLLINEAR_TOL = CFG.get('simplify_tolerance_m', 0.4)

TO_WGS = pyproj.Transformer.from_crs(CFG.get('source_crs', 'EPSG:3826'),
                                     'EPSG:4326', always_xy=True)


def log(*a):
    print(*a, flush=True)


# ════════════════════════════════════════════════ 幾何工具
def seglen(pts):
    a = np.asarray(pts, float)
    return 0.0 if len(a) < 2 else float(np.sqrt(((a[1:] - a[:-1]) ** 2).sum(1)).sum())


def drop_collinear(pts, tol=COLLINEAR_TOL):
    if len(pts) < 3:
        return pts
    a = np.asarray(pts, float)
    keep = [0]
    for i in range(1, len(a) - 1):
        p0, p1, p2 = a[keep[-1]], a[i], a[i + 1]
        vx, vy = p2 - p0
        wx, wy = p1 - p0
        L = math.hypot(vx, vy)
        d = abs(vx * wy - vy * wx) / L if L > 0 else math.hypot(wx, wy)
        if d > tol:
            keep.append(i)
    keep.append(len(a) - 1)
    return [tuple(a[i]) for i in keep]


def substr(pts, fa, fb):
    """沿線取 [fa, fb] 比例區間的子折線"""
    a = np.asarray(pts, float)
    d = np.sqrt(((a[1:] - a[:-1]) ** 2).sum(1))
    cum = np.concatenate([[0], np.cumsum(d)])
    tot = cum[-1]
    if tot <= 0:
        return [tuple(a[0]), tuple(a[-1])]
    da, db = fa * tot, fb * tot

    def at(dd):
        j = max(0, min(int(np.searchsorted(cum, dd, 'right') - 1), len(a) - 2))
        s = cum[j + 1] - cum[j]
        t = 0.0 if s <= 0 else (dd - cum[j]) / s
        return tuple(a[j] + t * (a[j + 1] - a[j]))

    return [at(da)] + [tuple(a[j]) for j in range(len(a)) if da < cum[j] < db] + [at(db)]


# ════════════════════════════════════════════════ 建置管網
def build_network(spec):
    nid = spec['id']
    log(f'\n── 建置管網 {nid} ──')

    # 人孔圖層
    sm = shapefile.Reader(str(ROOT / spec['manholes']), encoding=spec.get('encoding', 'utf-8'))
    mf = [f[0] for f in sm.fields[1:]]
    mh, mxy, mkey = {}, [], []
    for r, s in zip(sm.records(), sm.shapes()):
        rec = dict(zip(mf, r))
        k = (str(rec['行政區']).strip(), str(rec['NUM']).strip())
        t = str(rec['Type']).strip()
        if k not in mh:
            mh[k] = {'real': t in ('正常', '覆蓋'), 'type': t,
                     'road': str(rec.get('ROAD_NAME', '')).strip()}
        if s.points:
            mxy.append(s.points[0]); mkey.append(k)
    MXY = np.array(mxy)
    log(f'   人孔 {len(mh):,} 座（實人孔 {sum(v["real"] for v in mh.values()):,}、'
        f'虛人孔 {sum(not v["real"] for v in mh.values()):,}）')

    # 管線圖層
    sp = shapefile.Reader(str(ROOT / spec['pipes']), encoding=spec.get('encoding', 'utf-8'))
    pf = [f[0] for f in sp.fields[1:]]

    def snap(key, x, y):
        if key in mh:
            return key
        try:
            d = np.sqrt(((MXY - np.array([float(x), float(y)])) ** 2).sum(1))
            j = int(d.argmin())
            if d[j] < SNAP_TOL:
                return mkey[j]
        except Exception:
            pass
        return key

    pipes, nsnap = [], 0
    for r, s in zip(sp.records(), sp.shapes()):
        rec = dict(zip(pf, r))
        pts = [tuple(p) for p in s.points]
        if len(pts) < 2:
            continue
        dist = str(rec['行政區']).strip()
        u0 = (dist, str(rec['US_MH']).strip()); d0 = (dist, str(rec['DS_MH']).strip())
        u = snap(u0, rec['US_MH_X'], rec['US_MH_Y'])
        d = snap(d0, rec['DS_MH_X'], rec['DS_MH_Y'])
        nsnap += (u != u0) + (d != d0)
        pipes.append({'dist': dist, 'u': u, 'd': d, 'pts': pts, 'len': seglen(pts),
                      'pinum': str(rec['PI_NUM']).strip()})
    TOT = sum(p['len'] for p in pipes)
    log(f'   管線 {len(pipes):,} 條／{TOT/1000:,.2f} km（座標吸附修正 {nsnap} 個端點）')

    # 節點分類
    deg = Counter()
    for p in pipes:
        deg[p['u']] += 1; deg[p['d']] += 1
    ncls = {k: ('REAL' if mh[k]['real'] else 'VIRT') if k in mh else 'UNKNOWN' for k in deg}
    log(f'   節點 {len(ncls):,}（{dict(Counter(ncls.values()))}）')

    # ── 網路最近人孔分配 ──────────────────────────────────────────
    # 管線上的每一點，歸屬於「沿管線走最近的那座實人孔」。
    # 兩座人孔直接相連時分界點落在中點（即各一半）；一端無人孔時整段歸另一端；
    # 遇到分岔則自然依網路距離分界，不會把整段誤判給遠處的人孔。
    adj = defaultdict(list)
    for i, p in enumerate(pipes):
        adj[p['u']].append((p['d'], p['len'], i))
        adj[p['d']].append((p['u'], p['len'], i))

    INF = float('inf')
    dist_to = {}; owner = {}
    heap = []
    for k, c in ncls.items():
        if c == 'REAL':
            dist_to[k] = 0.0; owner[k] = k
            heapq.heappush(heap, (0.0, k))
    while heap:
        d, u = heapq.heappop(heap)
        if d > dist_to.get(u, INF) + 1e-9:
            continue
        for v, w, _ in adj[u]:
            nd = d + w
            if nd < dist_to.get(v, INF) - 1e-9:
                dist_to[v] = nd; owner[v] = owner[u]
                heapq.heappush(heap, (nd, v))
    reach = sum(1 for k in ncls if k in owner)
    log(f'   可達實人孔的節點 {reach:,}／{len(ncls):,}')

    # 無法連到任何實人孔的連通分量：永遠無法以開孔巡檢
    seen, comp_has_unknown = set(), {}
    for k in ncls:
        if k in owner or k in seen:
            continue
        stack, comp = [k], []
        seen.add(k)
        while stack:
            x = stack.pop(); comp.append(x)
            for y, _, _ in adj[x]:
                if y not in seen:
                    seen.add(y); stack.append(y)
        flag = 2 if any(ncls.get(x) == 'UNKNOWN' for x in comp) else 1
        for x in comp:
            comp_has_unknown[x] = flag

    # ── 切成受檢單元 ─────────────────────────────────────────────
    dists = sorted({p['dist'] for p in pipes})
    DI = {d: i for i, d in enumerate(dists)}
    U = {'d': [], 'len': [], 'node': [], 'nodeDist': [], 'pinum': [], 'blocked': [], 'geom': []}

    def emit(dist, length, node, pinum, blocked, pts):
        pts = drop_collinear(pts)
        xs, ys = zip(*pts)
        lon, lat = TO_WGS.transform(np.array(xs), np.array(ys))
        U['d'].append(DI[dist])
        U['len'].append(round(length, 2))
        U['node'].append(node[1] if node else '')
        U['nodeDist'].append(DI.get(node[0], -1) if node else -1)
        U['pinum'].append(pinum)
        U['blocked'].append(blocked)
        U['geom'].append([[round(float(a), 6), round(float(b), 6)] for a, b in zip(lon, lat)])

    n_split = 0
    for p in pipes:
        u, v, w, pts = p['u'], p['d'], p['len'], p['pts']
        ou, ov = owner.get(u), owner.get(v)
        if ou is None and ov is None:
            emit(p['dist'], w, None, p['pinum'], comp_has_unknown.get(u, 1), pts)
            continue
        if ou is None or ov is None:          # 理論上不會發生，保險處理
            o = ou or ov
            emit(p['dist'], w, o, p['pinum'], 0, pts)
            continue
        if ou == ov:
            emit(p['dist'], w, ou, p['pinum'], 0, pts)
            continue
        # 分界點：距 u 為 x 處滿足 dist[u]+x == dist[v]+(w-x)
        x = (w + dist_to[v] - dist_to[u]) / 2.0
        if x <= 0.01:
            emit(p['dist'], w, ov, p['pinum'], 0, pts)
        elif x >= w - 0.01:
            emit(p['dist'], w, ou, p['pinum'], 0, pts)
        else:
            f = x / w
            emit(p['dist'], x, ou, p['pinum'], 0, substr(pts, 0.0, f))
            emit(p['dist'], w - x, ov, p['pinum'], 0, substr(pts, f, 1.0))
            n_split += 1

    got = sum(U['len'])
    log(f'   受檢單元 {len(U["len"]):,} 筆（其中 {n_split:,} 條管線被分界點切開）')
    log(f'   長度守恆誤差 {abs(got-TOT)*1000:.1f} mm')
    if abs(got - TOT) > 5.0:
        log('   ⚠ 長度守恆誤差過大，請檢查圖資')

    # 實人孔座標（供地圖標示真實位置）
    mhpts = []
    for k, c in ncls.items():
        if c != 'REAL':
            continue
        i = mkey.index(k) if k in mkey else -1
        if i < 0:
            continue
        lon, lat = TO_WGS.transform(mxy[i][0], mxy[i][1])
        mhpts.append([DI.get(k[0], -1), k[1], round(float(lon), 6), round(float(lat), 6)])

    out = {'id': nid, 'label': spec.get('label', nid), 'dists': dists,
           'totalLengthKm': round(TOT / 1000, 3), 'units': U, 'manholes': mhpts,
           'stats': {'pipes': len(pipes), 'manholes': len(mh), 'split': n_split,
                     'snapped': nsnap, 'realNodes': sum(1 for c in ncls.values() if c == 'REAL')}}
    return out, {'mh': mh, 'dists': dists, 'DI': DI}


# ════════════════════════════════════════════════ 建置年度
def norm_cols(df, want):
    """以關鍵字比對欄位名稱，回傳 {want_key: 實際欄名}"""
    out = {}
    for k, kws in want.items():
        for c in df.columns:
            if any(w in str(c) for w in kws):
                out[k] = c
                break
    return out


def build_year(spec, net, meta):
    yid = str(spec['id'])
    log(f'\n── 建置年度 {yid} ──')
    xls = pd.ExcelFile(ROOT / spec['workbook'])

    listed_sheet = spec.get('listed_sheet', 0)
    record_sheet = spec.get('record_sheet', 1)
    li = pd.read_excel(xls, sheet_name=listed_sheet)
    rc = pd.read_excel(xls, sheet_name=record_sheet)

    lc = norm_cols(li, {'dist': ['行政區'], 'num': ['NUM', '編號']})
    rcc = norm_cols(rc, {'dist': ['行政區'], 'num': ['人孔', 'NUM', '編號'], 'date': ['日期', 'DATE']})
    if len(lc) < 2 or len(rcc) < 3:
        sys.exit(f'✗ 無法辨識欄位：列管表 {lc}、紀錄表 {rcc}')

    listed = {(str(a).strip(), str(b).strip())
              for a, b in zip(li[lc['dist']], li[lc['num']])}
    rc = rc.assign(_d=rc[rcc['dist']].astype(str).str.strip(),
                   _n=rc[rcc['num']].astype(str).str.strip(),
                   _t=pd.to_datetime(rc[rcc['date']], errors='coerce'))
    bad = rc._t.isna().sum()
    rc = rc.dropna(subset=['_t'])
    year_ad = spec.get('ad_year')
    if year_ad:
        off = rc[rc._t.dt.year != year_ad]
        if len(off):
            log(f'   ⚠ {len(off)} 筆紀錄年份不是 {year_ad}，已排除')
            rc = rc[rc._t.dt.year == year_ad]
    log(f'   列管人孔 {len(listed):,} 座｜開孔紀錄 {len(rc):,} 筆'
        + (f'（日期無法解析 {bad} 筆已略過）' if bad else ''))

    # 每座人孔：月份位元遮罩 + 總次數 + 檢查日索引
    dates = sorted({t.date() for t in rc._t})
    didx = {d: i for i, d in enumerate(dates)}
    mask, cnt = defaultdict(int), Counter()
    days = defaultdict(set)
    for d, n, t in zip(rc._d, rc._n, rc._t):
        mask[(d, n)] |= 1 << (t.month - 1)
        cnt[(d, n)] += 1
        days[(d, n)].add(didx[t.date()])
    months = sorted({t.month for t in rc._t})
    log(f'   檢查日 {len(dates)} 天（{dates[0]} ~ {dates[-1]}）')
    log(f'   涵蓋月份 {months}｜有開孔人孔 {len(cnt):,} 座')

    U = net['units']
    dists = net['dists']
    n = len(U['len'])
    ym, yc, yl = [0] * n, [0] * n, [0] * n
    yd = [None] * n
    for i in range(n):
        if U['blocked'][i]:
            yd[i] = []
            continue
        k = (dists[U['nodeDist'][i]], U['node'][i])
        ym[i] = mask.get(k, 0)
        yc[i] = cnt.get(k, 0)
        yl[i] = 1 if k in listed else 0
        yd[i] = sorted(days.get(k, ()))

    covered = sum(U['len'][i] for i in range(n) if yc[i] > 0)
    log(f'   已巡檢 {covered/1000:,.2f} km／{net["totalLengthKm"]:,.2f} km '
        f'= {covered/1000/net["totalLengthKm"]*100:.2f}%')
    bym = {}
    for m in months:
        bym[m] = round(sum(U['len'][i] for i in range(n) if ym[i] >> (m - 1) & 1) / 1000, 3)
    log('   各月單獨巡檢長度(km)：' + '、'.join(f'{m}月 {v:,.1f}' for m, v in bym.items()))

    return {'id': yid, 'label': spec.get('label', yid), 'network': net['id'],
            'months': months, 'monthly_km': bym,
            'dates': [str(d) for d in dates],
            'dataThrough': str(rc._t.max().date()),
            'listedCount': len(listed), 'openedCount': len(cnt),
            'm': ym, 'cnt': yc, 'listed': yl, 'dd': yd}


# ════════════════════════════════════════════════ 主程式
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--inline', action='store_true', help='另外輸出單檔離線版 standalone.html')
    args = ap.parse_args()

    (ROOT / 'data' / 'network').mkdir(parents=True, exist_ok=True)
    (ROOT / 'data' / 'years').mkdir(parents=True, exist_ok=True)

    nets, metas = {}, {}
    for spec in CFG['networks']:
        net, meta = build_network(spec)
        nets[net['id']] = net; metas[net['id']] = meta
        p = ROOT / 'data' / 'network' / f'{net["id"]}.json'
        p.write_text(json.dumps(net, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        log(f'   → {p.relative_to(ROOT)}  {p.stat().st_size/1e6:.2f} MB')

    years = []
    for spec in CFG['years']:
        net = nets[spec['network']]
        y = build_year(spec, net, metas[spec['network']])
        p = ROOT / 'data' / 'years' / f'{y["id"]}.json'
        p.write_text(json.dumps(y, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        log(f'   → {p.relative_to(ROOT)}  {p.stat().st_size/1e3:.0f} KB')
        years.append({'id': y['id'], 'label': y['label'], 'network': y['network'],
                      'file': f'years/{y["id"]}.json', 'months': y['months'],
                      'dateCount': len(y['dates']),
                      'dataThrough': y['dataThrough']})

    manifest = {
        'title': CFG.get('title', '下水道開孔抽樣巡檢覆蓋率'),
        'subtitle': CFG.get('subtitle', ''),
        'networks': {k: {'file': f'network/{k}.json', 'label': v['label'],
                         'totalLengthKm': v['totalLengthKm']} for k, v in nets.items()},
        'years': sorted(years, key=lambda y: y['id'], reverse=True),
        'defaultYear': CFG.get('default_year') or sorted(years, key=lambda y: y['id'])[-1]['id'],
    }
    bf = CFG.get('boundaries')
    if bf and (ROOT / 'data' / bf).exists():
        manifest['boundaries'] = {'file': bf}
        log(f'   行政區界：data/{bf}')
    elif bf:
        log(f'   ⚠ 找不到行政區界檔 data/{bf}，地圖將不顯示區界')
    mp = ROOT / 'data' / 'manifest.json'
    mp.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    log(f'\n→ {mp.relative_to(ROOT)}')

    if args.inline:
        make_standalone(manifest, nets)
    log('\n✓ 建置完成')


def make_standalone(manifest, nets):
    """把 manifest + 所有資料內嵌成單一 HTML，可離線雙擊開啟"""
    html = (ROOT / 'index.html').read_text(encoding='utf-8')
    css = (ROOT / 'assets' / 'styles.css').read_text(encoding='utf-8')
    js = (ROOT / 'assets' / 'app.js').read_text(encoding='utf-8')
    bundle = {'manifest': manifest,
              'networks': {k: json.loads((ROOT / 'data' / 'network' / f'{k}.json')
                                         .read_text(encoding='utf-8')) for k in nets},
              'years': {y['id']: json.loads((ROOT / 'data' / 'years' / f'{y["id"]}.json')
                                            .read_text(encoding='utf-8'))
                        for y in manifest['years']}}
    if manifest.get('boundaries'):
        bundle['boundaries'] = json.loads(
            (ROOT / 'data' / manifest['boundaries']['file']).read_text(encoding='utf-8'))
    lcss = (ROOT / 'vendor' / 'leaflet' / 'leaflet.css').read_text(encoding='utf-8')
    ljs = (ROOT / 'vendor' / 'leaflet' / 'leaflet.js').read_text(encoding='utf-8')
    html = html.replace('<link rel="stylesheet" href="vendor/leaflet/leaflet.css">',
                        f'<style>{lcss}</style>')
    html = html.replace('<script src="vendor/leaflet/leaflet.js"></script>',
                        f'<script>{ljs}</script>')
    html = html.replace('<link rel="stylesheet" href="assets/styles.css">',
                        f'<style>{css}</style>')
    html = html.replace('<script src="assets/app.js"></script>',
                        '<script>window.__BUNDLE__=' +
                        json.dumps(bundle, ensure_ascii=False, separators=(',', ':')) +
                        ';</script>\n<script>' + js + '</script>')
    out = ROOT / 'standalone.html'
    out.write_text(html, encoding='utf-8')
    log(f'→ {out.name}  {out.stat().st_size/1e6:.2f} MB（離線單檔版）')


if __name__ == '__main__':
    main()
