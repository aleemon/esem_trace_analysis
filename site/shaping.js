"use strict";
// ---------- Shaping contract (top-level tab) ----------
// Data per region-year (R/shaping.R): pdp and rd [day][run][period], act [day][period]; 13 runs (08:00-20:00 on D-1),
// 56 half-hours ending D 00:30 ... D+1 04:00. Everything below is computed in the browser from those arrays.
const SH = { region: null, y0: 0, y1: 0, dur: 4, minw: 1, maxw: 2, nom: 16, start: 0, end: 48, q: 100, k: 100, pf: 85, alt: false,
  kmode: "single", kp: {}, bbs: new Set(["rd"]), day: null, init: false };
const SH_NP = 56, SH_NR = 13, SH_R0 = 8;
let SHD = null, SHR = null, shPlot = null, DSINFO = null;
const BASES = { rd: "Residual demand", pd: "PD price", pf: "Perfect foresight" }, BK = ["rd", "pd", "pf"], LANE = { rd: "RD", pd: "PD", pf: "PF" };
// strike spread by period: one value, or one per year / quarter / month (blank periods use the default strike)
const kKey = iso => SH.kmode === "year" ? iso.slice(0, 4) : SH.kmode === "quarter" ? `${iso.slice(0, 4)}-Q${Math.floor((+iso.slice(5, 7) - 1) / 3) + 1}` : iso.slice(0, 7);
const kOf = iso => { if (SH.kmode === "single") return SH.k; const v = SH.kp[SH.kmode + ":" + kKey(iso)]; return v == null ? SH.k : v; };
const hhmm = p => { const m = p * 30; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
const dayTs = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 1000 - NEM_OFF;   // market midnight
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);
const shPeriod = () => SH.y0 === SH.y1 ? `${SH.y0}` : `${SH.y0}-${SH.y1}`;
window.shFileBase = key => `${SH.region}_${shPeriod()}_${key}`;

// top-level tabs
function setTop(top) {
  TOP = top;
  document.querySelectorAll("nav.top button").forEach(x => x.setAttribute("aria-selected", x.dataset.top === top));
  for (const id of ["bulk", "shape", "guide"]) $(id).hidden = id !== top;
  $("bulkctl").hidden = top !== "bulk";
  if (DSINFO != null && top !== "shape") $("dsinfo").textContent = DSINFO;
  if (top === "shape") shOpen(); else if (top === "bulk" && META) render();
}
document.querySelectorAll("nav.top button").forEach(b => b.onclick = () => setTop(b.dataset.top));
// guide links: data-goto="bulk:settle" opens a top-level tab (and a bulk sub-tab)
document.querySelectorAll("[data-goto]").forEach(b => b.onclick = () => {
  const [top, sub] = b.dataset.goto.split(":");
  setTop(top);
  if (sub) document.querySelector(`nav.tabs button[data-tab="${sub}"]`)?.click();
  window.scrollTo({ top: 0 });
});

const waitMeta = () => new Promise(ok => { const f = () => META ? ok() : setTimeout(f, 50); f(); });
async function shOpen() {
  await waitMeta();
  const M = META.shaping;
  if (!M) { $("shkpi").innerHTML = `<p class="note">No shaping data in this build. It needs predispatch history (SHAPE_START_YEAR).</p>`; return; }
  if (!SH.init) shInit(M);
  if (DSINFO == null) DSINFO = $("dsinfo").textContent;
  $("dsinfo").textContent = `shaping contract · ${M.regions.length} regions · ${M.years[0]}–${M.years.at(-1)} · 30-min predispatch at ${M.runs.length} nomination runs`;
  shRun(true);
}
function shInit(M) {
  const arr = v => v == null ? [] : Array.isArray(v) ? v : [v];
  M.years = arr(M.years); M.regions = arr(M.regions); M.runs = arr(M.runs);
  for (const r of M.regions) $("sh-reg").add(new Option(r.replace("1", ""), r));
  for (const y of M.years) { $("sh-y0").add(new Option(y, y)); $("sh-y1").add(new Option(y, y)); }
  SH.region = M.regions.includes("NSW1") ? "NSW1" : M.regions[0]; $("sh-reg").value = SH.region;
  SH.y0 = SH.y1 = M.years.length > 1 ? M.years.at(-2) : M.years.at(-1); $("sh-y0").value = SH.y0; $("sh-y1").value = SH.y1;
  for (let h = 8; h <= 20; h++) $("sh-nom").add(new Option(`${String(h).padStart(2, "0")}:00`, h));
  $("sh-nom").value = SH.nom;
  for (let p = 0; p <= 24; p++) $("sh-start").add(new Option(hhmm(p), p));
  $("sh-start").value = SH.start;
  shOptions();
  const rerun = (load = false) => shRun(load);
  $("sh-reg").onchange = e => { SH.region = e.target.value; rerun(true); };
  $("sh-y0").onchange = e => { SH.y0 = +e.target.value; if (SH.y1 < SH.y0) { SH.y1 = SH.y0; $("sh-y1").value = SH.y1; } SH.day = null; rerun(true); };
  $("sh-y1").onchange = e => { SH.y1 = +e.target.value; if (SH.y0 > SH.y1) { SH.y0 = SH.y1; $("sh-y0").value = SH.y0; } SH.day = null; rerun(true); };
  $("sh-dur").querySelectorAll("button").forEach(b => b.onclick = () => { SH.dur = +b.dataset.v; $("sh-dur").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); shOptions(); rerun(); });
  $("sh-minw").onchange = e => { SH.minw = +e.target.value; rerun(); };
  $("sh-maxw").onchange = e => { SH.maxw = +e.target.value; rerun(); };
  $("sh-nom").onchange = e => { SH.nom = +e.target.value; rerun(); };
  $("sh-start").onchange = e => { SH.start = +e.target.value; shOptions(); rerun(); };
  $("sh-end").onchange = e => { SH.end = +e.target.value; rerun(); };
  let dt; const num = (id, key) => $(id).oninput = e => { const v = parseFloat(e.target.value); if (isFinite(v)) { SH[key] = v; clearTimeout(dt); dt = setTimeout(() => shRender(), 120); } };
  num("sh-q", "q"); num("sh-k", "k"); num("sh-pf", "pf");
  $("sh-alt").onchange = e => { SH.alt = e.target.checked; rerun(); };
  $("sh-kmode").onchange = e => { SH.kmode = e.target.value; shStrikeGrid(); shRender(); };
  $("sh-kfill").onclick = () => { for (const k of Object.keys(SH.kp)) if (k.startsWith(SH.kmode + ":")) delete SH.kp[k]; shStrikeGrid(); shRender(); };
  $("sh-bb").querySelectorAll("button").forEach(b => b.onclick = () => {
    const v = b.dataset.v; if (SH.bbs.has(v)) { if (SH.bbs.size > 1) SH.bbs.delete(v); } else SH.bbs.add(v);
    $("sh-bb").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", SH.bbs.has(x.dataset.v))); shExplorer(); });
  $("sh-pax").onchange = () => shExplorer();
  $("sh-day").onchange = e => { if (e.target.value) { SH.day = e.target.value; shExplorer(); } };
  $("sh-prev").onclick = () => { SH.day = addDays(SH.day, -7); shExplorer(); };
  $("sh-next").onclick = () => { SH.day = addDays(SH.day, 7); shExplorer(); };
  SH.init = true;
}
// dependent selects: minimum window <= duration; shaping day end leaves room for both blocks
function shOptions() {
  const mw = [0.5, 1, 1.5, 2, 3, 4, 6, 8].filter(v => v <= SH.dur);
  if (!mw.includes(SH.minw)) SH.minw = Math.min(SH.dur, 1);
  $("sh-minw").innerHTML = mw.map(v => `<option value="${v}" ${v === SH.minw ? "selected" : ""}>${v} h</option>`).join("");
  const lo = SH.start + 4 * SH.dur;
  if (SH.end < lo) SH.end = Math.min(SH_NP, Math.max(lo, 48));
  if (SH.end > SH_NP) SH.end = SH_NP;
  $("sh-end").innerHTML = Array.from({ length: SH_NP - lo + 1 }, (_, i) => lo + i).map(p => `<option value="${p}" ${p === SH.end ? "selected" : ""}>${hhmm(p)}</option>`).join("");
  if (lo > SH_NP) { SH.start = SH_NP - 4 * SH.dur; $("sh-start").value = SH.start; return shOptions(); }
}

// one input per strike period in the loaded range
function shStrikeGrid() {
  const el = $("sh-kgrid"); $("sh-kfill").hidden = SH.kmode === "single";
  if (SH.kmode === "single" || !SHD) { el.innerHTML = ""; el.hidden = true; return; }
  const keys = [...new Set(SHD.days.map(kKey))];
  el.hidden = false;
  el.innerHTML = keys.map(k => { const v = SH.kp[SH.kmode + ":" + k]; return `<label><span>${k}</span><input type="number" step="5" data-k="${k}" value="${v == null ? "" : v}" placeholder="${SH.k}"></label>`; }).join("");
  let dt;
  el.querySelectorAll("input").forEach(i => i.oninput = () => { const v = parseFloat(i.value), key = SH.kmode + ":" + i.dataset.k;
    if (isFinite(v)) SH.kp[key] = v; else delete SH.kp[key]; clearTimeout(dt); dt = setTimeout(() => shRender(), 150); });
}

async function shLoad() {
  const M = META.shaping, yrs = M.years.filter(y => y >= SH.y0 && y <= SH.y1);
  const files = (await Promise.all(yrs.map(y => { const f = M.files[y] && M.files[y][SH.region]; return f ? getFile(f.file) : null; }))).filter(Boolean);
  if (!files.length) throw new Error(`no shaping data for ${SH.region} in ${shPeriod()}`);
  const nd = files.reduce((a, f) => a + f.header.nd, 0);
  const pdp = new Float32Array(nd * SH_NR * SH_NP), rd = new Float32Array(nd * SH_NR * SH_NP), act = new Float32Array(nd * SH_NP), days = [];
  let o = 0;
  for (const f of files) {
    const get = id => { const s = f.header.series.find(x => x.id === id); return new Float32Array(f.buf, f.body + s.off, s.len / 4); };
    pdp.set(get("pdp"), o * SH_NR * SH_NP); rd.set(get("rd"), o * SH_NR * SH_NP); act.set(get("act"), o * SH_NP);
    for (let i = 0; i < f.header.nd; i++) days.push(addDays(f.header.d0, i));
    o += f.header.nd;
  }
  return { key: `${SH.region}_${shPeriod()}`, nd, days, pdp, rd, act };
}

// Best set of half-hours in a window: exactly K of them, in at most N contiguous runs, each run at least m long,
// maximising sign * sum(v). Dynamic programme over (taken, runs used, current run length capped at m); excl marks
// half-hours already used by the other block. need > 0 additionally requires at least one half-hour before index
// need (a flag dimension: "taken one before need yet").
let DPB = new Int32Array(0), DPC = new Float64Array(0), DPN = new Float64Array(0);
function pickBlock(v, n, K, m, N, sign, excl, need = 0) {
  N = Math.min(N, Math.floor(K / m));
  if (K > n || m > K || N < 1) return null;
  const R = m + 1, W = N + 1, S0 = (K + 1) * W * R, F = need > 0 ? 2 : 1, S = S0 * F, NEG = -Infinity;
  if (DPB.length < n * S) DPB = new Int32Array(n * S);
  if (DPC.length < S) { DPC = new Float64Array(S); DPN = new Float64Array(S); }
  let cur = DPC, nxt = DPN; cur.fill(NEG, 0, S); cur[0] = 0;
  for (let t = 0; t < n; t++) {
    nxt.fill(NEG, 0, S);
    const val = sign * v[t], ex = excl && excl[t], bo = t * S;
    for (let f = 0; f < F; f++) { const fo = f * S0, fn = (f || t < need) && F > 1 ? S0 : 0;
     for (let c = 0; c <= K; c++) for (let w = 0; w <= N; w++) {
      const cw = (c * W + w) * R;
      for (let r = 0; r <= m; r++) {
        const st = fo + cw + r, x = cur[st]; if (x === NEG) continue;
        if (r === 0 || r === m) { const ns = fo + cw; if (x > nxt[ns]) { nxt[ns] = x; DPB[bo + ns] = st * 2; } }
        if (!ex && c < K) {
          const ns0 = r === 0 ? (w < N ? ((c + 1) * W + w + 1) * R + 1 : -1) : ((c + 1) * W + w) * R + Math.min(r + 1, m);
          if (ns0 >= 0) { const ns = ns0 + fn, y = x + val; if (y > nxt[ns]) { nxt[ns] = y; DPB[bo + ns] = st * 2 + 1; } }
        }
      }
     }
    }
    const tmp = cur; cur = nxt; nxt = tmp;
  }
  let best = NEG, bs = -1;
  for (let w = 0; w <= N; w++) for (const r of [0, m]) { const st = (F - 1) * S0 + (K * W + w) * R + r; if (cur[st] > best) { best = cur[st]; bs = st; } }
  if (bs < 0) return null;
  const out = []; let st = bs;
  for (let t = n - 1; t >= 0; t--) { const b = DPB[t * S + st]; if (b & 1) out.push(t); st = b >> 1; }
  return out.reverse();
}

// For every f: the best feasible set (as pickBlock) whose first half-hour is exactly f. Runs the same DP on the
// reversed window, recording each step where a take completes the set (the set's last point in reverse = first point).
function pickByFirst(v, n, K, m, N, sign, excl) {
  N = Math.min(N, Math.floor(K / m));
  const val = new Float64Array(n).fill(-Infinity), sets = new Array(n).fill(null);
  if (K > n || m > K || N < 1) return { val, sets };
  const R = m + 1, W = N + 1, S = (K + 1) * W * R, NEG = -Infinity;
  if (DPB.length < n * S) DPB = new Int32Array(n * S);
  if (DPC.length < S) { DPC = new Float64Array(S); DPN = new Float64Array(S); }
  let cur = DPC, nxt = DPN; cur.fill(NEG, 0, S); cur[0] = 0;
  const endSt = new Int32Array(n).fill(-1), endFrom = new Int32Array(n);
  for (let t = 0; t < n; t++) {
    const o = n - 1 - t;   // original index
    nxt.fill(NEG, 0, S);
    const vv = sign * v[o], ex = excl && excl[o], bo = t * S;
    for (let c = 0; c <= K; c++) for (let w = 0; w <= N; w++) {
      const cw = (c * W + w) * R;
      for (let r = 0; r <= m; r++) {
        const st = cw + r, x = cur[st]; if (x === NEG) continue;
        if (r === 0 || r === m) { const ns = cw; if (x > nxt[ns]) { nxt[ns] = x; DPB[bo + ns] = st * 2; } }
        if (!ex && c < K) {
          const ns = r === 0 ? (w < N ? ((c + 1) * W + w + 1) * R + 1 : -1) : ((c + 1) * W + w) * R + Math.min(r + 1, m);
          if (ns >= 0) { const y = x + vv; if (y > nxt[ns]) { nxt[ns] = y; DPB[bo + ns] = st * 2 + 1; }
            if (c + 1 === K && ns % R === m && y > val[o]) { val[o] = y; endSt[o] = ns; endFrom[o] = st; } }
        }
      }
    }
    const tmp = cur; cur = nxt; nxt = tmp;
  }
  // a set ending (in reverse) at step t with run length m is complete: its last run must also be >= m, which ns % R === m ensures
  for (let o = 0; o < n; o++) if (endSt[o] >= 0) {
    const out = [o]; let st = endFrom[o];
    for (let t = n - o - 2; t >= 0; t--) { const b = DPB[t * S + st]; if (b & 1) out.push(n - 1 - t); st = b >> 1; }
    sets[o] = out.sort((a, b) => a - b);
  }
  return { val, sets };
}
const argBest = (P, lo, hi) => { let bi = -1; for (let f = lo; f < hi; f++) if (P.val[f] > (bi < 0 ? -Infinity : P.val[bi])) bi = f; return bi < 0 ? null : P.sets[bi]; };

// Blocks for one day on one basis: high (discharge, type 1) = highest values, then low (charge, type 2) = lowest of the
// rest. With alternation on and prev = the type of the previous day's last window, the day's first window must be the
// other type (X). For every cut b, the later block (Y, prev's type) must lie in [b, n) and X must have a half-hour
// before b; both picking orders are tried and the feasible pair with the widest high-minus-low total is kept.
function dayBlocks(x, n, K, m, N, prev, ex) {
  const pair = (hi, lo) => { if (!hi || !lo) return null; const f = Math.min(hi[0], lo[0]), l = Math.max(hi.at(-1), lo.at(-1));
    let sc = 0; for (const i of hi) sc += x[i]; for (const i of lo) sc -= x[i];
    return { hi, lo, first: hi[0] === f ? 1 : 2, last: hi.at(-1) === l ? 1 : 2, sc }; };
  const mark = idx => { ex.fill(0); if (idx) for (const i of idx) ex[i] = 1; return ex; };
  const hi0 = pickBlock(x, n, K, m, N, 1, null), base = hi0 && pair(hi0, pickBlock(x, n, K, m, N, -1, mark(hi0)));
  if (!base || !prev || base.first !== prev) return base && { ...base, adj: false };
  const X = prev === 1 ? 2 : 1, sx = X === 1 ? 1 : -1, sy = -sx;
  let best = null;
  const consider = (xb, yb) => { const c = X === 1 ? pair(xb, yb) : pair(yb, xb); if (c && (!best || c.sc > best.sc)) best = c; };
  const memo = new Map(), byFirst = (sign, excl) => { const k = sign + ":" + (excl || []).join(","); if (!memo.has(k)) memo.set(k, pickByFirst(x, n, K, m, N, sign, excl && mark(excl).slice())); return memo.get(k); };
  const PY = byFirst(sy, null), PX = byFirst(sx, null);
  for (let b = 1; b <= n - K; b++) {
    const Y1 = argBest(PY, b, n);                       // order 1: Y from [b, n), then X before b from the rest
    if (Y1) consider(argBest(byFirst(sx, Y1), 0, b), Y1);
    const X2 = argBest(PX, 0, b);                       // order 2: X starting before b, then Y from [b, n) minus X
    if (X2) consider(X2, argBest(byFirst(sy, X2), b, n));
  }
  return best ? { ...best, adj: true } : { ...base, adj: false };
}

function shCompute(D) {
  const s = SH.start, e = SH.end, n = e - s, K = SH.dur * 2, m = Math.max(1, Math.round(SH.minw * 2)), N = SH.maxw, ri = SH.nom - SH_R0;
  const nd = D.nd, z = () => new Float64Array(nd).fill(NaN), bz = () => ({ rd: 0, pd: 0, pf: 0 });
  const R = { ok: new Uint8Array(nd), mask: { rd: new Uint8Array(nd * SH_NP), pd: new Uint8Array(nd * SH_NP), pf: new Uint8Array(nd * SH_NP) },
    real: { rd: z(), pd: z(), pf: z() }, fc: { rd: z(), pd: z() }, prof: {}, same: { pd: [0, 0], pf: [0, 0] }, why: { pd: 0, act: 0, blk: 0 },
    seq: bz(), adj: bz(), bnd: 0, seqDay: { rd: new Uint8Array(nd), pd: new Uint8Array(nd), pf: new Uint8Array(nd) }, n, K };
  for (const b of BK) R.prof[b] = { hi: new Float64Array(SH_NP), lo: new Float64Array(SH_NP) };
  const rv = new Float64Array(n), pv = new Float64Array(n), av = new Float64Array(n), ex = new Uint8Array(n);
  const mean = (x, idx) => { let t = 0; for (const i of idx) t += x[i]; return t / idx.length; };
  const last = { rd: 0, pd: 0, pf: 0 };   // type of the previous settled day's last window (0 = no previous day)
  for (let d = 0; d < nd; d++) {
    const b0 = (d * SH_NR + ri) * SH_NP + s, a0 = d * SH_NP + s, contig = d > 0 && R.ok[d - 1];
    if (!contig) for (const b of BK) last[b] = 0;
    let okpd = true, okact = true;
    for (let i = 0; i < n; i++) { rv[i] = D.rd[b0 + i]; pv[i] = D.pdp[b0 + i]; av[i] = D.act[a0 + i]; if (!(rv[i] === rv[i] && pv[i] === pv[i])) okpd = false; if (av[i] !== av[i]) okact = false; }
    if (!okpd) { R.why.pd++; continue; } if (!okact) { R.why.act++; continue; }
    const blocks = {};
    for (const [b, x] of [["rd", rv], ["pd", pv], ["pf", av]]) blocks[b] = dayBlocks(x, n, K, m, N, SH.alt ? last[b] : 0, ex);
    if (!blocks.rd || !blocks.pd || !blocks.pf) { R.why.blk++; continue; }
    R.ok[d] = 1;
    if (contig) R.bnd++;
    for (const b of BK) {
      const B = blocks[b], { hi, lo } = B;
      if (contig && last[b] && B.first === last[b]) { R.seq[b]++; R.seqDay[b][d] = 1; }
      if (B.adj) R.adj[b]++;
      last[b] = B.last;
      R.real[b][d] = mean(av, hi) - mean(av, lo);
      if (b !== "pf") R.fc[b][d] = mean(pv, hi) - mean(pv, lo);
      for (const i of hi) { R.mask[b][d * SH_NP + s + i] = 1; R.prof[b].hi[s + i]++; }
      for (const i of lo) { R.mask[b][d * SH_NP + s + i] = 2; R.prof[b].lo[s + i]++; }
    }
    for (const b of ["pd", "pf"]) {   // share of the contract's (residual-demand) half-hours that the other basis also picks
      const h = new Set(blocks[b].hi), l = new Set(blocks[b].lo);
      R.same[b][0] += blocks.rd.hi.filter(i => h.has(i)).length / K; R.same[b][1] += blocks.rd.lo.filter(i => l.has(i)).length / K;
    }
  }
  R.nok = R.ok.reduce((a, b) => a + b, 0);
  return R;
}

let shTok = 0;
async function shRun(load) {
  const tok = ++shTok;
  try {
    if (load || !SHD || SHD.key !== `${SH.region}_${shPeriod()}`) { $("shkpi").innerHTML = `<p class="note">Loading…</p>`; SHD = await shLoad(); shStrikeGrid(); }
    if (tok !== shTok) return;
    if (SH.alt) { $("shkpi").insertAdjacentHTML("afterbegin", `<p class="note" id="shbusy" style="grid-column:1/-1;margin:0">Re-blocking days for alternation…</p>`); await new Promise(r => setTimeout(r, 30)); }
    if (tok !== shTok) return;
    const t0 = performance.now();
    SHR = shCompute(SHD); SHR.ms = performance.now() - t0;
    if (!SH.day || SH.day < SHD.days[0] || SH.day > SHD.days.at(-1)) { let last = SHD.nd - 1; while (last > 0 && !SHR.ok[last]) last--; SH.day = SHD.days[Math.max(0, last - 6)]; }
    shRender();
  } catch (e) { $("shkpi").innerHTML = `<span class="err">${e.message}</span>`; console.error(e); }
}
function shResize() { if (SHR) shRender(); }

// ---------- rendering ----------
function shRender() {
  const D = SHD, R = SHR; if (!D || !R) return;
  const pfx = SH.pf / 100, E = SH.q * SH.dur;   // MWh per block per day
  const days = [], rows = { rd: [], pd: [], pf: [] }, ks = [];
  for (let d = 0; d < D.nd; d++) if (R.ok[d]) { days.push(d); ks.push(kOf(D.days[d])); for (const b of BK) rows[b].push(R.real[b][d]); }
  const sum = a => a.reduce((x, y) => x + y, 0), avg = a => a.length ? sum(a) / a.length : NaN;
  const stlA = a => sum(a.map((sp, i) => E * (ks[i] - sp)));
  const tot = { rd: stlA(rows.rd), pd: stlA(rows.pd), pf: stlA(rows.pf), pfx: stlA(rows.pf.map(v => v * pfx)) };
  const cap = b => sum(rows[b]) / sum(rows.pf);
  const kLo = Math.min(...ks), kHi = Math.max(...ks), kTxt = !ks.length ? money(SH.k, 0) : kLo === kHi ? money(kLo, 0) : `${money(kLo, 0)}–${money(kHi, 0)} by ${SH.kmode}`;
  const ui = `${SH.region.replace("1", "")} · ${shPeriod()} · nomination ${String(SH.nom).padStart(2, "0")}:00 D-1 · ${SH.dur} h blocks, ≤ ${SH.maxw} window${SH.maxw > 1 ? "s" : ""} of ≥ ${SH.minw} h · shaping day ${hhmm(SH.start)}–${hhmm(SH.end)}${SH.alt ? " · alternating across days" : ""}`;
  const skipped = D.nd - R.nok, below = a => a.filter((v, i) => v < ks[i]).length / Math.max(1, a.length);
  const seqTxt = b => `${fmt(R.seq[b])} of ${fmt(R.bnd)}`;
  $("shkpi").innerHTML = [
    ["Days settled", fmt(R.nok), skipped ? `${fmt(skipped)} skipped: ${[R.why.pd && `${fmt(R.why.pd)} no predispatch`, R.why.act && `${fmt(R.why.act)} no spot`, R.why.blk && `${fmt(R.why.blk)} no feasible block`].filter(Boolean).join(", ")}` : "every day in range"],
    ["Realised spread", money(avg(rows.rd), 1) + "/MWh", `mean, residual-demand blocks · strike ${kTxt}`],
    ["Settlement to holder", money(tot.rd / 1e6, 2) + "M", `${fmt(SH.q)} MW × ${SH.dur} h × (strike − realised)`],
    ["Days holder paid", fmt(below(rows.rd) * 100, 0) + "%", "realised spread below strike"],
    ["Capture of perfect foresight", fmt(cap("rd") * 100, 0) + "%", `PD-price blocks ${fmt(cap("pd") * 100, 0)}% · benchmark ${SH.pf}%`],
    ["Same-type day starts", fmt(R.seq.rd), SH.alt ? `of ${fmt(R.bnd)} · alternation on, ${fmt(R.adj.rd)} days re-blocked` : `of ${fmt(R.bnd)} consecutive days (${fmt(R.seq.rd / Math.max(1, R.bnd) * 100, 0)}%) · alternation off`]
  ].map(([a, v, s]) => `<div class="kpi"><span>${a}</span><b>${v}</b><small>${s}</small></div>`).join("");

  // basis table
  $("sh-tbls").textContent = `${ui} · ${fmt(R.nok)} days · realised spread = spot over the chosen blocks, $/MWh · capture = Σ realised ÷ Σ perfect-foresight spread · overlap = share of the contract's high / low half-hours the basis also picks · same-type starts = consecutive settled days where the first window of a day is the same type (charge or discharge) as the last window of the day before · settlement to the holder at strike ${kTxt}`;
  const tr = (cells, cls = "") => `<tr class="${cls}">${cells.join("")}</tr>`;
  const mny = (v, d = 1) => `<td class="${v < 0 ? "neg" : ""}">${money(v, d)}</td>`;
  const pct = v => `<td>${v == null || !isFinite(v) ? "–" : fmt(v * 100, 0) + "%"}</td>`;
  const T = [
    { k: "rd", name: "Residual demand (contract)", re: avg(rows.rd), cp: cap("rd"), st: tot.rd, oh: 1, ol: 1, lk: below(rows.rd), sq: R.seq.rd, cls: "dflt" },
    { k: "pd", name: "Predispatch price", re: avg(rows.pd), cp: cap("pd"), st: tot.pd, oh: R.same.pd[0] / R.nok, ol: R.same.pd[1] / R.nok, lk: below(rows.pd), sq: R.seq.pd },
    { k: "pf", name: "Perfect foresight", re: avg(rows.pf), cp: 1, st: tot.pf, oh: R.same.pf[0] / R.nok, ol: R.same.pf[1] / R.nok, lk: below(rows.pf), sq: R.seq.pf },
    { k: "pfx", name: `Perfect foresight × ${SH.pf}%`, re: avg(rows.pf) * pfx, cp: pfx, st: tot.pfx, oh: null, ol: null, lk: below(rows.pf.map(v => v * pfx)), sq: null }];
  T.forEach(r => r.bnd = R.bnd);
  LAST.shTable = T;
  $("sh-tbl").innerHTML = `<table><thead><tr><th>Blocks from</th><th>Realised spread</th><th>Capture of PF</th><th>Settlement $M</th><th>High overlap</th><th>Low overlap</th><th>Days below strike</th><th title="Consecutive settled days where the day starts with the same block type (charge or discharge) as the previous day ended">Same-type starts</th></tr></thead><tbody>` +
    T.map(r => tr([`<td class="l">${r.name}</td>`, mny(r.re), pct(r.cp), mny(r.st / 1e6, 2), pct(r.oh), pct(r.ol), pct(r.lk), r.sq == null ? "<td>–</td>" : `<td title="${fmt(r.sq / Math.max(1, R.bnd) * 100, 0)}% of ${fmt(R.bnd)} consecutive-day boundaries">${fmt(r.sq)}</td>`], r.cls || "")).join("") + `</tbody></table>`;

  shExplorer(); shProfile(); shSeries(days, rows, E, pfx, ks);
}

// week explorer: spot, nominated predispatch price and residual demand, with the blocks of the chosen basis
function shExplorer() {
  const D = SHD, R = SHR; if (!D || !R) return;
  let d0 = D.days.indexOf(SH.day); if (d0 < 0) { d0 = Math.max(0, D.nd - 7); SH.day = D.days[d0]; }
  d0 = Math.max(0, Math.min(d0, D.nd - 7)); SH.day = D.days[d0]; $("sh-day").value = SH.day; $("sh-day").min = D.days[0]; $("sh-day").max = D.days.at(-1);
  const d1 = Math.min(D.nd, d0 + 7), ri = SH.nom - SH_R0, xs = [], a = [], p = [], r = [];
  for (let d = d0; d < d1; d++) { const t0 = dayTs(D.days[d]); for (let k = 0; k < 48; k++) {
    xs.push(t0 + (k + 1) * 1800);
    const v = D.act[d * SH_NP + k], q = D.pdp[(d * SH_NR + ri) * SH_NP + k], w = D.rd[(d * SH_NR + ri) * SH_NP + k];
    a.push(v === v ? v : null); p.push(q === q ? q : null); r.push(w === w ? w : null); } }
  // runs of the same block type per selected basis (lanes) and where every selected basis agrees (full-height shading)
  const sel = BK.filter(b => SH.bbs.has(b));
  const runs = f => { const out = []; for (let d = d0; d < d1; d++) { const t0 = dayTs(D.days[d]); let cur = 0, st = 0;
    for (let k = 0; k <= SH_NP; k++) { const mk = k < SH_NP ? f(d * SH_NP + k) : 0;
      if (mk !== cur) { if (cur) out.push([t0 + st * 1800, t0 + k * 1800, cur]); cur = mk; st = k; } } } return out; };
  const lanes = sel.map(b => ({ b, spans: runs(i => R.mask[b][i]) }));
  const spans = runs(i => { const v = R.mask[sel[0]][i]; return sel.every(b => R.mask[b][i] === v) ? v : 0; });
  const seqDays = []; for (let d = d0; d < d1; d++) for (const b of sel) if (R.seqDay[b][d]) seqDays.push(`${D.days[d].slice(5)} (${BASES[b]})`);
  const unsettled = []; for (let d = d0; d < d1; d++) if (!R.ok[d]) unsettled.push(D.days[d].slice(5));
  $("sh1s").textContent = `${SH.region.replace("1", "")} · ${D.days[d0]} to ${D.days[d1 - 1]} · half-hour ending, market time · predispatch from the ${String(SH.nom).padStart(2, "0")}:00 D-1 run · residual demand = PD total demand − PD semi-scheduled solar and wind UIGF (right axis)${unsettled.length ? ` · not settled: ${unsettled.join(", ")}` : ""}${seqDays.length ? ` · same type as the previous day's last window: ${seqDays.join(", ")}` : ""}`;
  const hiC = css("--neg"), loC = css("--s1"), ax = css("--ink-3"), grid = css("--rule-2");
  $("sh1l").innerHTML = `<span><i style="background:${hiC}"></i>Discharge (high block)</span><span><i style="background:${loC}"></i>Charge (low block)</span><span>Lanes above the chart: ${sel.map(b => `${LANE[b]} = ${BASES[b]}`).join(" · ")}</span><span>${sel.length > 1 ? "Full-height shading: all selected bases agree" : `Full-height shading: ${BASES[sel[0]]} blocks`}</span>`;
  const pv = $("sh-pax").value, prange = pv === "zoom" ? [-100, 300] : pv === "mid" ? [-1000, 2000] : null;
  const fF = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const fD = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, day: "numeric", month: "short" }), fT = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const pf = v => v == null ? "–" : money(v, 0), mw = v => v == null ? "–" : fmt(v, 0) + " MW";
  const font = '13px "IBM Plex Mono", monospace';
  const pr = uPlot.pxRatio || devicePixelRatio || 1, LH = 9, LG = 4, PADT = 12 + lanes.length * (LH + LG);
  const opts = {
    width: Math.max(320, $("sh1").clientWidth || 1200), height: 420 + PADT, padding: [PADT, null, null, null], tzDate: ts => uPlot.tzDate(new Date(ts * 1e3), TZ),
    cursor: { drag: { x: true, y: false } }, legend: { live: true },
    scales: { x: { time: true }, y: prange ? { range: prange } : {}, rd: {} },
    axes: [{ stroke: ax, font, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 44, space: 64, values: (u, sp, i, s, inc) => sp.map(ts => { const d = new Date(ts * 1e3); return inc >= 86400 ? fD.format(d) : (fT.format(d) === "00:00" ? fD.format(d) : fT.format(d)); }) },
      { stroke: ax, font, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 70, values: (u, sp) => sp.map(v => money(v, 0)) },
      { scale: "rd", side: 1, stroke: css("--s3"), font, grid: { show: false }, ticks: { stroke: grid }, size: 80, values: (u, sp) => sp.map(v => fmt(v, 0)) }],
    series: [{ label: "Half-hour ending", value: (u, ts) => ts == null ? "–" : fF.format(new Date(ts * 1e3)) },
      { label: "Spot", stroke: css("--ink"), width: 1.5, value: (u, v) => pf(v) },
      { label: "Predispatch price", stroke: css("--s2"), width: 1.5, dash: [6, 4], value: (u, v) => pf(v) },
      { label: "PD residual demand", stroke: css("--s3"), width: 1.25, scale: "rd", value: (u, v) => mw(v) }],
    hooks: { drawClear: [u => { const c = u.ctx, { top, height } = u.bbox; c.save();
      for (const [t0, t1, k] of spans) { const x0 = u.valToPos(t0, "x", true), x1 = u.valToPos(t1, "x", true); if (x1 < u.bbox.left || x0 > u.bbox.left + u.bbox.width) continue;
        c.fillStyle = k === 1 ? hiC : loC; c.globalAlpha = 0.14; c.fillRect(Math.max(x0, u.bbox.left), top, Math.min(x1, u.bbox.left + u.bbox.width) - Math.max(x0, u.bbox.left), height); }
      c.restore(); }],
      draw: [u => { const c = u.ctx, L0 = u.bbox.left, L1 = u.bbox.left + u.bbox.width; c.save();
        lanes.forEach((ln, li) => { const y = u.bbox.top - (lanes.length - li) * (LH + LG) * pr - 2 * pr;
          c.globalAlpha = 1; c.fillStyle = css("--rule-2"); c.fillRect(L0, y, L1 - L0, LH * pr);
          for (const [t0, t1, k] of ln.spans) { const x0 = Math.max(L0, u.valToPos(t0, "x", true)), x1 = Math.min(L1, u.valToPos(t1, "x", true)); if (x1 <= x0) continue;
            c.fillStyle = k === 1 ? hiC : loC; c.globalAlpha = 0.85; c.fillRect(x0, y, x1 - x0, LH * pr); }
          c.globalAlpha = 1; c.fillStyle = css("--ink-3"); c.font = `${11 * pr}px ${css("--f-num")}`; c.textAlign = "right"; c.textBaseline = "middle";
          c.fillText(LANE[ln.b], L0 - 6 * pr, y + LH * pr / 2); });
        c.restore(); }] }
  };
  if (shPlot) shPlot.destroy(); $("sh1").innerHTML = "";
  shPlot = new uPlot(opts, [xs, a, p, r], $("sh1"));
  LAST.shWeek = { xs, a, p, r, lanes, d0, d1 };
}

// time-of-day profile: share of settled days each half-hour is in the charge (low) / discharge (high) block, per basis
function shProfile() {
  const R = SHR; if (!R) return;
  const s = SH.start, e = SH.end, h = 320, L = 60, Rr = 18, T = 14, B = 40;
  const col = { rd: css("--s1"), pd: css("--s2"), pf: css("--s7") }, n = Math.max(1, R.nok);
  for (const [id, w] of [["sh2as", "charge (low)"], ["sh2bs", "discharge (high)"]]) $(id).textContent = `Share of the ${fmt(R.nok)} settled days on which each half-hour falls in the ${w} block, by selection basis · half-hour starting, market time`;
  const one = (el, k, title) => {
    const w = Math.max(300, el.clientWidth || 700), H = hidden("sh2"), X = p => L + (p - s) / Math.max(1, e - s) * (w - L - Rr), Y = v => T + (1 - v) * (h - T - B);
    let g = "";
    [0, .25, .5, .75, 1].forEach(v => g += `<line x1="${L}" x2="${w - Rr}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--rule-2)"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="12.5" class="num" fill="var(--ink-3)">${v * 100}%</text>`);
    const step = (e - s) > 24 ? 8 : 4;
    for (let p = s; p <= e; p += 2) if ((p - s) % step === 0) g += `<text x="${X(p)}" y="${h - B + 18}" text-anchor="middle" font-size="12" class="num" fill="var(--ink-3)">${hhmm(p)}</text>`;
    for (const b of BK) { if (H.has(b)) continue;
      const pts = []; for (let p = s; p < e; p++) { const v = R.prof[b][k][p] / n; pts.push(`${X(p)},${Y(v)}`, `${X(p + 1)},${Y(v)}`); }
      g += `<polyline fill="none" stroke="${col[b]}" stroke-width="${b === "rd" ? 2.25 : 1.6}" points="${pts.join(" ")}"/>`; }
    g += `<line class="xh" y1="${T}" y2="${h - B}" stroke="var(--ink-3)" stroke-dasharray="3 3" visibility="hidden"/>`;
    el.innerHTML = svgEl(w, h, g, title);
    const svg = el.querySelector("svg"), xh = svg.querySelector(".xh");
    svg.onmousemove = ev => { const r = svg.getBoundingClientRect(), sx = (ev.clientX - r.left) * w / r.width, p = Math.floor(s + (sx - L) / (w - L - Rr) * (e - s));
      if (p < s || p >= e) { hideTip(); xh.setAttribute("visibility", "hidden"); return; }
      xh.setAttribute("x1", X(p + 0.5)); xh.setAttribute("x2", X(p + 0.5)); xh.setAttribute("visibility", "visible");
      showTip(`<b>${title} · ${hhmm(p)}–${hhmm(p + 1)}</b>` + BK.map(b => `<div><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${col[b]};margin-right:6px"></i>${BASES[b]} <span class="num">${fmt(R.prof[b][k][p] / n * 100, 0)}%</span></div>`).join(""), ev); };
    svg.onmouseleave = () => { hideTip(); xh.setAttribute("visibility", "hidden"); };
    legend(el, "sh2", BK.map(b => ({ key: b, name: BASES[b] + (b === "rd" ? " (contract)" : ""), color: col[b] })), draw);
  };
  const draw = () => { one($("sh2a"), "lo", "Charging (low block)"); one($("sh2b"), "hi", "Discharging (high block)"); };
  draw();
}

// cumulative settlement, monthly bars, rolling spreads vs perfect foresight, distribution of daily spreads
function shSeries(days, rows, E, pfx, ks) {
  const D = SHD, R = SHR;
  const xs = D.days, col = { rd: css("--s1"), pd: css("--s2"), pf: css("--s7"), k: css("--ink-3") };
  const cum = f => { let c = 0; return xs.map((_, d) => { if (R.ok[d]) c += f(d); return c / 1e6; }); };
  const kd = xs.map(kOf), stl = (d, sp) => E * (kd[d] - sp);
  const cs = [{ key: "rd", name: "Contract", long: "Contract (residual-demand blocks)", color: col.rd, vals: cum(d => stl(d, R.real.rd[d])), width: 2 },
    { key: "pd", name: "PD-price blocks", long: "On predispatch-price blocks", color: col.pd, vals: cum(d => stl(d, R.real.pd[d])), width: 1.5 },
    { key: "pf", name: `PF × ${SH.pf}%`, long: `Perfect foresight × ${SH.pf}%`, color: col.pf, vals: cum(d => stl(d, R.real.pf[d] * pfx)), width: 1.5, dash: "5 4" }];
  $("sh3s").textContent = `Settlement to the holder, $M · ${fmt(SH.q)} MW × ${SH.dur} h × (strike − realised spread) per settled day, strike ${SH.kmode === "single" ? money(SH.k, 0) : "set by " + SH.kmode} · the perfect-foresight line settles against ${SH.pf}% of the best achievable spread`;
  const W3 = Math.max(320, $("sh3").clientWidth || 700);
  const draw3 = () => { lineChart($("sh3"), { xs, series: cs.filter(x => !hidden("sh3").has(x.key)), yfmt: v => v == null ? "–" : money(v, 2) + "M", w: W3, h: 340, title: "Cumulative settlement", xlab: i => xs[i], daily: true });
    legend($("sh3"), "sh3", cs.map(x => ({ key: x.key, name: x.long, color: x.color, dash: !!x.dash })), draw3); };
  draw3();

  // monthly bars
  const mo = new Map();
  for (const d of days) { const k = xs[d].slice(0, 7); const o = mo.get(k) || { s: 0, n: 0, sp: 0, pf: 0 }; o.s += stl(d, R.real.rd[d]); o.k = (o.k || 0) + kd[d]; o.n++; o.sp += R.real.rd[d]; o.pf += R.real.pf[d]; mo.set(k, o); }
  const mrows = [...mo.entries()].map(([k, o]) => ({ k, v: o.s, n: o.n, sp: o.sp / o.n, pf: o.pf / o.n, strike: o.k / o.n }));
  LAST.shMonthly = mrows;
  $("sh4s").textContent = `Contract settlement to the holder by month, $k · hover for days settled and average spreads`;
  barChart($("sh4"), mrows, Math.max(320, $("sh4").clientWidth || 700));

  // rolling 30-day spreads
  const roll = f => xs.map((_, d) => { let t = 0, c = 0; for (let j = Math.max(0, d - 29); j <= d; j++) if (R.ok[j]) { t += f(j); c++; } return c >= 10 ? t / c : null; });
  const ss = [{ key: "rd", name: "Contract", long: "Realised, residual-demand blocks", color: col.rd, vals: roll(d => R.real.rd[d]), width: 2 },
    { key: "pd", name: "PD-price blocks", long: "Realised, predispatch-price blocks", color: col.pd, vals: roll(d => R.real.pd[d]), width: 1.5 },
    { key: "pf", name: `PF × ${SH.pf}%`, long: `Perfect foresight × ${SH.pf}%`, color: col.pf, vals: roll(d => R.real.pf[d] * pfx), width: 1.5, dash: "5 4" },
    { key: "k", name: "Strike", long: "Strike", color: col.k, vals: kd, width: 1.25, dash: "2 3" }];
  $("sh5s").textContent = `Spread, $/MWh, 30-day rolling mean of settled days · the holder is paid when the contract's realised spread is below the strike · the gap to the perfect-foresight line is the forecasting shortfall of the residual-demand rule`;
  const W5 = Math.max(320, $("sh5").clientWidth || 1200);
  const draw5 = () => { lineChart($("sh5"), { xs, series: ss.filter(x => !hidden("sh5").has(x.key)), yfmt: v => v == null ? "–" : money(v, 0), w: W5, h: 340, title: "Spreads against perfect foresight", xlab: i => `30 days to ${xs[i]}`, daily: true });
    legend($("sh5"), "sh5", ss.map(x => ({ key: x.key, name: x.long, color: x.color, dash: !!x.dash })), draw5); };
  draw5();

  // distribution of daily spreads
  $("sh6s").textContent = `Daily spread, $/MWh, over ${fmt(days.length)} settled days · box = P25–P75, line = median, whisker = P10–P90, circles = lowest and highest day · strike ${SH.kmode === "single" ? money(SH.k, 0) : "set by " + SH.kmode}`;
  boxRows($("sh6"), [["Residual-demand blocks", rows.rd, "a"], ["Predispatch-price blocks", rows.pd, "b"], [`Perfect foresight × ${SH.pf}%`, rows.pf.map(v => v * pfx), "c"], ["Perfect foresight", rows.pf, "m"]],
    v => money(v, 0), Math.max(320, $("sh6").clientWidth || 1200), "$/MWh", { extremes: true, noun: "days", labelW: 260 });
  LAST.shDaily = { days, pfx, E, kd };
}

function barChart(el, rows, w) {
  const h = 340, L = 76, Rr = 16, T = 14, B = 40;
  if (!rows.length) { el.innerHTML = `<p class="note">No settled days.</p>`; return; }
  const vs = rows.map(r => r.v / 1000), lo = Math.min(0, ...vs), hi = Math.max(0, ...vs), ticks = niceTicks(lo, hi, 5);
  const a = Math.min(lo, ticks[0]), b = Math.max(hi, ticks.at(-1)), Y = v => T + (b - v) / ((b - a) || 1) * (h - T - B);
  const bw = (w - L - Rr) / rows.length; let g = "";
  ticks.forEach(t => g += `<line x1="${L}" x2="${w - Rr}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--rule-2)"/><text x="${L - 8}" y="${Y(t) + 4}" text-anchor="end" font-size="12.5" class="num" fill="var(--ink-3)">${money(t, 0)}k</text>`);
  let lastX = -1e9;
  rows.forEach((r, i) => { const x = L + i * bw, v = r.v / 1000, y0 = Y(0), y1 = Y(v);
    g += `<rect data-i="${i}" x="${x + bw * 0.12}" y="${Math.min(y0, y1)}" width="${Math.max(1, bw * 0.76)}" height="${Math.max(1, Math.abs(y1 - y0))}" rx="2" fill="${v < 0 ? "var(--neg)" : "var(--pos)"}" fill-opacity=".85"/>`;
    if (x - lastX >= 40) { g += `<text x="${x + bw / 2}" y="${h - B + 18}" text-anchor="middle" font-size="12" class="num" fill="var(--ink-3)">${r.k.slice(5) === "01" || i === 0 ? r.k : MONTHS[+r.k.slice(5) - 1]}</text>`; lastX = x; } });
  g += `<line x1="${L}" x2="${w - Rr}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--ink-3)"/>`;
  el.innerHTML = svgEl(w, h, g, "Monthly settlement");
  el.querySelectorAll("rect[data-i]").forEach(n => { const r = rows[+n.dataset.i];
    n.onmousemove = ev => showTip(`<b>${r.k}</b><div class="num">Settlement ${money(r.v / 1000, 1)}k</div><div class="num">${r.n} days · strike ${money(r.strike, 1)} · realised ${money(r.sp, 1)} · perfect foresight ${money(r.pf, 1)} /MWh</div>`, ev);
    n.onmouseleave = hideTip; });
}

// ---------- downloads ----------
function shDailyCsv() {
  const D = SHD, R = SHR, L = LAST.shDaily; if (!D || !R || !L) return;
  saveCsv(fileBase("shaping-daily"), ["date", "settled", "strike", "realised_spread_rd", "realised_spread_pd", "perfect_foresight_spread", "settlement_rd", "settlement_pd", "settlement_pf_derated", "high_block_rd", "low_block_rd", "same_type_as_previous_day_rd", "same_type_as_previous_day_pd", "same_type_as_previous_day_pf", "alternation", "region", "nomination", "duration_h", "min_window_h", "max_windows", "day_start", "day_end", "quantity_mw", "pf_pct"],
    D.days.map((iso, d) => { const blk = k => { const o = []; for (let p = 0; p < SH_NP; p++) if (R.mask.rd[d * SH_NP + p] === k) o.push(hhmm(p)); return o.join(" "); };
      const ok = R.ok[d], st = sp => ok ? L.E * (L.kd[d] - sp) : "";
      return [iso, ok, L.kd[d], R.real.rd[d], R.real.pd[d], R.real.pf[d], st(R.real.rd[d]), st(R.real.pd[d]), st(R.real.pf[d] * L.pfx), ok ? blk(1) : "", ok ? blk(2) : "",
        R.seqDay.rd[d], R.seqDay.pd[d], R.seqDay.pf[d], SH.alt ? 1 : 0,
        SH.region, `${SH.nom}:00 D-1`, SH.dur, SH.minw, SH.maxw, hhmm(SH.start), hhmm(SH.end), SH.q, SH.pf].map(v => typeof v === "number" && !isFinite(v) ? "" : v); }));
}
function shTableCsv() { const T = LAST.shTable; if (!T) return; saveCsv(fileBase("shaping-basis"), ["blocks_from", "realised_spread", "capture_of_pf", "settlement_to_holder", "high_overlap", "low_overlap", "days_below_strike", "same_type_boundaries", "consecutive_day_boundaries", "alternation"], T.map(r => [r.name, r.re, r.cp, r.st, r.oh, r.ol, r.lk, r.sq, r.bnd, SH.alt ? 1 : 0])); }
function shWeekCsv() { const W = LAST.shWeek; if (!W) return; const f = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const blk = (ln, ts) => { const s = ln.spans.find(([a, b]) => ts > a && ts <= b); return s ? (s[2] === 1 ? "discharge" : "charge") : ""; };
  saveCsv(fileBase("shaping-week"), ["half_hour_ending", "spot", "predispatch_price", "pd_residual_demand_mw", ...W.lanes.map(l => `block_${l.b}`)], W.xs.map((t, i) => [f.format(new Date(t * 1e3)), W.a[i], W.p[i], W.r[i], ...W.lanes.map(l => blk(l, t))])); }
function shProfileCsv() { const R = SHR; if (!R) return; const n = Math.max(1, R.nok);
  saveCsv(fileBase("shaping-block-timing"), ["half_hour_start", "rd_high", "rd_low", "pd_high", "pd_low", "pf_high", "pf_low"], Array.from({ length: SH.end - SH.start }, (_, i) => { const p = SH.start + i; return [hhmm(p), ...["rd", "pd", "pf"].flatMap(b => [R.prof[b].hi[p] / n, R.prof[b].lo[p] / n])]; })); }
function shMonthlyCsv() { const M = LAST.shMonthly; if (!M) return; saveCsv(fileBase("shaping-monthly"), ["month", "days", "mean_strike", "settlement_to_holder", "realised_spread_rd", "perfect_foresight_spread"], M.map(r => [r.k, r.n, r.strike, r.v, r.sp, r.pf])); }
Object.assign(EXPORTS, {
  "sh-tbl": { png: (pn, n) => tablePng($("sh-tbl"), pn, n), csv: shTableCsv },
  sh1: { png: (pn, n) => shPlot && uplotPng(shPlot, pn, n), csv: shWeekCsv },
  sh2a: { png: (pn, n) => svgPng($("sh2a"), pn, n), csv: shProfileCsv },
  sh2b: { png: (pn, n) => svgPng($("sh2b"), pn, n), csv: shProfileCsv },
  sh3: { png: (pn, n) => svgPng($("sh3"), pn, n), csv: shDailyCsv },
  sh4: { png: (pn, n) => svgPng($("sh4"), pn, n), csv: shMonthlyCsv },
  sh5: { png: (pn, n) => svgPng($("sh5"), pn, n), csv: shDailyCsv },
  sh6: { png: (pn, n) => svgPng($("sh6"), pn, n), csv: shDailyCsv },
});
