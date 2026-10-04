"use strict";
// ---------- utilities ----------
const $ = id => document.getElementById(id);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const DATA = "data/";
// Set true only for hosts that refuse binary files (e.g. claude.ai artifacts); GitHub Pages serves .bin as-is.
const B64 = false;
const H = 300 / 3600;
const REF_SUN = Date.UTC(2020, 11, 27) / 1000, NEM_OFF = 36000, WEEK = 604800;
const fmt = (v, d = 0) => (v == null || !isFinite(v)) ? "–" : v.toLocaleString("en-AU", { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (v, d = 1) => (v == null || !isFinite(v)) ? "–" : (v < 0 ? "−$" : "$") + fmt(Math.abs(v), d);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TZ = "Australia/Brisbane";
const TECH = { wind: "Wind", solar: "Solar" };
const AP = { a: "A · Exposed", b: "B · Cap + floor", c: "C · Cap + knockout" };
const TRN = { so: "Sent-out", ug: "UIGF on negative" }, TRS = { so: "sent-out", ug: "UIGF" };
const tip = $("tip");
function showTip(html, ev) {
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
  if (y + h > innerHeight - 8) y = ev.clientY - h - 14;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
const hideTip = () => { tip.hidden = true; };
const quant = (s, q) => { if (!s.length) return NaN; const p = (s.length - 1) * q, i = Math.floor(p), f = p - i; return i + 1 < s.length ? s[i] * (1 - f) + s[i + 1] * f : s[i]; };
const sd = a => { if (a.length < 2) return NaN; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const svgEl = (w, h, inner, label) => `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${label}" style="display:block;max-width:100%">${inner}</svg>`;
function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) hi = lo + 1;
  const span = hi - lo, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= n) || 10 * mag;
  const t = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) t.push(+v.toFixed(10));
  return t;
}
const wkOf = t => Math.floor((t + NEM_OFF - 300 - REF_SUN) / WEEK);

// ---------- WDB1 reader ----------
async function fetchBin(path) {
  const url = DATA + (B64 ? path.replace(/\.bin$/, ".b64.txt") : path);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  let buf;
  if (B64) { const t = (await r.text()).trim(); const bin = atob(t); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); buf = u.buffer; }
  else buf = await r.arrayBuffer();
  const u8 = new Uint8Array(buf, 0, 2);
  if (u8[0] === 0x1f && u8[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  if (String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== "WDB1") throw new Error(`${path}: not a WDB1 file`);
  const hlen = new DataView(buf).getUint32(4, true);
  return { header: JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen))), buf, body: 8 + hlen };
}
function decodeSeries(file, s, base) {
  const n = file.header.n, off = file.body + s.off, out = new Float32Array(n);
  if (s.enc === "f32") out.set(new Float32Array(file.buf, off, n));
  else {
    const lo = new Uint8Array(file.buf, off, n), hi = new Uint8Array(file.buf, off + n, n); let acc = 0; const sc = +s.scale;
    for (let i = 0; i < n; i++) { let d = lo[i] | (hi[i] << 8); if (d > 32767) d -= 65536; acc += d; out[i] = acc * sc; }
  }
  if (base) for (let i = 0; i < n; i++) out[i] += (base[i] === base[i] ? base[i] : 0);
  for (const [st, len] of s.gaps) out.fill(NaN, st, st + len);
  return out;
}
const series = (f, id) => f.header.series.find(s => s.id === id);

// ---------- state ----------
const S = { tab: "farm", unit: null, y0: 0, y1: 0, units: "cf", showug: false,
  k: 75, q: 100, cap: 600, floor: 0, tr: { a: "so", b: "ug", c: "so" },
  ftech: "wind", freg: "", fk: 75, fr: 100, fpair: "dflt", fsort: { k: "net_b", d: -1 } };
let META, SETTLE, UNIT = new Map();
const cache = new Map();
const getFile = f => { if (!cache.has(f)) cache.set(f, fetchBin(f)); return cache.get(f); };

async function boot() {
  try {
    const t0 = performance.now();
    META = await fetch(DATA + "meta.json").then(r => r.json());
    // R's JSON writer turns length-1 vectors into scalars; normalise every field the page treats as an array
    const arr = v => v == null ? [] : Array.isArray(v) ? v : [v];
    META.years = arr(META.years);
    META.units.forEach(u => { u.member = arr(u.member); });
    const st = await fetchBin(META.settle.file);
    const [u, r] = st.header.series;
    SETTLE = { weeks: st.header.weeks, U: new Float32Array(st.buf, st.body + u.off, u.len / 4), R: new Float32Array(st.buf, st.body + r.off, r.len / 4),
      uf: u.fields, rf: r.fields, W: u.shape[2], NU: u.shape[0] };
    META.units.forEach(x => UNIT.set(x.id, x));
    const nW = META.units.filter(x => x.tech === "wind").length, nS = META.units.length - nW;
    const tot = Object.values(META.unit_parts).reduce((a, p) => a + p.bytes, 0) + Object.values(META.idx).reduce((a, p) => a + p.bytes, 0);
    $("dsinfo").textContent = `${nW} wind · ${nS} solar · ${META.years[0]}–${META.years.at(-1)} · 5-min · ${(tot / 1e6).toFixed(0)} MB on demand`;
    const load = `Summary loaded in ${Math.round(performance.now() - t0)} ms.`;
    $("foot").textContent = META.source === "aemo"
      ? `Source: AEMO (NEMWeb MMSDM and daily reports). Data to ${META.data_end} (interval ending, market time). Built ${META.generated}. ${load}`
      : `Demonstration build on synthetic data: DUIDs, outputs and prices are generated, not market records. ${load}`;
    for (const y of META.years) { $("y0").add(new Option(y, y)); $("y1").add(new Option(y, y)); }
    const full = META.years.length > 1 ? META.years.at(-2) : META.years.at(-1);   // latest complete year
    S.y0 = S.y1 = full; $("y0").value = S.y0; $("y1").value = S.y1;
    for (const r of META.regions) $("freg").add(new Option(r.id.replace("1", ""), r.id));
    const first = META.units.filter(x => x.tech === "wind").sort((a, b) => b.cap - a.cap)[0] || META.units[0];
    selectUnit(first.id, false);
    wire(); render();
  } catch (e) { $("dsinfo").innerHTML = `<span class="err">Couldn't load data: ${e.message}</span>`; console.error(e); }
}
function selectUnit(id, rerender = true) {
  S.unit = id; const u = UNIT.get(id);
  $("unitq").value = `${u.name} (${u.id})`;
  S.q = Math.round(u.cap); $("q").value = S.q;
  if (rerender) render();
}
function setPressed(a, b, on) { $(a).setAttribute("aria-pressed", on); $(b).setAttribute("aria-pressed", !on); }
function wire() {
  $("y0").onchange = e => { S.y0 = +e.target.value; if (S.y1 < S.y0) { S.y1 = S.y0; $("y1").value = S.y1; } render(); };
  $("y1").onchange = e => { S.y1 = +e.target.value; if (S.y0 > S.y1) { S.y0 = S.y1; $("y0").value = S.y0; } render(); };
  $("u-cf").onclick = () => { S.units = "cf"; setPressed("u-cf", "u-mw", true); drawPlots(); };
  $("u-mw").onclick = () => { S.units = "mw"; setPressed("u-cf", "u-mw", false); drawPlots(); };
  $("showug").onchange = e => { S.showug = e.target.checked; drawPlots(); };
  $("paxis").onchange = () => drawPlots();
  $("reset").onclick = () => resetZoom();
  document.querySelectorAll("nav.tabs button").forEach(b => b.onclick = () => {
    S.tab = b.dataset.tab;
    document.querySelectorAll("nav.tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
    for (const id of ["farm", "settle", "fleet"]) $(id).hidden = id !== S.tab;
    render();
  });
  const num = (id, key, f) => $(id).oninput = e => { const v = parseFloat(e.target.value); if (isFinite(v)) { S[key] = v; f(); } };
  num("k", "k", () => renderSettle()); num("q", "q", () => renderSettle()); num("cap", "cap", () => renderSettle()); num("floor", "floor", () => renderSettle());
  document.querySelectorAll("[data-ap]").forEach(b => b.onclick = () => {
    S.tr[b.dataset.ap] = b.dataset.tr;
    document.querySelectorAll(`[data-ap="${b.dataset.ap}"]`).forEach(x => x.setAttribute("aria-pressed", x.dataset.tr === b.dataset.tr));
    renderSettle();
  });
  $("ft-w").onclick = () => { S.ftech = "wind"; setPressed("ft-w", "ft-s", true); renderFleet(); };
  $("ft-s").onclick = () => { S.ftech = "solar"; setPressed("ft-w", "ft-s", false); renderFleet(); };
  $("freg").onchange = e => { S.freg = e.target.value; renderFleet(); };
  num("fk", "fk", () => renderFleet()); num("fr", "fr", () => renderFleet());
  $("fpair").onchange = e => { S.fpair = e.target.value; renderFleet(); };
  // unit picker
  const q = $("unitq"), list = $("unitlist");
  const fill = () => {
    const s = q.value.trim().toLowerCase(), cur = UNIT.get(S.unit);
    const items = META.units.filter(u => !s || q.value === `${cur.name} (${cur.id})` || u.name.toLowerCase().includes(s) || u.id.toLowerCase().includes(s) || u.region.toLowerCase().startsWith(s) || u.tech.startsWith(s))
      .sort((a, b) => a.region.localeCompare(b.region) || a.tech.localeCompare(b.tech) || a.name.localeCompare(b.name)).slice(0, 300);
    list.innerHTML = items.map(u => `<li data-id="${u.id}" class="${u.id === S.unit ? "on" : ""}"><span>${u.name} <small>${u.id}</small></span><small>${u.region.replace("1", "")} · ${TECH[u.tech]} · ${fmt(u.cap)} MW</small></li>`).join("") || `<li>No matches</li>`;
    list.hidden = false;
  };
  q.onfocus = () => { q.select(); fill(); }; q.oninput = fill;
  q.onblur = () => setTimeout(() => { list.hidden = true; const u = UNIT.get(S.unit); q.value = `${u.name} (${u.id})`; }, 150);
  list.onmousedown = e => { const li = e.target.closest("li[data-id]"); if (li) { list.hidden = true; selectUnit(li.dataset.id); } };
  q.onkeydown = e => { if (e.key === "Enter") { const li = list.querySelector("li[data-id]"); if (li) { list.hidden = true; q.blur(); selectUnit(li.dataset.id); } } };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => render());
  new MutationObserver(() => render()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  let rt; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (S.tab === "farm") sizePlots(); else render(); }, 150); }).observe(document.querySelector(".wrap"));
}
function render() {
  renderUnitBar();
  if (S.tab === "farm") renderFarm(); else if (S.tab === "settle") renderSettle(); else renderFleet();
}
function renderUnitBar() {
  const u = UNIT.get(S.unit); if (!u) return;
  $("unitbar").hidden = S.tab === "fleet";
  const yrs = META.years.map(y => `<span class="yr ${u.member.includes(y) ? "in" : ""}" title="${u.member.includes(y) ? "In" : "Not in"} the ${y} ${u.region} ${u.tech} reference basket">${y}</span>`).join("");
  $("unitbar").innerHTML = `<b>${u.name}</b><span>${u.id} · ${u.region} · ${TECH[u.tech]} · ${fmt(u.cap, 1)} MW</span>
    <span>Registered ${u.reg_date || "–"} · first generation ${!u.first_gen ? "none yet" : (u.first_op && u.first_op < u.first_gen ? "before the data history starts" : u.first_gen)} · operational from ${u.first_op || "–"}</span>
    <span style="display:inline-flex;gap:4px;align-items:center">Reference basket ${yrs}</span>`;
}

// ---------- data for one unit over the period ----------
let EX = null, exToken = 0;
async function loadUnit() {
  const u = UNIT.get(S.unit), years = META.years.filter(y => y >= S.y0 && y <= S.y1);
  const key = `${u.id}|${years.join(",")}`;
  if (EX && EX.key === key) return EX;
  const t0 = performance.now();
  const idx = await Promise.all(years.map(y => getFile(META.idx[`${u.region}_${y}`].file)));
  const blk = await Promise.all(years.map(y => getFile(META.unit_parts[`${u.region}_${y}_b${u.block}`].file)));
  const N = idx.reduce((a, f) => a + f.header.n, 0), T0 = idx[0].header.t0, dt = idx[0].header.dt;
  const cat = parts => { const o = new Float32Array(N); let k = 0; parts.forEach(p => { o.set(p, k); k += p.length; }); return o; };
  const price = cat(idx.map(f => decodeSeries(f, series(f, "rrp"))));
  const tso = cat(idx.map(f => decodeSeries(f, series(f, `${u.tech}_so`))));
  const tug = cat(idx.map(f => decodeSeries(f, series(f, `${u.tech}_ug`))));
  const so = [], ug = [];
  blk.forEach(f => { const a = decodeSeries(f, series(f, `${u.id}:so`)); so.push(a); ug.push(decodeSeries(f, series(f, `${u.id}:ug`), a)); });
  let bytes = 0; years.forEach(y => { bytes += META.idx[`${u.region}_${y}`].bytes + META.unit_parts[`${u.region}_${y}_b${u.block}`].bytes; });
  return { key, u, T0, dt, N, price, tso, tug, so: cat(so), ug: cat(ug), x0: T0, x1: T0 + (N - 1) * dt, ms: performance.now() - t0, bytes, nfiles: years.length * 2 };
}

// ---------- farm tab ----------
let plots = [], syncing = false;
function lod(src, i0, i1, nb) {
  const mean = new Array(nb), mn = new Array(nb), mx = new Array(nb), s = (i1 - i0) / nb;
  for (let b = 0; b < nb; b++) {
    const j0 = i0 + Math.floor(b * s), j1 = Math.max(j0 + 1, i0 + Math.floor((b + 1) * s));
    let sum = 0, c = 0, lo = Infinity, hi = -Infinity;
    for (let j = j0; j < j1; j++) { const v = src[j]; if (v === v) { sum += v; c++; if (v < lo) lo = v; if (v > hi) hi = v; } }
    mean[b] = c ? sum / c : null; mn[b] = c ? lo : null; mx[b] = c ? hi : null;
  }
  return { mean, mn, mx };
}
function buildData(x0, x1, width) {
  const E = EX, i0 = Math.max(0, Math.floor((x0 - E.T0) / E.dt) - 1), i1 = Math.min(E.N, Math.ceil((x1 - E.T0) / E.dt) + 2);
  const n = Math.max(1, i1 - i0), nb = Math.max(50, Math.round(width)), raw = n <= nb * 2;
  const pick = src => { if (raw) { const a = Array.from(src.subarray(i0, i1), v => v === v ? v : null); return { mean: a, mn: a, mx: a }; } return lod(src, i0, i1, nb); };
  const xs = [];
  if (raw) for (let j = i0; j < i1; j++) xs.push(E.T0 + j * E.dt);
  else { const s = n / nb; for (let b = 0; b < nb; b++) xs.push(E.T0 + (i0 + (b + 0.5) * s) * E.dt); }
  const scale = (src, f) => { const o = new Float32Array(src.length); for (let i = 0; i < src.length; i++) o[i] = src[i] * f; return o; };
  const cap = E.u.cap, cf = S.units === "cf";
  const p = pick(E.price);
  const farm = pick(cf ? scale(E.so, 1 / cap) : E.so).mean;
  const ref = pick(cf ? E.tso : scale(E.tso, cap)).mean;
  const refu = pick(cf ? E.tug : scale(E.tug, cap)).mean;
  const fug = pick(cf ? scale(E.ug, 1 / cap) : E.ug).mean;
  return { d1: [xs, p.mean, p.mx, p.mn], d2: [xs, farm, ref, refu, fug] };
}
const plotWidth = () => Math.max(280, $("p1").clientWidth || 600);
function sizePlots() { if (!plots.length) return; const w = plotWidth(); plots.forEach(p => p.setSize({ width: w, height: p.height })); }
function plotOpts(series, h, extra = {}) {
  const ax = css("--ink-3"), grid = css("--rule-2");
  const fD = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, day: "numeric", month: "short" }), fM = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, month: "short", year: "numeric" }),
    fT = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), fF = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const xvals = (u, splits, a, sp, incr) => splits.map(ts => { const d = new Date(ts * 1e3); if (incr >= 27 * 86400) return fM.format(d); if (incr >= 86400) return fD.format(d); const t = fT.format(d); return t === "00:00" ? fD.format(d) : t; });
  return Object.assign({
    width: plotWidth(), height: h, tzDate: ts => uPlot.tzDate(new Date(ts * 1e3), TZ),
    cursor: { sync: { key: "ex" }, drag: { x: true, y: false }, bind: { dblclick: () => () => { resetZoom(); return null; } } },
    scales: { x: { time: true } }, legend: { live: true },
    axes: [{ stroke: ax, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, values: xvals }, { stroke: ax, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 60 }],
    series: [{ label: "Interval ending", value: (u, ts) => ts == null ? "–" : fF.format(new Date(ts * 1e3)) }].concat(series),
    hooks: { setScale: [(u, key) => { if (key === "x") onZoom(u); }] }
  }, extra);
}
async function renderFarm() {
  const tok = ++exToken;
  $("exstatus").textContent = "Loading…";
  let E; try { E = await loadUnit(); } catch (e) { $("exstatus").innerHTML = `<span class="err">${e.message}</span>`; return; }
  if (tok !== exToken) return;
  const keep = EX && EX.key === E.key && plots.length ? plots[0].scales.x : null;
  EX = E;
  $("exstatus").textContent = `${E.nfiles} files · ${(E.bytes / 1e6).toFixed(1)} MB · decoded in ${Math.round(E.ms)} ms · ${(E.N / 1e3).toFixed(0)}k intervals`;
  drawPlots(keep);
}
function drawPlots(keep) {
  const E = EX; if (!E) return;
  if (keep === undefined && plots.length) keep = plots[0].scales.x;
  const u = E.u, cf = S.units === "cf";
  $("p1t").textContent = `${u.region.replace("1", "")} settlement price`;
  $("p2t").textContent = `${u.name} vs ${u.region.replace("1", "")} ${u.tech} reference trace`;
  $("p2s").textContent = `${cf ? "Capacity factor" : `MW (reference traces scaled to ${fmt(u.cap, 1)} MW)`} · reference = basket output ÷ basket capacity, basket fixed each 1 January`;
  plots.forEach(p => p.destroy()); plots = []; $("p1").innerHTML = ""; $("p2").innerHTML = "";
  const d = buildData(E.x0, E.x1, plotWidth());
  const pv = $("paxis").value, prange = pv === "zoom" ? [-100, 300] : pv === "mid" ? [-1000, 2000] : null;
  const pf = v => v == null ? "–" : (v < 0 ? "−$" : "$") + fmt(Math.abs(v), 0);
  plots.push(new uPlot(plotOpts([
    { label: "Price (mean)", stroke: css("--s1"), width: 1.25, value: (x, v) => pf(v) },
    { label: "max", stroke: "transparent", width: 0, points: { show: false }, value: (x, v) => pf(v) },
    { label: "min", stroke: "transparent", width: 0, points: { show: false }, value: (x, v) => pf(v) }
  ], 210, Object.assign({ bands: [{ series: [2, 3], fill: css("--band") }] }, prange ? { scales: { x: { time: true }, y: { range: prange } } } : {})), d.d1, $("p1")));
  const vf = v => v == null ? "–" : cf ? fmt(v, 3) : fmt(v, 1) + " MW";
  plots.push(new uPlot(plotOpts([
    { label: `${u.name} sent-out`, stroke: css("--s3"), width: 1.5, value: (x, v) => vf(v) },
    { label: "Reference, sent-out", stroke: css("--s1"), width: 1.5, value: (x, v) => vf(v) },
    { label: "Reference, UIGF on negative", stroke: css("--s2"), width: 1.25, dash: [5, 4], value: (x, v) => vf(v) },
    { label: `${u.name} UIGF`, stroke: css("--ink-3"), width: 1, value: (x, v) => vf(v), show: S.showug }
  ], 280, cf ? { scales: { x: { time: true }, y: { range: [0, 1.05] } } } : {}), d.d2, $("p2")));
  if (keep && keep.min != null && keep.min >= E.x0 - 1 && keep.max <= E.x1 + 1 && (keep.max - keep.min) < (E.x1 - E.x0) * 0.999) refreshLod(keep.min, keep.max);
}
function resetZoom() { if (EX) refreshLod(EX.x0, EX.x1); }
function onZoom(u) { if (syncing) return; const { min, max } = u.scales.x; refreshLod(min, max); }
function refreshLod(min, max) {
  if (!EX || plots.length < 2) return;
  const d = buildData(min, max, plotWidth());
  syncing = true; plots[0].setData(d.d1, false); plots[1].setData(d.d2, false); plots.forEach(p => p.setScale("x", { min, max })); syncing = false;
}

// ---------- settlement (single farm, 5-min, editable cap/floor) ----------
const KEYS = [];
for (const a of ["a", "b", "c"]) for (const t of ["so", "ug"]) KEYS.push(a + "_" + t);
function settle(E, p) {
  const w0 = wkOf(E.T0), nW = wkOf(E.T0 + (E.N - 1) * E.dt) - w0 + 1;
  const z = () => new Float64Array(nW);
  const R = { nW, w0, merch: z(), merchRaw: z(), energy: z(), nint: z(), ok: z() };
  for (const k of KEYS) { R["s_" + k] = z(); R["v_" + k] = z(); }
  const att = { so: { floor: 0, cap: 0, ko: 0, kocap: 0 }, ug: { floor: 0, cap: 0, ko: 0, kocap: 0 } };
  const { k: K, q: Q, cap: X, floor: F } = p;
  for (let i = 0; i < E.N; i++) {
    const P = E.price[i]; if (P !== P) continue;
    const w = wkOf(E.T0 + i * E.dt) - w0;
    const g = E.so[i];
    if (g === g) { const gg = g > 0 ? g : 0; R.merch[w] += gg * (P > 0 ? P : 0) * H; R.merchRaw[w] += gg * P * H; R.energy[w] += gg * H; }
    const pb = P < F ? F : P > X ? X : P, pc = P > X ? X : P, live = P >= 0;
    R.nint[w]++;
    for (const t of ["so", "ug"]) {
      const cf = t === "so" ? E.tso[i] : E.tug[i]; if (cf !== cf) continue;
      const v = cf * Q * H;
      R["s_a_" + t][w] += v * (K - P); R["v_a_" + t][w] += v;
      R["s_b_" + t][w] += v * (K - pb); R["v_b_" + t][w] += v;
      if (live) { R["s_c_" + t][w] += v * (K - pc); R["v_c_" + t][w] += v; }
      // attribution of B and C relative to A (same trace): settlement change = v * (P - P')
      if (P < F) att[t].floor += v * (P - F); else if (P > X) att[t].cap += v * (P - X);
      if (!live) att[t].ko += -v * (K - P); else if (P > X) att[t].kocap += v * (P - X);
    }
    if (g === g) R.ok[w]++;
  }
  R.att = att;
  return R;
}
const sum = a => a.reduce((x, y) => x + y, 0);
function lineChart(el, { xs, series, yfmt, w = 600, h = 240, title, xlab }) {
  const L = 58, Rr = 112, T = 10, B = 26, ph = h - T - B;
  series.forEach(s => { s.vals = Array.from(s.vals); });
  const all = series.flatMap(s => s.vals).filter(v => v != null && isFinite(v));
  let lo = Math.min(0, ...all), hi = Math.max(...all); const pad = (hi - lo) * 0.06 || 1; hi += pad; if (lo < 0) lo -= pad;
  const ticks = niceTicks(lo, hi, 5); lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks.at(-1));
  const n = xs.length, X = i => L + (n <= 1 ? 0 : i * (w - L - Rr) / (n - 1)), Y = v => T + ph - (v - lo) / (hi - lo) * ph;
  let g = "";
  ticks.forEach(t => g += `<line x1="${L}" x2="${w - Rr}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--rule-2)"/><text x="${L - 8}" y="${Y(t) + 4}" text-anchor="end" font-size="11" class="num" fill="var(--ink-3)">${yfmt(t)}</text>`);
  if (lo < 0) g += `<line x1="${L}" x2="${w - Rr}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--ink-3)"/>`;
  // label each year at its first week that starts in January, at least 36 px after the previous label
  let lastX = -1e9, lastY = "";
  const mid = d => new Date(Date.parse(d) + 3 * 864e5).toISOString().slice(0, 10);   // a week belongs to the year of its Wednesday
  xs.forEach((d0, i) => { const d = mid(d0), y = d.slice(0, 4); if (y !== lastY && (d.slice(5, 7) === "01" || i === 0)) { lastY = y; if (X(i) - lastX >= 36) { g += `<text x="${X(i)}" y="${h - 8}" font-size="11" fill="var(--ink-3)">${y}</text><line x1="${X(i)}" x2="${X(i)}" y1="${T + ph}" y2="${T + ph + 4}" stroke="var(--rule)"/>`; lastX = X(i); } } });
  if (n > 0 && n <= 60) { const mi = []; xs.forEach((d, i) => { if (mid(d).slice(8, 10) <= "07" && i > 0) mi.push(i); }); mi.forEach(i => { if (X(i) - lastX >= 30) { g += `<text x="${X(i)}" y="${h - 8}" font-size="11" fill="var(--ink-3)">${MONTHS[+mid(xs[i]).slice(5, 7) - 1]}</text>`; lastX = X(i); } }); }
  const ends = [];
  series.forEach(s => {
    let dd = "", pen = false; s.vals.forEach((v, i) => { if (v == null || !isFinite(v)) { pen = false; return; } dd += (pen ? "L" : "M") + X(i).toFixed(1) + "," + Y(v).toFixed(1); pen = true; });
    g += `<path d="${dd}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} stroke-linejoin="round"/>`;
    let li = s.vals.length - 1; while (li > 0 && (s.vals[li] == null || !isFinite(s.vals[li]))) li--;
    ends.push({ y: Y(s.vals[li]), name: s.name, color: s.color });
  });
  ends.sort((a, b) => a.y - b.y); for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  ends.forEach(e => g += `<circle cx="${w - Rr + 8}" cy="${e.y - 4}" r="3.5" fill="${e.color}"/><text x="${w - Rr + 15}" y="${e.y}" font-size="11.5" fill="var(--ink-2)">${e.name}</text>`);
  g += `<line class="xh" y1="${T}" y2="${T + ph}" stroke="var(--ink-3)" stroke-dasharray="3 3" visibility="hidden"/>`;
  el.innerHTML = svgEl(w, h, g, title);
  const svg = el.querySelector("svg"), xh = svg.querySelector(".xh");
  svg.onmousemove = ev => {
    const r = svg.getBoundingClientRect(), sx = (ev.clientX - r.left) * w / r.width;
    if (sx < L - 4 || sx > w - Rr + 4) { hideTip(); xh.setAttribute("visibility", "hidden"); return; }
    const i = Math.max(0, Math.min(n - 1, Math.round((sx - L) / ((w - L - Rr) / Math.max(1, n - 1)))));
    xh.setAttribute("x1", X(i)); xh.setAttribute("x2", X(i)); xh.setAttribute("visibility", "visible");
    showTip(`<b>${xlab ? xlab(i) : xs[i]}</b>` + series.map(s => `<div><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:6px"></i>${s.name} <span class="num">${yfmt(s.vals[i])}</span></div>`).join(""), ev);
  };
  svg.onmouseleave = () => { hideTip(); xh.setAttribute("visibility", "hidden"); };
}
function bridge(el, rows, w) {
  // rows: [{label, v, kind: 'total'|'delta'}]; horizontal bars from a common zero
  const L = 250, Rr = 76, rh = 26, T = 8, h = T + rows.length * rh + 10;
  const vals = rows.map(r => r.v), lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const X = v => L + (v - lo) / ((hi - lo) || 1) * (w - L - Rr);
  let g = `<line x1="${X(0)}" x2="${X(0)}" y1="${T - 2}" y2="${h - 6}" stroke="var(--ink-3)"/>`;
  rows.forEach((r, i) => {
    const y = T + i * rh, c = r.kind === "total" ? "var(--ink-3)" : r.v >= 0 ? "var(--pos)" : "var(--neg)";
    g += `<text x="${L - 10}" y="${y + 16}" text-anchor="end" font-size="12" fill="var(--ink${r.kind === "total" ? "" : "-2"})" font-weight="${r.kind === "total" ? 600 : 400}">${r.label}</text>
      <rect x="${Math.min(X(0), X(r.v))}" y="${y + 5}" width="${Math.max(1, Math.abs(X(r.v) - X(0)))}" height="15" rx="3" fill="${c}" fill-opacity="${r.kind === "total" ? 0.45 : 0.85}"/>
      <text x="${Math.max(X(0), X(r.v)) + 6}" y="${y + 16}" font-size="11.5" class="num" fill="var(--ink-2)">${money(r.v / 1e6, 2)}M</text>`;
  });
  el.innerHTML = svgEl(w, h, g, "Settlement attribution");
}
async function renderSettle() {
  const tok = ++exToken;
  let E; try { E = await loadUnit(); } catch (e) { $("stkpi").innerHTML = `<span class="err">${e.message}</span>`; return; }
  if (tok !== exToken) return; EX = E;
  const u = E.u;
  $("bdesc").textContent = `Floating clamped to ${money(S.floor, 0)} – ${money(S.cap, 0)}`;
  $("cdesc").textContent = `Floating capped at ${money(S.cap, 0)}; quantity 0 when price < $0`;
  const R = settle(E, S);
  const full = []; for (let w = 0; w < R.nW; w++) if (R.nint[w] >= 0.9 * 2016 && R.ok[w] >= 0.9 * 2016) full.push(w);
  const M = sum(R.merch), EG = sum(R.energy), MR = sum(R.merchRaw);
  const row = key => {
    const s = R["s_" + key], net = s.map((v, w) => v + R.merch[w]);
    const nf = full.map(w => net[w]).sort((a, b) => a - b);
    return { key, ap: key[0], tr: key.slice(2), S: sum(s), V: sum(R["v_" + key]), net: sum(net), sd: sd(nf), p10: quant(nf, 0.1), worst: nf[0], weekly: net, s };
  };
  const rows = KEYS.map(row);
  const sel = { a: rows.find(r => r.key === "a_" + S.tr.a), b: rows.find(r => r.key === "b_" + S.tr.b), c: rows.find(r => r.key === "c_" + S.tr.c) };
  const mf = full.map(w => R.merch[w]).sort((a, b) => a - b), msd = sd(mf);
  $("stkpi").innerHTML = [
    ["Farm output", fmt(EG / 1000, 1) + " GWh", `${fmt(EG / (u.cap * R.nint.reduce((a, b) => a + b, 0) * H) * 100, 1)}% CF`],
    ["Merchant", money(M / 1e6, 2) + "M", `${money(M / EG, 1)}/MWh · floored at $0`],
    ...["a", "b", "c"].map(a => [AP[a], money(sel[a].net / 1e6, 2) + "M", `${money(sel[a].net / EG, 1)}/MWh · settlement ${money(sel[a].S / 1e6, 2)}M`])
  ].map(([a, v, s]) => `<div class="kpi"><span>${a}</span><b>${v}</b><small>${s}</small></div>`).join("");
  // comparison table
  $("cmps").textContent = `${u.name}, ${S.y0 === S.y1 ? S.y0 : S.y0 + "–" + S.y1} · K ${money(S.k, 2)}/MWh · Q ${fmt(S.q)} MW · weekly statistics over ${full.length} complete weeks · highlighted rows are the selected trace per approach`;
  const tr = (cls, cells) => `<tr class="${cls}">${cells.join("")}</tr>`;
  const td = (v, d = 2, isMoney = true) => `<td class="${v < 0 ? "neg" : ""}">${isMoney ? money(v / 1e6, d) : fmt(v, d)}</td>`;
  let h = `<table><thead><tr><th>Approach</th><th>Trace</th><th>Contract GWh</th><th>Settlement $M</th><th>Net revenue $M</th><th>Net $/MWh</th><th>vs merchant $/MWh</th><th>Weekly SD $k</th><th>P10 week $k</th><th>Worst week $k</th></tr></thead><tbody>`;
  h += tr("", [`<td class="l"><span class="tag m">M</span>Merchant only</td>`, `<td class="l">–</td>`, `<td>–</td>`, `<td>–</td>`, td(M), `<td>${money(M / EG, 1)}</td>`, `<td>–</td>`, `<td>${fmt(msd / 1000, 0)}</td>`, `<td>${money(quant(mf, 0.1) / 1000, 0)}</td>`, `<td>${money(mf[0] / 1000, 0)}</td>`]);
  for (const r of rows) {
    const d = sel[r.ap].key === r.key ? "dflt" : "";
    h += tr(d, [`<td class="l"><span class="tag ${r.ap}">${r.ap.toUpperCase()}</span>${AP[r.ap].slice(4)}</td>`, `<td class="l">${TRN[r.tr]}</td>`, `<td>${fmt(r.V / 1000, 1)}</td>`, td(r.S), td(r.net),
      `<td>${money(r.net / EG, 1)}</td>`, `<td class="${(r.net - M) < 0 ? "neg" : ""}">${money((r.net - M) / EG, 1)}</td>`, `<td>${fmt(r.sd / 1000, 0)}</td>`, `<td>${money(r.p10 / 1000, 0)}</td>`, `<td>${money(r.worst / 1000, 0)}</td>`]);
  }
  $("cmp").innerHTML = h + `</tbody></table>`;
  // cumulative + weekly
  const W = Math.max(320, Math.min(760, $("st1").clientWidth || 600));
  const wk = Array.from({ length: R.nW }, (_, w) => SETTLE.weeks[R.w0 + w] || "");
  const cum = a => { let c = 0; return a.map(v => (c += v) / 1e6); };
  const lines = [{ name: "Merchant", color: css("--ink-3"), vals: cum(Array.from(R.merch)), dash: "4 3", width: 1.5 },
    ...["a", "b", "c"].map((a, i) => ({ name: `${a.toUpperCase()} · ${S.tr[a] === "so" ? "SO" : "UIGF"}`, color: css(["--s1", "--s2", "--s7"][i]), vals: cum(sel[a].weekly) }))];
  lineChart($("st1"), { xs: wk, series: lines, yfmt: v => v == null ? "–" : money(v, 1) + "M", w: W, h: 250, title: "Cumulative net revenue", xlab: i => `Week from ${wk[i]}` });
  const W3 = Math.max(320, Math.min(1240, $("st3").clientWidth || 900));
  lineChart($("st3"), { xs: wk, series: [{ name: "Merchant", color: css("--ink-3"), vals: Array.from(R.merch, v => v / 1000), dash: "4 3", width: 1.25 },
    ...["a", "b", "c"].map((a, i) => ({ name: `${a.toUpperCase()} · ${S.tr[a] === "so" ? "SO" : "UIGF"}`, color: css(["--s1", "--s2", "--s7"][i]), vals: sel[a].weekly.map(v => v / 1000), width: 1.25 }))],
    yfmt: v => v == null ? "–" : money(v, 0) + "k", w: W3, h: 260, title: "Weekly net revenue", xlab: i => `Week from ${wk[i]}` });
  // attribution bridge (A -> B and A -> C, each on its own selected trace)
  const tb = S.tr.b, tc = S.tr.c, aB = rows.find(r => r.key === "a_" + tb), aC = rows.find(r => r.key === "a_" + tc);
  const traceEffB = tb === S.tr.a ? 0 : aB.S - sel.a.S;
  const bridgeRows = [
    { label: `A on ${TRS[S.tr.a]} trace`, v: sel.a.S, kind: "total" },
    ...(traceEffB ? [{ label: `Switch to ${TRS[tb]} trace`, v: traceEffB, kind: "delta" }] : []),
    { label: `Floor at ${money(S.floor, 0)}`, v: R.att[tb].floor, kind: "delta" },
    { label: `Cap at ${money(S.cap, 0)}`, v: R.att[tb].cap, kind: "delta" },
    { label: `= B on ${TRS[tb]} trace`, v: sel.b.S, kind: "total" },
    { label: `A on ${TRS[tc]} trace`, v: aC.S, kind: "total" },
    { label: `Knock out negative-price volume`, v: R.att[tc].ko, kind: "delta" },
    { label: `Cap at ${money(S.cap, 0)}`, v: R.att[tc].kocap, kind: "delta" },
    { label: `= C on ${TRS[tc]} trace`, v: sel.c.S, kind: "total" }];
  $("st2s").textContent = `Settlement $M for the period · each step is the change in settlement from that rule alone`;
  bridge($("st2"), bridgeRows, Math.max(320, Math.min(760, $("st2").clientWidth || 600)));
  window.__settle = { R, rows, M, EG };   // exposed for verification
}

// ---------- fleet (precomputed weekly components, $600 cap / $0 floor) ----------
function renderFleet() {
  const { U, R: RR, uf, rf, W, weeks } = SETTLE;
  const from = `${S.y0}-01-01`, to = `${S.y1 + 1}-01-01`;
  const wks = []; weeks.forEach((d, w) => { if (d >= from && d < to) wks.push(w); });
  const fi = n => uf.indexOf(n), ri = n => rf.indexOf(n);
  const pair = S.fpair === "dflt" ? { a: "so", b: "ug", c: "so" } : { a: S.fpair, b: S.fpair, c: S.fpair };
  const rows = [];
  for (const u of META.units) {
    if (u.tech !== S.ftech || (S.freg && u.region !== S.freg)) continue;
    const r = META.rt.findIndex(x => x.region === u.region && x.tech === u.tech); if (r < 0) continue;
    const ub = u.gi * uf.length * W, rb = r * rf.length * W;
    let EG = 0, MG = 0; const mw = [], nets = { a: [], b: [], c: [] }, tot = { a: 0, b: 0, c: 0 };
    for (const w of wks) {
      if (U[ub + fi("nvalid") * W + w] < 0.9 * 2016 || RR[rb + ri("nint") * W + w] < 0.9 * 2016) continue;
      const eg = U[ub + fi("EG") * W + w], mg = U[ub + fi("MG") * W + w];
      EG += eg; MG += mg; mw.push(mg / u.cap);
      for (const a of ["a", "b", "c"]) {
        const an = { a: 1, b: 2, c: 3 }[a];
        const A = RR[rb + ri(`${pair[a]}_a${an}_A`) * W + w], B = RR[rb + ri(`${pair[a]}_a${an}_B`) * W + w];
        const s = (S.fr / 100) * u.cap * (S.fk * A - B);
        tot[a] += s; nets[a].push((mg + s) / u.cap);
      }
    }
    if (mw.length < 4 || EG <= 0) continue;
    const msd = sd(mw);
    rows.push({ u, n: mw.length, EG, cf: EG / (u.cap * mw.length * 168), merch: MG / EG,
      net_a: (MG + tot.a) / EG, net_b: (MG + tot.b) / EG, net_c: (MG + tot.c) / EG,
      red_a: sd(nets.a) / msd - 1, red_b: sd(nets.b) / msd - 1, red_c: sd(nets.c) / msd - 1 });
  }
  const per = S.y0 === S.y1 ? S.y0 : `${S.y0}–${S.y1}`;
  $("fl1s").textContent = `${rows.length} ${S.ftech} assets${S.freg ? " in " + S.freg : ""}, ${per} · $/MWh of each asset's own output · K ${money(S.fk, 0)} · contract ${fmt(S.fr)}% of capacity`;
  const W1 = Math.max(320, Math.min(760, $("fl1").clientWidth || 600));
  boxRows($("fl1"), [["Merchant", rows.map(r => r.merch), "m"], [AP.a, rows.map(r => r.net_a), "a"], [AP.b, rows.map(r => r.net_b), "b"], [AP.c, rows.map(r => r.net_c), "c"]], v => money(v, 0), W1, "$/MWh");
  boxRows($("fl2"), [[AP.a, rows.map(r => r.red_a * 100), "a"], [AP.b, rows.map(r => r.red_b * 100), "b"], [AP.c, rows.map(r => r.red_c * 100), "c"]], v => (v > 0 ? "+" : "") + fmt(v, 0) + "%", W1, "%");
  const cols = [["name", "Asset"], ["region", "Region"], ["cap", "MW"], ["cf", "CF"], ["merch", "Merchant $/MWh"], ["net_a", "A net $/MWh"], ["net_b", "B net $/MWh"], ["net_c", "C net $/MWh"], ["red_a", "A SD vs merchant"], ["red_b", "B SD vs merchant"], ["red_c", "C SD vs merchant"], ["n", "Weeks"]];
  const val = (r, k) => k === "name" ? r.u.name : k === "region" ? r.u.region : k === "cap" ? r.u.cap : r[k];
  const { k, d } = S.fsort;
  rows.sort((a, b) => { const x = val(a, k), y = val(b, k); return (typeof x === "string" ? x.localeCompare(y) : x - y) * d; });
  const pc = v => `${fmt(v * 100, 0)}%`, pcs = v => `${v > 0 ? "+" : ""}${fmt(v * 100, 0)}%`;
  $("fl3").innerHTML = `<table><thead><tr>${cols.map(([c, l]) => `<th data-k="${c}">${l}${c === k ? (d > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>${rows.map(r =>
    `<tr data-id="${r.u.id}" class="${r.u.id === S.unit ? "sel" : ""}"><td>${r.u.name}</td><td>${r.u.region.replace("1", "")}</td><td>${fmt(r.u.cap)}</td><td>${pc(r.cf)}</td><td>${money(r.merch, 1)}</td><td>${money(r.net_a, 1)}</td><td>${money(r.net_b, 1)}</td><td>${money(r.net_c, 1)}</td><td>${pcs(r.red_a)}</td><td>${pcs(r.red_b)}</td><td>${pcs(r.red_c)}</td><td>${r.n}</td></tr>`).join("")}</tbody></table>`;
  $("fl3").querySelectorAll("th").forEach(th => th.onclick = () => { const c = th.dataset.k; S.fsort = { k: c, d: S.fsort.k === c ? -S.fsort.d : (c === "name" || c === "region" ? 1 : -1) }; renderFleet(); });
  $("fl3").querySelectorAll("tbody tr").forEach(tr => tr.onclick = () => { selectUnit(tr.dataset.id, false); document.querySelector('[data-tab="farm"]').click(); });
  window.__fleet = rows;
}
function boxRows(el, groups, f, w, unit) {
  const L = 170, Rr = 60, rh = 34, T = 24, h = T + groups.length * rh + 6;
  const all = groups.flatMap(g => g[1]).filter(isFinite); if (!all.length) { el.innerHTML = `<p class="note">No assets with data in this period.</p>`; return; }
  const sorted = all.slice().sort((a, b) => a - b), lo0 = quant(sorted, 0.01), hi0 = quant(sorted, 0.99);
  const ticks = niceTicks(Math.min(lo0, 0), hi0, 5), a = ticks[0], b = ticks.at(-1), X = v => L + (Math.max(a, Math.min(b, v)) - a) / (b - a) * (w - L - Rr);
  let g = "";
  ticks.forEach(t => g += `<line x1="${X(t)}" x2="${X(t)}" y1="${T - 6}" y2="${h - 6}" stroke="var(--rule-2)"/><text x="${X(t)}" y="${T - 10}" text-anchor="middle" font-size="11" class="num" fill="var(--ink-3)">${f(t)}</text>`);
  const col = { m: "var(--ink-3)", a: "var(--s1)", b: "var(--s2)", c: "var(--s7)" };
  groups.forEach(([name, vals, c], i) => {
    const s = vals.filter(isFinite).sort((x, y) => x - y), y = T + i * rh + rh / 2;
    if (!s.length) return;
    const q = [0.1, 0.25, 0.5, 0.75, 0.9].map(p => quant(s, p));
    g += `<g data-i="${i}"><rect x="0" y="${y - rh / 2}" width="${w}" height="${rh}" fill="transparent"/><text x="${L - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="var(--ink-2)">${name}</text>
      <line x1="${X(q[0])}" x2="${X(q[4])}" y1="${y}" y2="${y}" stroke="${col[c]}" stroke-width="1.25"/>
      <rect x="${X(q[1])}" y="${y - 7}" width="${Math.max(1, X(q[3]) - X(q[1]))}" height="14" rx="3" fill="${col[c]}" fill-opacity=".22" stroke="${col[c]}"/>
      <line x1="${X(q[2])}" x2="${X(q[2])}" y1="${y - 8}" y2="${y + 8}" stroke="${col[c]}" stroke-width="2.5"/>
      <text x="${w - Rr + 8}" y="${y + 4}" font-size="11" class="num" fill="var(--ink-2)">${f(q[2])}</text></g>`;
  });
  el.innerHTML = svgEl(w, h, g, "Distribution across assets");
  el.querySelectorAll("g[data-i]").forEach(n => {
    const [name, vals] = groups[+n.dataset.i], s = vals.filter(isFinite).sort((x, y) => x - y);
    n.onmousemove = ev => showTip(`<b>${name}</b><div class="num">median ${f(quant(s, 0.5))}</div><div class="num">P10 ${f(quant(s, 0.1))} · P90 ${f(quant(s, 0.9))}</div><div class="num">${s.length} assets</div>`, ev);
    n.onmouseleave = hideTip;
  });
}
if (window.uPlot) boot(); else $("dsinfo").innerHTML = `<span class="err">Chart library failed to load.</span>`;
