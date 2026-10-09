"use strict";
// ---------- Portfolio (bulk energy contract, fourth sub-tab) ----------
// Each asset carries its own contract (strike K_i, volume Q_i MW) settled against its own region-technology reference
// trace; the floating cap and floor and the trace used by each approach are common to every contract.
// Settlement is linear in K and Q, so per region-technology we only need, per billing week and approach/trace,
//   V_w = Σ CF·v·5/60   (contract MWh per MW)      F_w = Σ CF·v·F(P)·5/60   (floating $ per MW)
// and asset i settles Q_i·(K_i·V_w − F_w). Merchant revenue and data coverage per asset come from settle.bin.
const PF = { assets: [], cap: 600, floor: 0, tr: { a: "so", b: "ug", c: "so" }, dk: 75, dq: 100, init: false };
const PF_KEY = "esem_portfolio_v1";
const APS = ["a", "b", "c"];
let PFREG = new Map(), PFLAST = null;

function pfSave() { try { localStorage.setItem(PF_KEY, JSON.stringify({ assets: PF.assets, cap: PF.cap, floor: PF.floor, tr: PF.tr, dk: PF.dk, dq: PF.dq })); } catch (e) { /* storage unavailable */ } }
function pfLoadSaved() {
  try { const o = JSON.parse(localStorage.getItem(PF_KEY) || "null"); if (o && Array.isArray(o.assets)) Object.assign(PF, o, { tr: { ...PF.tr, ...(o.tr || {}) } }); } catch (e) { /* ignore */ }
  PF.assets = PF.assets.filter(a => UNIT.has(a.id));
}

function pfInit() {
  pfLoadSaved();
  $("pf-cap").value = PF.cap; $("pf-floor").value = PF.floor; $("pf-dk").value = PF.dk; $("pf-dq").value = PF.dq;
  APS.forEach(a => document.querySelectorAll(`[data-pap="${a}"]`).forEach(x => x.setAttribute("aria-pressed", x.dataset.tr === PF.tr[a])));
  let dt; const later = () => { clearTimeout(dt); dt = setTimeout(() => { pfSave(); renderPortfolio(); }, 150); };
  const num = (id, key) => $(id).oninput = e => { const v = parseFloat(e.target.value); if (isFinite(v)) { PF[key] = v; later(); } };
  num("pf-cap", "cap"); num("pf-floor", "floor");
  $("pf-dk").oninput = e => { const v = parseFloat(e.target.value); if (isFinite(v)) { PF.dk = v; pfSave(); } };
  $("pf-dq").oninput = e => { const v = parseFloat(e.target.value); if (isFinite(v)) { PF.dq = v; pfSave(); } };
  document.querySelectorAll("[data-pap]").forEach(b => b.onclick = () => {
    PF.tr[b.dataset.pap] = b.dataset.tr;
    document.querySelectorAll(`[data-pap="${b.dataset.pap}"]`).forEach(x => x.setAttribute("aria-pressed", x.dataset.tr === b.dataset.tr));
    pfSave(); renderPortfolio(); });
  document.querySelectorAll("[data-prisk]").forEach(b => b.onclick = () => { S.risk = b.dataset.prisk; renderPortfolio(); });
  $("pf-allk").onclick = () => { PF.assets.forEach(a => a.k = PF.dk); pfSave(); renderPortfolio(); };
  $("pf-allq").onclick = () => { PF.assets.forEach(a => a.q = Math.round(UNIT.get(a.id).cap * PF.dq / 100)); pfSave(); renderPortfolio(); };
  $("pf-clear").onclick = () => { PF.assets = []; pfSave(); renderPortfolio(); };
  $("pf-example").onclick = () => {
    const pick = [];
    for (const r of META.regions.map(x => x.id)) for (const t of ["wind", "solar"]) {
      const u = META.units.filter(x => x.region === r && x.tech === t).sort((a, b) => b.cap - a.cap)[0];
      if (u && pick.length < 6) pick.push(u);
    }
    PF.assets = pick.map(u => ({ id: u.id, k: PF.dk, q: Math.round(u.cap * PF.dq / 100) })); pfSave(); renderPortfolio();
  };
  // asset picker
  const q = $("pfq"), list = $("pflist");
  const fill = () => {
    const s = q.value.trim().toLowerCase(), have = new Set(PF.assets.map(a => a.id));
    const items = META.units.filter(u => !s || u.name.toLowerCase().includes(s) || u.id.toLowerCase().includes(s) || u.region.toLowerCase().startsWith(s) || u.tech.startsWith(s))
      .sort((a, b) => a.region.localeCompare(b.region) || a.tech.localeCompare(b.tech) || a.name.localeCompare(b.name)).slice(0, 300);
    list.innerHTML = items.map(u => `<li data-id="${u.id}" class="${have.has(u.id) ? "on" : ""}"><span>${u.name} <small>${u.id}</small></span><small>${have.has(u.id) ? "added · " : ""}${u.region.replace("1", "")} · ${TECH[u.tech]} · ${fmt(u.cap)} MW</small></li>`).join("") || `<li>No matches</li>`;
    list.hidden = false;
  };
  const add = id => { if (!PF.assets.some(a => a.id === id)) { PF.assets.push({ id, k: PF.dk, q: Math.round(UNIT.get(id).cap * PF.dq / 100) }); pfSave(); renderPortfolio(); } q.value = ""; fill(); };
  q.onfocus = fill; q.oninput = fill;
  q.onblur = () => setTimeout(() => { list.hidden = true; q.value = ""; }, 150);
  list.onmousedown = e => { e.preventDefault(); const li = e.target.closest("li[data-id]"); if (li) add(li.dataset.id); };
  q.onkeydown = e => { if (e.key === "Enter") { const li = list.querySelector("li[data-id]:not(.on)"); if (li) add(li.dataset.id); } if (e.key === "Escape") q.blur(); };
  PF.init = true;
}

// weekly V and F per approach/trace for every technology in one region, at the current cap/floor
async function pfRegion(region, years) {
  const key = `${region}|${years.join(",")}|${PF.cap}|${PF.floor}`;
  if (PFREG.has(key)) return PFREG.get(key);
  const W = SETTLE.W, X = PF.cap, F0 = PF.floor;
  const out = { nint: new Float64Array(W) };
  const z = () => new Float64Array(W);
  for (const tech of ["wind", "solar"]) for (const t of ["so", "ug"]) for (const a of APS) { out[`${tech}_${t}_${a}_V`] = z(); out[`${tech}_${t}_${a}_F`] = z(); }
  for (const y of years) {
    const m = META.idx[`${region}_${y}`]; if (!m) continue;
    const f = await getFile(m.file), n = f.header.n, T0 = f.header.t0, dt = f.header.dt;
    const P = decodeSeries(f, series(f, "rrp"));
    const tr = {}; for (const tech of ["wind", "solar"]) for (const t of ["so", "ug"]) { const s = series(f, `${tech}_${t}`); tr[`${tech}_${t}`] = s ? decodeSeries(f, s) : null; }
    for (let i = 0; i < n; i++) {
      const p = P[i]; if (p !== p) continue;
      const w = wkOf(T0 + i * dt); if (w < 0 || w >= W) continue;
      out.nint[w]++;
      const pb = p < F0 ? F0 : p > X ? X : p, pc = p > X ? X : p, live = p >= 0;
      for (const k in tr) { const c = tr[k]; if (!c) continue; const cf = c[i]; if (cf !== cf) continue;
        const v = cf * H;
        out[`${k}_a_V`][w] += v; out[`${k}_a_F`][w] += v * p;
        out[`${k}_b_V`][w] += v; out[`${k}_b_F`][w] += v * pb;
        if (live) { out[`${k}_c_V`][w] += v; out[`${k}_c_F`][w] += v * pc; } }
    }
  }
  PFREG.set(key, out);
  return out;
}

let pfTok = 0;
async function renderPortfolio() {
  if (!META || !SETTLE) return;
  if (!PF.init) pfInit();
  const tok = ++pfTok;
  document.querySelectorAll("[data-prisk]").forEach(b => b.setAttribute("aria-pressed", b.dataset.prisk === S.risk));
  const empty = !PF.assets.length;
  for (const id of ["pf-results"]) $(id).hidden = empty;
  $("pf-empty").hidden = !empty;
  pfAssetTable(null);
  if (empty) { $("pfkpi").innerHTML = ""; return; }
  const years = META.years.filter(y => y >= S.y0 && y <= S.y1);
  const regions = [...new Set(PF.assets.map(a => UNIT.get(a.id).region))];
  $("pfstatus").textContent = "Calculating…";
  const RC = {}; for (const r of regions) RC[r] = await pfRegion(r, years);
  if (tok !== pfTok) return;
  $("pfstatus").textContent = "";
  const { U, uf, W, weeks } = SETTLE, fi = n => uf.indexOf(n);
  const from = `${S.y0}-01-01`, to = `${S.y1 + 1}-01-01`;
  const wks = []; weeks.forEach((d, w) => { if (d >= from && d < to) wks.push(w); });
  const full = 0.9 * 2016;
  const A = PF.assets.map(a => { const u = UNIT.get(a.id), R = RC[u.region], ub = u.gi * uf.length * W;
    return { ...a, u, R, ub, ok: w => U[ub + fi("nvalid") * W + w] >= full && R.nint[w] >= full, EG: w => U[ub + fi("EG") * W + w], MG: w => U[ub + fi("MG") * W + w],
      st: (w, ap, t) => a.q * (a.k * R[`${u.tech}_${t}_${ap}_V`][w] - R[`${u.tech}_${t}_${ap}_F`][w]) }; });
  const pw = wks.filter(w => A.every(x => x.ok(w)));   // weeks where every asset has complete data
  // per-asset results over the portfolio weeks
  for (const x of A) {
    x.eg = 0; x.mg = 0; x.s = {}; x.nets = {}; for (const ap of APS) { x.s[ap] = 0; x.nets[ap] = []; } x.mw = [];
    for (const w of pw) { const eg = x.EG(w), mg = x.MG(w); x.eg += eg; x.mg += mg; x.mw.push(mg);
      for (const ap of APS) { const s = x.st(w, ap, PF.tr[ap]); x.s[ap] += s; x.nets[ap].push(mg + s); } }
    x.vol = {}; for (const ap of APS) x.vol[ap] = pw.reduce((t, w) => t + x.q * x.R[`${x.u.tech}_${PF.tr[ap]}_${ap}_V`][w], 0);
    x.weeksOk = wks.filter(w => x.ok(w)).length;
  }
  // portfolio weekly series for every approach x trace
  const merch = pw.map(w => sum(A.map(x => x.MG(w))));
  const EG = sum(A.map(x => x.eg)), M = sum(merch), capT = sum(A.map(x => x.u.cap)), qT = sum(A.map(x => x.q));
  const rows = [];
  for (const ap of APS) for (const t of ["so", "ug"]) {
    const s = pw.map(w => sum(A.map(x => x.st(w, ap, t)))), net = s.map((v, i) => v + merch[i]), nf = net.slice().sort((a, b) => a - b);
    const vol = sum(A.map(x => pw.reduce((acc, w) => acc + x.q * x.R[`${x.u.tech}_${t}_${ap}_V`][w], 0)));
    const sds = A.map(x => sd(pw.map(w => x.MG(w) + x.st(w, ap, t))));
    const wi = net.indexOf(nf[0]);
    rows.push({ ap, t, key: `${ap}_${t}`, sel: PF.tr[ap] === t, S: sum(s), V: vol, net: sum(net), weekly: net, sd: sd(nf), dsd: dsd(nf), mean: mean(nf), tail: riskTail(nf), p10: quant(nf, 0.1), worst: nf[0], worstWk: pw[wi], div: 1 - sd(nf) / sum(sds) });
  }
  const mf = merch.slice().sort((a, b) => a - b), msds = A.map(x => sd(x.mw));
  const mrow = { sd: sd(mf), dsd: dsd(mf), mean: mean(mf), tail: riskTail(mf), worst: mf[0], worstWk: pw[merch.indexOf(mf[0])], div: 1 - sd(mf) / sum(msds) };
  const sel = Object.fromEntries(APS.map(ap => [ap, rows.find(r => r.ap === ap && r.sel)]));
  const per = S.y0 === S.y1 ? `${S.y0}` : `${S.y0}–${S.y1}`;

  $("pfkpi").innerHTML = [
    ["Portfolio", `${A.length} assets`, `${fmt(capT, 0)} MW · contract ${fmt(qT, 0)} MW (${fmt(qT / capT * 100, 0)}% of capacity)`],
    ["Output", fmt(EG / 1000, 1) + " GWh", `${fmt(pw.length)} common complete weeks`],
    ["Merchant", money(M / 1e6, 2) + "M", `${money(M / EG, 1)}/MWh · floored at $0`],
    ...APS.map(ap => [AP[ap], money(sel[ap].net / 1e6, 2) + "M", `${money(sel[ap].net / EG, 1)}/MWh · settlement ${money(sel[ap].S / 1e6, 2)}M`])
  ].map(([a, v, s]) => `<div class="kpi"><span>${a}</span><b>${v}</b><small>${s}</small></div>`).join("");

  // approaches table
  const wkDate = w => w == null ? "" : `week from ${weeks[w]}`;
  $("pf-tbls").textContent = `${A.length} assets, ${per} · cap ${money(PF.cap, 0)}, floor ${money(PF.floor, 0)} for every contract · weekly statistics over the ${fmt(pw.length)} weeks where every asset has complete data · ${RISK[S.risk].desc} · diversification = 1 − SD(portfolio weekly net) ÷ Σ SD(each asset's weekly net) · highlighted rows are the selected trace per approach`;
  const td = (v, d = 2) => `<td class="${v < 0 ? "neg" : ""}">${money(v / 1e6, d)}</td>`, pc = v => `<td>${isFinite(v) ? fmt(v * 100, 0) + "%" : "–"}</td>`;
  let h = `<table><thead><tr><th>Approach</th><th>Trace</th><th>Contract GWh</th><th>Settlement $M</th><th>Net revenue $M</th><th>Net $/MWh</th><th>vs merchant $/MWh</th><th>Weekly SD $k</th><th>Downside SD $k</th><th>Mean week $k</th><th>${RISK[S.risk].col} $k</th><th title="${RISK[S.risk].desc}">EaR $k</th><th>Worst week $k</th><th>Diversification</th></tr></thead><tbody>`;
  h += `<tr><td class="l"><span class="tag m">M</span>Merchant only</td><td class="l">–</td><td>–</td><td>–</td>${td(M)}<td>${money(M / EG, 1)}</td><td>–</td><td>${fmt(mrow.sd / 1000, 0)}</td><td>${fmt(mrow.dsd / 1000, 0)}</td><td>${money(mrow.mean / 1000, 0)}</td><td>${money(mrow.tail / 1000, 0)}</td><td>${fmt((mrow.mean - mrow.tail) / 1000, 0)}</td><td title="${wkDate(mrow.worstWk)}">${money(mrow.worst / 1000, 0)}</td>${pc(mrow.div)}</tr>`;
  for (const r of rows) h += `<tr class="${r.sel ? "dflt" : ""}"><td class="l"><span class="tag ${r.ap}">${r.ap.toUpperCase()}</span>${AP[r.ap].slice(4)}</td><td class="l">${TRN[r.t]}</td><td>${fmt(r.V / 1000, 1)}</td>${td(r.S)}${td(r.net)}<td>${money(r.net / EG, 1)}</td><td class="${r.net < M ? "neg" : ""}">${money((r.net - M) / EG, 1)}</td><td>${fmt(r.sd / 1000, 0)}</td><td>${fmt(r.dsd / 1000, 0)}</td><td>${money(r.mean / 1000, 0)}</td><td>${money(r.tail / 1000, 0)}</td><td>${fmt((r.mean - r.tail) / 1000, 0)}</td><td title="${wkDate(r.worstWk)}">${money(r.worst / 1000, 0)}</td>${pc(r.div)}</tr>`;
  $("pf-tbl").innerHTML = h + `</tbody></table>`;

  pfAssetTable(A, pw.length);

  // charts over the common weeks
  const xs = pw.map(w => weeks[w]), col = { a: css("--s1"), b: css("--s2"), c: css("--s7"), m: css("--ink-3") };
  const cum = a => { let c = 0; return a.map(v => (c += v) / 1e6); };
  const cs = [{ key: "m", name: "Merchant", color: col.m, vals: cum(merch), dash: "4 3", width: 1.5 },
    ...APS.map(ap => ({ key: ap, name: `${ap.toUpperCase()} · ${PF.tr[ap] === "so" ? "SO" : "UIGF"}`, color: col[ap], vals: cum(sel[ap].weekly) }))];
  const lg = cs.map(x => ({ key: x.key, name: x.key === "m" ? "Merchant only" : `${AP[x.key]} (${TRS[PF.tr[x.key]]})`, color: x.color, dash: !!x.dash }));
  const W1 = Math.max(320, $("pf1").clientWidth || 700);
  const d1 = () => { lineChart($("pf1"), { xs, series: cs.filter(x => !hidden("pf1").has(x.key)), yfmt: v => v == null ? "–" : money(v, 1) + "M", w: W1, h: 340, title: "Portfolio cumulative net revenue", xlab: i => `Week from ${xs[i]}` }); legend($("pf1"), "pf1", lg, d1); };
  d1();
  const ws = [{ key: "m", name: "Merchant", color: col.m, vals: merch.map(v => v / 1000), dash: "4 3", width: 1.5 },
    ...APS.map(ap => ({ key: ap, name: `${ap.toUpperCase()} · ${PF.tr[ap] === "so" ? "SO" : "UIGF"}`, color: col[ap], vals: sel[ap].weekly.map(v => v / 1000), width: 1.5 }))];
  const W3 = Math.max(320, $("pf3").clientWidth || 1200);
  const d3 = () => { lineChart($("pf3"), { xs, series: ws.filter(x => !hidden("pf3").has(x.key)), yfmt: v => v == null ? "–" : money(v, 0) + "k", w: W3, h: 360, title: "Portfolio weekly net revenue", xlab: i => `Week from ${xs[i]}` }); legend($("pf3"), "pf3", lg, d3); };
  d3();
  $("pf2s").textContent = `Portfolio weekly net revenue, $M · ${fmt(pw.length)} common complete weeks · box = P25–P75, line = median, whisker = P10–P90, circles = worst and best week · selected trace per approach`;
  boxRows($("pf2"), [["Merchant only", merch.map(v => v / 1e6), "m"], ...APS.map(ap => [`${AP[ap]} (${TRS[PF.tr[ap]]})`, sel[ap].weekly.map(v => v / 1e6), ap])],
    v => money(v, 1) + "M", Math.max(320, $("pf2").clientWidth || 1200), "$M", { extremes: true, noun: "weeks", labelW: 250 });
  // efficient frontier: every contract scaled by the same factor, 0-200% of the specified volumes
  const stat = arr => { const v = arr.slice().sort((x, y) => x - y), m = mean(v), t = riskTail(v); return { mean: m, p10: t, ear: m - t }; };
  const sweep = APS.map(ap => { const st = sel[ap].weekly.map((v, i) => v - merch[i]);
    const pt = pct => ({ pct, q: qT * pct / 100, ...stat(merch.map((m, i) => m + pct / 100 * st[i])) });
    return { a: ap, tr: PF.tr[ap], pts: Array.from({ length: 21 }, (_, i) => pt(i * 10)), cur: pt(100) }; });
  $("pf4s").textContent = `Portfolio mean weekly net revenue vs earnings-at-risk, $k/week · ${RISK[S.risk].desc} · every contract scaled together from 0% to 200% of its specified volume in 10% steps (0% = merchant only, filled marker = the volumes as specified, ${fmt(qT, 0)} MW in total) · each contract keeps its own strike · ${fmt(pw.length)} common complete weeks · selected trace per approach`;
  const W4 = Math.max(320, $("pf4").clientWidth || 1200), ecol = { a: css("--s1"), b: css("--s2"), c: css("--s7") };
  const d4 = () => { earChart($("pf4"), sweep.filter(x => !hidden("pf4").has(x.a)), W4); legend($("pf4"), "pf4", sweep.map(x => ({ key: x.a, name: `${AP[x.a]} (${TRS[x.tr]})`, color: ecol[x.a] })), d4); };
  d4();
  PFLAST = { A, rows, mrow, merch, pw, xs, EG, M, sel, sweep, qT };
  window.__pf = PFLAST;
}

// editable contracts table; with results when A is given
function pfAssetTable(A, nw) {
  const el = $("pf-assets");
  if (!PF.assets.length) { el.innerHTML = ""; return; }
  const byId = A ? new Map(A.map(x => [x.id, x])) : new Map();
  const head = `<tr><th>Asset</th><th>Region</th><th>Tech</th><th>MW</th><th>Strike $/MWh</th><th>Volume MW</th><th>% of cap</th><th>Weeks complete</th><th>Output GWh</th><th>Merchant $/MWh</th>${APS.map(ap => `<th>${ap.toUpperCase()} net $/MWh</th>`).join("")}${APS.map(ap => `<th>${ap.toUpperCase()} settlement $M</th>`).join("")}<th></th></tr>`;
  const body = PF.assets.map((a, i) => { const u = UNIT.get(a.id), x = byId.get(a.id);
    const r = x ? [`<td>${fmt(x.weeksOk)}</td>`, `<td>${fmt(x.eg / 1000, 1)}</td>`, `<td>${money(x.mg / x.eg, 1)}</td>`, ...APS.map(ap => `<td>${money((x.mg + x.s[ap]) / x.eg, 1)}</td>`), ...APS.map(ap => `<td class="${x.s[ap] < 0 ? "neg" : ""}">${money(x.s[ap] / 1e6, 2)}</td>`)] : Array(10).fill("<td>–</td>");
    return `<tr data-i="${i}"><td class="l">${u.name} <small style="color:var(--ink-3)">${u.id}</small></td><td class="l">${u.region.replace("1", "")}</td><td class="l">${TECH[u.tech]}</td><td>${fmt(u.cap)}</td>
      <td><input type="number" class="pfk" step="1" value="${a.k}" aria-label="Strike for ${u.name}"></td><td><input type="number" class="pfqv" step="1" min="0" value="${a.q}" aria-label="Volume for ${u.name}"></td><td>${fmt(a.q / u.cap * 100, 0)}%</td>
      ${r.join("")}<td><button type="button" class="navbtn pfdel" title="Remove from portfolio">✕</button></td></tr>`; }).join("");
  const focus = document.activeElement && el.contains(document.activeElement) ? [document.activeElement.closest("tr")?.dataset.i, document.activeElement.className, document.activeElement.selectionStart] : null;
  el.innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  $("pf-assetss").textContent = `Strike and volume are set per contract; results are over the ${A ? fmt(nw) : "–"} weeks where every asset has complete data · net $/MWh of each asset's own output · selected trace per approach`;
  let dt;
  el.querySelectorAll("tbody tr").forEach(tr => { const i = +tr.dataset.i;
    tr.querySelector(".pfk").oninput = e => { const v = parseFloat(e.target.value); if (isFinite(v)) { PF.assets[i].k = v; pfSave(); clearTimeout(dt); dt = setTimeout(renderPortfolio, 300); } };
    tr.querySelector(".pfqv").oninput = e => { const v = parseFloat(e.target.value); if (isFinite(v) && v >= 0) { PF.assets[i].q = v; pfSave(); clearTimeout(dt); dt = setTimeout(renderPortfolio, 300); } };
    tr.querySelector(".pfdel").onclick = () => { PF.assets.splice(i, 1); pfSave(); renderPortfolio(); }; });
  if (focus && focus[0] != null) { const inp = el.querySelector(`tr[data-i="${focus[0]}"] .${focus[1].split(" ")[0]}`); if (inp) { inp.focus(); try { inp.setSelectionRange(focus[2], focus[2]); } catch (e) { /* number inputs */ } } }
}

// ---------- downloads ----------
function pfTableCsv() { const L = PFLAST; if (!L) return;
  saveCsv(fileBase("portfolio-approaches"), ["approach", "trace", "selected", "contract_mwh", "settlement", "net_revenue", "net_per_mwh", "weekly_sd", "weekly_downside_sd", "mean_week", "p10_week", "cvar10_week", "ear_selected_measure", "risk_measure", "worst_week", "worst_week_start", "diversification", "cap", "floor"],
    [["merchant", "", "", "", "", L.M, L.M / L.EG, L.mrow.sd, L.mrow.dsd, L.mrow.mean, quant(L.merch.slice().sort((a, b) => a - b), .1), cvar(L.merch.slice().sort((a, b) => a - b)), L.mrow.mean - L.mrow.tail, RISK[S.risk].label, L.mrow.worst, SETTLE.weeks[L.mrow.worstWk], L.mrow.div, PF.cap, PF.floor],
     ...L.rows.map(r => { const s = r.weekly.slice().sort((a, b) => a - b); return [AP[r.ap], TRN[r.t], r.sel ? 1 : 0, r.V, r.S, r.net, r.net / L.EG, r.sd, r.dsd, r.mean, r.p10, cvar(s), r.mean - r.tail, RISK[S.risk].label, r.worst, SETTLE.weeks[r.worstWk], r.div, PF.cap, PF.floor]; })]); }
function pfAssetsCsv() { const L = PFLAST; if (!L) return;
  saveCsv(fileBase("portfolio-assets"), ["duid", "name", "region", "tech", "capacity_mw", "strike", "volume_mw", "weeks_complete", "output_mwh", "merchant", ...APS.flatMap(ap => [`${ap}_trace`, `${ap}_contract_mwh`, `${ap}_settlement`, `${ap}_net`]), "cap", "floor"],
    L.A.map(x => [x.u.id, x.u.name, x.u.region, x.u.tech, x.u.cap, x.k, x.q, x.weeksOk, x.eg, x.mg, ...APS.flatMap(ap => [PF.tr[ap], x.vol[ap], x.s[ap], x.mg + x.s[ap]]), PF.cap, PF.floor])); }
function pfWeeklyCsv() { const L = PFLAST; if (!L) return;
  saveCsv(fileBase("portfolio-weekly"), ["week_start", "merchant", ...L.rows.map(r => `net_${r.key}`), ...L.A.flatMap(x => [`${x.u.id}_merchant`, ...APS.map(ap => `${x.u.id}_settlement_${ap}`)])],
    L.pw.map((w, i) => [SETTLE.weeks[w], L.merch[i], ...L.rows.map(r => r.weekly[i]), ...L.A.flatMap(x => [x.MG(w), ...APS.map(ap => x.st(w, ap, PF.tr[ap]))])])); }
function pfFrontierCsv() { const L = PFLAST; if (!L) return;
  saveCsv(fileBase("portfolio-frontier"), ["approach", "trace", "pct_of_specified_volumes", "total_contract_mw", "mean_week", "tail_week", "earnings_at_risk", "risk_measure", "is_specified"],
    L.sweep.flatMap(s => s.pts.map(x => [AP[s.a], TRN[s.tr], x.pct, x.q, x.mean, x.p10, x.ear, RISK[S.risk].label, x.pct === 100 ? 1 : 0]))); }
Object.assign(EXPORTS, {
  "pf-tbl": { png: (pn, n) => tablePng($("pf-tbl"), pn, n), csv: pfTableCsv },
  "pf-assets": { png: (pn, n) => tablePng($("pf-assets"), pn, n), csv: pfAssetsCsv },
  pf1: { png: (pn, n) => svgPng($("pf1"), pn, n), csv: pfWeeklyCsv },
  pf2: { png: (pn, n) => svgPng($("pf2"), pn, n), csv: pfWeeklyCsv },
  pf3: { png: (pn, n) => svgPng($("pf3"), pn, n), csv: pfWeeklyCsv },
  pf4: { png: (pn, n) => svgPng($("pf4"), pn, n), csv: pfFrontierCsv },
});
