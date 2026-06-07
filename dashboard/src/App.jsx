import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend, Cell,
} from "recharts";

/* ---------- theme ---------- */
const TEAM_COLORS = { A: "#ff3355", B: "#00e0c6", C: "#b06bff", D: "#43d977", E: "#ffa23a", F: "#5a8dee", G: "#e85bd0" };
const DRIVER_PALETTE = [
  "#ff3355", "#00e0c6", "#b06bff", "#43d977", "#ffce3a", "#ff7c2a",
  "#38b6ff", "#e055a3", "#a8e63d", "#00bfa5", "#ff6b6b", "#c084fc",
];
const AMBER = "#ffce3a";

/* display-only: tidy an over-grabbed session label for grouping/headers.
   Mirrors the scraper's clean_label so existing JSON renders cleanly too. */
const tidyLabel = (s) =>
  (String(s || "")
    .split(/\s+(?:Confirmed|Live|Provisional|Unconfirmed|Result)\b|\s+[·\u00b7]\s+|\s+\d{1,2}:\d{2}\b|\s+Winner:/)[0]
    .trim()) || "Session";

/* ---------- lineup CSV import ---------- */
const teamLetterFrom = (s) => {
  const m = String(s || "").match(/\b([A-G])\b/i);
  return m ? m[1].toUpperCase() : null;
};
const raceToken = (s) => {
  s = String(s || "").toLowerCase();
  let m = s.match(/race\s*0*(\d+)/); if (m) return "race" + m[1];
  m = s.match(/practice\s*0*(\d+)/); if (m) return "practice" + m[1];
  if (/quali/.test(s)) return "qualifying";
  return s.replace(/[^a-z0-9]/g, "");
};
/* the heat number a session belongs to (works for "Race 4" and "Race 1: ... Qualifying").
   Inters: practice/quali/race of the same heat share one driver, so this unifies them. */
const sessionHeat = (label) => {
  // strip "Round N" first so the round number is never mistaken for the heat,
  // then take the Practice/Race/Qualifying/Heat number. Practice 3, Quali 3 and
  // Race 3 all resolve to heat 3 so one driver name covers them.
  let s = String(label || "").replace(/round\s*\d+/i, "");
  const m = s.match(/(?:race|practice|heat|qualifying|quali)\s*0*(\d+)/i) || s.match(/^\s*0*(\d+)\b/);
  return m ? Number(m[1]) : null;
};
const sessionKind = (label) => {
  const s = String(label || "").toLowerCase();
  if (/quali/.test(s)) return "Quali";
  if (/practice/.test(s)) return "Practice";
  return "Race";
};
function parseLineupCsv(text) {
  const rows = [];
  String(text).split(/\r?\n/).forEach((line) => {
    if (!line.trim()) return;
    const parts = (line.includes(",") ? line.split(",") : line.split(/\s*-\s*/)).map((p) => p.trim());
    if (parts.length < 3) return;
    const [team, race, driver] = parts;
    if (/^team$/i.test(team)) return; // skip header row
    if (team && race && driver) rows.push({ team, race, driver });
  });
  return rows;
}
function matchLineup(entries, rows) {
  const assignments = {};
  rows.forEach((r) => {
    const letter = teamLetterFrom(r.team);
    const rtok = raceToken(r.race);
    entries.forEach((e) => {
      const teamOk = letter ? e.teamLetter === letter
        : e.teamName.toLowerCase().includes(r.team.toLowerCase());
      const raceOk = raceToken(e.session.raceLabel) === rtok
        || tidyLabel(e.session.raceLabel).toLowerCase().includes(r.race.toLowerCase());
      if (teamOk && raceOk) assignments[e.key] = r.driver;
    });
  });
  return assignments;
}

function makeDriverColorMap(entries, assign) {
  const map = {};
  let idx = 0;
  entries.forEach((e) => {
    const driver = assign[e.key]?.trim();
    if (driver && !map[driver]) map[driver] = DRIVER_PALETTE[idx++ % DRIVER_PALETTE.length];
  });
  return map;
}

/* ---------- stats helpers ---------- */
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const b = Math.floor(pos), rest = pos - b;
  return sorted[b + 1] !== undefined ? sorted[b] + rest * (sorted[b + 1] - sorted[b]) : sorted[b];
};
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const fmt = (t) => (t == null ? "—" : t.toFixed(3));
const splitClean = (laps, factor = 1.10) => {
  const valid = laps.filter((x) => x != null && !isNaN(x));
  if (!valid.length) return { clean: [], incidents: [] };
  const med = quantile([...valid].sort((a, b) => a - b), 0.5);
  const clean = [], incidents = [];
  valid.forEach((x) => (x <= med * factor ? clean : incidents).push(x));
  return { clean, incidents };
};

function kartLaps(session, num, teamName) {
  const cleanTeamKey = teamName ? teamName.toLowerCase().trim() : "";
  const series = session.laps
    .map((l) => {
      const t = l.times[num] || l.times[cleanTeamKey];
      return { lap: l.lap, t };
    })
    .filter((x) => x.t != null);
    
  const { clean, incidents } = splitClean(series.map((x) => x.t));
  const cleanSet = new Set(clean);
  return { series, clean, incidents, cleanSet };
}

function fieldStats(session) {
  const pooled = [];
  const fieldKarts = (session.allKarts && session.allKarts.length) ? session.allKarts : session.karts;
  fieldKarts.forEach((k) => {
    const ls = session.laps.map((l) => l.times[k.num] || l.times[(k.teamName || "").toLowerCase().trim()]).filter((x) => x != null);
    splitClean(ls).clean.forEach((x) => pooled.push(x));
  });
  const sorted = [...pooled].sort((a, b) => a - b);
  return { median: quantile(sorted, 0.5), best: sorted[0] ?? null, n: pooled.length };
}

/* ---------- B Pillar style driver report ---------- */
/* Ranks every kart in a session on the fastest 50% of its clean laps.
   Clean = lap 1 dropped, within 110% of class fastest AND 105% of own fastest.
   Z-score = average per-lap standardised pace vs the field (negative = faster). */
// Reconstruct net positions gained (signed) per kart from lap times alone:
// rank by (laps completed, then cumulative time) at the first lap vs the finish.
function racecraftGain(session) {
  const karts = (session.allKarts || []).map((k) => k.num);
  if (!session.laps || !session.laps.length || karts.length < 2) return {};
  const lap1 = {}, total = {}, done = {};
  karts.forEach((k) => { total[k] = 0; done[k] = 0; });
  session.laps.forEach(({ lap, times }) => {
    karts.forEach((k) => {
      const t = times[k];
      if (t != null) { total[k] += t; done[k] += 1; if (lap === 1) lap1[k] = t; }
    });
  });
  const started = karts.filter((k) => lap1[k] != null);
  const finishers = karts.filter((k) => done[k] > 0);
  if (started.length < 2 || finishers.length < 2) return {};
  const startPos = {}; [...started].sort((a, b) => lap1[a] - lap1[b]).forEach((k, i) => { startPos[k] = i + 1; });
  const finishPos = {}; [...finishers].sort((a, b) => (done[b] - done[a]) || (total[a] - total[b])).forEach((k, i) => { finishPos[k] = i + 1; });
  const gained = {};
  karts.forEach((k) => { if (startPos[k] != null && finishPos[k] != null) gained[k] = startPos[k] - finishPos[k]; });
  return gained;
}

function driverReport(session, leedsNums = [], extraNums = [], removedSet = null) {
  if (!session || !session.laps || !session.laps.length) return null;
  const fieldKarts = (session.allKarts && session.allKarts.length) ? session.allKarts : session.karts;
  const nums = fieldKarts.map((k) => k.num);
  const pool = [];
  session.laps.forEach((l) => { if (l.lap > 1) nums.forEach((n) => { const t = l.times[n]; if (t != null) pool.push(t); }); });
  if (!pool.length) return null;
  const classFastest = Math.min(...pool);
  const lapStats = {};
  session.laps.forEach((l) => {
    if (l.lap <= 1) return;
    const ts = nums.map((n) => l.times[n]).filter((t) => t != null);
    if (ts.length >= 3) lapStats[l.lap] = { m: mean(ts), s: sd(ts) || 1 };
  });
  const rows = fieldKarts.map((k) => {
    const own = session.laps.filter((l) => l.lap > 1)
      .map((l) => ({ lap: l.lap, t: l.times[k.num] })).filter((x) => x.t != null);
    const total = session.laps.filter((l) => l.times[k.num] != null).length;
    if (!own.length) return null;
    const fastest = Math.min(...own.map((x) => x.t));
    const valid = own.filter((x) => x.t <= classFastest * 1.10 && x.t <= fastest * 1.05).sort((a, b) => a.t - b.t);
    const shown = valid.slice(0, Math.max(1, Math.ceil(valid.length * 0.5)));
    const times = shown.map((x) => x.t);
    const zs = shown.map((x) => (lapStats[x.lap] ? (x.t - lapStats[x.lap].m) / lapStats[x.lap].s : null)).filter((z) => z != null);
    const m = k.teamName.match(/\b([A-G])\b/i);
    const isLeedsProper = /leeds/i.test(k.teamName) && !/beckett/i.test(k.teamName);
    const isRemoved = removedSet && removedSet.has(`${session.id}|${k.num}`);
    const isLeeds = !isRemoved && (isOurTeam(k.teamName, leedsNums) || (extraNums || []).includes(String(k.num)));
    return {
      num: k.num, team: k.teamName, isLeeds, teamLetter: isLeedsProper && m ? m[1].toUpperCase() : null,
      fastest, avg: mean(times), sd: sd(times), z: zs.length ? mean(zs) : null,
      shown: shown.length, total, times,
    };
  }).filter(Boolean).sort((a, b) => a.avg - b.avg);
  return { classFastest, rows };
}

function ReportTable({ report, nameOf }) {
  const all = report.rows.flatMap((r) => r.times);
  if (!all.length) return <Empty msg="No lap data in this session." />;
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.05 || 0.5; lo -= pad; hi += pad;
  const PW = 360;
  const x = (t) => ((t - lo) / (hi - lo)) * PW;
  const ticks = Array.from({ length: 6 }, (_, i) => lo + (i / 5) * (hi - lo));
  const col = (r) => (r.isLeeds ? (TEAM_COLORS[r.teamLetter] || AMBER) : "#48566a");
  const cell = { padding: "0 8px", textAlign: "right", color: "#c2cbd6" };
  const head = { padding: "4px 8px", textAlign: "right", color: "#6b7685", fontWeight: 500, letterSpacing: "0.5px", cursor: "pointer", userSelect: "none" };
  const [sort, setSort] = useState({ key: "avg", dir: "asc" });
  const arrow = (k) => (sort.key === k ? (sort.dir === "asc" ? " ▴" : " ▾") : "");
  const hCol = (k) => (sort.key === k ? AMBER : "#6b7685");
  const clickSort = (k) => () => setSort((s) => ({ key: k, dir: s.key === k && s.dir === "asc" ? "desc" : "asc" }));
  const rows = [...report.rows].sort((a, b) => {
    const m = sort.dir === "asc" ? 1 : -1, k = sort.key;
    if (k === "driver") return m * String(nameOf(a.num) || a.team).localeCompare(String(nameOf(b.num) || b.team));
    const av = a[k] == null ? Infinity : a[k], bv = b[k] == null ? Infinity : b[k];
    return m * (av - bv);
  });
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ minWidth: 760 }}>
        {/* header */}
        <div className="mono" style={{ display: "grid", gridTemplateColumns: `28px 190px ${PW}px 64px 64px 56px 52px 64px`,
          alignItems: "end", fontSize: 10.5, borderBottom: "1px solid #1e2733", paddingBottom: 4 }}>
          <div style={head}>#</div>
          <div style={{ ...head, textAlign: "left", color: hCol("driver") }} onClick={clickSort("driver")}>DRIVER / KART{arrow("driver")}</div>
          <svg width={PW} height="16" style={{ overflow: "visible" }}>
            {ticks.map((tv, i) => (
              <text key={i} x={x(tv)} y="12" textAnchor="middle" fill="#5b6776" fontSize="9.5" fontFamily="IBM Plex Mono">
                {tv.toFixed(1)}
              </text>
            ))}
          </svg>
          <div style={{ ...head, color: hCol("avg") }} onClick={clickSort("avg")}>AVG{arrow("avg")}</div>
          <div style={{ ...head, color: hCol("fastest") }} onClick={clickSort("fastest")}>FAST{arrow("fastest")}</div>
          <div style={{ ...head, color: hCol("sd") }} onClick={clickSort("sd")}>STD{arrow("sd")}</div>
          <div style={{ ...head, color: hCol("z") }} onClick={clickSort("z")}>Z{arrow("z")}</div>
          <div style={{ ...head, color: hCol("shown") }} onClick={clickSort("shown")}>SHOWN{arrow("shown")}</div>
        </div>
        {/* rows */}
        {rows.map((r, i) => {
          const s = [...r.times].sort((a, b) => a - b);
          const q1 = quantile(s, 0.25), med = quantile(s, 0.5), q3 = quantile(s, 0.75);
          const c = col(r);
          const driver = nameOf(r.num);
          return (
            <div key={r.num} className="mono" style={{ display: "grid",
              gridTemplateColumns: `28px 190px ${PW}px 64px 64px 56px 52px 64px`, alignItems: "center",
              fontSize: 11.5, padding: "3px 0", borderBottom: "1px solid #0e141c",
              background: r.isLeeds ? `${c}10` : "transparent" }}>
              <div style={{ ...cell, textAlign: "center", color: "#5b6776" }}>{i + 1}</div>
              <div style={{ padding: "0 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <span style={{ color: r.isLeeds ? c : "#c2cbd6", fontWeight: r.isLeeds ? 600 : 400 }}>
                  {driver || r.team}
                </span>
                <span style={{ color: "#5b6776" }}> #{r.num}</span>
              </div>
              <svg width={PW} height="18" style={{ overflow: "visible" }}>
                <line x1={x(s[0])} x2={x(s[s.length - 1])} y1="9" y2="9" stroke={c} strokeOpacity="0.5" strokeWidth="1" />
                <rect x={x(q1)} y="4" width={Math.max(1, x(q3) - x(q1))} height="10" fill={c} fillOpacity="0.18" stroke={c} strokeWidth="1" rx="1" />
                <line x1={x(med)} x2={x(med)} y1="3" y2="15" stroke={c} strokeWidth="1.8" />
                {r.times.map((t, j) => <circle key={j} cx={x(t)} cy="9" r="2" fill={c} fillOpacity={r.isLeeds ? 0.95 : 0.55} />)}
              </svg>
              <div style={{ ...cell, color: "#e6edf3" }}>{fmt(r.avg)}</div>
              <div style={cell}>{fmt(r.fastest)}</div>
              <div style={cell}>{r.sd.toFixed(3)}</div>
              <div style={{ ...cell, color: r.z == null ? "#5b6776" : r.z <= 0 ? "#43d977" : "#ff8a5b" }}>
                {r.z == null ? "—" : (r.z <= 0 ? "" : "+") + r.z.toFixed(2)}
              </div>
              <div style={{ ...cell, color: "#8b97a7" }}>{r.shown}/{r.total}</div>
            </div>
          );
        })}
      </div>
      <div className="mono" style={{ fontSize: 10, color: "#5b6776", marginTop: 12, lineHeight: 1.5 }}>
        Ranked on the fastest 50% of laps, excluding lap 1, within 110% of class fastest and 105% of the driver's own fastest.
        Z-score is average per-lap pace vs the field (negative = faster). Clear-air % and overtakes aren't shown — BUKC timing data doesn't expose traffic position per lap.
      </div>
    </div>
  );
}

/* ---------- box plot ---------- */
function BoxPlot({ boxes, fieldMedian }) {
  const allClean = boxes.flatMap((b) => b.clean).filter((x) => x != null && !isNaN(x));
  if (!allClean.length) return <Empty msg="No clean lap sheets data found to visualize." />;

  const sortedLaps = [...allClean].sort((a, b) => a - b);
  
  let lo = quantile(sortedLaps, 0.01);
  let hi = quantile(sortedLaps, 0.99);
  
  if (hi - lo < 0.5) {
    lo -= 1;
    hi += 1;
  } else {
    const paddingMultiplier = (hi - lo) * 0.20;
    lo = Math.max(0, lo - paddingMultiplier);
    hi = hi + paddingMultiplier;
  }

  const W = Math.max(800, boxes.length * 115 + 140), H = 500;
  const padL = 70, padR = 40, padT = 40, padB = 120;

  const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
  const bw = (W - padL - padR) / boxes.length;

  const delta = hi - lo;
  let gapInterval = 1;
  if (delta > 60) gapInterval = 10;
  else if (delta > 40) gapInterval = 5;
  else if (delta > 20) gapInterval = 2;
  else if (delta > 8) gapInterval = 1;
  else gapInterval = 0.5;

  const initialTick = Math.ceil(lo / gapInterval) * gapInterval;
  const customGridTicks = [];
  for (let tick = initialTick; tick <= hi; tick += gapInterval) {
    customGridTicks.push(tick);
  }

  return (
    <div style={{ overflowX: "auto", background: "#0a0e14", borderRadius: 8, padding: "8px" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: W, display: "block" }}>
        {customGridTicks.map((tv, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(tv)} y2={y(tv)} stroke="#1e293b" strokeWidth="1" strokeDasharray="4 4" />
            <text x={padL - 12} y={y(tv) + 4} textAnchor="end" fill="#64748b"
              fontSize="11" fontFamily="IBM Plex Mono, monospace">{tv.toFixed(1)}s</text>
          </g>
        ))}
        
        {fieldMedian != null && y(fieldMedian) >= padT && y(fieldMedian) <= H - padB && (
          <g>
            <line x1={padL} x2={W - padR} y1={y(fieldMedian)} y2={y(fieldMedian)}
              stroke={AMBER} strokeWidth="2" strokeDasharray="6 4" opacity="0.9" />
            <text x={W - padR - 6} y={y(fieldMedian) - 8} textAnchor="end" fill={AMBER}
              fontSize="11" fontWeight="600" fontFamily="IBM Plex Mono, monospace" letterSpacing="0.5">
              FIELD MEDIAN {fieldMedian.toFixed(3)}s
            </text>
          </g>
        )}

        {boxes.map((b, i) => {
          const cx = padL + bw * (i + 0.5);
          const halfBoxWidth = Math.min(35, bw * 0.35);
          const s = [...b.clean].sort((a, x) => a - x);
          if (!s.length) return null;

          const q1 = quantile(s, 0.25), med = quantile(s, 0.5), q3 = quantile(s, 0.75);
          const mn = s[0], mx = s[s.length - 1], mu = mean(s);
          const col = b.color;

          const safetyClampY = (val) => Math.max(padT, Math.min(H - padB, y(val)));

          return (
            <g key={i}>
              <line x1={cx} x2={cx} y1={safetyClampY(mx)} y2={safetyClampY(q3)} stroke={col} strokeWidth="1.5" />
              <line x1={cx} x2={cx} y1={safetyClampY(q1)} y2={safetyClampY(mn)} stroke={col} strokeWidth="1.5" />
              
              {y(mx) >= padT && y(mx) <= H - padB && (
                <line x1={cx - halfBoxWidth * 0.5} x2={cx + halfBoxWidth * 0.5} y1={y(mx)} y2={y(mx)} stroke={col} strokeWidth="1.5" />
              )}
              {y(mn) >= padT && y(mn) <= H - padB && (
                <line x1={cx - halfBoxWidth * 0.5} x2={cx + halfBoxWidth * 0.5} y1={y(mn)} y2={y(mn)} stroke={col} strokeWidth="1.5" />
              )}

              <rect x={cx - halfBoxWidth} y={safetyClampY(q3)} width={halfBoxWidth * 2} height={Math.max(3, safetyClampY(q1) - safetyClampY(q3))}
                fill={col} fillOpacity="0.16" stroke={col} strokeWidth="1.8" rx="3" />
              
              <line x1={cx - halfBoxWidth} x2={halfBoxWidth + cx} y1={safetyClampY(med)} y2={safetyClampY(med)} stroke={col} strokeWidth="3" />
              
              <line x1={cx - halfBoxWidth} x2={halfBoxWidth + cx} y1={safetyClampY(mu)} y2={safetyClampY(mu)} stroke="#cbd5e1"
                strokeWidth="1.2" strokeDasharray="3 3" opacity="0.65" />

              {b.incidents.map((iv, j) => {
                const outlierY = y(iv);
                if (outlierY < padT || outlierY > H - padB) return null; 
                return (
                  <circle key={j} cx={cx} cy={outlierY} r="3.5" fill="none" stroke={col} strokeOpacity="0.55" strokeWidth="1.2" />
                );
              })}

              <text x={cx} y={H - padB + 24} textAnchor="end" fill="#e2e8f0" fontSize="12"
                fontWeight="500" fontFamily="IBM Plex Sans, sans-serif" transform={`rotate(-32 ${cx} ${H - padB + 24})`}>
                {b.label}
              </text>
              <text x={cx} y={H - padB + 42} textAnchor="end" fill="#475569" fontSize="10.5"
                fontFamily="IBM Plex Mono, monospace" transform={`rotate(-32 ${cx} ${H - padB + 42})`}>
                {b.sub}
              </text>
            </g>
          );
        })}
        <text x={14} y={(H - padB) / 2} fill="#475569" fontSize="11" fontFamily="IBM Plex Sans"
          transform={`rotate(-90 14 ${(H - padB) / 2})`} textAnchor="middle">LAP TIME (s)</text>
      </svg>
    </div>
  );
}

const Empty = ({ msg }) => (
  <div style={{ padding: "48px 20px", textAlign: "center", color: "#5b6776",
    fontFamily: "IBM Plex Sans", fontSize: 14 }}>{msg}</div>
);

/* ---------- app ---------- */
const parseSecs = (v) => {
  if (v == null) return null;
  const str = String(v);
  const s = str.includes(":") ? parseFloat(str.split(":")[0]) * 60 + parseFloat(str.split(":")[1]) : parseFloat(str);
  return (!isNaN(s) && s > 0) ? Math.round(s * 1000) / 1000 : null;
};

// persistence — saves roster/extras between visits on this device
const LS = (k, fallback) => { try { const v = localStorage.getItem("pitwall_" + k); return v != null ? JSON.parse(v) : fallback; } catch { return fallback; } };
const saveLS = (k, v) => { try { localStorage.setItem("pitwall_" + k, JSON.stringify(v)); } catch {} };
const isOurTeam = (teamName, extraTeams = []) => {
  const t = (teamName || "").toLowerCase();
  if (t.includes("leeds") && !t.includes("beckett")) return true;
  return extraTeams.some((x) => x && t.includes(x.toLowerCase()));
};
function convertEvent(data, extraTeams = [], extraNums = []) {
  if (!data || !data.sessions) return [];
  return data.sessions.map((s) => {
    const raceLabel = s.label || `Race ${s.session_id}`;
    const round = data.title || "Round";
    const isRound = /(?:mains|inters)\s*round\s*\d+/i.test(round);
    const category = /main/i.test(round) ? "Mains" : /inter/i.test(round) ? "Inters" : "Other";
    const ours = (r) => isOurTeam(r.team, extraTeams) || extraNums.includes(String(r.kart || ""));
    const karts = (s.results || []).filter(ours).map((r) => ({ num: String(r.kart || ""), teamName: r.team })).filter((k) => k.num);
    let laps = [];
    if (s.lap_times && s.lap_times.length > 0) {
      const maxLaps = Math.max(...s.lap_times.map((d) => (d.laps ? d.laps.length : 0)));
      for (let i = 0; i < maxLaps; i++) {
        const times = {};
        s.lap_times.forEach((d) => {
          const secs = d.laps && d.laps[i] != null ? parseSecs(d.laps[i]) : null;
          if (secs != null) { if (d.kart) times[String(d.kart)] = secs; if (d.team) times[d.team.toLowerCase().trim()] = secs; }
        });
        if (Object.keys(times).length > 0) laps.push({ lap: i + 1, times });
      }
    }
    if (laps.length === 0) {
      const times = {};
      (s.results || []).filter(ours).forEach((r) => {
        const secs = parseSecs(r.best_lap_time);
        if (secs != null) { times[String(r.kart)] = secs; if (r.team) times[r.team.toLowerCase().trim()] = secs; }
      });
      if (Object.keys(times).length > 0) laps.push({ lap: 1, times });
    }
    const seen = new Set(); const allKarts = [];
    (s.results || []).forEach((r) => { const num = String(r.kart || ""); if (num && !seen.has(num)) { seen.add(num); allKarts.push({ num, teamName: r.team || num }); } });
    return { id: `scraped__${s.session_id}`, name: s.label, title: s.label, round, isRound, category, raceLabel, karts, allKarts, laps,
      penalties: (s.penalties || []).filter((p) => isOurTeam(p.team, extraTeams) || extraNums.includes(String(p.kart || ""))),
      posByKart: Object.fromEntries((s.results || []).map((r) => [String(r.kart), Number(r.position_change) || 0])),
      finByKart: Object.fromEntries((s.results || []).map((r) => [String(r.kart), Number(r.position) || null])),
      ptsByKart: Object.fromEntries((s.results || []).map((r) => [String(r.kart), Number(r.points) || 0])),
      sectorsByKart: Object.fromEntries((s.results || []).map((r) => [String(r.kart), {
        s1: parseSecs(r.sector_1), s2: parseSecs(r.sector_2), s3: parseSecs(r.sector_3),
        ult: parseSecs(r.ultimate_lap), best: parseSecs(r.best_lap_time),
      }])),
      kartIndex: Object.fromEntries(karts.map((k) => [k.num, k.teamName])) };
  });
}

export default function App() {
  const [assign, setAssign] = useState(() => LS("assign", {}));
  const [importMsg, setImportMsg] = useState("");
  const csvRef = useRef();
  const [tab, setTab] = useState("scraped");   const [cleanOnly, setCleanOnly] = useState(true);
  const [reportSession, setReportSession] = useState(null);
  const [sectorSession, setSectorSession] = useState(null);
  const [ratingScope, setRatingScope] = useState("season");
  const [debrief, setDebrief] = useState("");
  const [debriefLoading, setDebriefLoading] = useState(false);
  const [ratingSort, setRatingSort] = useState({ key: "overall", dir: "desc" });
  const [debriefScope, setDebriefScope] = useState("overall");
  const [debriefTime, setDebriefTime] = useState("season");
  const [statsView, setStatsView] = useState("drivers");
  const [statsMode, setStatsMode] = useState("cards");
  const [statsCat, setStatsCat] = useState("all");
  const [progSel, setProgSel] = useState(null);
  const [statsSort, setStatsSort] = useState({ key: "points", dir: "desc" });
  const [traceType, setTraceType] = useState("all");
  const [adminPw, setAdminPw] = useState("");
  const [syncMsg, setSyncMsg] = useState("");
  const [syncing, setSyncing] = useState(false);

  // pull the shared global roster on load (network is the team source of truth, local is fallback)
  useEffect(() => {
    fetch("/api/roster").then((r) => r.json())
      .then((d) => { if (d && d.roster && Object.keys(d.roster).length) setAssign((prev) => ({ ...prev, ...d.roster })); })
      .catch(() => {});
  }, []);

  const syncRoster = async () => {
    setSyncing(true); setSyncMsg("");
    try {
      const res = await fetch("/api/roster", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ roster: assign, adminPassword: adminPw }) });
      const d = await res.json();
      setSyncMsg(res.ok && d.ok ? `✓ Synced ${d.count} names to the global roster.` : (d.error || "Sync failed."));
    } catch { setSyncMsg("Couldn't reach the sync service (only works on the live site)."); }
    setSyncing(false);
  };
  const [extraList, setExtraList] = useState(() => {
    const v = LS("extra", []);
    if (Array.isArray(v)) return v;
    if (typeof v === "string" && v.trim()) return v.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
    return [];
  });
  const [extraDraft, setExtraDraft] = useState("");
  const [compareIds, setCompareIds] = useState(() => LS("compareIds", []));
  const [compareCache, setCompareCache] = useState({});
  const [seasonRaws, setSeasonRaws] = useState({});
  const [removed, setRemoved] = useState(() => new Set(LS("removed", [])));
  const [compareOpen, setCompareOpen] = useState(false);
  const [wetSessions, setWetSessions] = useState(() => new Set(LS("wet", [])));
  useEffect(() => { saveLS("wet", [...wetSessions]); }, [wetSessions]);

  useEffect(() => { saveLS("assign", assign); }, [assign]);
  useEffect(() => { saveLS("extra", extraList); }, [extraList]);
  useEffect(() => { saveLS("compareIds", compareIds); }, [compareIds]);
  useEffect(() => { saveLS("removed", [...removed]); }, [removed]);
  
  const [eventIndex, setEventIndex] = useState([]);
  const [activeEventId, setActiveEventId] = useState(null);
  const [scrapedEventData, setScrapedEventData] = useState(null);
  const [loadError, setLoadError] = useState("");

  // Load the season index once. The scraper writes index.json listing every round it pulled.
  useEffect(() => {
    fetch("/index.json")
      .then((r) => r.text())
      .then((t) => {
        const idx = JSON.parse(t.replace(/\uFFFD/g, "·"));
        const evs = (idx.events || []).map((e) => {
          const m = String(e.title || "").match(/(Mains|Inters)\s*Round\s*(\d+)/i);
          return {
            id: String(e.event_public_id),
            title: e.title || `Event ${e.event_public_id}`,
            file: e.file || `${e.event_public_id}.json`,
            category: m ? (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) : "Other",
            round: m ? Number(m[2]) : 999,
            date: e.date || null,
          };
        });
        setEventIndex(evs);
        const firstReal = evs.find((e) => e.category === "Mains" || e.category === "Inters") || evs[0];
        setActiveEventId((cur) => cur || (firstReal && firstReal.id) || null);
      })
      .catch(() => { setEventIndex([]); setLoadError("No index.json found — run the scraper into dashboard/public to populate rounds."); });
  }, []);

  // Load the selected round's data.
  useEffect(() => {
    if (!activeEventId) return;
    const ev = eventIndex.find((e) => e.id === activeEventId);
    const url = ev ? `/${ev.file}` : `/${activeEventId}.json`;
    setReportSession(null);
    fetch(url)
      .then((r) => r.text())
      .then((t) => { setScrapedEventData(JSON.parse(t.replace(/\uFFFD/g, "·"))); setLoadError(""); })
      .catch(() => { setScrapedEventData(null); setLoadError(`Couldn't load ${url}`); });
  }, [activeEventId, eventIndex]);

  const { extraTeams, extraNums } = useMemo(() => {
    const toks = extraList.map((t) => t.trim()).filter(Boolean);
    return { extraTeams: toks.filter((t) => !/^\d+$/.test(t)), extraNums: toks.filter((t) => /^\d+$/.test(t)) };
  }, [extraList]);
  const addExtra = () => { const t = extraDraft.trim(); if (t && !extraList.includes(t)) setExtraList((p) => [...p, t]); setExtraDraft(""); };

  const convertedSessions = useMemo(() => {
    const raws = [scrapedEventData, ...compareIds.map((id) => compareCache[id])].filter(Boolean);
    const seen = new Set();
    return raws
      .flatMap((raw) => convertEvent(raw, extraTeams, extraNums))
      .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  }, [scrapedEventData, compareIds, compareCache, extraTeams, extraNums]);

  // load every round in the season (for whole-season driver ratings)
  useEffect(() => {
    eventIndex.forEach((e) => {
      if (seasonRaws[e.id]) return;
      fetch(`/${e.file}`).then((r) => r.text())
        .then((t) => { const j = JSON.parse(t.replace(/\uFFFD/g, "·")); setSeasonRaws((c) => ({ ...c, [e.id]: j })); })
        .catch(() => {});
    });
  }, [eventIndex, seasonRaws]);

  const seasonSessions = useMemo(() => {
    const seen = new Set();
    return Object.values(seasonRaws)
      .flatMap((raw) => convertEvent(raw, extraTeams, extraNums))
      .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  }, [seasonRaws, extraTeams, extraNums]);

  // Pace baseline = the Leeds squad's pace at that track (per race weekend, Mains + Inters pooled),
  // so each driver is measured against the rest of Leeds at the same circuit.
  const roundBaselines = useMemo(() => {
    const evs = [];
    Object.values(seasonRaws).forEach((raw) => {
      if (!raw || !raw.title) return;
      if (!/(?:mains|inters)\s*round\s*\d+/i.test(raw.title)) return;   // special events out of the pace baseline
      let date = null; const leeds = [];
      (raw.sessions || []).forEach((s) => {
        const lab = s.label || s.title || "";
        if (s.date && !date) { const dt = new Date(s.date); if (!isNaN(dt)) date = dt; }
        if (!/race/i.test(lab) || /quali/i.test(lab)) return;
        if (wetSessions.has(`scraped__${s.session_id}`)) return;   // dry laps only in the baseline
        (s.lap_times || []).forEach((e) => {
          if (!(isOurTeam(e.team, extraTeams) || extraNums.includes(String(e.kart || "")))) return;
          const laps = (e.laps || []).map(parseSecs).filter((x) => x != null);
          splitClean(laps).clean.forEach((x) => leeds.push(x));
        });
      });
      evs.push({ title: raw.title, date, leeds });
    });
    const baselines = {};
    const dated = evs.filter((e) => e.date).sort((a, b) => a.date - b.date);
    const weekends = [];
    dated.forEach((e) => {
      let wk = weekends.find((w) => Math.abs(w.date - e.date) <= 10 * 86400000);
      if (!wk) { wk = { date: e.date, laps: [], titles: [] }; weekends.push(wk); }
      wk.laps.push(...e.leeds); wk.titles.push(e.title);
    });
    weekends.forEach((w) => {
      const med = quantile([...w.laps].sort((a, b) => a - b), 0.5);
      w.titles.forEach((t) => { baselines[t] = med; });
    });
    evs.filter((e) => !e.date).forEach((e) => { baselines[e.title] = quantile([...e.leeds].sort((a, b) => a - b), 0.5); });
    return baselines;
  }, [seasonRaws, extraTeams, extraNums, wetSessions]);

  // fetch any selected comparison rounds not yet cached
  useEffect(() => {
    compareIds.forEach((eid) => {
      if (compareCache[eid]) return;
      const ev = eventIndex.find((e) => e.id === eid);
      const url = ev ? `/${ev.file}` : `/${eid}.json`;
      fetch(url).then((r) => r.text())
        .then((t) => { const j = JSON.parse(t.replace(/\uFFFD/g, "·")); setCompareCache((c) => ({ ...c, [eid]: j })); })
        .catch(() => {});
    });
  }, [compareIds, eventIndex, compareCache]);

  // normalised cross-round comparison: each driver's avg clean lap as % off that round's field median
  const compareRows = useMemo(() => {
    const map = {};
    compareIds.forEach((eid) => {
      const raw = compareCache[eid];
      if (!raw) return;
      convertEvent(raw, extraTeams, extraNums).forEach((s) => {
        if (!/race/i.test(s.raceLabel)) return;       // races only
        const fm = fieldStats(s).median;
        if (!fm) return;
        s.karts.forEach((k) => {
          const ls = s.laps.map((l) => l.times[k.num]).filter((x) => x != null);
          const clean = splitClean(ls).clean;
          if (!clean.length) return;
          const pct = (mean(clean) / fm - 1) * 100;   // negative = faster than the field
          const name = assign[`${s.id}|${k.num}`]?.trim() || k.teamName;
          const letter = (k.teamName.match(/\b([A-G])\b/i) || [])[1];
          map[name] = map[name] || { label: name, teamLetter: letter ? letter.toUpperCase() : null, perRound: {} };
          (map[name].perRound[eid] = map[name].perRound[eid] || []).push(pct);
        });
      });
    });
    const rows = Object.values(map).map((r) => {
      const cells = {}; let best = Infinity;
      compareIds.forEach((eid) => {
        const arr = r.perRound[eid];
        if (arr && arr.length) { const v = mean(arr); cells[eid] = v; if (v < best) best = v; }
        else cells[eid] = null;
      });
      return { ...r, cells, best };
    }).filter((r) => Object.values(r.cells).some((v) => v != null));
    rows.sort((a, b) => a.best - b.best);
    return rows;
  }, [compareIds, compareCache, assign, extraTeams, extraNums]);

  const roundLabel = (eid) => {
    const e = eventIndex.find((x) => x.id === eid);
    return e ? `${e.category[0]}${e.round === 999 ? "?" : e.round}` : eid;
  };

  const allEntries = useMemo(() => {
    const rows = [];
    convertedSessions.forEach((s) => {
      s.karts.forEach((k) => {
        const match = k.teamName.match(/\b([A-G])\b/i);
        const teamLetter = match ? match[1].toUpperCase() : "?";
        rows.push({
          sid: s.id,
          session: s,
          num: k.num,
          teamLetter,
          teamName: k.teamName,
          key: `${s.id}|${k.num}`,
        });
      });
    });
    return rows;
  }, [convertedSessions]);

  // entries used by all the analysis views — excludes anything removed in the roster
  const entries = useMemo(() => allEntries.filter((e) => !removed.has(e.key)), [allEntries, removed]);

  const driverColorMap = useMemo(() => makeDriverColorMap(entries, assign), [entries, assign]);

  const colorOf = useCallback((key) => {
    const entry = entries.find((e) => e.key === key);
    if (!entry) return "#8b97a7";
    const driver = assign[key]?.trim();
    return (driver && driverColorMap[driver]) || TEAM_COLORS[entry.teamLetter] || "#8b97a7";
  }, [assign, driverColorMap, entries]);

  const fieldComparisonGroups = useMemo(() => {
    const groups = {};
    
    entries.forEach((e) => {
      if (!/race/i.test(e.session.raceLabel) || /quali/i.test(e.session.raceLabel)) return;  // races only
      const raceName = e.session.raceLabel;
      if (!groups[raceName]) groups[raceName] = [];
      
      const { clean, incidents } = kartLaps(e.session, e.num, e.teamName);
      const driver = assign[e.key]?.trim();
      
      if (clean.length || incidents.length) {
        groups[raceName].push({
          ...e, clean, incidents,
          color: colorOf(e.key),
          label: driver || `${e.teamName}`,
          sub: `#${e.num}`,
          best: clean.length ? Math.min(...clean) : null,
          avg: mean(clean), cons: sd(clean), inc: incidents.length,
        });
      }
    });
    
    const masterDriverBoxes = [];
    const individualDriverPools = {};
    
    entries.forEach((e) => {
      if (!/race/i.test(e.session.raceLabel) || /quali/i.test(e.session.raceLabel)) return;  // races only
      const assignedDriverName = assign[e.key]?.trim();
      const trackableIdentity = assignedDriverName || `${e.teamName} (${e.session.raceLabel})`;
      
      if (!individualDriverPools[trackableIdentity]) {
        individualDriverPools[trackableIdentity] = {
          ...e, clean: [], incidents: [],
          label: trackableIdentity, 
          sub: assignedDriverName ? `Leeds ${e.teamLetter} Overall` : "Stint pooled"
        };
      }
      const { clean, incidents } = kartLaps(e.session, e.num, e.teamName);
      individualDriverPools[trackableIdentity].clean.push(...clean);
      individualDriverPools[trackableIdentity].incidents.push(...incidents);
    });
    
    Object.values(individualDriverPools).forEach((db) => {
      if (db.clean.length || db.incidents.length) {
        const namedDriver = assign[db.key]?.trim();
        masterDriverBoxes.push({
          ...db,
          color: namedDriver ? (driverColorMap[namedDriver] || "#fff") : (TEAM_COLORS[db.teamLetter] || "#8b97a7"),
          best: db.clean.length ? Math.min(...db.clean) : null,
          avg: mean(db.clean), cons: sd(db.clean), inc: db.incidents.length,
        });
      }
    });
    
    if (masterDriverBoxes.length > 0) {
      masterDriverBoxes.sort((a, b) => (a.avg ?? 9e9) - (b.avg ?? 9e9));
      groups["MASTER DRIVER TELEMETRY RANKING (OVERALL ROUND SUMMARY)"] = masterDriverBoxes;
    }
    
    return groups;
  }, [entries, assign, colorOf, driverColorMap]);

  const fieldMed = useMemo(() => {
    if (!convertedSessions.length) return null;
    const meds = convertedSessions.map((s) => fieldStats(s).median).filter((x) => x != null);
    return meds.length ? mean(meds) : null;
  }, [convertedSessions]);

  const [traceKeys, setTraceKeys] = useState(null);
  const activeTrace = traceKeys || entries.map((e) => e.key);
  const traceData = useMemo(() => {
    const maxLap = Math.max(0, ...convertedSessions.flatMap((s) => s.laps.map((l) => l.lap)));
    const data = Array.from({ length: maxLap }, (_, i) => ({ lap: i + 1 }));
    entries.forEach((e) => {
      if (!activeTrace.includes(e.key)) return;
      const { series, cleanSet } = kartLaps(e.session, e.num, e.teamName);
      series.forEach(({ lap, t }) => {
        const row = data[lap - 1];
        if (row) row[e.key] = cleanOnly && !cleanSet.has(t) ? null : t;
      });
    });
    return data;
  }, [entries, activeTrace, convertedSessions, cleanOnly]);

  const progression = useMemo(() => {
    const byDriver = {};
    convertedSessions.forEach((s) => {
      if (!s.isRound || !/race/i.test(s.raceLabel) || /quali/i.test(s.raceLabel)) return;
      // field reference: median of every kart's fastest clean lap this session
      const fieldFastest = (s.allKarts || []).map((k) => {
        const c = splitClean(s.laps.map((l) => l.times[k.num]).filter((x) => x != null)).clean;
        return c.length ? Math.min(...c) : null;
      }).filter((x) => x != null).sort((a, b) => a - b);
      const fieldMedFast = quantile(fieldFastest, 0.5);
      if (fieldMedFast == null) return;
      s.karts.forEach((k) => {
        const driver = assign[`${s.id}|${k.num}`]?.trim();
        if (!driver) return;
        const c = splitClean(s.laps.map((l) => l.times[k.num]).filter((x) => x != null)).clean;
        if (!c.length) return;
        const delta = Math.min(...c) - fieldMedFast;   // fastest lap vs field's median fastest (negative = quicker than field)
        const m = k.teamName.match(/\b([A-G])\b/i);
        byDriver[driver] = byDriver[driver] || { driver, team: m ? m[1].toUpperCase() : null, pts: {} };
        (byDriver[driver].pts[s.round] = byDriver[driver].pts[s.round] || []).push(delta);
      });
    });
    const rounds = [...new Set(convertedSessions.filter((s) => s.isRound).map((s) => s.round))];
    const data = rounds.map((r) => ({ round: r }));
    Object.values(byDriver).forEach((d) => {
      Object.entries(d.pts).forEach(([r, arr]) => {
        const row = data.find((x) => x.round === r);
        if (row) row[d.driver] = Math.round(mean(arr) * 100) / 100;
      });
    });
    return { data, drivers: Object.values(byDriver) };
  }, [convertedSessions, assign]);

  const leedsOverallStandings = useMemo(() => {
    if (!scrapedEventData || !scrapedEventData.overall_result) return [];
    return scrapedEventData.overall_result.filter(row => 
      row.team && row.team.toLowerCase().includes("leeds") && !row.team.toLowerCase().includes("beckett")
    );
  }, [scrapedEventData]);

  const hasData = scrapedEventData !== null;

  // Special events (Drivers Champ, Qualifiers, testing) — shown separately, never in the round maths
  const specialEvents = useMemo(() => {
    return Object.values(seasonRaws)
      .filter((r) => r && r.title && !/(?:mains|inters)\s*round\s*\d+/i.test(r.title))
      .map((r) => ({
        title: r.title,
        date: ((r.sessions || []).find((s) => s.date) || {}).date || null,
        sessions: (r.sessions || [])
          .filter((s) => /race/i.test(s.label || "") && !/practice/i.test(s.label || ""))
          .map((s) => ({
            label: tidyLabel(s.label || ""),
            winner: ((s.results || [])[0] || {}).team || null,
            ours: (s.results || [])
              .filter((x) => isOurTeam(x.team, extraTeams) || extraNums.includes(String(x.kart || "")))
              .map((x) => ({ team: x.team, kart: x.kart, pos: x.position, pts: x.points })),
          })),
      }))
      .filter((e) => e.sessions.length);
  }, [seasonRaws, extraTeams, extraNums]);


  // Season stats: per driver, per team, and overall Leeds
  const stats = useMemo(() => {
    const make = (name) => ({ name, races: 0, points: 0, finishes: [], posch: [], best: [], raceAvg: [], qualiPos: [] });
    const acc = (a, s, k, isRace, ls, clean) => {
      if (isRace) {
        a.races += 1;
        if (s.ptsByKart && s.ptsByKart[k.num] != null) a.points += s.ptsByKart[k.num];
        if (s.finByKart && s.finByKart[k.num] != null) a.finishes.push(s.finByKart[k.num]);
        if (s.posByKart && s.posByKart[k.num] != null) a.posch.push(s.posByKart[k.num]);
        if (ls.length) a.best.push(Math.min(...ls));
        if (clean.length) a.raceAvg.push(mean(clean));
      } else if (s.finByKart && s.finByKart[k.num] != null) a.qualiPos.push(s.finByKart[k.num]);
    };
    const drivers = {}, teams = {}, overall = make("Leeds Overall");
    seasonSessions.forEach((s) => {
      if (!s.isRound) return;   // special events excluded from season stats
      if ((statsCat === "mains" || statsCat === "inters") && (s.category || "").toLowerCase() !== statsCat) return;
      const isQuali = /quali/i.test(s.raceLabel);
      const isRace = /race/i.test(s.raceLabel) && !isQuali;
      if (!isRace && !isQuali) return;
      s.karts.forEach((k) => {
        const key = `${s.id}|${k.num}`;
        if (removed.has(key)) return;   // skip removed (e.g. non-Leeds renters in a paid-seat kart)
        if (!["all", "mains", "inters"].includes(statsCat) && k.teamName !== statsCat) return;
        const ls = s.laps.map((l) => l.times[k.num]).filter((x) => x != null);
        const clean = splitClean(ls).clean;
        const isRealLeeds = /leeds/i.test(k.teamName) && !/beckett/i.test(k.teamName);
        if (isRealLeeds) {   // teams + overall only count genuine Leeds entries, not paid seats under other unis
          teams[k.teamName] = teams[k.teamName] || make(k.teamName);
          acc(teams[k.teamName], s, k, isRace, ls, clean);
          acc(overall, s, k, isRace, ls, clean);
        }
        const dr = assign[key]?.trim();
        if (dr) { drivers[dr] = drivers[dr] || make(dr); acc(drivers[dr], s, k, isRace, ls, clean); }
      });
    });
    const avg = (x) => (x.length ? x.reduce((p, c) => p + c, 0) / x.length : null);
    const sum = (x) => x.reduce((p, c) => p + c, 0);
    const derive = (d) => ({ ...d, avgFinish: avg(d.finishes), totalPosCh: d.posch.length ? sum(d.posch) : null,
      bestLap: d.best.length ? Math.min(...d.best) : null, racePace: avg(d.raceAvg), bestQualiPos: d.qualiPos.length ? Math.min(...d.qualiPos) : null });
    return {
      drivers: Object.values(drivers).map(derive).sort((a, b) => b.points - a.points),
      teams: Object.values(teams).map(derive).sort((a, b) => b.points - a.points),
      overall: derive(overall),
    };
  }, [seasonSessions, assign, removed, statsCat]);

  const leedsTeamNames = useMemo(() => {
    const set = new Set();
    seasonSessions.forEach((s) => s.karts.forEach((k) => { if (/leeds/i.test(k.teamName) && !/beckett/i.test(k.teamName)) set.add(k.teamName); }));
    return [...set].sort();
  }, [seasonSessions]);

  const signedOverview = !!scrapedEventData && (scrapedEventData.sessions || []).some((s) => (s.results || []).some((r) => (r.position_change || 0) < 0));

  // Driver rating /10 from pace (z-score vs field), consistency (lap spread), and racecraft (net positions gained)
  const driverRatings = useMemo(() => {
    const clamp = (v) => Math.max(0, Math.min(10, v));
    const agg = {};
    const sessionsForRating = ratingScope === "season" ? seasonSessions : convertedSessions;
    // racecraft only switches on once the data has the official signed gained/lost (a negative value proves it)
    const signed = sessionsForRating.some((s) => Object.values(s.posByKart || {}).some((v) => v < 0));
    const paceScale = ratingScope === "round" ? 3.5 : 2.5;   // harsher when comparing drivers head-to-head in one round
    sessionsForRating.forEach((s) => {
      if (!s.isRound) return;   // special events (Drivers Champ, testing) don't count to round maths
      if (!/race/i.test(s.raceLabel) || /quali/i.test(s.raceLabel)) return;  // real races only
      const report = driverReport(s, extraTeams, extraNums, removed);
      if (!report) return;
      // field consistency spread this session (cv = lap-time spread %), for relative scoring
      const fieldCvs = (s.allKarts || []).map((k) => {
        const kl = s.laps.map((l) => l.times[k.num]).filter((x) => x != null);
        const kc = splitClean(kl).clean;
        const ka = mean(kc), ks = kc.length > 1 ? sd(kc) : null;
        return (ka && ks != null) ? (ks / ka) * 100 : null;
      }).filter((x) => x != null);
      const cvMean = mean(fieldCvs), cvSd = sd(fieldCvs) || 0.0001;
      const sessionFieldMed = fieldStats(s).median;   // session field median (absorbs wet/dry conditions)
      report.rows.forEach((r) => {
        if (!r.isLeeds) return;
        const name = assign[`${s.id}|${r.num}`]?.trim();
        if (!name) return;   // only rate named drivers, not team-fallback rows
        const ls = s.laps.map((l) => l.times[r.num]).filter((x) => x != null);
        const clean = splitClean(ls).clean;
        const cavg = mean(clean), csd = clean.length > 1 ? sd(clean) : 0;
        const cv = cavg ? (csd / cavg) * 100 : 5;   // this driver's lap-spread %
        const consZ = (cvMean - cv) / cvSd;          // tighter than field = positive
        const isWet = wetSessions.has(s.id);
        agg[name] = agg[name] || { name, team: r.teamLetter, pace: [], cons: [], race: [], gain: [], wet: [], races: 0 };
        if (isWet) {
          if (sessionFieldMed && cavg) agg[name].wet.push(cavg - sessionFieldMed);   // seconds vs the wet session's field median
        } else {
          const baseline = roundBaselines[s.round];                    // dry: vs the Leeds squad at this track
          const pacePct = (baseline && cavg) ? (cavg / baseline - 1) * 100 : null;
          agg[name].pace.push(pacePct != null ? clamp(6 - pacePct * paceScale) : clamp(5 - (r.z ?? 0) * 2.5));
          agg[name].cons.push(clamp(10 - (cv - 1.2) * 3.2));   // absolute lap-spread: tighter cv = higher, always
        }
        const gained = s.posByKart ? s.posByKart[r.num] : null;
        const fin = s.finByKart ? s.finByKart[r.num] : null;
        if (signed && gained != null && fin != null) {
          const start = fin + gained;
          const fieldSize = (s.allKarts || []).length || 20;
          let sc;
          if (fin === 1) sc = 10;                            // won the race — max, you can't lose for winning
          else if (start <= 3 && fin <= 3) sc = 9.5;          // podium retention
          else { const deep = start > fieldSize * 0.6 ? 1.4 : 1; sc = clamp(5.5 + gained * 0.45 * (gained > 0 ? deep : 1)); }
          if (start <= fieldSize * 0.33 && gained >= -2) sc = Math.max(sc, 7.5);  // held a front-third start = good defending
          if ((s.penalties || []).some((p) => String(p.kart) === r.num)) sc = clamp(sc - 3);  // penalty = poor racecraft
          agg[name].race.push(sc); agg[name].gain.push(gained);
        }
        agg[name].races += 1;
      });
    });
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    return Object.values(agg).map((d) => {
      const pace = avg(d.pace), cons = avg(d.cons), race = avg(d.race);
      const hasPace = d.pace.length > 0, hasRace = d.race.length > 0, hasCons = d.cons.length > 0;
      let tot = 0, w = 0;
      if (hasPace) { tot += pace * 0.65; w += 0.65; }
      if (hasRace) { tot += race * 0.20; w += 0.20; }
      if (hasCons) { tot += cons * 0.15; w += 0.15; }
      const overall = w ? tot / w : 0;
      const wetDelta = d.wet.length ? sum(d.wet) / d.wet.length : null;
      return { ...d, pace, cons, race, hasPace, hasRace, hasCons, wetDelta, netGain: sum(d.gain), overall };
    }).sort((a, b) => b.overall - a.overall);
  }, [ratingScope, seasonSessions, convertedSessions, assign, extraTeams, extraNums, roundBaselines, wetSessions]);

  const onLineupCsv = async (file) => {
    if (!file) return;
    try {
      const rows = parseLineupCsv(await file.text());
      const assignments = matchLineup(entries, rows);
      const filled = Object.keys(assignments).length;
      setAssign((p) => ({ ...p, ...assignments }));
      setImportMsg(filled
        ? `Imported ${filled} name${filled === 1 ? "" : "s"} from ${rows.length} row${rows.length === 1 ? "" : "s"}.`
        : `Read ${rows.length} rows but matched none — check the team/race names line up with the loaded event.`);
    } catch (e) {
      setImportMsg(`Couldn't read that file: ${e.message}`);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#07090d", color: "#e6edf3", zoom: 1.18,
      fontFamily: "IBM Plex Sans, system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
        html, body, #root { margin: 0 !important; padding: 0 !important; max-width: none !important; width: 100% !important; display: block !important; place-items: initial !important; text-align: left !important; background: #07090d; }
        * { box-sizing: border-box; }
        .mono { font-family: 'IBM Plex Mono', monospace; }
        .disp { font-family: 'Archivo', sans-serif; letter-spacing: 0.2px; }
        ::-webkit-scrollbar { height: 8px; width: 8px; }
        ::-webkit-scrollbar-thumb { background:#1e2733; border-radius: 4px; }
        .appwrap { padding: 24px 28px; max-width: 1380px; margin: 0 auto; }
        .apphead { padding: 16px 28px; max-width: 1380px; margin: 0 auto; }
        @media (max-width: 680px) {
          .appwrap { padding: 12px 12px; }
          .apphead { padding: 12px 14px; flex-wrap: wrap; gap: 10px; }
          .apptabs button { font-size: 12px !important; padding: 7px 11px !important; }
        }
      `}</style>

      {/* header */}
      <div className="apphead" style={{ borderBottom: "1px solid #161d27",
        display: "flex", alignItems: "center", gap: 16, background: "linear-gradient(180deg,#0b0f15,#07090d)" }}>
        <div style={{ width: 10, height: 30, background: AMBER, borderRadius: 2 }} />
        <div style={{ flex: 1 }}>
          <div className="disp" style={{ fontSize: 23, fontWeight: 700, lineHeight: 1 }}>
            LEEDS MOTORSPORT <span style={{ color: AMBER }}>· TELEMETRY</span>
          </div>
          <div className="mono" style={{ fontSize: 11, color: loadError ? "#ff8a5b" : "#6b7685", marginTop: 4 }}>
            {scrapedEventData?.title ? scrapedEventData.title.toUpperCase() : (loadError || "BUKC PIPELINE ENGINE")}
          </div>
        </div>
        
        {/* round selector — grouped by category, populated from the season index */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#0d141c", border: "1px solid #222c38", padding: "5px 10px", borderRadius: 8 }}>
          <span className="disp" style={{ fontSize: 11.5, color: "#6b7685", fontWeight: 600 }}>ROUND:</span>
          <select className="mono" value={activeEventId || ""} onChange={(e) => setActiveEventId(e.target.value)}
            style={{ background: "#11171f", border: "1px solid #222c38", borderRadius: 6, color: "#e6edf3",
              padding: "5px 8px", fontSize: 12.5, fontFamily: "IBM Plex Mono, monospace", minWidth: 180, cursor: "pointer" }}>
            {eventIndex.length === 0 && <option value="">no rounds — run scraper</option>}
            {["Mains", "Inters", "Other"].filter((cat) => eventIndex.some((e) => e.category === cat)).map((cat) => (
              <optgroup key={cat} label={cat === "Other" ? "Special Events" : cat}>
                {eventIndex.filter((e) => e.category === cat).sort((a, b) => a.round - b.round).map((e) => (
                  <option key={e.id} value={e.id}>{cat === "Other" ? e.title : `${e.category} Round ${e.round === 999 ? "?" : e.round}`}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {/* compare-with: dropdown of extra rounds; they flow into field comparison, progression, report */}
        {eventIndex.length > 1 && (
          <div style={{ position: "relative" }}>
            <button onClick={() => setCompareOpen((o) => !o)} className="disp"
              style={{ display: "flex", alignItems: "center", gap: 8, background: "#0d141c",
                border: `1px solid ${compareIds.length ? AMBER : "#222c38"}`, padding: "6px 12px", borderRadius: 8,
                cursor: "pointer", color: compareIds.length ? AMBER : "#8b97a7", fontSize: 12, fontWeight: 600 }}>
              + COMPARE{compareIds.length ? ` (${compareIds.length})` : ""} ▾
            </button>
            {compareOpen && (
              <div style={{ position: "absolute", top: "112%", left: 0, zIndex: 50, background: "#0d141c",
                border: "1px solid #222c38", borderRadius: 8, padding: 10, minWidth: 210, maxHeight: 300,
                overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
                {["Mains", "Inters"].filter((cat) => eventIndex.some((e) => e.category === cat && e.id !== activeEventId)).map((cat) => (
                  <div key={cat} style={{ marginBottom: 8 }}>
                    <div className="mono" style={{ fontSize: 10, color: "#5b6776", marginBottom: 4 }}>{cat.toUpperCase()}</div>
                    {eventIndex.filter((e) => e.category === cat && e.id !== activeEventId).sort((a, b) => a.round - b.round).map((e) => {
                      const on = compareIds.includes(e.id);
                      return (
                        <label key={e.id} className="mono" style={{ display: "flex", alignItems: "center", gap: 8,
                          padding: "3px 0", fontSize: 12, color: on ? AMBER : "#c2cbd6", cursor: "pointer" }}>
                          <input type="checkbox" checked={on}
                            onChange={() => setCompareIds((p) => on ? p.filter((x) => x !== e.id) : [...p, e.id])} />
                          {e.category} Round {e.round === 999 ? "?" : e.round}
                        </label>
                      );
                    })}
                  </div>
                ))}
                {compareIds.length > 0 && (
                  <button onClick={() => setCompareIds([])} className="mono"
                    style={{ marginTop: 2, fontSize: 11, color: "#ff8a5b", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                    clear all
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="appwrap">
        
        {/* driver assignment — grouped by race, collapsible */}
        {allEntries.length > 0 && (
          <Panel title="01 · ROSTER ASSIGNMENT">
            <div style={{ marginBottom: 14 }}>
              <Label>EXTRA ENTRIES <span style={{ color: "#5b6776" }}>(paid seats under another uni — type a kart number or team, press Enter)</span></Label>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <input value={extraDraft} onChange={(e) => setExtraDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addExtra(); } }}
                  placeholder="e.g. Lancaster B  ↵"
                  style={{ ...inp(220) }} />
                {extraList.map((t) => (
                  <span key={t} className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5,
                    background: "#11233a", border: "1px solid #3da9fc55", borderRadius: 6, padding: "4px 6px 4px 9px", color: "#cfe3ff" }}>
                    {t}
                    <button onClick={() => setExtraList((p) => p.filter((x) => x !== t))}
                      style={{ background: "none", border: "none", color: "#ff8a5b", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}>✕</button>
                  </span>
                ))}
              </div>
            </div>
            <Label>TEAM LINEUPS <span style={{ color: "#5b6776" }}>(name a driver once per heat — quali and race fill together)</span></Label>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
              <button onClick={() => csvRef.current?.click()} className="disp"
                style={{ background: "#11233a", color: AMBER, border: `1px solid ${AMBER}55`, borderRadius: 7,
                  padding: "7px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                ⬆ IMPORT LINEUP CSV
              </button>
              <span className="mono" style={{ fontSize: 11, color: "#5b6776" }}>
                columns: team, race, driver &nbsp;(e.g. Leeds A, Race 1, Sam)
              </span>
              <input ref={csvRef} type="file" accept=".csv,.txt" hidden
                onChange={(ev) => onLineupCsv(ev.target.files?.[0])} />
              {importMsg && <span className="mono" style={{ fontSize: 11.5, color: importMsg.includes("matched none") || importMsg.includes("Couldn't") ? "#ff8a5b" : "#43d977" }}>{importMsg}</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
              <input type="password" value={adminPw} onChange={(e) => setAdminPw(e.target.value)} placeholder="admin password"
                style={{ ...inp(150), fontFamily: "IBM Plex Sans, sans-serif" }} />
              <button onClick={syncRoster} disabled={syncing} className="disp"
                style={{ background: "#11233a", color: "#3da9fc", border: "1px solid #3da9fc55", borderRadius: 7,
                  padding: "7px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                {syncing ? "SYNCING…" : "💾 SYNC GLOBAL ROSTER"}
              </button>
              <span className="mono" style={{ fontSize: 11, color: "#5b6776" }}>pushes this roster to everyone (admin only)</span>
              {syncMsg && <span className="mono" style={{ fontSize: 11.5, color: syncMsg.startsWith("✓") ? "#43d977" : "#ff8a5b" }}>{syncMsg}</span>}
            </div>
            <datalist id="driverNames">
              {[...new Set(Object.values(assign).map((v) => v && v.trim()).filter(Boolean))].map((n) => <option key={n} value={n} />)}
            </datalist>
            {Object.entries(
              allEntries.reduce((acc, e) => {
                const g = `${e.session.round}||${e.teamName}`;
                (acc[g] = acc[g] || []).push(e); return acc;
              }, {})
            ).sort(([a], [b]) => a.localeCompare(b)).map(([groupKey, teamEntries]) => {
              const [roundName, teamName] = groupKey.split("||");
              const letter = (teamName.match(/\b([A-G])\b/i) || [])[1]?.toUpperCase();
              const isLeedsTeam = /leeds/i.test(teamName) && !/beckett/i.test(teamName);
              // Inters: practice/quali heats don't match race heat numbers. Pair by ORDER —
              // first practice/quali listed = first race listed, second = second, etc.
              const pqByHeat = {}, raceByHeat = {};
              teamEntries.forEach((e) => {
                const isRace = sessionKind(e.session.raceLabel) === "Race";
                const h = sessionHeat(e.session.raceLabel);
                const bucket = isRace ? raceByHeat : pqByHeat;
                const key = h != null ? h : 999;
                (bucket[key] = bucket[key] || []).push(e);
              });
              const pqHeats = Object.keys(pqByHeat).map(Number).sort((a, b) => a - b);
              const raceHeats = Object.keys(raceByHeat).map(Number).sort((a, b) => a - b);
              const driverCount = Math.max(pqHeats.length, raceHeats.length);
              const drivers = [];
              for (let i = 0; i < driverCount; i++) {
                const rows = [...(pqByHeat[pqHeats[i]] || []), ...(raceByHeat[raceHeats[i]] || [])];
                if (!rows.length) continue;
                const parts = [];
                if (pqHeats[i] != null) parts.push(`P/Q H${pqHeats[i]}`);
                if (raceHeats[i] != null) parts.push(`Race H${raceHeats[i]}`);
                drivers.push({ rows, label: `Driver ${i + 1}`, sub: parts.join(" → ") });
              }
              const named = drivers.filter((d) => assign[d.rows[0].key]?.trim()).length;
              const col = (isLeedsTeam && letter) ? TEAM_COLORS[letter] : AMBER;
              return (
                <Collapsible key={groupKey} accent={col}
                  title={`${roundName} · ${teamName}`}
                  subtitle={`#${teamEntries[0].num} · ${named}/${drivers.length} drivers named`}>
                  {(() => {
                    const allRemoved = teamEntries.every((e) => removed.has(e.key));
                    return (
                      <button onClick={() => setRemoved((prev) => { const n = new Set(prev); teamEntries.forEach((e) => allRemoved ? n.delete(e.key) : n.add(e.key)); return n; })}
                        className="mono" style={{ marginBottom: 8, fontSize: 10.5, cursor: "pointer", background: "none",
                          border: `1px solid ${allRemoved ? "#43d977" : "#3a2530"}`, borderRadius: 5, padding: "3px 9px", color: allRemoved ? "#43d977" : "#ff8a5b" }}>
                        {allRemoved ? "↺ restore this team this round" : "✕ not our team this round (remove)"}
                      </button>
                    );
                  })()}
                  <div style={{ display: "grid", gap: 6 }}>
                    {drivers.map((d, di) => {
                      const rows = d.rows;
                      const isRemoved = rows.every((r) => removed.has(r.key));
                      return (
                        <div key={di} style={{ display: "flex", alignItems: "center", gap: 10,
                          background: "#080d13", borderRadius: 7, padding: "6px 10px", borderLeft: `3px solid ${col}`,
                          opacity: isRemoved ? 0.4 : 1 }}>
                          <span className="disp" style={{ color: col, fontWeight: 700, width: 64 }}>{d.label}</span>
                          <span className="mono" style={{ color: "#6b7685", fontSize: 10.5, width: 130 }}>{d.sub}</span>
                          <input list="driverNames" placeholder="driver name…" disabled={isRemoved}
                            value={assign[rows[0].key] || ""}
                            onChange={(ev) => {
                              const v = ev.target.value;
                              setAssign((p) => { const n = { ...p }; rows.forEach((r) => { n[r.key] = v; }); return n; });
                            }}
                            style={{ ...inp(180), flex: 1 }} />
                          <button title={isRemoved ? "restore" : "remove this driver's races"}
                            onClick={() => setRemoved((prev) => {
                              const n = new Set(prev);
                              rows.forEach((r) => (isRemoved ? n.delete(r.key) : n.add(r.key)));
                              return n;
                            })}
                            className="mono" style={{ background: "none", border: "none", cursor: "pointer",
                              color: isRemoved ? "#43d977" : "#ff6b6b", fontSize: 14, padding: "0 4px" }}>
                            {isRemoved ? "↺" : "✕"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </Collapsible>
              );
            })}
          </Panel>
        )}

        {hasData && (
          <>
            <div className="apptabs" style={{ display: "flex", gap: 8, margin: "20px 0 16px", flexWrap: "wrap", alignItems: "center" }}>
              {[
                ["scraped", "LIVE EVENT OVERVIEW"],
                ["field", "FIELD COMPARISON"], 
                ["trace", "LAP TRACES"], 
                ["prog", "PROGRESSION"],
                ["report", "DRIVER REPORT"],
                ["rating", "DRIVER RATING"],
                ["debrief", "AI DEBRIEF"],
                ["stats", "STATS"],
                ["special", "SPECIAL EVENTS"],
                ["sectors", "SECTORS"],
                ["lineup", "LINEUP"]
              ].map(([k, l]) => (
                <button key={k} onClick={() => setTab(k)} className="disp"
                  style={{ padding: "8px 16px", borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: "pointer",
                    border: "1px solid", borderColor: tab === k ? AMBER : "#222c38",
                    background: tab === k ? "#1a160a" : "#0b1017", color: tab === k ? AMBER : "#8b97a7" }}>
                  {l}
                </button>
              ))}
            </div>

            {/* TAB: EVENT OVERVIEW */}
            {tab === "scraped" && (
              <Panel title={`EVENT METRICS — ${scrapedEventData.title.toUpperCase()}`}>
                <div style={{ display: "grid", gap: 24 }}>
                  
                  {leedsOverallStandings.length > 0 && (
                    <div style={{ background: "linear-gradient(135deg, #0f172a, #0b1017)", borderRadius: 10, padding: "16px", border: "1px solid #334155" }}>
                      <div className="disp" style={{ color: AMBER, fontSize: 15, fontWeight: 700, marginBottom: 10, letterSpacing: "1px" }}>
                        🏆 OVERALL CHAMPIONSHIP ROUND STANDINGS
                      </div>
                      <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ color: "#6b7685", textAlign: "left" }}>
                            <th style={{ padding: "6px 8px", borderBottom: "1px solid #1e2733" }}>POS</th>
                            <th style={{ padding: "6px 8px", borderBottom: "1px solid #1e2733" }}>TEAM</th>
                            <th style={{ padding: "6px 8px", borderBottom: "1px solid #1e2733" }}>KART</th>
                            <th style={{ padding: "6px 8px", borderBottom: "1px solid #1e2733" }}>TOTAL LAPS</th>
                            <th style={{ padding: "6px 8px", borderBottom: "1px solid #1e2733" }}>POINTS</th>
                          </tr>
                        </thead>
                        <tbody>
                          {leedsOverallStandings.map((row, idx) => (
                            <tr key={idx} style={{ borderBottom: "1px solid #1e2733" }}>
                              <td style={{ padding: "8px", color: AMBER, fontWeight: "700" }}>{row.position}</td>
                              <td style={{ padding: "8px", color: "#fff", fontWeight: "600" }}>{row.team}</td>
                              <td style={{ padding: "8px", color: "#6b7685" }}>#{row.kart || "—"}</td>
                              <td style={{ padding: "8px", color: "#c2cbd6" }}>{row.total_laps}</td>
                              <td style={{ padding: "8px", color: "#43d977", fontWeight: "700" }}>{row.total_points || "—"} pts</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {[...scrapedEventData.sessions].sort((a, b) => {
                    const rank = (s) => { const l = (s.label || s.title || "").toLowerCase(); return /quali/.test(l) ? 1 : /practice/.test(l) ? 2 : 0; };
                    return rank(a) - rank(b);
                  }).map((session) => {
                    const leedsSessionRows = session.results.filter(row => 
                      row.team && row.team.toLowerCase().includes("leeds") && !row.team.toLowerCase().includes("beckett")
                    );

                    if (leedsSessionRows.length === 0) return null;

                    return (
                      <div key={session.session_id} style={{ background: "#0b1017", borderRadius: 10, padding: "18px", border: "1px solid #161d27" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, borderBottom: "1px solid #1e2733", paddingBottom: 6 }}>
                          <div className="disp" style={{ color: AMBER, fontSize: 14.5, fontWeight: 700 }}>
                            🏁 {session.label.toUpperCase()}
                          </div>
                          <div className="mono" style={{ fontSize: 11, color: "#5b6776", display: "flex", alignItems: "center", gap: 10 }}>
                            START: {session.start_time || "—"} · LAPS: {session.total_laps || "—"}
                            {(() => { const sid = `scraped__${session.session_id}`; const wet = wetSessions.has(sid); return (
                              <button onClick={() => setWetSessions((prev) => { const n = new Set(prev); wet ? n.delete(sid) : n.add(sid); return n; })}
                                style={{ cursor: "pointer", borderRadius: 5, padding: "3px 8px", fontSize: 10.5, fontWeight: 600,
                                  border: `1px solid ${wet ? "#3da9fc" : "#2a3543"}`, background: wet ? "#0b2030" : "#0b1017", color: wet ? "#3da9fc" : "#5b6776" }}>
                                {wet ? "🌧 WET" : "DRY"}
                              </button>
                            ); })()}
                          </div>
                        </div>
                        <div style={{ overflowX: "auto" }}>
                          <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                            <thead>
                              <tr style={{ color: "#6b7685", textAlign: "left" }}>
                                <th style={{ padding: "6px 8px", borderBottom: "1px solid #11171f" }}>POS</th>
                                {signedOverview && <th style={{ padding: "6px 8px", borderBottom: "1px solid #11171f" }}>+/-</th>}
                                <th style={{ padding: "6px 8px", borderBottom: "1px solid #11171f" }}>TEAM</th>
                                <th style={{ padding: "6px 8px", borderBottom: "1px solid #11171f" }}>KART</th>
                                <th style={{ padding: "6px 8px", borderBottom: "1px solid #11171f" }}>BEST LAP</th>
                                <th style={{ padding: "6px 8px", borderBottom: "1px solid #11171f" }}>TOTAL TIME</th>
                                <th style={{ padding: "6px 8px", borderBottom: "1px solid #11171f" }}>POINTS</th>
                              </tr>
                            </thead>
                            <tbody>
                              {leedsSessionRows.map((row, rIdx) => {
                                return (
                                  <tr key={rIdx} style={{ borderBottom: "1px solid #11171f" }}>
                                    <td style={{ padding: "8px", color: AMBER, fontWeight: "700" }}>{row.position || "—"}</td>
                                    {signedOverview && (
                                      <td style={{ padding: "8px", fontWeight: "600", color: row.position_change > 0 ? "#43d977" : row.position_change < 0 ? "#ff3355" : "#4b5563" }}>
                                        {row.position_change > 0 ? `+${row.position_change}` : row.position_change < 0 ? row.position_change : row.position_change === 0 ? "0" : "—"}
                                      </td>
                                    )}
                                    <td style={{ padding: "8px", color: "#fff", fontWeight: "600" }}>
                                      {row.team} {row.penalty && <span style={{ color: "#ff3355", fontSize: 10, marginLeft: 6 }}>[+PENALTY]</span>}
                                    </td>
                                    <td style={{ padding: "8px", color: "#6b7685" }}>#{row.kart || "—"}</td>
                                    <td style={{ padding: "8px", color: "#c2cbd6" }}>{row.best_lap_time ? `${row.best_lap_time}s` : "—"} <span style={{ fontSize: 10, color: "#5b6776" }}>{row.best_lap_number ? `(L${row.best_lap_number})` : ""}</span></td>
                                    <td style={{ padding: "8px", color: "#c2cbd6" }}>{row.total_time || "—"}</td>
                                    <td style={{ padding: "8px", color: "#43d977", fontWeight: "600" }}>{row.points || "0"} pts</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {(() => {
                          const sp = (session.penalties || []).filter((p) => {
                            const t = (p.team || "").toLowerCase();
                            return t.includes("leeds") && !t.includes("beckett");
                          });
                          if (!sp.length) return null;
                          return (
                            <div style={{ marginTop: 10, borderTop: "1px solid #11171f", paddingTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                              <span className="disp" style={{ fontSize: 11, color: "#ff6b6b", fontWeight: 600, letterSpacing: "0.5px", alignSelf: "center" }}>⚑</span>
                              {sp.map((p, pi) => (
                                <span key={pi} className="mono" style={{ background: "#1a0f12", border: "1px solid #ff335530", borderRadius: 6, padding: "4px 8px", fontSize: 11 }}>
                                  <span style={{ color: "#e6edf3", fontWeight: 600 }}>#{p.kart}</span>
                                  <span style={{ color: "#ff8a5b" }}> {p.penalty}</span>
                                  <span style={{ color: "#6b7685" }}> · {String(p.reason || "").replace(/^\s*\d+\w*\.\s*/, "")}</span>
                                </span>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })}
                </div>
              </Panel>
            )}

            {/* TAB: SEGMENTED RACE PACK GROUPINGS */}
            {tab === "field" && (
              <Panel title="RACE PACE — SEGMENTED HEATS + ROUND SUMMARY INDIVIDUAL LEADERBOARD">
                {scrapedEventData?.sessions?.[0] && !("lap_times" in scrapedEventData.sessions[0]) && (
                  <div style={{ background: "#1e1b10", border: "1px solid #ffce3a40", color: AMBER, padding: "10px 14px", borderRadius: 8, fontSize: 12, marginBottom: 20 }} className="mono">
                    ⚠️ NOTIFICATION: Scraper ran without full metrics sheets. Run your dad's script layout file using <span style={{ color: "#fff" }}>--full</span> (e.g., <span style={{ color: "#fff" }}>python scraper.py --event {activeEventId} --full</span>) to download and plot distribution charts.
                  </div>
                )}
                {Object.entries(fieldComparisonGroups)
                  .sort(([a], [b]) => (b.includes("SUMMARY") ? 1 : 0) - (a.includes("SUMMARY") ? 1 : 0))
                  .map(([groupName, groupBoxes]) => {
                  const isSummary = groupName.includes("SUMMARY");
                  return (
                    <Collapsible key={groupName} defaultOpen={isSummary}
                      accent={isSummary ? AMBER : "#8b97a7"}
                      title={`${isSummary ? "🏆" : "📊"} ${tidyLabel(groupName)}`}
                      subtitle={`${groupBoxes.length} ${isSummary ? "drivers" : "entr" + (groupBoxes.length === 1 ? "y" : "ies")}`}>
                      <BoxPlot boxes={groupBoxes} fieldMedian={cleanOnly ? fieldMed : null} />
                      <StatsTable boxes={groupBoxes} fieldMed={fieldMed} />
                    </Collapsible>
                  );
                })}
              </Panel>
            )}

            {tab === "trace" && (
              <Panel title="LAP-BY-LAP TRACE">
                <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                  {[["all", "ALL"], ["race", "RACE"], ["quali", "QUALI"], ["practice", "PRACTICE"]].map(([k, l]) => (
                    <button key={k} onClick={() => setTraceType(k)} className="disp"
                      style={{ padding: "6px 14px", borderRadius: 7, fontWeight: 600, fontSize: 12.5, cursor: "pointer",
                        border: `1px solid ${traceType === k ? AMBER : "#222c38"}`, background: traceType === k ? "#1a160a" : "#0b1017", color: traceType === k ? AMBER : "#8b97a7" }}>{l}</button>
                  ))}
                </div>
                <div style={{ marginBottom: 14 }}>
                  {Object.entries(
                    entries.filter((e) => {
                      const lab = e.session.raceLabel || "";
                      if (traceType === "quali") return /quali/i.test(lab);
                      if (traceType === "practice") return /practice/i.test(lab);
                      if (traceType === "race") return /race/i.test(lab) && !/quali/i.test(lab);
                      return true;
                    }).reduce((acc, e) => {
                      const g = tidyLabel(e.session.raceLabel);
                      (acc[g] = acc[g] || []).push(e);
                      return acc;
                    }, {})
                  ).map(([race, rows]) => {
                    const shown = rows.filter((r) => activeTrace.includes(r.key)).length;
                    return (
                      <Collapsible key={race} title={race} subtitle={`${shown}/${rows.length} shown`}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                          {rows.map((e) => {
                            const on = activeTrace.includes(e.key);
                            const col = colorOf(e.key);
                            return (
                              <button key={e.key} onClick={() => setTraceKeys(
                                on ? activeTrace.filter((k) => k !== e.key) : [...activeTrace, e.key])}
                                className="mono" style={{ fontSize: 11.5, padding: "5px 10px", borderRadius: 6, cursor: "pointer",
                                  border: `1px solid ${col}`, opacity: on ? 1 : 0.35,
                                  background: on ? `${col}1f` : "#0b1017", color: col }}>
                                {(assign[e.key]?.trim() || `${e.teamName}`)} · #{e.num}
                              </button>
                            );
                          })}
                        </div>
                      </Collapsible>
                    );
                  })}
                </div>
                <ResponsiveContainer width="100%" height={400}>
                  <LineChart data={traceData} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
                    <CartesianGrid stroke="#161d27" />
                    <XAxis dataKey="lap" stroke="#5b6776" tick={{ fontSize: 11, fontFamily: "IBM Plex Mono" }}
                      label={{ value: "LAP", position: "insideBottom", offset: -2, fill: "#5b6776", fontSize: 11 }} />
                    <YAxis stroke="#5b6776" tick={{ fontSize: 11, fontFamily: "IBM Plex Mono" }}
                      domain={["dataMin - 0.5", "dataMax + 0.5"]} width={52}
                      allowDecimals={false} interval={0} tickFormatter={(v) => v.toFixed(1)}
                      ticks={(() => { const all = traceData.flatMap((r) => Object.entries(r).filter(([k]) => k !== "lap").map(([, v]) => v)).filter((v) => typeof v === "number"); if (!all.length) return undefined; const lo = Math.floor(Math.min(...all) * 2) / 2, hi = Math.ceil(Math.max(...all) * 2) / 2; const t = []; for (let v = lo; v <= hi + 0.001; v += 0.5) t.push(Math.round(v * 2) / 2); return t; })()} />
                    <Tooltip formatter={(v) => (typeof v === "number" ? v.toFixed(3) + "s" : v)}
                      contentStyle={{ background: "#0d141c", border: "1px solid #222c38", borderRadius: 8,
                      fontFamily: "IBM Plex Mono", fontSize: 12 }} labelStyle={{ color: AMBER }} />
                    {fieldMed != null && (
                      <ReferenceLine y={fieldMed} stroke={AMBER} strokeDasharray="6 5"
                        label={{ value: "field median", fill: AMBER, fontSize: 10, position: "insideTopRight" }} />
                    )}
                    {entries.filter((e) => activeTrace.includes(e.key)).map((e) => (
                      <Line key={e.key} dataKey={e.key} name={(assign[e.key]?.trim() || `${e.teamName}`)}
                        stroke={colorOf(e.key)} strokeWidth={2} dot={{ r: 2.5 }} connectNulls
                        isAnimationActive={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </Panel>
            )}

            {tab === "prog" && (
              <Panel title="DRIVER PROGRESSION — FASTEST LAP vs FIELD, BY ROUND">
                {progression.drivers.length === 0 ? (
                  <Empty msg="Assign driver names above, and load telemetry lap sheets, to generate stats metrics charts." />
                ) : (() => {
                  const active = progSel || progression.drivers.map((d) => d.driver);
                  return (
                  <>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                    {progression.drivers.map((d, di) => {
                      const on = active.includes(d.driver); const col = DRIVER_PALETTE[di % DRIVER_PALETTE.length];
                      return (
                        <button key={d.driver} className="mono"
                          onClick={() => setProgSel(on ? active.filter((x) => x !== d.driver) : [...active, d.driver])}
                          style={{ fontSize: 11, padding: "4px 9px", borderRadius: 6, cursor: "pointer",
                            border: `1px solid ${col}`, opacity: on ? 1 : 0.35, background: on ? `${col}1f` : "#0b1017", color: col }}>
                          {d.driver}
                        </button>
                      );
                    })}
                  </div>
                  <ResponsiveContainer width="100%" height={380}>
                    <LineChart data={progression.data} margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
                      <CartesianGrid stroke="#161d27" />
                      <XAxis dataKey="round" stroke="#5b6776" tick={{ fontSize: 10, fontFamily: "IBM Plex Mono" }} />
                      <YAxis stroke="#5b6776" tick={{ fontSize: 11, fontFamily: "IBM Plex Mono" }}
                        domain={["dataMin - 0.3", "dataMax + 0.3"]} width={52} tickFormatter={(v) => v.toFixed(1)}
                        ticks={(() => { const all = progression.data.flatMap((r) => Object.entries(r).filter(([k]) => k !== "round").map(([, v]) => v)).filter((v) => typeof v === "number"); if (!all.length) return undefined; const lo = Math.floor(Math.min(...all) * 2) / 2, hi = Math.ceil(Math.max(...all) * 2) / 2; const t = []; for (let v = lo; v <= hi + 0.001; v += 0.5) t.push(Math.round(v * 2) / 2); return t; })()}
                        label={{ value: "fastest lap vs field (s) — lower is better", angle: -90, position: "insideLeft", fill: "#5b6776", fontSize: 10 }} />
                      <Tooltip formatter={(v) => (typeof v === "number" ? v.toFixed(2) + "s" : v)}
                        contentStyle={{ background: "#0d141c", border: "1px solid #222c38", borderRadius: 8,
                        fontFamily: "IBM Plex Mono", fontSize: 12 }} labelStyle={{ color: AMBER }} />
                      {progression.drivers.map((d, di) => active.includes(d.driver) && (
                        <Line key={d.driver} dataKey={d.driver}
                          stroke={DRIVER_PALETTE[di % DRIVER_PALETTE.length]}
                          strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                  </>
                  );
                })()}
              </Panel>
            )}

            {tab === "report" && (() => {
              const races = convertedSessions.filter((s) => s.laps.length && !/practice/i.test(s.raceLabel));
              const rep = races.find((s) => s.id === reportSession)
                || races.find((s) => /race/i.test(s.raceLabel)) || races[0];
              if (!rep) return <Panel title="DRIVER REPORT"><Empty msg="No session with lap data loaded." /></Panel>;
              const report = driverReport(rep, extraTeams, extraNums, removed);
              const nameOf = (num) => assign[`${rep.id}|${num}`]?.trim();
              return (
                <Panel title="DRIVER REPORT — FASTEST 50% OF LAPS">
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                    <span className="mono" style={{ fontSize: 11, color: "#6b7685" }}>SESSION</span>
                    <select value={rep.id} onChange={(e) => setReportSession(e.target.value)}
                      style={{ ...inp(280), flex: "0 1 320px" }}>
                      {races.map((s) => <option key={s.id} value={s.id}>{tidyLabel(s.raceLabel)}</option>)}
                    </select>
                  </div>
                  {report ? <ReportTable report={report} nameOf={nameOf} /> : <Empty msg="No lap data in this session." />}
                </Panel>
              );
            })()}

            {tab === "rating" && (
              <Panel title={`DRIVER RATING — ${ratingScope === "season" ? "WHOLE SEASON" : "SELECTED ROUND(S)"}, OUT OF 10`}>
                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  {[["round", "THIS ROUND"], ["season", "WHOLE SEASON"]].map(([k, l]) => (
                    <button key={k} onClick={() => setRatingScope(k)} className="disp"
                      style={{ padding: "6px 14px", borderRadius: 7, fontWeight: 600, fontSize: 12.5, cursor: "pointer",
                        border: `1px solid ${ratingScope === k ? AMBER : "#222c38"}`,
                        background: ratingScope === k ? "#1a160a" : "#0b1017", color: ratingScope === k ? AMBER : "#8b97a7" }}>
                      {l}
                    </button>
                  ))}
                </div>
                {driverRatings.length === 0 ? (
                  <Empty msg="Name drivers in the roster to rate them. 'This round' rates the round you've selected (plus any compare rounds); 'Whole season' combines everything." />
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    {(() => {
                      const showRace = driverRatings.some((d) => d.hasRace);
                      const cols = [["#", null], ["DRIVER", "name"], ["RACES", "races"], ["PACE", "pace"], ["CONSISTENCY", "cons"], ...(showRace ? [["RACECRAFT", "race"]] : []), ["RATING", "overall"]];
                      const clickSort = (key) => { if (!key) return; setRatingSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" })); };
                      const sorted = [...driverRatings].sort((a, b) => {
                        const k = ratingSort.key, m = ratingSort.dir === "asc" ? 1 : -1;
                        if (k === "name") return m * String(a.name).localeCompare(String(b.name));
                        return m * ((a[k] ?? 0) - (b[k] ?? 0));
                      });
                      return (
                    <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 420 }}>
                      <thead>
                        <tr style={{ color: "#6b7685" }}>
                          {cols.map(([h, key], i) => (
                            <th key={h} onClick={() => clickSort(key)}
                              style={{ padding: "6px 10px", textAlign: i < 2 ? "left" : "right", borderBottom: "1px solid #1e2733",
                                fontWeight: 500, cursor: key ? "pointer" : "default", color: ratingSort.key === key ? AMBER : "#6b7685", userSelect: "none" }}>
                              {h}{ratingSort.key === key ? (ratingSort.dir === "desc" ? " ▾" : " ▴") : ""}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((d, i) => {
                          const rc = (v) => v >= 7 ? "#43d977" : v >= 4.5 ? "#ffce3a" : "#ff8a5b";
                          const bar = (v) => (<span style={{ color: rc(v) }}>{v.toFixed(2)}</span>);
                          return (
                            <tr key={d.name} style={{ borderBottom: "1px solid #11171f" }}>
                              <td style={{ padding: "7px 10px", color: "#5b6776" }}>{i + 1}</td>
                              <td style={{ padding: "7px 10px", color: "#e6edf3", fontWeight: 600 }}>{d.name}</td>
                              <td style={{ padding: "7px 10px", textAlign: "right", color: "#8b97a7" }}>{d.races}</td>
                              <td style={{ padding: "7px 10px", textAlign: "right" }}>
                                {d.hasPace ? bar(d.pace) : <span style={{ color: "#3a4655" }}>—</span>}
                                {d.wetDelta != null && <span style={{ color: "#3da9fc", fontSize: 10.5 }}> ({d.wetDelta <= 0 ? "" : "+"}{d.wetDelta.toFixed(2)})</span>}
                              </td>
                              <td style={{ padding: "7px 10px", textAlign: "right" }}>{d.hasCons ? bar(d.cons) : <span style={{ color: "#3a4655" }}>—</span>}</td>
                              {showRace && (
                                <td style={{ padding: "7px 10px", textAlign: "right" }}>
                                  {d.hasRace ? (
                                    <>{bar(d.race)} <span style={{ color: d.netGain >= 0 ? "#43d977" : "#ff8a5b", fontSize: 10.5 }}>({d.netGain >= 0 ? "+" : ""}{d.netGain})</span></>
                                  ) : <span style={{ color: "#3a4655" }}>—</span>}
                                </td>
                              )}
                              <td style={{ padding: "7px 10px", textAlign: "right", color: rc(d.overall), fontWeight: 700, fontSize: 14 }}>{d.overall.toFixed(2)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    ); })()}
                    <div className="mono" style={{ fontSize: 10, color: "#5b6776", marginTop: 12, lineHeight: 1.5 }}>
                      Pace (dry races) is measured against the rest of the Leeds squad at the same track. Wet races are pulled out of
                      the pace score; the blue bracket shows seconds vs the wet field median (negative = faster than the wet field).
                      Consistency is your own clean-lap spread (sd vs lap average) — tighter is always a higher score, matching the field comparison. (dry only)
                    </div>
                  </div>
                )}
              </Panel>
            )}

            {tab === "debrief" && (
              <Panel title="AI DEBRIEF — KAI ASKEY, DRIVER COACH">
                {(() => {
                  const sel = (label, val, set, opts) => (
                    <label className="mono" style={{ fontSize: 11, color: "#6b7685", display: "flex", flexDirection: "column", gap: 4 }}>
                      {label}
                      <select value={val} onChange={(e) => set(e.target.value)}
                        style={{ background: "#11171f", border: "1px solid #222c38", borderRadius: 6, color: "#e6edf3", padding: "6px 8px", fontSize: 12.5, fontFamily: "IBM Plex Mono, monospace" }}>
                        {opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                      </select>
                    </label>
                  );
                  const runDebrief = async () => {
                    setDebriefLoading(true); setDebrief("");
                    const sessions = debriefTime === "season" ? seasonSessions : convertedSessions;
                    const inScope = (round) => debriefScope === "overall" ? true : debriefScope === "mains" ? /main/i.test(round) : /inter/i.test(round);
                    const byDriver = {};
                    sessions.forEach((s) => {
                      if (!/race/i.test(s.raceLabel) || /quali/i.test(s.raceLabel) || !inScope(s.round)) return;
                      const rep = driverReport(s, extraTeams, extraNums, removed); if (!rep) return;
                      rep.rows.forEach((r) => {
                        if (!r.isLeeds) return;
                        const name = assign[`${s.id}|${r.num}`]?.trim();
                        if (!name) return;   // only named Leeds drivers, never team-name fallbacks
                        const d = byDriver[name] || (byDriver[name] = { name, avg: [], sd: [], z: [], gain: 0, races: 0 });
                        if (r.avg) d.avg.push(r.avg); if (r.sd != null) d.sd.push(r.sd); if (r.z != null) d.z.push(r.z);
                        if (s.posByKart && s.posByKart[r.num] != null) d.gain += s.posByKart[r.num];
                        d.races += 1;
                      });
                    });
                    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
                    const drivers = Object.values(byDriver);
                    if (!drivers.length) { setDebrief("No named drivers in this scope. Name drivers in the roster first."); setDebriefLoading(false); return; }
                    const lines = drivers.map((d) => `${d.name}: avg lap ${fmt(mean(d.avg))}s, lap-spread sd ±${(mean(d.sd) || 0).toFixed(3)}s, field z-score ${(mean(d.z) ?? 0).toFixed(2)}, net positions ${d.gain >= 0 ? "+" + d.gain : d.gain} across ${d.races} race(s)`).join("\n");
                    const scopeName = debriefScope === "overall" ? "the whole team" : debriefScope === "mains" ? "the Mains drivers" : "the Inters drivers";
                    const prompt = `Debrief ${scopeName}, ${debriefTime === "season" ? "across the whole season" : "for the selected round"}. Negative z-score = faster than the field; lower sd = more consistent. Drivers:\n${lines}`;
                    try {
                      const res = await fetch("/api/debrief", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) });
                      const j = await res.json();
                      setDebrief(j.text || j.error || "No response.");
                    } catch { setDebrief("Couldn't reach the debrief service (works on the live site with the API key set)."); }
                    setDebriefLoading(false);
                  };
                  return (
                    <>
                      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
                        {sel("SCOPE", debriefScope, setDebriefScope, [["overall", "Overall Team Summary"], ["mains", "Mains Only"], ["inters", "Inters Only"]])}
                        {sel("TIMELINE", debriefTime, setDebriefTime, [["round", "This Round"], ["season", "Whole Season"]])}
                        <button onClick={runDebrief} disabled={debriefLoading} className="disp"
                          style={{ background: AMBER, color: "#000", border: "none", borderRadius: 7, padding: "9px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                          {debriefLoading ? "ANALYSING…" : "✦ GENERATE DEBRIEF"}
                        </button>
                      </div>
                      {debrief && (
                        <div style={{ background: "#0b0f15", borderLeft: `3px solid ${AMBER}`, border: "1px solid #222c38", borderRadius: 8, padding: "18px 20px", whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.7, color: "#dbe2ea" }}>
                          {debrief}
                        </div>
                      )}
                    </>
                  );
                })()}
              </Panel>
            )}

            {tab === "stats" && (
              <Panel title="SEASON STATS">
                {(() => {
                  const list = statsView === "teams" ? stats.teams : stats.drivers;
                  const o = stats.overall;
                  const Stat = ({ label, value, color }) => (
                    <div style={{ flex: "1 1 0", minWidth: 92 }}>
                      <div className="mono" style={{ fontSize: 9.5, color: "#5b6776", letterSpacing: "0.5px" }}>{label}</div>
                      <div className="mono" style={{ fontSize: 17, fontWeight: 600, color: color || "#e6edf3", marginTop: 2 }}>{value}</div>
                    </div>
                  );
                  const posCh = (v) => v == null ? "—" : (v >= 0 ? "+" : "") + v;
                  return (
                    <>
                      {/* OVERALL LEEDS hero */}
                      <div style={{ background: "linear-gradient(135deg,#11160f,#0b1017)", border: `1px solid ${AMBER}40`, borderRadius: 12, padding: "16px 20px", marginBottom: 18 }}>
                        <div className="disp" style={{ fontSize: 14, color: AMBER, fontWeight: 700, letterSpacing: "1px", marginBottom: 12 }}>🦁 LEEDS OVERALL — SEASON</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
                          <Stat label="POINTS" value={o.points} color="#43d977" />
                          <Stat label="RACES" value={o.races} />
                          <Stat label="AVG FINISH" value={o.avgFinish != null ? o.avgFinish.toFixed(1) : "—"} />
                          <Stat label="NET +/-" value={posCh(o.totalPosCh)} color={o.totalPosCh >= 0 ? "#43d977" : "#ff8a5b"} />
                          <Stat label="BEST LAP" value={o.bestLap != null ? fmt(o.bestLap) : "—"} color={AMBER} />
                          <Stat label="RACE PACE" value={o.racePace != null ? fmt(o.racePace) : "—"} />
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                        {[["drivers", "BY DRIVER"], ["teams", "BY TEAM"]].map(([k, l]) => (
                          <button key={k} onClick={() => setStatsView(k)} className="disp"
                            style={{ padding: "6px 14px", borderRadius: 7, fontWeight: 600, fontSize: 12.5, cursor: "pointer",
                              border: `1px solid ${statsView === k ? AMBER : "#222c38"}`, background: statsView === k ? "#1a160a" : "#0b1017", color: statsView === k ? AMBER : "#8b97a7" }}>{l}</button>
                        ))}
                        <span style={{ width: 14 }} />
                        {[["all", "ALL"], ["mains", "MAINS"], ["inters", "INTERS"], ...leedsTeamNames.map((t) => [t, t.toUpperCase()])].map(([k, l]) => (
                          <button key={k} onClick={() => setStatsCat(k)} className="disp"
                            style={{ padding: "6px 12px", borderRadius: 7, fontWeight: 600, fontSize: 12.5, cursor: "pointer",
                              border: `1px solid ${statsCat === k ? "#b06bff" : "#222c38"}`, background: statsCat === k ? "#1a0f2a" : "#0b1017", color: statsCat === k ? "#b06bff" : "#8b97a7" }}>{l}</button>
                        ))}
                        <span style={{ flex: 1 }} />
                        {[["cards", "CARDS"], ["chart", "CHART"], ["table", "TABLE"]].map(([k, l]) => (
                          <button key={k} onClick={() => setStatsMode(k)} className="disp"
                            style={{ padding: "6px 14px", borderRadius: 7, fontWeight: 600, fontSize: 12.5, cursor: "pointer",
                              border: `1px solid ${statsMode === k ? "#3da9fc" : "#222c38"}`, background: statsMode === k ? "#0b2030" : "#0b1017", color: statsMode === k ? "#3da9fc" : "#8b97a7" }}>{l}</button>
                        ))}
                      </div>

                      {list.length === 0 ? <Empty msg="Name drivers in the roster to build stats." /> : statsMode === "chart" ? (
                        <ResponsiveContainer width="100%" height={Math.max(260, list.length * 34)}>
                          <BarChart data={list} layout="vertical" margin={{ top: 4, right: 30, bottom: 4, left: 10 }}>
                            <CartesianGrid stroke="#161d27" horizontal={false} />
                            <XAxis type="number" stroke="#5b6776" tick={{ fontSize: 11, fontFamily: "IBM Plex Mono" }} />
                            <YAxis type="category" dataKey="name" width={110} stroke="#5b6776" tick={{ fontSize: 12, fontFamily: "IBM Plex Sans" }} />
                            <Tooltip cursor={{ fill: "#ffffff08" }} contentStyle={{ background: "#0d141c", border: "1px solid #222c38", borderRadius: 8, fontFamily: "IBM Plex Mono", fontSize: 12 }} labelStyle={{ color: AMBER }} />
                            <Bar dataKey="points" name="Points" radius={[0, 4, 4, 0]}>
                              {list.map((e, i) => <Cell key={i} fill={i === 0 ? AMBER : "#3da9fc"} />)}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      ) : statsMode === "table" ? (
                        <div style={{ overflowX: "auto" }}>
                          {(() => {
                            const cols = [["#", null], [statsView === "teams" ? "TEAM" : "DRIVER", "name"], ["RACES", "races"], ["POINTS", "points"], ["AVG FINISH", "avgFinish"], ["TOTAL +/-", "totalPosCh"], ["BEST LAP", "bestLap"], ["RACE PACE", "racePace"], ["BEST QUALI", "bestQualiPos"]];
                            const clickSort = (key) => { if (!key) return; setStatsSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" })); };
                            const sorted = [...list].sort((a, b) => {
                              const k = statsSort.key, m = statsSort.dir === "asc" ? 1 : -1;
                              if (k === "name") return m * String(a.name).localeCompare(String(b.name));
                              const av = a[k] == null ? Infinity : a[k], bv = b[k] == null ? Infinity : b[k];
                              return m * (av - bv);
                            });
                            return (
                          <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 640 }}>
                            <thead>
                              <tr style={{ color: "#6b7685" }}>
                                {cols.map(([h, key], i) => (
                                  <th key={h} onClick={() => clickSort(key)} style={{ padding: "6px 10px", textAlign: i < 2 ? "left" : "right", borderBottom: "1px solid #1e2733",
                                    fontWeight: 500, cursor: key ? "pointer" : "default", color: statsSort.key === key ? AMBER : "#6b7685", userSelect: "none" }}>
                                    {h}{statsSort.key === key ? (statsSort.dir === "desc" ? " ▾" : " ▴") : ""}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {sorted.map((d, i) => (
                                <tr key={d.name} style={{ borderBottom: "1px solid #11171f" }}>
                                  <td style={{ padding: "7px 10px", color: "#5b6776" }}>{i + 1}</td>
                                  <td style={{ padding: "7px 10px", color: "#e6edf3", fontWeight: 600 }}>{d.name}</td>
                                  <td style={{ padding: "7px 10px", textAlign: "right", color: "#8b97a7" }}>{d.races}</td>
                                  <td style={{ padding: "7px 10px", textAlign: "right", color: "#43d977", fontWeight: 700 }}>{d.points}</td>
                                  <td style={{ padding: "7px 10px", textAlign: "right", color: "#c2cbd6" }}>{d.avgFinish != null ? d.avgFinish.toFixed(1) : "—"}</td>
                                  <td style={{ padding: "7px 10px", textAlign: "right", color: d.totalPosCh == null ? "#5b6776" : d.totalPosCh >= 0 ? "#43d977" : "#ff8a5b" }}>{posCh(d.totalPosCh)}</td>
                                  <td style={{ padding: "7px 10px", textAlign: "right", color: AMBER }}>{d.bestLap != null ? fmt(d.bestLap) : "—"}</td>
                                  <td style={{ padding: "7px 10px", textAlign: "right", color: "#c2cbd6" }}>{d.racePace != null ? fmt(d.racePace) : "—"}</td>
                                  <td style={{ padding: "7px 10px", textAlign: "right", color: "#8b97a7" }}>{d.bestQualiPos != null ? "P" + d.bestQualiPos : "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                            );
                          })()}
                        </div>
                      ) : (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
                          {list.map((d, i) => (
                            <div key={d.name} style={{ background: "#0b1017", border: "1px solid #1b2430", borderRadius: 10, padding: "14px 16px" }}>
                              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
                                <span className="disp" style={{ fontSize: 17, fontWeight: 700, color: "#e6edf3" }}>
                                  <span style={{ color: "#5b6776", fontSize: 13 }}>{i + 1}. </span>{d.name}
                                </span>
                                <span className="mono" style={{ fontSize: 19, fontWeight: 700, color: "#43d977" }}>{d.points}<span style={{ fontSize: 11, color: "#5b6776" }}> pts</span></span>
                              </div>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                                <Stat label="RACES" value={d.races} />
                                <Stat label="AVG FINISH" value={d.avgFinish != null ? d.avgFinish.toFixed(1) : "—"} />
                                <Stat label="NET +/-" value={posCh(d.totalPosCh)} color={d.totalPosCh == null ? "#5b6776" : d.totalPosCh >= 0 ? "#43d977" : "#ff8a5b"} />
                                <Stat label="BEST LAP" value={d.bestLap != null ? fmt(d.bestLap) : "—"} color={AMBER} />
                                <Stat label="RACE PACE" value={d.racePace != null ? fmt(d.racePace) : "—"} />
                                <Stat label="BEST QUALI" value={d.bestQualiPos != null ? "P" + d.bestQualiPos : "—"} />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="mono" style={{ fontSize: 10, color: "#5b6776", marginTop: 14, lineHeight: 1.5 }}>
                        Whole season, races only. Points and finishes from results; net +/- is total positions gained/lost; best lap and race pace are clean laps;
                        best quali is the driver's best qualifying finishing position (Inters). By driver counts named drivers; by team sums each Leeds entry.
                      </div>
                    </>
                  );
                })()}
              </Panel>
            )}

            {tab === "special" && (
              <Panel title="SPECIAL EVENTS">
                <div className="mono" style={{ fontSize: 11, color: "#5b6776", marginBottom: 16 }}>
                  One-off events (Drivers Championship, Qualifiers, testing). Shown on their own and never counted in the round ratings or stats.
                </div>
                {specialEvents.length === 0 ? (
                  <Empty msg="No special events found in the loaded season." />
                ) : specialEvents.map((e) => (
                  <Collapsible key={e.title} title={e.title} subtitle={`${e.sessions.length} session${e.sessions.length === 1 ? "" : "s"}`}>
                    <div style={{ display: "grid", gap: 8 }}>
                      {e.sessions.map((s, si) => (
                        <div key={si} style={{ background: "#080d13", borderRadius: 7, padding: "8px 12px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                            <span className="disp" style={{ color: "#e6edf3", fontWeight: 600, fontSize: 13 }}>{s.label}</span>
                            {s.winner && <span className="mono" style={{ fontSize: 11.5, color: "#8b97a7" }}>Winner: <span style={{ color: AMBER }}>{s.winner}</span></span>}
                          </div>
                          {s.ours.length > 0 && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                              {s.ours.map((o, oi) => (
                                <span key={oi} className="mono" style={{ fontSize: 11, background: "#0b1017", border: "1px solid #2a3543", borderRadius: 6, padding: "3px 8px", color: "#c2cbd6" }}>
                                  {o.team} #{o.kart} · P{o.pos} · {o.pts || 0} pts
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </Collapsible>
                ))}
              </Panel>
            )}

            {tab === "sectors" && (() => {
              const races = convertedSessions.filter((s) => s.isRound && s.laps.length && /race/i.test(s.raceLabel) && !/quali/i.test(s.raceLabel));
              const rep = races.find((s) => s.id === sectorSession) || races[0];
              if (!rep) return <Panel title="SECTOR ANALYSIS"><Empty msg="No race session loaded." /></Panel>;
              const sb = rep.sectorsByKart || {};
              const allK = (rep.allKarts || []).map((k) => k.num);
              const fieldBest = (sec) => { const v = allK.map((n) => sb[n] && sb[n][sec]).filter((x) => x != null); return v.length ? Math.min(...v) : null; };
              const fb = { s1: fieldBest("s1"), s2: fieldBest("s2"), s3: fieldBest("s3") };
              const ours = rep.karts.map((k) => ({ num: k.num, name: assign[`${rep.id}|${k.num}`]?.trim() || k.teamName, ...(sb[k.num] || {}) })).filter((o) => o.best != null || o.s1 != null);
              const dCell = (v, best) => v == null ? <span style={{ color: "#3a4655" }}>—</span> :
                <span style={{ color: best != null && v <= best + 0.001 ? "#b06bff" : "#c2cbd6" }}>{v.toFixed(3)}{best != null && v > best + 0.001 ? <span style={{ color: "#5b6776", fontSize: 10 }}> +{(v - best).toFixed(2)}</span> : ""}</span>;
              return (
                <Panel title="SECTOR ANALYSIS — BEST SECTORS & ULTIMATE-LAP GAP">
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                    <span className="mono" style={{ fontSize: 11, color: "#6b7685" }}>SESSION</span>
                    <select value={rep.id} onChange={(e) => setSectorSession(e.target.value)} style={{ ...inp(300) }}>
                      {races.map((s) => <option key={s.id} value={s.id}>{tidyLabel(s.raceLabel)}</option>)}
                    </select>
                  </div>
                  {ours.length === 0 ? <Empty msg="No Leeds sector data in this race." /> : (
                    <div style={{ overflowX: "auto" }}>
                      <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 560 }}>
                        <thead><tr style={{ color: "#6b7685" }}>
                          {["DRIVER", "S1", "S2", "S3", "THEORETICAL", "BEST LAP", "GAP"].map((h, i) => (
                            <th key={h} style={{ padding: "6px 10px", textAlign: i === 0 ? "left" : "right", borderBottom: "1px solid #1e2733", fontWeight: 500 }}>{h}</th>
                          ))}
                        </tr></thead>
                        <tbody>
                          {ours.sort((a, b) => (a.best ?? 9e9) - (b.best ?? 9e9)).map((o) => {
                            const gap = (o.best != null && o.ult != null) ? o.best - o.ult : null;
                            return (
                              <tr key={o.num} style={{ borderBottom: "1px solid #11171f" }}>
                                <td style={{ padding: "7px 10px", color: "#e6edf3", fontWeight: 600 }}>{o.name} <span style={{ color: "#5b6776" }}>#{o.num}</span></td>
                                <td style={{ padding: "7px 10px", textAlign: "right" }}>{dCell(o.s1, fb.s1)}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right" }}>{dCell(o.s2, fb.s2)}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right" }}>{dCell(o.s3, fb.s3)}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right", color: "#8b97a7" }}>{o.ult != null ? fmt(o.ult) : "—"}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right", color: AMBER }}>{o.best != null ? fmt(o.best) : "—"}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right", color: gap == null ? "#5b6776" : gap > 0.3 ? "#ff8a5b" : "#43d977" }}>{gap == null ? "—" : "+" + gap.toFixed(3)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      <div className="mono" style={{ fontSize: 10, color: "#5b6776", marginTop: 12, lineHeight: 1.5 }}>
                        Purple = matched the field's best sector. THEORETICAL is their ultimate lap (sum of their own best sectors); GAP is best lap minus theoretical —
                        how much they left on the table by not stringing the sectors together. A big gap = the speed's there, the lap isn't.
                      </div>
                    </div>
                  )}
                </Panel>
              );
            })()}

            {tab === "lineup" && (() => {
              const cat = {};
              seasonSessions.forEach((s) => {
                if (!s.isRound || !/race/i.test(s.raceLabel) || /quali/i.test(s.raceLabel)) return;
                s.karts.forEach((k) => { const n = assign[`${s.id}|${k.num}`]?.trim(); if (!n) return; cat[n] = cat[n] || { Mains: 0, Inters: 0 }; cat[n][s.category] = (cat[n][s.category] || 0) + 1; });
              });
              const catOf = (n) => { const c = cat[n]; if (!c) return "?"; return (c.Mains || 0) >= (c.Inters || 0) ? "M" : "I"; };
              const ranked = driverRatings;
              const mainsScores = ranked.filter((d) => catOf(d.name) === "M").map((d) => d.overall);
              const lowestMains = mainsScores.length ? Math.min(...mainsScores) : 0;
              return (
                <Panel title="LINEUP OPTIMISER — RANKED, WITH PROMOTION FLAGS">
                  {ranked.length === 0 ? <Empty msg="Name drivers to build the lineup." /> : (
                    <div style={{ display: "grid", gap: 6 }}>
                      {ranked.map((d, i) => {
                        const c = catOf(d.name);
                        const promote = c === "I" && d.overall > lowestMains && mainsScores.length > 0;
                        return (
                          <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 12, background: "#0b1017", border: `1px solid ${promote ? "#43d97755" : "#1b2430"}`, borderRadius: 8, padding: "8px 12px" }}>
                            <span className="mono" style={{ color: "#5b6776", width: 24 }}>{i + 1}</span>
                            <span className="disp" style={{ fontWeight: 700, color: "#e6edf3", flex: 1 }}>{d.name}</span>
                            <span className="mono" style={{ fontSize: 10.5, padding: "2px 7px", borderRadius: 5, border: "1px solid #2a3543", color: c === "M" ? AMBER : "#3da9fc" }}>{c === "M" ? "MAINS" : c === "I" ? "INTERS" : "—"}</span>
                            {promote && <span className="mono" style={{ fontSize: 10.5, padding: "2px 7px", borderRadius: 5, background: "#0e2018", border: "1px solid #43d97755", color: "#43d977" }}>↑ PROMOTE</span>}
                            <span className="mono" style={{ fontSize: 15, fontWeight: 700, color: d.overall >= 7 ? "#43d977" : d.overall >= 4.5 ? "#ffce3a" : "#ff8a5b", width: 48, textAlign: "right" }}>{d.overall.toFixed(2)}</span>
                          </div>
                        );
                      })}
                      <div className="mono" style={{ fontSize: 10, color: "#5b6776", marginTop: 8, lineHeight: 1.5 }}>
                        Ranked on overall rating (follows the rating tab's round/season scope). Drivers tagged by the category they race most.
                        An Inters driver flagged ↑ PROMOTE is rated above your weakest Mains driver — a case to move them up.
                      </div>
                    </div>
                  )}
                </Panel>
              );
            })()}

          </>
        )}

        {!hasData && (
          <div className="mono" style={{ color: "#5b6776", fontSize: 13, textAlign: "center", padding: "40px 0" }}>
            Type an event identifier at the top and select load to populate dashboard layout
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- stats table ---------- */
function StatsTable({ boxes, fieldMed }) {
  if (!boxes || !boxes.length) return null;
  const ranked = [...boxes].sort((a, b) => (a.avg ?? 9e9) - (b.avg ?? 9e9));
  return (
    <div style={{ marginTop: 12, overflowX: "auto" }}>
      <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ color: "#6b7685", textAlign: "right" }}>
            {["DRIVER/TEAM", "BEST LAP", "CLEAN AVG", "CONSISTENCY", "INCIDENTS", "VS FIELD"].map((h, i) => (
              <th key={h} style={{ padding: "6px 10px", textAlign: i === 0 ? "left" : "right",
                borderBottom: "1px solid #1e2733", fontWeight: 500 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ranked.map((b, idx) => {
            const gap = fieldMed != null && b.avg != null ? b.avg - fieldMed : null;
            return (
              <tr key={idx} style={{ borderBottom: "1px solid #11171f" }}>
                <td style={{ padding: "6px 10px", color: b.color, fontWeight: 600, textAlign: "left" }}>{b.label}</td>
                <td style={td}>{fmt(b.best)}</td>
                <td style={td}>{fmt(b.avg)}</td>
                <td style={td}>{fmt(b.cons)}</td>
                <td style={td}>{b.inc}</td>
                <td style={{ padding: "6px 10px", textAlign: "right", color: gap == null ? "#5b6776" : gap <= 0 ? "#43d977" : "#ff3355" }}>
                  {gap == null ? "—" : gap <= 0 ? `${gap.toFixed(3)}s` : `+${gap.toFixed(3)}s`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- small ui ---------- */
const td = { padding: "6px 10px", textAlign: "right", color: "#c2cbd6" };
const inp = (w) => ({ background: "#11171f", border: "1px solid #222c38", borderRadius: 6,
  color: "#e6edf3", padding: "5px 8px", fontSize: 12.5, width: w, fontFamily: "IBM Plex Mono, monospace" });
const Label = ({ children }) => (
  <div className="disp" style={{ fontSize: 12.5, color: "#8b97a7", letterSpacing: "1px",
    fontWeight: 600, marginBottom: 9, textTransform: "uppercase" }}>{children}</div>
);
function Panel({ title, children }) {
  return (
    <div style={{ background: "#0a0f16", border: "1px solid #161d27", borderRadius: 12, padding: 18, marginBottom: 14 }}>
      <div className="disp" style={{ fontSize: 13, color: AMBER, letterSpacing: "1.5px",
        fontWeight: 600, marginBottom: 14 }}>{title}</div>
      {children}
    </div>
  );
}

function Collapsible({ title, subtitle, defaultOpen = false, accent = AMBER, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: "1px solid #161d27", borderRadius: 10, marginBottom: 10,
      overflow: "hidden", background: "#0b1017" }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "11px 14px",
          background: open ? "#0d141c" : "none", border: "none", cursor: "pointer", textAlign: "left" }}>
        <span className="disp" style={{ color: accent, fontWeight: 700, fontSize: 13,
          display: "inline-block", transition: "transform .15s", transform: open ? "rotate(90deg)" : "none" }}>▸</span>
        <span className="disp" style={{ color: "#e6edf3", fontWeight: 600, fontSize: 14,
          letterSpacing: "0.5px", flex: 1 }}>{title}</span>
        {subtitle && <span className="mono" style={{ color: "#5b6776", fontSize: 11 }}>{subtitle}</span>}
      </button>
      {open && <div style={{ padding: "6px 14px 16px" }}>{children}</div>}
    </div>
  );
}