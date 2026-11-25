/**
 * Live dashboard page (single self-contained HTML document, no external assets).
 * All agent-produced text is inserted with textContent, never as HTML.
 */

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Automaton Live</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --line: #e3e6eb; --text: #14171c; --muted: #677080;
    --up: #0f9d58; --down: #d93025; --warn: #e37400; --accent: #2b6cde; --chip: #eef1f5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1015; --panel: #151a21; --line: #252c36; --text: #e6e9ee; --muted: #8a93a3;
      --up: #34c77b; --down: #ff6b5e; --warn: #f5a524; --accent: #6ea2ff; --chip: #1d242d;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", sans-serif; }
  .num { font-variant-numeric: tabular-nums; }
  header { position: sticky; top: 0; z-index: 2; background: var(--panel); border-bottom: 1px solid var(--line);
    padding: 12px 20px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
  header h1 { font-size: 16px; margin: 0 6px 0 0; font-weight: 650; }
  .badge { font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px; background: var(--chip); color: var(--muted); }
  .badge.good { color: var(--up); } .badge.bad { color: var(--down); } .badge.warn { color: var(--warn); }
  .live { margin-left: auto; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--up); }
  .dot.stale { background: var(--down); }
  main { max-width: 1280px; margin: 0 auto; padding: 18px 20px 40px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
  @media (max-width: 600px) { main { padding: 12px 16px 32px; } header { padding: 10px 16px; } }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; min-width: 0; }
  .panel h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 10px; font-weight: 600; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
  .kpi .label { font-size: 12px; color: var(--muted); }
  .kpi .value { font-size: 22px; font-weight: 650; margin-top: 2px; }
  .kpi .sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .kpi.hero .value { font-size: 30px; white-space: nowrap; }
  @media (min-width: 700px) { .kpi.hero { grid-column: span 2; } }
  .up { color: var(--up); } .down { color: var(--down); }
  .bar { height: 6px; background: var(--chip); border-radius: 3px; margin-top: 8px; position: relative; overflow: hidden; }
  .bar > span { position: absolute; inset: 0 auto 0 0; background: var(--accent); border-radius: 3px; }
  .bar.hot > span { background: var(--warn); }
  .grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
  .grid2 > * { min-width: 0; }
  @media (max-width: 900px) { .grid2 { grid-template-columns: minmax(0, 1fr); } }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-weight: 600; color: var(--muted); font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 7px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  td.r, th.r { text-align: right; }
  tr:last-child td { border-bottom: 0; }
  .scroll { overflow-x: auto; }
  .empty { color: var(--muted); font-size: 13px; padding: 10px 2px; }
  #chart { width: 100%; height: 220px; display: block; }
  .feed { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .turn { border-left: 3px solid var(--line); padding: 4px 0 4px 12px; min-width: 0; }
  .turn .meta { font-size: 12px; color: var(--muted); }
  .turn .think { margin: 4px 0 6px; white-space: pre-wrap; word-break: break-word; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { font-size: 12px; background: var(--chip); border-radius: 6px; padding: 3px 8px; max-width: 100%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip b { font-weight: 650; } .chip.err b { color: var(--down); } .chip.ok b { color: var(--up); }
  .deny { font-size: 13px; padding: 6px 0; border-bottom: 1px solid var(--line); word-break: break-word; }
  .deny:last-child { border-bottom: 0; }
  pre.journal { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    max-height: 360px; overflow: auto; }
  .alert { display: none; background: color-mix(in srgb, var(--down) 14%, var(--panel)); border: 1px solid var(--down);
    color: var(--text); border-radius: 12px; padding: 12px 16px; font-weight: 600; }
</style>
</head>
<body>
<header>
  <h1 id="name">Automaton</h1>
  <span class="badge" id="state">-</span>
  <span class="badge" id="tier">-</span>
  <span class="badge" id="market">-</span>
  <span class="badge" id="seal">-</span>
  <span class="live"><span class="dot" id="dot"></span><span id="updated">connecting…</span></span>
</header>
<main>
  <div class="alert" id="alert"></div>
  <section class="panel"><div class="kpis" id="kpis"></div></section>
  <section class="panel"><h2>Equity</h2><svg id="chart" viewBox="0 0 1000 220" preserveAspectRatio="none" role="img" aria-label="Equity over time"></svg></section>
  <div class="grid2">
    <section class="panel"><h2>Open positions</h2><div class="scroll" id="positions"></div></section>
    <section class="panel"><h2>Recent trades</h2><div class="scroll" id="fills"></div></section>
  </div>
  <div class="grid2">
    <section class="panel"><h2>What it is doing</h2><div class="feed" id="activity"></div></section>
    <div style="display:grid;gap:16px;align-content:start">
      <section class="panel"><h2>Blocked by policy</h2><div id="denials"></div></section>
      <section class="panel"><h2>Trade journal</h2><pre class="journal" id="journal"></pre></section>
    </div>
  </div>
</main>
<script>
(function () {
  var token = new URLSearchParams(location.search).get("token");
  var api = "/api/state" + (token ? "?token=" + encodeURIComponent(token) : "");
  var cur = "";
  var lastOk = 0;
  var lastState = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function money(n) {
    if (n == null || !isFinite(n)) return "-";
    return (cur ? cur + " " : "") + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function signed(n) { return (n > 0 ? "+" : "") + money(n); }
  function num(n) { return n == null || !isFinite(n) ? "-" : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function snum(n) { return (n > 0 ? "+" : "") + num(n); }
  function pct(n) { return n == null || !isFinite(n) ? "-" : (n > 0 ? "+" : "") + n.toFixed(2) + "%"; }
  function tone(n) { return n > 0 ? "up" : n < 0 ? "down" : ""; }
  function ago(iso) {
    if (!iso) return "never";
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return Math.round(s) + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  function time(iso) {
    var d = new Date(String(iso).replace(" ", "T") + (/[zZ]|[+-]\\d\\d:?\\d\\d$/.test(iso) || String(iso).indexOf("T") > 0 ? "" : "Z"));
    return isNaN(d) ? String(iso) : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function badge(id, text, kind) {
    var b = document.getElementById(id);
    b.textContent = text;
    b.className = "badge" + (kind ? " " + kind : "");
  }
  function kpi(label, value, sub, cls, extra) {
    var k = el("div", "kpi" + (extra && extra.hero ? " hero" : ""));
    k.appendChild(el("div", "label", label));
    k.appendChild(el("div", "value num " + (cls || ""), value));
    if (sub) k.appendChild(el("div", "sub num", sub));
    if (extra && extra.bar != null) {
      var bar = el("div", "bar" + (extra.hot ? " hot" : ""));
      var fill = el("span");
      fill.style.width = Math.max(0, Math.min(100, extra.bar)) + "%";
      bar.appendChild(fill);
      k.appendChild(bar);
    }
    return k;
  }
  function table(cols, rows) {
    if (!rows.length) return el("div", "empty", "Nothing yet.");
    var t = el("table"), thead = el("thead"), tr = el("tr");
    cols.forEach(function (c) { tr.appendChild(el("th", c.r ? "r" : "", c.h)); });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = el("tbody");
    rows.forEach(function (r) {
      var row = el("tr");
      cols.forEach(function (c) {
        var v = c.v(r);
        var td = el("td", (c.r ? "r num " : "") + (c.cls ? c.cls(r) : ""), v);
        row.appendChild(td);
      });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    return t;
  }
  function chart(points, start) {
    var svg = document.getElementById("chart");
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var NS = "http://www.w3.org/2000/svg";
    function node(tag, attrs) { var n = document.createElementNS(NS, tag); for (var k in attrs) n.setAttribute(k, attrs[k]); svg.appendChild(n); return n; }
    if (points.length < 2) {
      var t = node("text", { x: 500, y: 115, "text-anchor": "middle", fill: "var(--muted)", "font-size": 14 });
      t.textContent = "Equity history appears after the agent has run for a few minutes.";
      return;
    }
    var ys = points.map(function (p) { return p.equity; });
    if (start) ys.push(start);
    var min = Math.min.apply(null, ys), max = Math.max.apply(null, ys);
    if (max - min < 1e-9) { max += 1; min -= 1; }
    var pad = (max - min) * 0.08; min -= pad; max += pad;
    var t0 = new Date(points[0].time).getTime(), t1 = new Date(points[points.length - 1].time).getTime();
    var X = function (t) { return t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * 1000; };
    var Y = function (v) { return 210 - ((v - min) / (max - min)) * 200; };
    if (start) node("line", { x1: 0, x2: 1000, y1: Y(start), y2: Y(start), stroke: "var(--muted)", "stroke-dasharray": "4 4", "stroke-width": 1, "vector-effect": "non-scaling-stroke", opacity: .6 });
    var d = points.map(function (p, i) { return (i ? "L" : "M") + X(new Date(p.time).getTime()).toFixed(1) + " " + Y(p.equity).toFixed(1); }).join(" ");
    var last = points[points.length - 1].equity;
    var color = start && last < start ? "var(--down)" : "var(--up)";
    node("path", { d: d + " L1000 220 L0 220 Z", fill: color, opacity: .12 });
    node("path", { d: d, fill: "none", stroke: color, "stroke-width": 2, "vector-effect": "non-scaling-stroke" });
  }

  function render(s) {
    cur = s.trading.currency || "";
    document.getElementById("name").textContent = s.agent.name;
    document.title = s.agent.name + " · Live";
    var st = s.agent.state;
    badge("state", st, st === "running" ? "good" : st === "dead" ? "bad" : st === "critical" || st === "low_compute" ? "warn" : "");
    var a = s.account;
    badge("tier", "tier: " + (a ? a.tier : "-"), a && a.tier === "dead" ? "bad" : a && (a.tier === "critical" || a.tier === "low_compute") ? "warn" : a ? "good" : "");
    badge("market", s.trading.market + " " + (s.trading.marketOpen ? "open" : "closed"), s.trading.marketOpen ? "good" : "");
    badge("seal", !a ? "seal: -" : a.seal === "ok" ? "seal intact" : a.seal === "tampered" ? "SEAL BROKEN" : "seal: no key yet", a && a.seal === "ok" ? "good" : a && a.seal === "tampered" ? "bad" : "");

    var alert = document.getElementById("alert");
    if (a && a.seal === "tampered") {
      alert.style.display = "block";
      alert.textContent = "Ledger seal broken: the paper account was changed outside the runtime. The account is dead.";
    } else if (st === "dead") {
      alert.style.display = "block";
      alert.textContent = "The automaton is dead: paper equity fell to its survival floor.";
    } else { alert.style.display = "none"; }

    var k = document.getElementById("kpis");
    k.replaceChildren();
    if (!a) {
      k.appendChild(el("div", "empty", s.trading.enabled ? "No paper account yet. It is created on the agent's first turn." : "Trading mode is not enabled in automaton.json."));
    } else {
      var levPct = s.trading.maxLeverage ? (a.leverage / s.trading.maxLeverage) * 100 : 0;
      k.appendChild(kpi("Equity", money(a.equity), pct(a.totalReturnPct) + " since start (" + money(a.startingCapital) + ")", "", { hero: true }));
      k.appendChild(kpi("Today", signed(a.dayPnl), a.dayStartEquity ? pct((a.dayPnl / a.dayStartEquity) * 100) + " · loss limit -" + s.trading.dailyLossLimitPct + "%" : "", tone(a.dayPnl)));
      k.appendChild(kpi("Leverage", a.leverage == null ? "∞" : a.leverage.toFixed(2) + "x", "max " + s.trading.maxLeverage + "x · margin call if equity < " + money(a.marginCallAt), "", { bar: levPct, hot: levPct > 80 }));
      k.appendChild(kpi("Cash", money(a.cash), (a.cash < 0 ? "negative = margin borrowed · " : "") + "exposure " + money(a.grossExposure), a.cash < 0 ? "down" : ""));
      k.appendChild(kpi("Realized P&L", signed(a.realizedPnl), "net of fees", tone(a.realizedPnl)));
    }

    chart(s.equityHistory, a ? a.startingCapital : 0);

    var pos = document.getElementById("positions");
    pos.replaceChildren(table([
      { h: "Symbol", v: function (p) { return p.symbol; } },
      { h: "Side", v: function (p) { return p.quantity > 0 ? "LONG" : "SHORT"; }, cls: function (p) { return p.quantity > 0 ? "up" : "down"; } },
      { h: "Qty", r: 1, v: function (p) { return Math.abs(p.quantity).toLocaleString(); } },
      { h: "Avg", r: 1, v: function (p) { return p.avgPrice.toFixed(2); } },
      { h: "Last", r: 1, v: function (p) { return p.lastPrice.toFixed(2); } },
      { h: "Value", r: 1, v: function (p) { return num(Math.abs(p.marketValue)); } },
      { h: "P&L", r: 1, v: function (p) { return snum(p.unrealizedPnl); }, cls: function (p) { return tone(p.unrealizedPnl); } },
      { h: "%", r: 1, v: function (p) { return pct(p.unrealizedPct); }, cls: function (p) { return tone(p.unrealizedPnl); } }
    ], s.positions));

    var fills = document.getElementById("fills");
    fills.replaceChildren(table([
      { h: "Time", v: function (f) { return time(f.time); } },
      { h: "Side", v: function (f) { return (f.reason === "margin_call" ? "⚠ " : "") + f.side.toUpperCase(); }, cls: function (f) { return f.side === "buy" ? "up" : "down"; } },
      { h: "Symbol", v: function (f) { return f.symbol; } },
      { h: "Qty", r: 1, v: function (f) { return f.quantity.toLocaleString(); } },
      { h: "Price", r: 1, v: function (f) { return f.price.toFixed(2); } },
      { h: "Realized", r: 1, v: function (f) { return f.realizedPnl ? snum(f.realizedPnl) : "-"; }, cls: function (f) { return tone(f.realizedPnl); } }
    ], s.fills));

    var act = document.getElementById("activity");
    act.replaceChildren();
    if (!s.activity.length) act.appendChild(el("div", "empty", "No turns yet."));
    s.activity.forEach(function (t) {
      var box = el("div", "turn");
      box.appendChild(el("div", "meta", time(t.time) + (t.source ? " · " + t.source : "")));
      if (t.thinking) box.appendChild(el("div", "think", t.thinking));
      if (t.tools.length) {
        var chips = el("div", "chips");
        t.tools.forEach(function (c) {
          var chip = el("div", "chip " + (c.ok ? "ok" : "err"));
          chip.title = c.summary;
          chip.appendChild(el("b", null, (c.ok ? "✓ " : "✗ ") + c.name));
          chip.appendChild(document.createTextNode(" " + c.summary));
          chips.appendChild(chip);
        });
        box.appendChild(chips);
      }
      act.appendChild(box);
    });

    var den = document.getElementById("denials");
    den.replaceChildren();
    if (!s.denials.length) den.appendChild(el("div", "empty", "Nothing blocked."));
    s.denials.forEach(function (d) {
      var row = el("div", "deny");
      row.appendChild(el("b", null, d.tool));
      row.appendChild(document.createTextNode(" · " + time(d.time) + " · " + d.reason));
      den.appendChild(row);
    });

    document.getElementById("journal").textContent = s.journal || "The agent has not written ~/.automaton/journal.md yet.";
  }

  function tick() {
    fetch(api, { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (s) { render(s); lastOk = Date.now(); lastState = s; })
      .catch(function () {})
      .finally(function () {
        var stale = Date.now() - lastOk > 15000;
        document.getElementById("dot").className = "dot" + (stale ? " stale" : "");
        document.getElementById("updated").textContent = lastOk
          ? (stale ? "connection lost · " : "live · ") + "updated " + ago(new Date(lastOk).toISOString()) + (lastState ? " · last turn " + ago(lastState.agent.lastTurnAt) : "")
          : "connecting…";
      });
  }
  tick();
  setInterval(tick, 3000);
})();
</script>
</body>
</html>`;
