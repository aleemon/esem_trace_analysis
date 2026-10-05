"use strict";
// ---------- utilities ----------
const $ = id => document.getElementById(id);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const DATA = "data/";
// Set true only for hosts that refuse binary files (e.g. claude.ai artifacts); GitHub Pages serves .bin as-is.
const B64 = false;
const H = 300 / 3600;
const REF_SUN = Date.UTC(2016, 11, 25) / 1000, NEM_OFF = 36000, WEEK = 604800;
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
const dsd = a => { if (a.length < 2) return NaN; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + Math.min(0, y - m) ** 2, 0) / a.length); };   // downside semi-deviation about the mean
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
const S = { tab: "farm", unit: null, y0: 0, y1: 0, units: "cf", showug: false, avg: "m",
  k: 75, q: 100, cap: 600, floor: 0, tr: { a: "so", b: "ug", c: "so" }, risk: "p10",
  ftech: "wind", freg: "", fk: 75, fr: 100, fpair: "dflt", fsort: { k: "net_b", d: -1 } };
let META, SETTLE, UNIT = new Map();
const LAST = {};   // latest data behind each chart/table, for downloads
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
    wire(); addDownloads(); render();
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
  $("av-w").onclick = () => { S.avg = "w"; setPressed("av-w", "av-m", true); drawAverages(); };
  $("av-m").onclick = () => { S.avg = "m"; setPressed("av-w", "av-m", false); drawAverages(); };
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
  document.querySelectorAll("[data-risk]").forEach(b => b.onclick = () => { S.risk = b.dataset.risk; renderSettle(); });
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
    <span style="display:inline-flex;gap:4px;align-items:center">Reference basket ${yrs} <a href="${DATA}baskets.csv" download style="margin-left:6px;font-size:.9em">basket list (CSV)</a></span>`;
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
    axes: [{ stroke: ax, font: '13px "IBM Plex Mono", monospace', grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, values: xvals, size: 44 }, { stroke: ax, font: '13px "IBM Plex Mono", monospace', grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 72 }],
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
  ], 300, Object.assign({ bands: [{ series: [2, 3], fill: css("--band") }] }, prange ? { scales: { x: { time: true }, y: { range: prange } } } : {})), d.d1, $("p1")));
  const vf = v => v == null ? "–" : cf ? fmt(v, 3) : fmt(v, 1) + " MW";
  plots.push(new uPlot(plotOpts([
    { label: `${u.name} sent-out`, stroke: css("--s3"), width: 1.5, value: (x, v) => vf(v) },
    { label: "Reference, sent-out", stroke: css("--s1"), width: 1.5, value: (x, v) => vf(v) },
    { label: "Reference, UIGF on negative", stroke: css("--s2"), width: 1.25, dash: [5, 4], value: (x, v) => vf(v) },
    { label: `${u.name} UIGF`, stroke: css("--ink-3"), width: 1, value: (x, v) => vf(v), show: S.showug }
  ], 420, cf ? { scales: { x: { time: true }, y: { range: [0, 1.05] } } } : {}), d.d2, $("p2")));
  if (keep && keep.min != null && keep.min >= E.x0 - 1 && keep.max <= E.x1 + 1 && (keep.max - keep.min) < (E.x1 - E.x0) * 0.999) refreshLod(keep.min, keep.max);
  drawAverages();
}
// period averages: farm CF vs both reference traces, over intervals where the farm and the trace both have data
const fMonth = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" });
function drawAverages() {
  const E = EX; if (!E) return;
  const u = E.u, cf = S.units === "cf", k = cf ? 1 : u.cap, byWeek = S.avg === "w";
  const groups = new Map();
  let curKey = null, curG = null, monthEnd = -Infinity;
  for (let i = 0; i < E.N; i++) {
    const t = E.T0 + i * E.dt;
    let key;
    if (byWeek) key = SETTLE.weeks[wkOf(t)] || "";
    else { if (t > monthEnd || curKey === null) { const d = fMonth.format(new Date((t - 300) * 1e3)); key = d + "-01"; } else key = curKey; }
    if (key !== curKey) {
      curKey = key; curG = groups.get(key);
      if (!curG) { curG = { f: 0, so: 0, ug: 0, n: 0 }; groups.set(key, curG); }
      if (!byWeek) { const [yy, mm] = key.split("-").map(Number); monthEnd = Date.UTC(yy, mm, 1) / 1000 - NEM_OFF; }
    }
    const g = E.so[i], a = E.tso[i], b = E.tug[i];
    if (g === g && a === a && b === b) { curG.f += Math.max(g, 0) / u.cap; curG.so += a; curG.ug += b; curG.n++; }
  }
  const keys = [...groups.keys()].filter(x => x && groups.get(x).n > 0).sort();
  const val = f => keys.map(x => { const g = groups.get(x); return g.n >= (byWeek ? 0.5 * 2016 : 0.5 * 8640) ? g[f] / g.n * k : null; });
  const farm = val("f"), so = val("so"), ug = val("ug");
  LAST.avg = { keys, farm, so, ug, byWeek, cf, u };
  let ef = 0, es = 0; farm.forEach((v, i) => { if (v != null) { ef += v; es += so[i]; } });
  $("p3t").textContent = `${byWeek ? "Weekly" : "Monthly"} average output vs reference trace`;
  $("p3s").textContent = `${cf ? "Mean capacity factor" : "Mean MW (traces scaled to " + fmt(u.cap, 1) + " MW)"} per ${byWeek ? "billing week (Sun–Sat)" : "calendar month"}, over intervals where the farm and both traces have data · farm ÷ reference (sent-out) over the period: ${fmt(es ? ef / es * 100 : NaN, 1)}% · periods with less than half their intervals are left out`;
  const W = Math.max(320, $("p3").clientWidth || 1200);
  const yf = v => v == null ? "–" : cf ? fmt(v * 100, 1) + "%" : fmt(v, 1) + " MW";
  lineChart($("p3"), { xs: keys, series: [
      { name: u.name.length > 16 ? u.name.slice(0, 15) + "…" : u.name, color: css("--s3"), vals: farm, width: 2.25 },
      { name: "Ref, sent-out", color: css("--s1"), vals: so, width: 2 },
      { name: "Ref, UIGF on neg", color: css("--s2"), vals: ug, width: 1.75, dash: "5 4" }],
    yfmt: yf, w: W, h: 340, title: "Average output vs reference trace",
    xlab: i => byWeek ? `Week from ${keys[i]}` : `${MONTHS[+keys[i].slice(5, 7) - 1]} ${keys[i].slice(0, 4)}` });
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
const mean = a => a.length ? sum(a) / a.length : NaN;
// low-tail measure for earnings-at-risk (EaR = mean − tail); s is sorted ascending
const cvar = (s, q = 0.1) => { const n = s.length, m = q * n; if (!n) return NaN; if (m <= 1) return s[0]; let t = 0, i = 0; for (; i + 1 <= m; i++) t += s[i]; return (t + (m - i) * (s[i] ?? 0)) / m; };   // mean of the worst 10% of weeks, fractional at the boundary
const Z10 = 1.2815516;
const RISK = {
  p10: { label: "P10", col: "P10 week", tail: s => quant(s, 0.1), desc: "EaR = mean week − P10 week (the week 10% of weeks fall below)" },
  cvar: { label: "CVaR 10%", col: "CVaR 10%", tail: s => cvar(s, 0.1), desc: "EaR = mean week − CVaR 10% (average of the worst 10% of weeks)" },
  param: { label: "Parametric", col: "μ − 1.28σ", tail: s => mean(s) - Z10 * sd(s), desc: "EaR = 1.28 × weekly SD (normal approximation of the 10th percentile)" } };
const riskTail = s => RISK[S.risk].tail(s);
function lineChart(el, { xs, series, yfmt, w = 600, h = 240, title, xlab }) {
  const L = 76, Rr = 136, T = 12, B = 30, ph = h - T - B;
  series.forEach(s => { s.vals = Array.from(s.vals); });
  const all = series.flatMap(s => s.vals).filter(v => v != null && isFinite(v));
  let lo = Math.min(0, ...all), hi = Math.max(...all); const pad = (hi - lo) * 0.06 || 1; hi += pad; if (lo < 0) lo -= pad;
  const ticks = niceTicks(lo, hi, 5); lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks.at(-1));
  const n = xs.length, X = i => L + (n <= 1 ? 0 : i * (w - L - Rr) / (n - 1)), Y = v => T + ph - (v - lo) / (hi - lo) * ph;
  let g = "";
  ticks.forEach(t => g += `<line x1="${L}" x2="${w - Rr}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--rule-2)"/><text x="${L - 8}" y="${Y(t) + 4}" text-anchor="end" font-size="12.5" class="num" fill="var(--ink-3)">${yfmt(t)}</text>`);
  if (lo < 0) g += `<line x1="${L}" x2="${w - Rr}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--ink-3)"/>`;
  // label each year at its first week that starts in January, at least 36 px after the previous label
  let lastX = -1e9, lastY = "";
  const mid = d => new Date(Date.parse(d) + 3 * 864e5).toISOString().slice(0, 10);   // a week belongs to the year of its Wednesday
  xs.forEach((d0, i) => { const d = mid(d0), y = d.slice(0, 4); if (y !== lastY && (d.slice(5, 7) === "01" || i === 0)) { lastY = y; if (X(i) - lastX >= 36) { g += `<text x="${X(i)}" y="${h - 8}" font-size="12.5" fill="var(--ink-3)">${y}</text><line x1="${X(i)}" x2="${X(i)}" y1="${T + ph}" y2="${T + ph + 4}" stroke="var(--rule)"/>`; lastX = X(i); } } });
  if (n > 0 && n <= 60) { const mi = []; xs.forEach((d, i) => { if (mid(d).slice(8, 10) <= "07" && i > 0) mi.push(i); }); mi.forEach(i => { if (X(i) - lastX >= 30) { g += `<text x="${X(i)}" y="${h - 8}" font-size="12.5" fill="var(--ink-3)">${MONTHS[+mid(xs[i]).slice(5, 7) - 1]}</text>`; lastX = X(i); } }); }
  const ends = [];
  series.forEach(s => {
    let dd = "", pen = false; s.vals.forEach((v, i) => { if (v == null || !isFinite(v)) { pen = false; return; } dd += (pen ? "L" : "M") + X(i).toFixed(1) + "," + Y(v).toFixed(1); pen = true; });
    g += `<path d="${dd}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} stroke-linejoin="round"/>`;
    let li = s.vals.length - 1; while (li > 0 && (s.vals[li] == null || !isFinite(s.vals[li]))) li--;
    ends.push({ y: Y(s.vals[li]), name: s.name, color: s.color });
  });
  ends.sort((a, b) => a.y - b.y); for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 16) ends[i].y = ends[i - 1].y + 16;
  ends.forEach(e => g += `<circle cx="${w - Rr + 10}" cy="${e.y - 4}" r="4" fill="${e.color}"/><text x="${w - Rr + 18}" y="${e.y}" font-size="13" fill="var(--ink-2)">${e.name}</text>`);
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
  const L = 300, Rr = 96, rh = 32, T = 8, h = T + rows.length * rh + 10;
  const vals = rows.map(r => r.v), lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const X = v => L + (v - lo) / ((hi - lo) || 1) * (w - L - Rr);
  let g = `<line x1="${X(0)}" x2="${X(0)}" y1="${T - 2}" y2="${h - 6}" stroke="var(--ink-3)"/>`;
  rows.forEach((r, i) => {
    const y = T + i * rh, c = r.kind === "total" ? "var(--ink-3)" : r.v >= 0 ? "var(--pos)" : "var(--neg)";
    g += `<text x="${L - 12}" y="${y + 21}" text-anchor="end" font-size="13.5" fill="var(--ink${r.kind === "total" ? "" : "-2"})" font-weight="${r.kind === "total" ? 600 : 400}">${r.label}</text>
      <rect x="${Math.min(X(0), X(r.v))}" y="${y + 6}" width="${Math.max(1, Math.abs(X(r.v) - X(0)))}" height="19" rx="3" fill="${c}" fill-opacity="${r.kind === "total" ? 0.45 : 0.85}"/>
      <text x="${Math.max(X(0), X(r.v)) + 8}" y="${y + 20}" font-size="13" class="num" fill="var(--ink-2)">${money(r.v / 1e6, 2)}M</text>`;
  });
  el.innerHTML = svgEl(w, h, g, "Settlement attribution");
}
async function renderSettle() {
  const tok = ++exToken;
  let E; try { E = await loadUnit(); } catch (e) { $("stkpi").innerHTML = `<span class="err">${e.message}</span>`; return; }
  if (tok !== exToken) return; EX = E;
  const u = E.u;
  $("bdesc").textContent = `Floating limited to ${money(S.floor, 0)} – ${money(S.cap, 0)}`;
  $("cdesc").textContent = `Floating capped at ${money(S.cap, 0)}; quantity 0 when price < $0`;
  const R = settle(E, S);
  const full = []; for (let w = 0; w < R.nW; w++) if (R.nint[w] >= 0.9 * 2016 && R.ok[w] >= 0.9 * 2016) full.push(w);
  const M = sum(R.merch), EG = sum(R.energy), MR = sum(R.merchRaw);
  const row = key => {
    const s = R["s_" + key], net = s.map((v, w) => v + R.merch[w]);
    const nf = full.map(w => net[w]).sort((a, b) => a - b);
    const ww = full.reduce((b, w) => net[w] < net[b] ? w : b, full[0]);
    return { key, ap: key[0], tr: key.slice(2), S: sum(s), V: sum(R["v_" + key]), net: sum(net), sd: sd(nf), dsd: dsd(nf), p10: quant(nf, 0.1), tail: riskTail(nf), mean: mean(nf), worst: nf[0], worstWk: ww, weekly: net, s };
  };
  const rows = KEYS.map(row);
  const sel = { a: rows.find(r => r.key === "a_" + S.tr.a), b: rows.find(r => r.key === "b_" + S.tr.b), c: rows.find(r => r.key === "c_" + S.tr.c) };
  const mf = full.map(w => R.merch[w]).sort((a, b) => a - b), msd = sd(mf), mdsd = dsd(mf), mww = full.reduce((b, w) => R.merch[w] < R.merch[b] ? w : b, full[0]);
  const wkDate = w => w == null ? "" : `week from ${SETTLE.weeks[R.w0 + w]}`;
  $("stkpi").innerHTML = [
    ["Farm output", fmt(EG / 1000, 1) + " GWh", `${fmt(EG / (u.cap * R.nint.reduce((a, b) => a + b, 0) * H) * 100, 1)}% CF`],
    ["Merchant", money(M / 1e6, 2) + "M", `${money(M / EG, 1)}/MWh · floored at $0`],
    ...["a", "b", "c"].map(a => [AP[a], money(sel[a].net / 1e6, 2) + "M", `${money(sel[a].net / EG, 1)}/MWh · settlement ${money(sel[a].S / 1e6, 2)}M`])
  ].map(([a, v, s]) => `<div class="kpi"><span>${a}</span><b>${v}</b><small>${s}</small></div>`).join("");
  // comparison table
  $("cmps").textContent = `${u.name}, ${S.y0 === S.y1 ? S.y0 : S.y0 + "–" + S.y1} · K ${money(S.k, 2)}/MWh · Q ${fmt(S.q)} MW · weekly statistics over ${full.length} complete weeks (hover a worst-week value for its date) · ${RISK[S.risk].desc} · highlighted rows are the selected trace per approach`;
  const tr = (cls, cells) => `<tr class="${cls}">${cells.join("")}</tr>`;
  const td = (v, d = 2, isMoney = true) => `<td class="${v < 0 ? "neg" : ""}">${isMoney ? money(v / 1e6, d) : fmt(v, d)}</td>`;
  let h = `<table><thead><tr><th>Approach</th><th>Trace</th><th>Contract GWh</th><th>Settlement $M</th><th>Net revenue $M</th><th>Net $/MWh</th><th>vs merchant $/MWh</th><th>Weekly SD $k</th><th>Downside SD $k</th><th>Mean week $k</th><th>${RISK[S.risk].col} $k</th><th title="${RISK[S.risk].desc}">EaR $k</th><th>Worst week $k</th></tr></thead><tbody>`;
  h += tr("", [`<td class="l"><span class="tag m">M</span>Merchant only</td>`, `<td class="l">–</td>`, `<td>–</td>`, `<td>–</td>`, td(M), `<td>${money(M / EG, 1)}</td>`, `<td>–</td>`, `<td>${fmt(msd / 1000, 0)}</td>`, `<td>${fmt(mdsd / 1000, 0)}</td>`, `<td>${money(mean(mf) / 1000, 0)}</td>`, `<td>${money(riskTail(mf) / 1000, 0)}</td>`, `<td>${fmt((mean(mf) - riskTail(mf)) / 1000, 0)}</td>`, `<td title="${wkDate(mww)}">${money(mf[0] / 1000, 0)}</td>`]);
  for (const r of rows) {
    const d = sel[r.ap].key === r.key ? "dflt" : "";
    h += tr(d, [`<td class="l"><span class="tag ${r.ap}">${r.ap.toUpperCase()}</span>${AP[r.ap].slice(4)}</td>`, `<td class="l">${TRN[r.tr]}</td>`, `<td>${fmt(r.V / 1000, 1)}</td>`, td(r.S), td(r.net),
      `<td>${money(r.net / EG, 1)}</td>`, `<td class="${(r.net - M) < 0 ? "neg" : ""}">${money((r.net - M) / EG, 1)}</td>`, `<td>${fmt(r.sd / 1000, 0)}</td>`, `<td>${fmt(r.dsd / 1000, 0)}</td>`, `<td>${money(r.mean / 1000, 0)}</td>`, `<td>${money(r.tail / 1000, 0)}</td>`, `<td>${fmt((r.mean - r.tail) / 1000, 0)}</td>`, `<td title="${wkDate(r.worstWk)}">${money(r.worst / 1000, 0)}</td>`]);
  }
  $("cmp").innerHTML = h + `</tbody></table>`;
  // cumulative + weekly
  const W = Math.max(320, $("st1").clientWidth || 700);
  const wk = Array.from({ length: R.nW }, (_, w) => SETTLE.weeks[R.w0 + w] || "");
  const cum = a => { let c = 0; return a.map(v => (c += v) / 1e6); };
  const lines = [{ name: "Merchant", color: css("--ink-3"), vals: cum(Array.from(R.merch)), dash: "4 3", width: 1.5 },
    ...["a", "b", "c"].map((a, i) => ({ name: `${a.toUpperCase()} · ${S.tr[a] === "so" ? "SO" : "UIGF"}`, color: css(["--s1", "--s2", "--s7"][i]), vals: cum(sel[a].weekly) }))];
  lineChart($("st1"), { xs: wk, series: lines, yfmt: v => v == null ? "–" : money(v, 1) + "M", w: W, h: 340, title: "Cumulative net revenue", xlab: i => `Week from ${wk[i]}` });
  const W3 = Math.max(320, $("st3").clientWidth || 1200);
  const inFull = new Set(full), keepW = (v, w) => inFull.has(w) ? v / 1000 : null;
  const wkSeries = [{ key: "m", name: "Merchant", color: css("--ink-3"), vals: Array.from(R.merch, keepW), dash: "4 3", width: 1.5 },
    ...["a", "b", "c"].map((a, i) => ({ key: a, name: `${a.toUpperCase()} · ${S.tr[a] === "so" ? "SO" : "UIGF"}`, color: css(["--s1", "--s2", "--s7"][i]), vals: Array.from(sel[a].weekly, keepW), width: 1.5 }))];
  const drawWeekly = () => {
    lineChart($("st3"), { xs: wk, series: wkSeries.filter(x => !hidden("st3").has(x.key)), yfmt: v => v == null ? "–" : money(v, 0) + "k", w: W3, h: 380, title: "Weekly net revenue", xlab: i => `Week from ${wk[i]}` });
    legend($("st3"), "st3", wkSeries.map(x => ({ key: x.key, name: x.key === "m" ? "Merchant only" : `${AP[x.key]} (${TRS[S.tr[x.key]]})`, color: x.color, dash: !!x.dash })), drawWeekly);
  };
  drawWeekly();
  // distribution of weekly net revenue, complete weeks only
  const fw = a => full.map(w => a[w] / 1000);
  boxRows($("st4"), [["Merchant only", fw(R.merch), "m"],
    ...["a", "b", "c"].map(a => [`${AP[a]} (${TRS[S.tr[a]]})`, fw(sel[a].weekly), a])], v => money(v, 0) + "k", Math.max(320, $("st4").clientWidth || 1200), "$k", { extremes: true, noun: "weeks", labelW: 290 });
  $("st4s").textContent = `Weekly net revenue (merchant + settlement), $k · ${full.length} complete weeks · box = P25–P75, line = median, whisker = P10–P90, circles = worst and best week · selected trace per approach`;
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
  bridge($("st2"), bridgeRows, Math.max(320, $("st2").clientWidth || 700));
  // mean vs earnings-at-risk across contract volume: settlement is linear in Q, so scale a 1 MW settlement
  const R1 = S.q > 0 ? null : settle(E, { ...S, q: 1 });
  const perMW = a => { const r = sel[a]; return R1 ? R1["s_" + r.key] : r.s.map(v => v / S.q); };
  const PCTS = Array.from({ length: 21 }, (_, i) => i * 10);
  const stat = arr => { const s = arr.slice().sort((x, y) => x - y), m = mean(s), t = riskTail(s); return { mean: m, p10: t, ear: m - t }; };
  const sweep = ["a", "b", "c"].map(a => { const pm = perMW(a); return { a, tr: S.tr[a], pts: PCTS.map(pct => { const q = pct / 100 * u.cap; return { pct, q, ...stat(full.map(w => R.merch[w] + q * pm[w])) }; }), cur: { pct: S.q / u.cap * 100, q: S.q, ...stat(full.map(w => R.merch[w] + S.q * pm[w])) } }; });
  $("st5s").textContent = `Mean weekly net revenue vs earnings-at-risk, $k/week · ${RISK[S.risk].desc} · ${full.length} complete weeks · contract volume 0–200% of ${fmt(u.cap, 0)} MW in 10% steps (0% = merchant) · K ${money(S.k, 2)}/MWh, cap ${money(S.cap, 0)}, floor ${money(S.floor, 0)} · selected trace per approach · filled marker = current Q`;
  document.querySelectorAll("[data-risk]").forEach(b => b.setAttribute("aria-pressed", b.dataset.risk === S.risk));
  const W5 = Math.max(320, $("st5").clientWidth || 1200), earCol = { a: css("--s1"), b: css("--s2"), c: css("--s7") };
  const drawEar = () => {
    earChart($("st5"), sweep.filter(x => !hidden("st5").has(x.a)), W5);
    legend($("st5"), "st5", sweep.map(x => ({ key: x.a, name: `${AP[x.a]} (${TRS[x.tr]})`, color: earCol[x.a] })), drawEar);
  };
  drawEar();
  LAST.settle = { R, rows, full, bridgeRows, sweep, u, M, EG, p: { k: S.k, q: S.q, cap: S.cap, floor: S.floor, tr: { ...S.tr }, risk: S.risk } };
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
    const msd = dsd(mw);
    rows.push({ u, n: mw.length, EG, cf: EG / (u.cap * mw.length * 168), merch: MG / EG,
      net_a: (MG + tot.a) / EG, net_b: (MG + tot.b) / EG, net_c: (MG + tot.c) / EG,
      red_a: dsd(nets.a) / msd - 1, red_b: dsd(nets.b) / msd - 1, red_c: dsd(nets.c) / msd - 1 });
  }
  const per = S.y0 === S.y1 ? S.y0 : `${S.y0}–${S.y1}`;
  $("fl1s").textContent = `${rows.length} ${S.ftech} assets${S.freg ? " in " + S.freg : ""}, ${per} · $/MWh of each asset's own output · K ${money(S.fk, 0)} · contract ${fmt(S.fr)}% of capacity`;
  const W1 = Math.max(320, $("fl1").clientWidth || 700);
  boxRows($("fl1"), [["Merchant", rows.map(r => r.merch), "m"], [AP.a, rows.map(r => r.net_a), "a"], [AP.b, rows.map(r => r.net_b), "b"], [AP.c, rows.map(r => r.net_c), "c"]], v => money(v, 0), W1, "$/MWh");
  boxRows($("fl2"), [[AP.a, rows.map(r => r.red_a * 100), "a"], [AP.b, rows.map(r => r.red_b * 100), "b"], [AP.c, rows.map(r => r.red_c * 100), "c"]], v => (v > 0 ? "+" : "") + fmt(v, 0) + "%", W1, "%");
  const cols = [["name", "Asset"], ["region", "Region"], ["cap", "MW"], ["cf", "CF"], ["merch", "Merchant $/MWh"], ["net_a", "A net $/MWh"], ["net_b", "B net $/MWh"], ["net_c", "C net $/MWh"], ["red_a", "A downside SD vs merchant"], ["red_b", "B downside SD vs merchant"], ["red_c", "C downside SD vs merchant"], ["n", "Weeks"]];
  const val = (r, k) => k === "name" ? r.u.name : k === "region" ? r.u.region : k === "cap" ? r.u.cap : r[k];
  const { k, d } = S.fsort;
  rows.sort((a, b) => { const x = val(a, k), y = val(b, k); return (typeof x === "string" ? x.localeCompare(y) : x - y) * d; });
  const pc = v => `${fmt(v * 100, 0)}%`, pcs = v => `${v > 0 ? "+" : ""}${fmt(v * 100, 0)}%`;
  $("fl3").innerHTML = `<table><thead><tr>${cols.map(([c, l]) => `<th data-k="${c}">${l}${c === k ? (d > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>${rows.map(r =>
    `<tr data-id="${r.u.id}" class="${r.u.id === S.unit ? "sel" : ""}"><td>${r.u.name}</td><td>${r.u.region.replace("1", "")}</td><td>${fmt(r.u.cap)}</td><td>${pc(r.cf)}</td><td>${money(r.merch, 1)}</td><td>${money(r.net_a, 1)}</td><td>${money(r.net_b, 1)}</td><td>${money(r.net_c, 1)}</td><td>${pcs(r.red_a)}</td><td>${pcs(r.red_b)}</td><td>${pcs(r.red_c)}</td><td>${r.n}</td></tr>`).join("")}</tbody></table>`;
  $("fl3").querySelectorAll("th").forEach(th => th.onclick = () => { const c = th.dataset.k; S.fsort = { k: c, d: S.fsort.k === c ? -S.fsort.d : (c === "name" || c === "region" ? 1 : -1) }; renderFleet(); });
  $("fl3").querySelectorAll("tbody tr").forEach(tr => tr.onclick = () => { selectUnit(tr.dataset.id, false); document.querySelector('[data-tab="farm"]').click(); });
  LAST.fleet = { rows, p: { k: S.fk, r: S.fr, pair: S.fpair, tech: S.ftech, reg: S.freg } };
  window.__fleet = rows;
}
// clickable legend under a chart: toggles series on and off (at least one stays on); state survives redraws
const HIDDEN = {};
const hidden = id => HIDDEN[id] || (HIDDEN[id] = new Set());
function legend(el, id, items, redraw) {
  const H = hidden(id), box = document.createElement("div"); box.className = "lgd";
  box.innerHTML = items.map(it => `<button type="button" data-k="${it.key}" aria-pressed="${!H.has(it.key)}" title="Show or hide this series"><i style="${it.dash ? `background:none;border-top:2px dashed ${it.color};height:0` : `background:${it.color}`}"></i>${it.name}</button>`).join("");
  box.onclick = e => { const b = e.target.closest("button"); if (!b) return; const k = b.dataset.k;
    if (H.has(k)) H.delete(k); else if (items.filter(it => !H.has(it.key)).length > 1) H.add(k); else return;
    redraw(); };
  el.appendChild(box);
}
function earChart(el, sweep, w) {
  const h = 460, L = 78, Rr = 150, T = 18, B = 52, col = { a: "var(--s1)", b: "var(--s2)", c: "var(--s7)" };
  const pts = sweep.flatMap(s => s.pts.concat([s.cur])).filter(p => isFinite(p.mean) && isFinite(p.ear));
  if (!pts.length) { el.innerHTML = `<p class="note">No complete weeks in this period.</p>`; return; }
  const k = v => v / 1000, xs = pts.map(p => k(p.ear)), ys = pts.map(p => k(p.mean));
  const pad = (lo, hi) => { const d = (hi - lo) || Math.abs(hi) || 1; return [lo - d * 0.06, hi + d * 0.06]; };
  const [x0, x1] = pad(Math.min(...xs), Math.max(...xs)), [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  const xt = niceTicks(x0, x1, 7), yt = niceTicks(y0, y1, 6);
  const xa = Math.min(xt[0], x0), xb = Math.max(xt.at(-1), x1), ya = Math.min(yt[0], y0), yb = Math.max(yt.at(-1), y1);
  const X = v => L + (v - xa) / (xb - xa) * (w - L - Rr), Y = v => T + (yb - v) / (yb - ya) * (h - T - B);
  let g = "";
  xt.forEach(t => g += `<line x1="${X(t)}" x2="${X(t)}" y1="${T}" y2="${h - B}" stroke="var(--rule-2)"/><text x="${X(t)}" y="${h - B + 18}" text-anchor="middle" font-size="12.5" class="num" fill="var(--ink-3)">${money(t, 0)}k</text>`);
  yt.forEach(t => g += `<line x1="${L}" x2="${w - Rr}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--rule-2)"/><text x="${L - 8}" y="${Y(t) + 4}" text-anchor="end" font-size="12.5" class="num" fill="var(--ink-3)">${money(t, 0)}k</text>`);
  g += `<text x="${(L + w - Rr) / 2}" y="${h - 10}" text-anchor="middle" font-size="13" fill="var(--ink-2)">Earnings-at-risk (${RISK[S.risk].label}), $k/week →  (lower risk to the left)</text>`;
  g += `<text transform="translate(16 ${(T + h - B) / 2}) rotate(-90)" text-anchor="middle" font-size="13" fill="var(--ink-2)">Mean weekly net revenue, $k/week</text>`;
  const hit = [];
  sweep.forEach(s => {
    const P = s.pts.filter(p => isFinite(p.mean) && isFinite(p.ear));
    g += `<polyline fill="none" stroke="${col[s.a]}" stroke-width="2" points="${P.map(p => `${X(k(p.ear))},${Y(k(p.mean))}`).join(" ")}"/>`;
    P.forEach(p => { const big = p.pct % 50 === 0; g += `<circle cx="${X(k(p.ear))}" cy="${Y(k(p.mean))}" r="${big ? 4 : 2.75}" fill="var(--surface)" stroke="${col[s.a]}" stroke-width="1.5"/>`; hit.push([s, p]);
      if (big && p.pct > 0) { const [dx, dy, an] = { a: [8, 16, "start"], b: [-8, -8, "end"], c: [8, -8, "start"] }[s.a]; g += `<text x="${X(k(p.ear)) + dx}" y="${Y(k(p.mean)) + dy}" text-anchor="${an}" font-size="11.5" class="num" fill="${col[s.a]}">${p.pct}%</text>`; } });
    if (isFinite(s.cur.mean)) { g += `<circle cx="${X(k(s.cur.ear))}" cy="${Y(k(s.cur.mean))}" r="6" fill="${col[s.a]}" stroke="var(--surface)" stroke-width="1.5"/>`; hit.push([s, s.cur, true]); }
    const e = P.at(-1); if (e) g += `<text x="${X(k(e.ear)) + 10}" y="${Y(k(e.mean)) + (s.a === "a" ? 34 : 16)}" font-size="12.5" font-weight="600" fill="${col[s.a]}">${s.a.toUpperCase()} · ${TRS[s.tr]}</text>`;
  });
  const m0 = sweep[0] && sweep[0].pts[0]; if (m0 && isFinite(m0.mean)) g += `<text x="${X(k(m0.ear))}" y="${Y(k(m0.mean)) + 22}" text-anchor="middle" font-size="12" fill="var(--ink-3)">0% = merchant</text>`;
  hit.forEach(([s, p, cur], i) => g += `<circle data-i="${i}" cx="${X(k(p.ear))}" cy="${Y(k(p.mean))}" r="9" fill="transparent"/>`);
  el.innerHTML = svgEl(w, h, g, "Mean weekly net revenue against earnings-at-risk by contract volume");
  el.querySelectorAll("circle[data-i]").forEach(n => { const [s, p, cur] = hit[+n.dataset.i];
    n.onmousemove = ev => showTip(`<b>${AP[s.a]} (${TRS[s.tr]})${cur ? " · current Q" : ""}</b><div class="num">Volume ${fmt(p.pct, 0)}% · ${fmt(p.q, 1)} MW</div><div class="num">Mean ${money(p.mean / 1000, 1)}k/week</div><div class="num">${RISK[S.risk].col} ${money(p.p10 / 1000, 1)}k · EaR ${money(p.ear / 1000, 1)}k</div>`, ev);
    n.onmouseleave = hideTip; });
}
function boxRows(el, groups, f, w, unit, opt = {}) {   // opt: { extremes: draw min/max and scale to them, noun: "assets" | "weeks" }
  const L = opt.labelW || 210, Rr = opt.extremes ? 110 : 76, rh = 42, T = 28, h = T + groups.length * rh + 8;
  const all = groups.flatMap(g => g[1]).filter(isFinite); if (!all.length) { el.innerHTML = `<p class="note">No assets with data in this period.</p>`; return; }
  const sorted = all.slice().sort((a, b) => a - b), lo0 = opt.extremes ? sorted[0] : quant(sorted, 0.01), hi0 = opt.extremes ? sorted.at(-1) : quant(sorted, 0.99);
  const ticks = niceTicks(Math.min(lo0, 0), Math.max(hi0, 0), 6), a = Math.min(ticks[0], lo0), b = Math.max(ticks.at(-1), hi0, a + 1e-9), X = v => L + (Math.max(a, Math.min(b, v)) - a) / (b - a) * (w - L - Rr);
  let g = "";
  ticks.forEach(t => g += `<line x1="${X(t)}" x2="${X(t)}" y1="${T - 6}" y2="${h - 6}" stroke="var(--rule-2)"/><text x="${X(t)}" y="${T - 10}" text-anchor="middle" font-size="12.5" class="num" fill="var(--ink-3)">${f(t)}</text>`);
  const col = { m: "var(--ink-3)", a: "var(--s1)", b: "var(--s2)", c: "var(--s7)" };
  groups.forEach(([name, vals, c], i) => {
    const s = vals.filter(isFinite).sort((x, y) => x - y), y = T + i * rh + rh / 2;
    if (!s.length) return;
    const q = [0.1, 0.25, 0.5, 0.75, 0.9].map(p => quant(s, p));
    g += `<g data-i="${i}"><rect x="0" y="${y - rh / 2}" width="${w}" height="${rh}" fill="transparent"/><text x="${L - 10}" y="${y + 4}" text-anchor="end" font-size="13.5" fill="var(--ink-2)">${name}</text>
      <line x1="${X(q[0])}" x2="${X(q[4])}" y1="${y}" y2="${y}" stroke="${col[c]}" stroke-width="1.25"/>
      <rect x="${X(q[1])}" y="${y - 7}" width="${Math.max(1, X(q[3]) - X(q[1]))}" height="14" rx="3" fill="${col[c]}" fill-opacity=".22" stroke="${col[c]}"/>
      <line x1="${X(q[2])}" x2="${X(q[2])}" y1="${y - 8}" y2="${y + 8}" stroke="${col[c]}" stroke-width="2.5"/>
      ${opt.extremes ? `<circle cx="${X(s[0])}" cy="${y}" r="3.5" fill="var(--surface)" stroke="${col[c]}" stroke-width="1.5"/><circle cx="${X(s.at(-1))}" cy="${y}" r="3.5" fill="var(--surface)" stroke="${col[c]}" stroke-width="1.5"/>` : ""}
      <text x="${w - Rr + 18}" y="${y + 4}" font-size="12.5" class="num" fill="var(--ink-2)">${f(q[2])}</text></g>`;
  });
  if (a < 0 && b > 0) g += `<line x1="${X(0)}" x2="${X(0)}" y1="${T - 6}" y2="${h - 6}" stroke="var(--ink-3)"/>`;
  el.innerHTML = svgEl(w, h, g, opt.noun === "weeks" ? "Distribution of weekly net revenue" : "Distribution across assets");
  el.querySelectorAll("g[data-i]").forEach(n => {
    const [name, vals] = groups[+n.dataset.i], s = vals.filter(isFinite).sort((x, y) => x - y);
    n.onmousemove = ev => showTip(`<b>${name}</b><div class="num">median ${f(quant(s, 0.5))}</div><div class="num">P10 ${f(quant(s, 0.1))} · P90 ${f(quant(s, 0.9))}</div>${opt.extremes ? `<div class="num">min ${f(s[0])} · max ${f(s.at(-1))}</div><div class="num">mean ${f(s.reduce((x, y) => x + y, 0) / s.length)}</div>` : ""}<div class="num">${s.length} ${opt.noun || "assets"}</div>`, ev);
    n.onmouseleave = hideTip;
  });
}
// ---------- downloads: PNG of any chart or table, CSV of the data behind it ----------
function save(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
const csvCell = v => v == null || (typeof v === "number" && !isFinite(v)) ? "" : typeof v === "number" ? String(+v.toPrecision(10)) : /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const toCsv = (head, rows) => [head.join(","), ...rows.map(r => r.map(csvCell).join(","))].join("\n") + "\n";
const saveCsv = (name, head, rows) => save(new Blob([toCsv(head, rows)], { type: "text/csv" }), name + ".csv");
const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const period = () => S.y0 === S.y1 ? `${S.y0}` : `${S.y0}-${S.y1}`;
const fileBase = key => `${S.tab === "fleet" ? S.ftech : S.unit}_${period()}_${key}`;
const mtime = t => new Date((t + NEM_OFF) * 1000).toISOString().slice(0, 16).replace("T", " ");   // market time, interval ending
// add a title block above an image and save as PNG
function composePng(src, w, h, panel, name) {
  const dpr = 2, title = panel.querySelector("h3")?.textContent || "", sub = panel.querySelector(".sub")?.textContent || "";
  const pad = 24, tH = 30;
  const m = document.createElement("canvas").getContext("2d"); m.font = `13px ${css("--f-ui")}`;
  const lines = []; let cur = "";
  for (const word of sub.split(/\s+/).filter(Boolean)) { const t = cur ? cur + " " + word : word; if (m.measureText(t).width > w && cur) { lines.push(cur); cur = word; } else cur = t; }
  if (cur) lines.push(cur);
  const top = pad + tH + lines.length * 18 + 10;
  const c = document.createElement("canvas"); c.width = (w + pad * 2) * dpr; c.height = (h + top + pad) * dpr;
  const x = c.getContext("2d"); x.scale(dpr, dpr);
  x.fillStyle = css("--surface"); x.fillRect(0, 0, w + pad * 2, h + top + pad);
  x.fillStyle = css("--ink"); x.font = `600 18px ${css("--f-ui")}`; x.fillText(title, pad, pad + 18);
  x.fillStyle = css("--ink-3"); x.font = `13px ${css("--f-ui")}`; lines.forEach((l, i) => x.fillText(l, pad, pad + tH + 10 + i * 18));
  x.drawImage(src, pad, top, w, h);
  c.toBlob(b => save(b, name + ".png"), "image/png");
}
function svgPng(el, panel, name) {
  const svg = el.querySelector("svg"); if (!svg) return;
  const r = svg.getBoundingClientRect(), clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg"); clone.setAttribute("width", r.width); clone.setAttribute("height", r.height);
  // CSS variables don't exist outside the page: resolve them, and carry the fonts
  const fix = v => v && v.includes("var(") ? v.replace(/var\((--[a-z0-9-]+)\)/g, (_, n) => css(n)) : v;
  clone.querySelectorAll("*").forEach(n => { for (const at of ["fill", "stroke"]) if (n.hasAttribute(at)) n.setAttribute(at, fix(n.getAttribute(at))); });
  const st = document.createElementNS("http://www.w3.org/2000/svg", "style");
  st.textContent = `text{font-family:${css("--f-ui")}} .num{font-family:${css("--f-num")}}`; clone.insertBefore(st, clone.firstChild);
  const img = new Image();
  img.onload = () => composePng(img, r.width, r.height, panel, name);
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
}
function uplotPng(u, panel, name) {
  // canvas plus a drawn legend (uPlot's legend is HTML)
  const cv = u.ctx.canvas, w = u.width, h = u.height, items = u.series.slice(1).filter(s => s.show !== false && s.width !== 0 && s.label && s.stroke && !/^(max|min)$/.test(s.label));
  const lh = 26, c = document.createElement("canvas"); c.width = w * 2; c.height = (h + lh) * 2;
  const x = c.getContext("2d"); x.scale(2, 2); x.drawImage(cv, 0, 0, w, h);
  let lx = 70; x.font = `13px ${css("--f-ui")}`;
  items.forEach(s => { const col = typeof s.stroke === "function" ? s.stroke(u) : s.stroke; x.fillStyle = col; x.fillRect(lx, h + 8, 14, 3); x.fillStyle = css("--ink-2"); x.fillText(s.label, lx + 20, h + 14); lx += 34 + x.measureText(s.label).width; });
  composePng(c, w, h + lh, panel, name);
}
let h2cLoading = null;
const loadH2C = () => h2cLoading || (h2cLoading = new Promise((ok, no) => { if (window.html2canvas) return ok(); const sc = document.createElement("script"); sc.src = "vendor/html2canvas.min.js"; sc.onload = ok; sc.onerror = () => { h2cLoading = null; sc.remove(); no(new Error("vendor/html2canvas.min.js did not load")); }; document.head.appendChild(sc); }));
async function tablePng(el, panel, name) {
  await loadH2C();
  const mh = el.style.maxHeight; el.style.maxHeight = "none";        // capture every row, not just the scrolled view
  try { const c = await html2canvas(el, { backgroundColor: css("--surface"), scale: 2, logging: false }); composePng(c, c.width / 2, c.height / 2, panel, name); }
  finally { el.style.maxHeight = mh; }
}
// CSV builders
function farmCsv() {
  const E = EX; if (!E) return;
  // the zoomed window if zoomed in, otherwise the whole selected period
  const xs = plots[0]?.scales.x, zoomed = xs && xs.min != null && (xs.max - xs.min) < (E.x1 - E.x0) * 0.98;
  const i0 = zoomed ? Math.max(0, Math.floor((xs.min - E.T0) / E.dt)) : 0, i1 = zoomed ? Math.min(E.N - 1, Math.ceil((xs.max - E.T0) / E.dt)) : E.N - 1;
  const r = (v, d) => v === v ? +v.toFixed(d) : null;
  const rows = []; for (let i = i0; i <= i1; i++) rows.push([mtime(E.T0 + i * E.dt), r(E.price[i], 2), r(E.so[i], 1), r(E.ug[i], 1), r(E.so[i] / E.u.cap, 4), r(E.tso[i], 4), r(E.tug[i], 4)]);
  saveCsv(fileBase("5min"), ["interval_ending_market_time", "rrp", "farm_sentout_mw", "farm_uigf_mw", "farm_cf", "ref_sentout_cf", "ref_uigf_on_negative_cf"], rows);
}
function avgCsv() {
  const A = LAST.avg; if (!A) return;
  saveCsv(fileBase(A.byWeek ? "weekly-average" : "monthly-average"), [A.byWeek ? "week_start" : "month", `farm_${A.cf ? "cf" : "mw"}`, `ref_sentout_${A.cf ? "cf" : "mw"}`, `ref_uigf_${A.cf ? "cf" : "mw"}`], A.keys.map((k, i) => [A.byWeek ? k : k.slice(0, 7), A.farm[i], A.so[i], A.ug[i]]));
}
function weeklyCsv() {
  const L = LAST.settle; if (!L) return; const { R, rows, full, p } = L, inFull = new Set(full);
  const head = ["week_start", "complete_week", "fixed_price", "contract_mw", "cap", "floor", "farm_mwh", "merchant_floored", "merchant_unfloored"];
  rows.forEach(r => head.push(`${r.key}_contract_mwh`, `${r.key}_settlement`, `${r.key}_net`));
  const out = [];
  for (let w = 0; w < R.nW; w++) { const line = [SETTLE.weeks[R.w0 + w], inFull.has(w) ? 1 : 0, p.k, p.q, p.cap, p.floor, R.energy[w], R.merch[w], R.merchRaw[w]]; rows.forEach(r => line.push(R["v_" + r.key][w], r.s[w], r.weekly[w])); out.push(line); }
  saveCsv(fileBase("weekly-settlement"), head, out);
}
function cmpCsv() {
  const L = LAST.settle; if (!L) return; const { rows, M, EG, p } = L;
  saveCsv(fileBase("approach-comparison"), ["approach", "trace", "selected", "contract_mwh", "settlement", "net_revenue", "net_per_mwh", "vs_merchant_per_mwh", "weekly_sd", "weekly_downside_sd", "mean_week", "p10_week", "cvar10_week", "ear_p10", "ear_cvar10", "ear_parametric", "worst_week", "worst_week_start"],
    [(() => { const mf = L.full.map(w => L.R.merch[w]).sort((a, b) => a - b), m = mean(mf); return ["merchant", "", "", "", "", M, M / EG, 0, sd(mf), dsd(mf), m, quant(mf, 0.1), cvar(mf), m - quant(mf, 0.1), m - cvar(mf), Z10 * sd(mf), mf[0], ""]; })(),
     ...rows.map(r => { const nf = L.full.map(w => r.weekly[w]).sort((a, b) => a - b); return [AP[r.ap], TRN[r.tr], p.tr[r.ap] === r.tr ? 1 : 0, r.V, r.S, r.net, r.net / EG, (r.net - M) / EG, r.sd, r.dsd, r.mean, r.p10, cvar(nf), r.mean - r.p10, r.mean - cvar(nf), Z10 * r.sd, r.worst, SETTLE.weeks[L.R.w0 + r.worstWk]]; })]);
}
function earCsv() {
  const L = LAST.settle; if (!L) return; const { sweep, p, u } = L;
  saveCsv(fileBase("mean-vs-earnings-at-risk"), ["approach", "trace", "volume_pct_of_capacity", "contract_mw", "mean_week", "tail_week", "earnings_at_risk", "risk_measure", "is_current_q", "fixed_price", "cap", "floor", "capacity_mw"],
    sweep.flatMap(s => s.pts.map(x => [AP[s.a], TRN[s.tr], x.pct, x.q, x.mean, x.p10, x.ear, RISK[p.risk].label, 0, p.k, p.cap, p.floor, u.cap]).concat([[AP[s.a], TRN[s.tr], s.cur.pct, s.cur.q, s.cur.mean, s.cur.p10, s.cur.ear, RISK[p.risk].label, 1, p.k, p.cap, p.floor, u.cap]])));
}
function bridgeCsv() { const L = LAST.settle; if (!L) return; saveCsv(fileBase("settlement-attribution"), ["step", "kind", "settlement"], L.bridgeRows.map(r => [r.label, r.kind, r.v])); }
function boxCsv() {
  const L = LAST.settle; if (!L) return; const { R, full, rows, p } = L;
  const series = [["merchant", Array.from(full, w => R.merch[w])], ...["a", "b", "c"].map(a => { const r = rows.find(x => x.key === `${a}_${p.tr[a]}`); return [`${AP[a]} (${TRS[p.tr[a]]})`, full.map(w => r.weekly[w])]; })];
  saveCsv(fileBase("weekly-net-distribution"), ["series", "weeks", "min", "p10", "p25", "median", "p75", "p90", "max", "mean", "sd", "downside_sd"],
    series.map(([n, v]) => { const s = v.slice().sort((a, b) => a - b); return [n, s.length, s[0], quant(s, .1), quant(s, .25), quant(s, .5), quant(s, .75), quant(s, .9), s.at(-1), s.reduce((a, b) => a + b, 0) / s.length, sd(s), dsd(s)]; }));
}
function fleetCsv() {
  const F = LAST.fleet; if (!F) return;
  saveCsv(fileBase("fleet"), ["duid", "name", "region", "tech", "capacity_mw", "weeks", "cf", "merchant_per_mwh", "a_net_per_mwh", "b_net_per_mwh", "c_net_per_mwh", "a_downside_sd_vs_merchant", "b_downside_sd_vs_merchant", "c_downside_sd_vs_merchant", "fixed_price", "contract_pct_capacity", "trace_pairing"],
    F.rows.map(r => [r.u.id, r.u.name, r.u.region, r.u.tech, r.u.cap, r.n, r.cf, r.merch, r.net_a, r.net_b, r.net_c, r.red_a, r.red_b, r.red_c, F.p.k, F.p.r, F.p.pair]));
}
const EXPORTS = {
  p1: { png: (pn, n) => plots[0] && uplotPng(plots[0], pn, n), csv: farmCsv },
  p2: { png: (pn, n) => plots[1] && uplotPng(plots[1], pn, n), csv: farmCsv },
  p3: { png: (pn, n) => svgPng($("p3"), pn, n), csv: avgCsv },
  cmp: { png: (pn, n) => tablePng($("cmp"), pn, n), csv: cmpCsv },
  st1: { png: (pn, n) => svgPng($("st1"), pn, n), csv: weeklyCsv },
  st2: { png: (pn, n) => svgPng($("st2"), pn, n), csv: bridgeCsv },
  st4: { png: (pn, n) => svgPng($("st4"), pn, n), csv: boxCsv },
  st3: { png: (pn, n) => svgPng($("st3"), pn, n), csv: weeklyCsv },
  st5: { png: (pn, n) => svgPng($("st5"), pn, n), csv: earCsv },
  fl1: { png: (pn, n) => svgPng($("fl1"), pn, n), csv: fleetCsv },
  fl2: { png: (pn, n) => svgPng($("fl2"), pn, n), csv: fleetCsv },
  fl3: { png: (pn, n) => tablePng($("fl3"), pn, n), csv: fleetCsv },
};
function addDownloads() {
  for (const [key, ex] of Object.entries(EXPORTS)) {
    const target = $(key), panel = target?.closest(".panel"); if (!panel) continue;
    const box = document.createElement("div"); box.className = "dl";
    box.innerHTML = `<button type="button" data-f="png" title="Download this chart as a PNG image">PNG</button><button type="button" data-f="csv" title="Download the data behind this chart as CSV">CSV</button>`;
    box.onclick = e => { const b = e.target.closest("button"); if (!b) return; const name = fileBase(slug(panel.querySelector("h3")?.textContent || key));
      const fail = err => { console.error(err); const t = b.textContent; b.textContent = "failed"; b.title = String(err && err.message || err); setTimeout(() => { b.textContent = t; }, 2500); };
      try { Promise.resolve(b.dataset.f === "png" ? ex.png(panel, name) : ex.csv()).catch(fail); } catch (err) { fail(err); } };
    const tb = panel.querySelector(".toolbar"); if (tb) tb.appendChild(box); else panel.insertBefore(box, panel.firstChild);
  }
}
if (window.uPlot) boot(); else $("dsinfo").innerHTML = `<span class="err">Chart library failed to load.</span>`;
