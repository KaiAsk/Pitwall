import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend, Cell,
} from "recharts";

/* ---------- theme ---------- */
const TEAM_COLORS = { A: "#ff2d4d", B: "#00e0c6", C: "#b06bff", D: "#2fd372", E: "#ffa23a", F: "#5a8dee", G: "#e85bd0" };
const DRIVER_PALETTE = [
  "#ff2d4d", "#00e0c6", "#b06bff", "#2fd372", "#ffce3a", "#ff7c2a",
  "#38b6ff", "#e055a3", "#a8e63d", "#00bfa5", "#ff6b6b", "#c084fc",
];
const AMBER = "#ffce3a";

/* display-only: tidy an over-grabbed session label for grouping/headers. */
const tidyLabel = (s) =>
  (String(s || "")
    .split(/\s+(?:Confirmed|Live|Provisional|Unconfirmed|Result)\b|\s+[··]\s+|\s+\d{1,2}:\d{2}\b|\s+Winner:/)[0]
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

const sessionHeat = (label) => {
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
    if (/^team$/i.test(team)) return; 
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
const fmt = (t) => { if (t == null) return "—"; if (t < 60) return t.toFixed(3);
  const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s < 10 ? "0" : ""}${s.toFixed(3)}`; };

// Aggressive Anomaly Filter: Drops any lap >1.5s faster than the field median best lap
const getValidFastest = (arr) => {
  const valid = arr.filter((x) => x != null && !isNaN(x)).sort((a, b) => a - b);
  if (!valid.length) return null;
  const med = quantile(valid, 0.5);
  const filtered = valid.filter((t) => t >= med - 1.5);
  return filtered.length ? filtered[0] : valid[0];
};

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
  return { median: quantile(sorted, 0.5), best: getValidFastest(sorted) ?? null, n: pooled.length };
}

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
  const classFastest = getValidFastest(pool);
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
  const head = { padding: "4px 8px", textAlign: "right", color: "#78889d", fontWeight: 500, letterSpacing: "0.5px", cursor: "pointer", userSelect: "none" };
  const [sort, setSort] = useState({ key: "avg", dir: "asc" });
  const arrow = (k) => (sort.key === k ? (sort.dir === "asc" ? " ▴" : " ▾") : "");
  const hCol = (k) => (sort.key === k ? AMBER : "#78889d");
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
        <div className="mono" style={{ display: "grid", gridTemplateColumns: `28px 190px ${PW}px 64px 64px 56px 52px 64px`,
          alignItems: "end", fontSize: 11.5, borderBottom: "1px solid #1e2733", paddingBottom: 4 }}>
          <div style={head}>#</div>
          <div style={{ ...head, textAlign: "left", color: hCol("driver") }} onClick={clickSort("driver")}>DRIVER / KART{arrow("driver")}</div>
          <svg width={PW} height="16" style={{ overflow: "visible" }}>
            {ticks.map((tv, i) => (
              <text key={i} x={x(tv)} y="12" textAnchor="middle" fill="#66758a" fontSize="9.5" fontFamily="Barlow Semi Condensed">
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
              <div style={{ ...cell, textAlign: "center", color: "#66758a" }}>{i + 1}</div>
              <div style={{ padding: "0 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <span style={{ color: r.isLeeds ? c : "#c2cbd6", fontWeight: r.isLeeds ? 600 : 400 }}>
                  {driver || r.team}
                </span>
                <span style={{ color: "#66758a" }}> #{r.num}</span>
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
              <div style={{ ...cell, color: r.z == null ? "#66758a" : r.z <= 0 ? "#2fd372" : "#ff8a5b" }}>
                {r.z == null ? "—" : (r.z <= 0 ? "" : "+") + r.z.toFixed(2)}
              </div>
              <div style={{ ...cell, color: "#9aa8bb" }}>{r.shown}/{r.total}</div>
            </div>
          );
        })}
      </div>
      <div className="mono" style={{ fontSize: 11, color: "#66758a", marginTop: 12, lineHeight: 1.5 }}>
        Ranked on the fastest 50% of laps, excluding lap 1, within 110% of class fastest and 105% of the driver's own fastest.
      </div>
    </div>
  );
}

function BoxPlot({ boxes, fieldMedian }) {
  const allClean = boxes.flatMap((b) => b.clean).filter((x) => x != null && !isNaN(x));
  if (!allClean.length) return <Empty msg="No clean lap sheets data found to visualize." />;

  const sortedLaps = [...allClean].sort((a, b) => a - b);
  let lo = quantile(sortedLaps, 0.01);
  let hi = quantile(sortedLaps, 0.99);
  
  if (hi - lo < 0.5) { lo -= 1; hi += 1; } 
  else { const paddingMultiplier = (hi - lo) * 0.20; lo = Math.max(0, lo - paddingMultiplier); hi = hi + paddingMultiplier; }

  const W = Math.max(800, boxes.length * 115 + 140), H = 500;
  const padL = 70, padR = 40, padT = 40, padB = 120;
  const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
  const bw = (W - padL - padR) / boxes.length;
  const delta = hi - lo;
  let gapInterval = delta > 60 ? 10 : delta > 40 ? 5 : delta > 20 ? 2 : delta > 8 ? 1 : 0.5;

  const initialTick = Math.ceil(lo / gapInterval) * gapInterval;
  const customGridTicks = [];
  for (let tick = initialTick; tick <= hi; tick += gapInterval) { customGridTicks.push(tick); }

  return (
    <div style={{ overflowX: "auto", background: "#0a0e14", borderRadius: 8, padding: "8px" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: W, display: "block" }}>
        {customGridTicks.map((tv, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(tv)} y2={y(tv)} stroke="#1e293b" strokeWidth="1" strokeDasharray="4 4" />
            <text x={padL - 12} y={y(tv) + 4} textAnchor="end" fill="#64748b" fontSize="11" fontFamily="Barlow Semi Condensed">{tv.toFixed(1)}s</text>
          </g>
        ))}
        {fieldMedian != null && y(fieldMedian) >= padT && y(fieldMedian) <= H - padB && (
          <g>
            <line x1={padL} x2={W - padR} y1={y(fieldMedian)} y2={y(fieldMedian)} stroke={AMBER} strokeWidth="2" strokeDasharray="6 4" opacity="0.9" />
            <text x={W - padR - 6} y={y(fieldMedian) - 8} textAnchor="end" fill={AMBER} fontSize="11" fontWeight="600" fontFamily="Barlow Semi Condensed">FIELD MEDIAN {fieldMedian.toFixed(3)}s</text>
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
              {y(mx) >= padT && y(mx) <= H - padB && ( <line x1={cx - halfBoxWidth * 0.5} x2={cx + halfBoxWidth * 0.5} y1={y(mx)} y2={y(mx)} stroke={col} strokeWidth="1.5" /> )}
              {y(mn) >= padT && y(mn) <= H - padB && ( <line x1={cx - halfBoxWidth * 0.5} x2={cx + halfBoxWidth * 0.5} y1={y(mn)} y2={y(mn)} stroke={col} strokeWidth="1.5" /> )}
              <rect x={cx - halfBoxWidth} y={safetyClampY(q3)} width={halfBoxWidth * 2} height={Math.max(3, safetyClampY(q1) - safetyClampY(q3))} fill={col} fillOpacity="0.16" stroke={col} strokeWidth="1.8" rx="3" />
              <line x1={cx - halfBoxWidth} x2={halfBoxWidth + cx} y1={safetyClampY(med)} y2={safetyClampY(med)} stroke={col} strokeWidth="3" />
              <line x1={cx - halfBoxWidth} x2={halfBoxWidth + cx} y1={safetyClampY(mu)} y2={safetyClampY(mu)} stroke="#cbd5e1" strokeWidth="1.2" strokeDasharray="3 3" opacity="0.65" />
              {b.incidents.map((iv, j) => {
                const outlierY = y(iv);
                if (outlierY < padT || outlierY > H - padB) return null;
                return ( <circle key={j} cx={cx} cy={outlierY} r="3.5" fill="none" stroke={col} strokeOpacity="0.55" strokeWidth="1.2" /> );
              })}
              <text x={cx} y={H - padB + 24} textAnchor="end" fill="#e2e8f0" fontSize="12" fontWeight="500" transform={`rotate(-32 ${cx} ${H - padB + 24})`}>{b.label}</text>
              <text x={cx} y={H - padB + 42} textAnchor="end" fill="#475569" fontSize="10.5" transform={`rotate(-32 ${cx} ${H - padB + 42})`}>{b.sub}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const Empty = ({ msg }) => (
  <div style={{ padding: "48px 20px", textAlign: "center", color: "#66758a", fontSize: 14 }}>{msg}</div>
);

/* ---------- app ---------- */
const parseSecs = (v) => {
  if (v == null) return null;
  const str = String(v);
  const s = str.includes(":") ? parseFloat(str.split(":")[0]) * 60 + parseFloat(str.split(":")[1]) : parseFloat(str);
  return (!isNaN(s) && s > 0) ? Math.round(s * 1000) / 1000 : null;
};

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
      penalties: (s.penalties || []).filter((p) => 
        isOurTeam(p.team, extraTeams) || 
        extraNums.includes(String(p.kart || "")) || 
        karts.some(k => k.num === String(p.kart || ""))
      ),
      posByKart: Object.fromEntries((s.results || []).map((r) => [String(r.kart), parseInt(r.position_change, 10) || 0])),
      finByKart: Object.fromEntries((s.results || []).map((r, i) => {
        let p = Number(r.position);
        return [String(r.kart), isNaN(p) || p === 0 ? i + 1 : p];
      })),
      ptsByKart: Object.fromEntries((s.results || []).map((r) => [String(r.kart), Number(r.points) || 0])),
      sectorsByKart: Object.fromEntries((s.results || []).map((r) => [String(r.kart), {
        s1: parseSecs(r.sector_1 || r.sector1 || r.s1 || r.Sector1), 
        s2: parseSecs(r.sector_2 || r.sector2 || r.s2 || r.Sector2), 
        s3: parseSecs(r.sector_3 || r.sector3 || r.s3 || r.Sector3),
        ult: parseSecs(r.ultimate_lap || r.ultimate || r.ult), 
        best: parseSecs(r.best_lap_time || r.best_lap || r.best),
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
  const [statsSort, setStatsSort] = useState({ key: "points", dir: "desc" });
  const [summarySort, setSummarySort] = useState({ key: "avgRgap", dir: "asc" });
  const [debriefScope, setDebriefScope] = useState("overall");
  const [debriefTime, setDebriefTime] = useState("season");
  const [statsView, setStatsView] = useState("drivers");
  const [h2hA, setH2hA] = useState("");
  const [h2hB, setH2hB] = useState("");
  const [statsMode, setStatsMode] = useState("cards");
  const [statsCat, setStatsCat] = useState("all");
  const [progSel, setProgSel] = useState(null);
  const [traceType, setTraceType] = useState("all");
  const [adminPw, setAdminPw] = useState("");
  const [syncMsg, setSyncMsg] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [appMode, setAppMode] = useState(() => LS("appMode", "telemetry"));
  useEffect(() => { saveLS("appMode", appMode); }, [appMode]);
  const [telemetryLocked, setTelemetryLocked] = useState(false);
  const [telemetryUnlocked, setTelemetryUnlocked] = useState(() => { try { return sessionStorage.getItem("pw_tele") === "1"; } catch { return false; } });
  const [gatePw, setGatePw] = useState("");
  const [gateMsg, setGateMsg] = useState("");
  const unlockTelemetry = async () => {
    setGateMsg("Checking…");
    try {
      const res = await fetch("/api/roster", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verifyControl: { passcode: gatePw } }) });
      const d = await res.json();
      if (res.ok && d.ok) { setTelemetryUnlocked(true); try { sessionStorage.setItem("pw_tele", "1"); } catch {} setGateMsg(""); }
      else setGateMsg("Wrong password.");
    } catch { setGateMsg("Couldn't reach the server (live site only)."); }
  };

  useEffect(() => {
    let m = document.querySelector('meta[name="viewport"]');
    if (!m) { m = document.createElement("meta"); m.name = "viewport"; document.head.appendChild(m); }
    m.setAttribute("content", "width=device-width, initial-scale=1, viewport-fit=cover");
  }, []);

  useEffect(() => {
    fetch("/api/roster").then((r) => r.json())
      .then((d) => {
        if (d && d.roster && Object.keys(d.roster).length) setAssign((prev) => ({ ...prev, ...d.roster }));
        if (d && Array.isArray(d.wetSessions) && d.wetSessions.length) setWetSessions(new Set(d.wetSessions));
        if (d && Array.isArray(d.extraList) && d.extraList.length) setExtraList(d.extraList);
        if (d && Array.isArray(d.removed) && d.removed.length) setRemoved(new Set(d.removed));
        if (d) setTelemetryLocked(!!d.telemetryLocked);
      })
      .catch(() => {});
  }, []);

  const syncRoster = async () => {
    setSyncing(true); setSyncMsg("");
    try {
      const res = await fetch("/api/roster", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roster: assign,
          wetSessions: [...wetSessions],
          extraList: extraList,
          removed: [...removed],
          adminPassword: adminPw,
        }),
      });
      const d = await res.json();
      setSyncMsg(res.ok && d.ok ? "✓ Synced roster, weather, extra entries & team removals." : (d.error || "Sync failed."));
    } catch {
      setSyncMsg("Couldn't reach the sync service (only works on the live site).");
    }
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

  const roundBaselines = useMemo(() => {
    const evs = [];
    Object.values(seasonRaws).forEach((raw) => {
      if (!raw || !raw.title) return;
      if (!/(?:mains|inters)\s*round\s*\d+/i.test(raw.title)) return;   
      let date = null; const leeds = [];
      (raw.sessions || []).forEach((s) => {
        const lab = s.label || s.title || "";
        if (s.date && !date) { const dt = new Date(s.date); if (!isNaN(dt)) date = dt; }
        if (!/race/i.test(lab) || /quali/i.test(lab)) return;
        if (wetSessions.has(`scraped__${s.session_id}`)) return;   
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

  const weekendFastest = useMemo(() => {
    const evs = [];
    Object.values(seasonRaws).forEach((raw) => {
      if (!raw || !raw.title) return;
      if (!/(?:mains|inters)\s*round\s*\d+/i.test(raw.title)) return;
      let date = null;
      const bests = [];
      (raw.sessions || []).forEach((s) => {
        const lab = s.label || s.title || "";
        if (s.date && !date) { const dt = new Date(s.date); if (!isNaN(dt)) date = dt; }
        if (/practice/i.test(lab) || !/race/i.test(lab)) return;   // races + quali, never practice
        if (wetSessions.has(`scraped__${s.session_id}`)) return;   // dry only
        (s.results || []).forEach((r) => { const t = parseSecs(r.best_lap_time); if (t != null) bests.push(t); });
      });
      if (bests.length) evs.push({ title: raw.title, date, fast: Math.min(...bests) });  // true fastest lap (a lap can't be anomalously quick)
    });
    const baselines = {};
    const dated = evs.filter((e) => e.date).sort((a, b) => a.date - b.date);
    const weekends = [];
    dated.forEach((e) => {
      // same weekend AND same-length track (within 12% of the weekend's pace) — stops a 53s track merging with a 73s one
      let wk = weekends.find((w) => Math.abs(w.date - e.date) <= 6 * 86400000 && Math.abs(e.fast - w.fast) / w.fast < 0.12);
      if (!wk) { wk = { date: e.date, fast: e.fast, fasts: [], titles: [] }; weekends.push(wk); }
      wk.fasts.push(e.fast); wk.titles.push(e.title);
    });
    weekends.forEach((w) => { const outright = Math.min(...w.fasts); w.titles.forEach((t) => { baselines[t] = outright; }); });
    evs.filter((e) => !e.date).forEach((e) => { baselines[e.title] = e.fast; });
    return baselines;
  }, [seasonRaws, wetSessions]);

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

  const compareRows = useMemo(() => {
    const map = {};
    compareIds.forEach((eid) => {
      const raw = compareCache[eid];
      if (!raw) return;
      convertEvent(raw, extraTeams, extraNums).forEach((s) => {
        if (!/race/i.test(s.raceLabel)) return;       
        const fm = fieldStats(s).median;
        if (!fm) return;
        s.karts.forEach((k) => {
          const ls = s.laps.map((l) => l.times[k.num]).filter((x) => x != null);
          const clean = splitClean(ls).clean;
          if (!clean.length) return;
          const pct = (mean(clean) / fm - 1) * 100;   
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

  const entries = useMemo(() => allEntries.filter((e) => !removed.has(e.key)), [allEntries, removed]);
  const driverColorMap = useMemo(() => makeDriverColorMap(entries, assign), [entries, assign]);

  const colorOf = useCallback((key) => {
    const entry = entries.find((e) => e.key === key);
    if (!entry) return "#9aa8bb";
    const driver = assign[key]?.trim();
    return (driver && driverColorMap[driver]) || TEAM_COLORS[entry.teamLetter] || "#9aa8bb";
  }, [assign, driverColorMap, entries]);

  const fieldComparisonGroups = useMemo(() => {
    const groups = {};
    entries.forEach((e) => {
      if (!/race/i.test(e.session.raceLabel) || /quali/i.test(e.session.raceLabel)) return;  
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
      if (!/race/i.test(e.session.raceLabel) || /quali/i.test(e.session.raceLabel)) return;  
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
          color: namedDriver ? (driverColorMap[namedDriver] || "#fff") : (TEAM_COLORS[db.teamLetter] || "#9aa8bb"),
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
      const fieldFastest = (s.allKarts || []).map((k) => {
        const c = splitClean(s.laps.map((l) => l.times[k.num]).filter((x) => x != null)).clean;
        return c.length ? Math.min(...c) : null;
      }).filter((x) => x != null);
      
      const fieldMedFast = quantile(fieldFastest.sort((a, b) => a - b), 0.5);
      if (fieldMedFast == null) return;
      
      s.karts.forEach((k) => {
        const driver = assign[`${s.id}|${k.num}`]?.trim();
        if (!driver) return;
        const c = splitClean(s.laps.map((l) => l.times[k.num]).filter((x) => x != null)).clean;
        if (!c.length) return;
        const delta = Math.min(...c) - fieldMedFast;   
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
      if (!s.isRound) return;   
      if ((statsCat === "mains" || statsCat === "inters") && (s.category || "").toLowerCase() !== statsCat) return;
      const isQuali = /quali/i.test(s.raceLabel);
      const isRace = /race/i.test(s.raceLabel) && !isQuali;
      if (!isRace && !isQuali) return;
      s.karts.forEach((k) => {
        const key = `${s.id}|${k.num}`;
        if (removed.has(key)) return;   
        if (!["all", "mains", "inters"].includes(statsCat) && k.teamName !== statsCat) return;
        const ls = s.laps.map((l) => l.times[k.num]).filter((x) => x != null);
        const clean = splitClean(ls).clean;
        const isRealLeeds = /leeds/i.test(k.teamName) && !/beckett/i.test(k.teamName);
        if (isRealLeeds) {   
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

  const arionSummary = useMemo(() => {
    const agg = {};
    seasonSessions.forEach((s) => {
      
      (s.penalties || []).forEach((p) => {
        const pKart = String(p.kart || "");
        const kartObj = s.karts.find(k => 
          (pKart && k.num === pKart) || 
          (p.team && k.teamName.toLowerCase() === (p.team || "").toLowerCase())
        );
        if (!kartObj) return;

        const key = `${s.id}|${kartObj.num}`;
        if (removed.has(key)) return;
        const name = assign[key]?.trim();
        if (!name) return;

        const a = agg[name] || (agg[name] = { name, qPos: [], qGap: [], rGap: [], pGap: [], penPos: 0, pens: 0 });
        a.pens += 1;
        
        const m = String(p.penalty || "").match(/(\d+)\s*(grid|place|pos)/i);
        if (m) {
          a.penPos += Number(m[1]);
        } else if (/exclud|exclusion|dsq|disqual/i.test(p.penalty || "") || /exclud|dsq|disqual/i.test(p.reason || "")) {
          const lost = s.posByKart ? s.posByKart[kartObj.num] : 0;
          if (lost < 0) {
            a.penPos += Math.abs(lost);
          } else {
            a.penPos += Math.floor((s.allKarts ? s.allKarts.length : 30) / 2); 
          }
        }
      });

      if (!s.isRound) return;
      const isQuali = /quali/i.test(s.raceLabel);
      const isRace = /race/i.test(s.raceLabel) && !isQuali;
      if (!isQuali && !isRace) return;
      const isWet = wetSessions.has(s.id);

      if (isWet) return;

      const wFast = weekendFastest[s.round];   // genuine fastest lap at this track (dry, both categories)

      s.karts.forEach((k) => {
        const key = `${s.id}|${k.num}`;
        if (removed.has(key)) return;
        const name = assign[key]?.trim();
        if (!name) return;

        const a = agg[name] || (agg[name] = { name, qPos: [], qGap: [], rGap: [], pGap: [], penPos: 0, pens: 0 });
        const best = s.sectorsByKart && s.sectorsByKart[k.num] ? s.sectorsByKart[k.num].best : null;
        const gap = (best != null && wFast != null) ? best - wFast : null;

        if (isQuali) {
          if (s.finByKart && s.finByKart[k.num] != null) a.qPos.push(s.finByKart[k.num]);
          if (gap != null) a.qGap.push(gap);
        } else if (isRace) {
          if (gap != null) a.rGap.push(gap);
        }
      });
    });
    
    const avg = (x) => (x.length ? x.reduce((p, c) => p + c, 0) / x.length : null);
    return Object.values(agg).map((d) => ({ 
      name: d.name, 
      avgQpos: avg(d.qPos), 
      avgQgap: avg(d.qGap), 
      avgRgap: avg(d.rGap), 
      avgPgap: avg(d.pGap), 
      penPos: d.penPos, 
      pens: d.pens 
    }));
  }, [seasonSessions, assign, removed, weekendFastest, wetSessions]);

  const signedOverview = !!scrapedEventData && (scrapedEventData.sessions || []).some((s) => (s.results || []).some((r) => (r.position_change || 0) < 0));

  const driverRatings = useMemo(() => {
    const clamp = (v) => Math.max(0, Math.min(10, v));
    const agg = {};
    const sessionsForRating = ratingScope === "season" ? seasonSessions : convertedSessions;
    const signed = sessionsForRating.some((s) => Object.values(s.posByKart || {}).some((v) => v < 0));
    const paceScale = ratingScope === "round" ? 3.5 : 2.5;   
    sessionsForRating.forEach((s) => {
      if (!s.isRound) return;   
      if (!/race/i.test(s.raceLabel) || /quali/i.test(s.raceLabel)) return;  
      const report = driverReport(s, extraTeams, extraNums, removed);
      if (!report) return;
      
      const fieldCvs = (s.allKarts || []).map((k) => {
        const kl = s.laps.map((l) => l.times[k.num]).filter((x) => x != null);
        const kc = splitClean(kl).clean;
        const ka = mean(kc), ks = kc.length > 1 ? sd(kc) : null;
        return (ka && ks != null) ? (ks / ka) * 100 : null;
      }).filter((x) => x != null);
      const cvMean = mean(fieldCvs), cvSd = sd(fieldCvs) || 0.0001;
      const sessionFieldMed = fieldStats(s).median;   

      report.rows.forEach((r) => {
        if (!r.isLeeds) return;
        const name = assign[`${s.id}|${r.num}`]?.trim();
        if (!name) return;   

        const ls = s.laps.map((l) => l.times[r.num]).filter((x) => x != null);
        const clean = splitClean(ls).clean;
        const cavg = mean(clean), csd = clean.length > 1 ? sd(clean) : 0;
        const cv = cavg ? (csd / cavg) * 100 : 5;   
        const consZ = (cvMean - cv) / cvSd;          
        const isWet = wetSessions.has(s.id);
        
        agg[name] = agg[name] || { name, team: r.teamLetter, pace: [], cons: [], race: [], gain: [], wet: [], decaySlopes: [], races: 0 };
        
        if (clean.length > 5) {
          let sx = 0, sy = 0, sxy = 0, sxx = 0;
          clean.forEach((t, i) => { const lapIdx = i + 1; sx += lapIdx; sy += t; sxy += lapIdx * t; sxx += lapIdx * lapIdx; });
          const slope = (clean.length * sxy - sx * sy) / (clean.length * sxx - sx * sx);
          if (slope > 0) agg[name].decaySlopes.push(slope);
        }

        if (isWet) {
          if (sessionFieldMed && cavg) agg[name].wet.push(cavg - sessionFieldMed);   
        } else {
          const baseline = roundBaselines[s.round];                    
          const pacePct = (baseline && cavg) ? (cavg / baseline - 1) * 100 : null;
          
          let calculatedPaceScore = pacePct != null ? clamp(6 - pacePct * paceScale) : clamp(5 - (r.z ?? 0) * 2.5);
          
          if (s.category === "Mains" && calculatedPaceScore < 6.5 && csd < 0.12) {
            calculatedPaceScore = Math.max(calculatedPaceScore, 7.8); 
          }
          if (s.category === "Inters" && s.sectorsByKart && s.sectorsByKart[r.num]) {
            const qBest = s.sectorsByKart[r.num].best;
            if (qBest && cavg && (cavg - qBest) > 1.2 && csd < 0.15) {
              calculatedPaceScore = Math.max(calculatedPaceScore, 8.0); 
            }
          }
          
          agg[name].pace.push(calculatedPaceScore);
          agg[name].cons.push(clamp(10 - (cv - 1.2) * 3.2));   
        }

        const gained = s.posByKart ? s.posByKart[r.num] : null;
        const fin = s.finByKart ? s.finByKart[r.num] : null;
        if (signed && gained != null && fin != null) {
          const start = fin + gained;
          const fieldSize = (s.allKarts || []).length || 20;
          let sc;
          if (fin === 1) sc = 10;                            
          else if (start <= 3 && fin <= 3) sc = 9.5;          
          else { const deep = start > fieldSize * 0.6 ? 1.4 : 1; sc = clamp(5.5 + gained * 0.45 * (gained > 0 ? deep : 1)); }
          if (start <= fieldSize * 0.33 && gained >= -2) sc = Math.max(sc, 7.5);  
          if ((s.penalties || []).some((p) => String(p.kart) === r.num)) sc = clamp(sc - 3);  
          agg[name].race.push(sc); agg[name].gain.push(gained);
        }
        agg[name].races += 1;
      });
    });
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    return Object.values(agg).map((d) => {
      const pace = avg(d.pace), race = avg(d.race);
      
      const decayIndex = d.decaySlopes.length ? avg(d.decaySlopes) : 0;
      const cons = d.cons.length ? clamp(avg(d.cons) - (decayIndex * 35)) : 0; 
      
      const hasPace = d.pace.length > 0, hasRace = d.race.length > 0, hasCons = d.cons.length > 0;
      let tot = 0, w = 0;
      if (hasPace) { tot += pace * 0.65; w += 0.65; }
      if (hasRace) { tot += race * 0.20; w += 0.20; }
      if (hasCons) { tot += cons * 0.15; w += 0.15; }
      
      const overall = w ? tot / w : (hasRace ? race : 0); 
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
    <div className="approot" style={{ minHeight: "100vh", background: "#05070b", color: "#e6edf3",
      fontFamily: "Barlow, system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=Barlow+Semi+Condensed:wght@400;500;600;700&family=Barlow:wght@400;500;600;700&display=swap');
        html, body, #root { margin: 0 !important; padding: 0 !important; max-width: none !important; width: 100% !important; display: block !important; place-items: initial !important; text-align: left !important; background: #05070b; overflow-x: hidden; }
        * { box-sizing: border-box; }
        .approot { zoom: 1.18; }
        .mono { font-family: 'Barlow Semi Condensed', sans-serif; font-variant-numeric: tabular-nums; line-height: 1.45; }
        .disp { font-family: 'Barlow Condensed', sans-serif; letter-spacing: 0.6px; text-transform: uppercase; line-height: 1.2; }
        .approot div { min-width: 0; }
        ::-webkit-scrollbar { height: 8px; width: 8px; }
        ::-webkit-scrollbar-thumb { background:#243042; border-radius: 4px; }
        .appwrap { padding: 24px 28px; max-width: 1380px; margin: 0 auto; }
        .apphead { padding: 14px 28px; max-width: 1380px; margin: 0 auto; }
        .stripe { height: 3px; background: linear-gradient(90deg, #ffce3a 0 120px, #ff2d4d 120px 180px, transparent 180px); }
        .scrollx { overflow-x: auto; -webkit-overflow-scrolling: touch; }
        table { max-width: 100%; }
        img, svg { max-width: 100%; }
        button { font-family: inherit; }
        @media (max-width: 820px) {
          .approot { zoom: 1 !important; }
          .appwrap { padding: 12px 11px; }
          .apphead { padding: 10px 13px; flex-wrap: wrap; gap: 10px; }
          .apptabs { flex-wrap: nowrap !important; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; max-width: 100%; }
          .apptabs::-webkit-scrollbar { display: none; }
          .apptabs button { font-size: 13px !important; padding: 7px 11px !important; white-space: nowrap; flex: 0 0 auto; }
          input, select, textarea { font-size: 16px !important; }
          .panelpad { padding: 13px !important; }
          .g2, .g3 { grid-template-columns: 1fr 1fr !important; }
        }
        @media (max-width: 460px) {
          .appwrap { padding: 10px 9px; }
          .hidesm { display: none !important; }
        }
      `}</style>

      {/* header */}
      <div className="stripe" />
      <div className="apphead" style={{ borderBottom: "1px solid #1b2433",
        display: "flex", alignItems: "center", gap: 16, background: "linear-gradient(180deg,#0b0f15,#05070b)" }}>
        <div style={{ width: 10, height: 32, background: AMBER, borderRadius: 2, boxShadow: "0 0 14px #ffce3a33", flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div className="disp" style={{ fontSize: 27, fontWeight: 700, lineHeight: 1 }}>
            LEEDS MOTORSPORT <span style={{ color: AMBER }}>· TELEMETRY</span>
          </div>
          <div className="mono" style={{ fontSize: 11, color: loadError ? "#ff8a5b" : "#78889d", marginTop: 4 }}>
            {appMode === "live24"
              ? "BUKC 24 HOUR 2026 · LIVE"
              : (scrapedEventData?.title ? scrapedEventData.title.toUpperCase() : (loadError || "BUKC PIPELINE ENGINE"))}
          </div>
        </div>
        
        {/* mode toggle */}
        <div className="apptabs" style={{ display: "flex", gap: 6 }}>
          {[["telemetry", "SEASON TELEMETRY"], ["live24", "24 HOURS LIVE"]].map(([k, l]) => (
            <button key={k} onClick={() => setAppMode(k)} className="disp"
              style={{ padding: "8px 14px", borderRadius: 6, fontWeight: 700, fontSize: 15, cursor: "pointer",
                border: "1px solid", borderColor: appMode === k ? AMBER : "#2b3a4e",
                background: appMode === k ? "#1a160a" : "#0b1017", color: appMode === k ? AMBER : "#9aa8bb",
                boxShadow: k === "live24" && appMode === k ? "0 0 0 1px #ff2d4d33" : "none" }}>
              {k === "live24" && <span style={{ color: "#ff2d4d", marginRight: 5 }}>●</span>}{l}
            </button>
          ))}
        </div>

        {appMode === "telemetry" && (<>
        {/* round selector */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#0d141c", border: "1px solid #2b3a4e", padding: "5px 10px", borderRadius: 8 }}>
          <span className="disp" style={{ fontSize: 11.5, color: "#78889d", fontWeight: 600 }}>ROUND:</span>
          <select className="mono" value={activeEventId || ""} onChange={(e) => setActiveEventId(e.target.value)}
            style={{ background: "#11171f", border: "1px solid #2b3a4e", borderRadius: 6, color: "#e6edf3",
              padding: "5px 8px", fontSize: 12.5, fontFamily: "Barlow Semi Condensed, sans-serif", minWidth: 180, cursor: "pointer" }}>
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

        {eventIndex.length > 1 && (
          <div style={{ position: "relative" }}>
            <button onClick={() => setCompareOpen((o) => !o)} className="disp"
              style={{ display: "flex", alignItems: "center", gap: 8, background: "#0d141c",
                border: `1px solid ${compareIds.length ? AMBER : "#2b3a4e"}`, padding: "6px 12px", borderRadius: 8,
                cursor: "pointer", color: compareIds.length ? AMBER : "#9aa8bb", fontSize: 12, fontWeight: 600 }}>
              + COMPARE{compareIds.length ? ` (${compareIds.length})` : ""} ▾
            </button>
            {compareOpen && (
              <div style={{ position: "absolute", top: "112%", left: 0, zIndex: 50, background: "#0d141c",
                border: "1px solid #2b3a4e", borderRadius: 8, padding: 10, minWidth: 210, maxHeight: 300,
                overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
                {["Mains", "Inters"].filter((cat) => eventIndex.some((e) => e.category === cat && e.id !== activeEventId)).map((cat) => (
                  <div key={cat} style={{ marginBottom: 8 }}>
                    <div className="mono" style={{ fontSize: 11, color: "#66758a", marginBottom: 4 }}>{cat.toUpperCase()}</div>
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
        </>)}
      </div>

      <div className="appwrap">
        {appMode === "live24" && (
          <Live24 knownDrivers={[...new Set(Object.values(assign).map((v) => v && v.trim()).filter(Boolean))]} />
        )}
        {appMode === "telemetry" && telemetryLocked && !telemetryUnlocked && (
          <div style={{ maxWidth: 380, margin: "60px auto", textAlign: "center", padding: 24, background: "#0b1017", border: "1px solid #2b3a4e", borderRadius: 12 }}>
            <div className="disp" style={{ fontSize: 16, fontWeight: 700, color: "#e6edf3" }}>🔒 Season telemetry is locked</div>
            <div className="mono" style={{ fontSize: 12, color: "#78889d", margin: "8px 0 16px" }}>Enter the admin password to view it. The 24 Hours Live section stays open.</div>
            <input type="password" value={gatePw} onChange={(e) => setGatePw(e.target.value)} placeholder="admin password"
              onKeyDown={(e) => { if (e.key === "Enter") unlockTelemetry(); }}
              style={{ ...inp(260), fontFamily: "Barlow, sans-serif", margin: "0 auto", display: "block" }} />
            <button onClick={unlockTelemetry} className="disp"
              style={{ marginTop: 12, background: AMBER, color: "#1a160a", border: "none", borderRadius: 8, padding: "10px 20px", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>UNLOCK</button>
            {gateMsg && <div className="mono" style={{ fontSize: 12, color: gateMsg === "Checking…" ? "#9aa8bb" : "#ff8a5b", marginTop: 10 }}>{gateMsg}</div>}
          </div>
        )}
        {appMode === "telemetry" && (!telemetryLocked || telemetryUnlocked) && (<>
        
        {/* driver assignment */}
        {allEntries.length > 0 && (
          <Panel title="01 · ROSTER ASSIGNMENT">
            <div style={{ marginBottom: 14 }}>
              <Label>EXTRA ENTRIES <span style={{ color: "#66758a" }}>(paid seats under another uni — type a kart number or team, press Enter)</span></Label>
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
            <Label>TEAM LINEUPS <span style={{ color: "#66758a" }}>(name a driver once per heat — quali and race fill together)</span></Label>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
              <button onClick={() => csvRef.current?.click()} className="disp"
                style={{ background: "#11233a", color: AMBER, border: `1px solid ${AMBER}55`, borderRadius: 7,
                  padding: "7px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                ⬆ IMPORT LINEUP CSV
              </button>
              <span className="mono" style={{ fontSize: 11, color: "#66758a" }}>
                columns: team, race, driver &nbsp;(e.g. Leeds A, Race 1, Sam)
              </span>
              <input ref={csvRef} type="file" accept=".csv,.txt" hidden
                onChange={(ev) => onLineupCsv(ev.target.files?.[0])} />
              {importMsg && <span className="mono" style={{ fontSize: 11.5, color: importMsg.includes("matched none") || importMsg.includes("Couldn't") ? "#ff8a5b" : "#2fd372" }}>{importMsg}</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
              <input type="password" value={adminPw} onChange={(e) => setAdminPw(e.target.value)} placeholder="admin password"
                style={{ ...inp(150), fontFamily: "Barlow, sans-serif" }} />
              <button onClick={syncRoster} disabled={syncing} className="disp"
                style={{ background: "#11233a", color: "#3da9fc", border: "1px solid #3da9fc55", borderRadius: 7,
                  padding: "7px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                {syncing ? "SYNCING…" : "💾 SYNC GLOBAL ROSTER"}
              </button>
              <span className="mono" style={{ fontSize: 11, color: "#66758a" }}>pushes this roster to everyone (admin only)</span>
              {syncMsg && <span className="mono" style={{ fontSize: 11.5, color: syncMsg.startsWith("✓") ? "#2fd372" : "#ff8a5b" }}>{syncMsg}</span>}
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
                        className="mono" style={{ marginBottom: 8, fontSize: 11.5, cursor: "pointer", background: "none",
                          border: `1px solid ${allRemoved ? "#2fd372" : "#3a2530"}`, borderRadius: 5, padding: "3px 9px", color: allRemoved ? "#2fd372" : "#ff8a5b" }}>
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
                          <span className="mono" style={{ color: "#78889d", fontSize: 11.5, width: 130 }}>{d.sub}</span>
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
                              color: isRemoved ? "#2fd372" : "#ff6b6b", fontSize: 14, padding: "0 4px" }}>
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
                ["summary", "SUMMARY"],
                ["field", "FIELD COMPARISON"], 
                ["trace", "LAP TRACES"], 
                ["prog", "PROGRESSION"],
                ["report", "DRIVER REPORT"],
                ["rating", "DRIVER RATING"],
                ["debrief", "AI DEBRIEF"],
                ["stats", "STATS"],
                ["special", "SPECIAL EVENTS"],
                ["sectors", "SECTORS"],
                ["lineup", "LINEUP"],
                ["h2h", "HEAD-TO-HEAD"]
              ].map(([k, l]) => (
                <button key={k} onClick={() => setTab(k)} className="disp"
                  style={{ padding: "8px 16px", borderRadius: 6, fontWeight: 600, fontSize: 15.5, cursor: "pointer",
                    border: "1px solid", borderColor: tab === k ? AMBER : "#2b3a4e",
                    background: tab === k ? "#1a160a" : "#0b1017", color: tab === k ? AMBER : "#9aa8bb" }}>
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
                          <tr style={{ color: "#78889d", textAlign: "left" }}>
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
                              <td style={{ padding: "8px", color: "#78889d" }}>#{row.kart || "—"}</td>
                              <td style={{ padding: "8px", color: "#c2cbd6" }}>{row.total_laps}</td>
                              <td style={{ padding: "8px", color: "#2fd372", fontWeight: "700" }}>{row.total_points || "—"} pts</td>
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
                      <div key={session.session_id} style={{ background: "#0b1017", borderRadius: 10, padding: "18px", border: "1px solid #1b2433" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, borderBottom: "1px solid #1e2733", paddingBottom: 6 }}>
                          <div className="disp" style={{ color: AMBER, fontSize: 14.5, fontWeight: 700 }}>
                            🏁 {session.label.toUpperCase()}
                          </div>
                          <div className="mono" style={{ fontSize: 11, color: "#66758a", display: "flex", alignItems: "center", gap: 10 }}>
                            START: {session.start_time || "—"} · LAPS: {session.total_laps || "—"}
                            {(() => { const sid = `scraped__${session.session_id}`; const wet = wetSessions.has(sid); return (
                              <button onClick={() => setWetSessions((prev) => { const n = new Set(prev); wet ? n.delete(sid) : n.add(sid); return n; })}
                                style={{ cursor: "pointer", borderRadius: 5, padding: "3px 8px", fontSize: 11.5, fontWeight: 600,
                                  border: `1px solid ${wet ? "#3da9fc" : "#2a3543"}`, background: wet ? "#0b2030" : "#0b1017", color: wet ? "#3da9fc" : "#66758a" }}>
                                {wet ? "🌧 WET" : "DRY"}
                              </button>
                            ); })()}
                          </div>
                        </div>
                        <div style={{ overflowX: "auto" }}>
                          <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                            <thead>
                              <tr style={{ color: "#78889d", textAlign: "left" }}>
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
                                      <td style={{ padding: "8px", fontWeight: "600", color: row.position_change > 0 ? "#2fd372" : row.position_change < 0 ? "#ff2d4d" : "#4b5563" }}>
                                        {row.position_change > 0 ? `+${row.position_change}` : row.position_change < 0 ? row.position_change : row.position_change === 0 ? "0" : "—"}
                                      </td>
                                    )}
                                    <td style={{ padding: "8px", color: "#fff", fontWeight: "600" }}>
                                      {row.team} {row.penalty && <span style={{ color: "#ff2d4d", fontSize: 11, marginLeft: 6 }}>[+PENALTY]</span>}
                                    </td>
                                    <td style={{ padding: "8px", color: "#78889d" }}>#{row.kart || "—"}</td>
                                    <td style={{ padding: "8px", color: "#c2cbd6" }}>{row.best_lap_time ? `${row.best_lap_time}s` : "—"} <span style={{ fontSize: 11, color: "#66758a" }}>{row.best_lap_number ? `(L${row.best_lap_number})` : ""}</span></td>
                                    <td style={{ padding: "8px", color: "#c2cbd6" }}>{row.total_time || "—"}</td>
                                    <td style={{ padding: "8px", color: "#2fd372", fontWeight: "600" }}>{row.points || "0"} pts</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {(() => {
                          const sp = (session.penalties || []).filter((p) => {
                            const t = (p.team || "").toLowerCase();
                            const pKart = String(p.kart || "");
                            return (t.includes("leeds") && !t.includes("beckett")) || 
                                   leedsSessionRows.some(r => String(r.kart) === pKart);
                          });
                          if (!sp.length) return null;
                          return (
                            <div style={{ marginTop: 10, borderTop: "1px solid #11171f", paddingTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                              <span className="disp" style={{ fontSize: 11, color: "#ff6b6b", fontWeight: 600, letterSpacing: "0.5px", alignSelf: "center" }}>⚑</span>
                              {sp.map((p, pi) => (
                                <span key={pi} className="mono" style={{ background: "#1a0f12", border: "1px solid #ff2d4d30", borderRadius: 6, padding: "4px 8px", fontSize: 11 }}>
                                  <span style={{ color: "#e6edf3", fontWeight: 600 }}>#{p.kart}</span>
                                  <span style={{ color: "#ff8a5b" }}> {p.penalty}</span>
                                  <span style={{ color: "#78889d" }}> · {String(p.reason || "").replace(/^\s*\d+\w*\.\s*/, "")}</span>
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

            {/* TAB: ARION'S CRITICAL SUMMARY LOGS - NOW INTERACTIVE */}
            {tab === "summary" && (
              <Panel title="SUMMARY — QUALIFYING, PACE GAP & PENALTIES (WHOLE SEASON)">
                {arionSummary.length === 0 ? <Empty msg="Name drivers to build logs summary." /> : (
                  <div style={{ overflowX: "auto" }}>
                    {(() => {
                      const cols = [
                        ["#", null],
                        ["DRIVER", "name"],
                        ["AVG QUALI POS", "avgQpos"],
                        ["QUALI GAP", "avgQgap"],
                        ["RACE GAP", "avgRgap"],
                        ["PACE GAP", "avgPgap"],
                        ["POS LOST (PENALTY)", "penPos"],
                        ["PENALTIES", "pens"]
                      ];
                      
                      const clickSort = (key) => {
                        if (!key) return;
                        setSummarySort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));
                      };

                      const sortedSummary = [...arionSummary].sort((a, b) => {
                        const k = summarySort.key;
                        const m = summarySort.dir === "asc" ? 1 : -1;
                        if (k === "name") return m * String(a.name).localeCompare(String(b.name));
                        
                        // Push nulls to the bottom automatically
                        if (a[k] == null && b[k] == null) return 0;
                        if (a[k] == null) return 1;
                        if (b[k] == null) return -1;
                        
                        return m * (a[k] - b[k]);
                      });

                      return (
                        <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 640 }}>
                          <thead>
                            <tr style={{ color: "#78889d" }}>
                              {cols.map(([h, key], i) => (
                                <th key={h} onClick={() => clickSort(key)}
                                  style={{ textAlign: i < 2 ? "left" : "right", padding: "6px 10px", borderBottom: "1px solid #1e2733", 
                                    fontWeight: 500, cursor: key ? "pointer" : "default", 
                                    color: summarySort.key === key ? AMBER : "#78889d", userSelect: "none" }}>
                                  {h}{summarySort.key === key ? (summarySort.dir === "desc" ? " ▾" : " ▴") : ""}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {sortedSummary.map((d, i) => (
                              <tr key={d.name} style={{ borderBottom: "1px solid #11171f" }}>
                                <td style={{ padding: "7px 10px", color: "#66758a" }}>{i + 1}</td>
                                <td style={{ padding: "7px 10px", color: "#e6edf3", fontWeight: 600 }}>{d.name}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right", color: AMBER, fontWeight: 600 }}>{d.avgQpos != null ? "P" + d.avgQpos.toFixed(1) : "—"}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right", color: "#c2cbd6" }}>{d.avgQgap != null ? "+" + d.avgQgap.toFixed(3) + "s" : "—"}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right", color: "#c2cbd6" }}>{d.avgRgap != null ? "+" + d.avgRgap.toFixed(3) + "s" : "—"}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right", color: "#3da9fc", fontWeight: 600 }}>{d.avgPgap != null ? "+" + d.avgPgap.toFixed(3) + "s" : "—"}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right", color: d.penPos > 0 ? "#ff8a5b" : "#66758a" }}>{d.penPos > 0 ? "-" + d.penPos : "0"}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right", color: d.pens > 0 ? "#ff6b6b" : "#66758a" }}>{d.pens}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      );
                    })()}
                  </div>
                )}
                <div className="mono" style={{ fontSize: 11, color: "#66758a", marginTop: 12, lineHeight: 1.5 }}>
                  Race/Quali Gap = difference between your best lap and the session's ultimate lap. Pace Gap = difference between your best lap and the outright best lap of the entire weekend cluster. Anomalous transponder glitches (&gt;1.5s faster than the field median) are permanently removed from all baseline calculations. Wet races are ignored from gap metrics.
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
                      accent={isSummary ? AMBER : "#9aa8bb"}
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
                        border: `1px solid ${traceType === k ? AMBER : "#2b3a4e"}`, background: traceType === k ? "#1a160a" : "#0b1017", color: traceType === k ? AMBER : "#9aa8bb" }}>{l}</button>
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
                    <CartesianGrid stroke="#1b2433" />
                    <XAxis dataKey="lap" stroke="#66758a" tick={{ fontSize: 11, fontFamily: "Barlow Semi Condensed" }}
                      label={{ value: "LAP", position: "insideBottom", offset: -2, fill: "#66758a", fontSize: 11 }} />
                    <YAxis stroke="#66758a" tick={{ fontSize: 11, fontFamily: "Barlow Semi Condensed" }}
                      domain={["dataMin - 0.5", "dataMax + 0.5"]} width={52}
                      allowDecimals={false} interval={0} tickFormatter={(v) => v.toFixed(1)}
                      ticks={(() => { const all = traceData.flatMap((r) => Object.entries(r).filter(([k]) => k !== "lap").map(([, v]) => v)).filter((v) => typeof v === "number"); if (!all.length) return undefined; const lo = Math.floor(Math.min(...all) * 2) / 2, hi = Math.ceil(Math.max(...all) * 2) / 2; const t = []; for (let v = lo; v <= hi + 0.001; v += 0.5) t.push(Math.round(v * 2) / 2); return t; })()} />
                    <Tooltip formatter={(v) => (typeof v === "number" ? v.toFixed(3) + "s" : v)}
                      contentStyle={{ background: "#0d141c", border: "1px solid #2b3a4e", borderRadius: 8,
                      fontFamily: "Barlow Semi Condensed", fontSize: 12 }} labelStyle={{ color: AMBER }} />
                    {fieldMed != null && (
                      <ReferenceLine y={fieldMed} stroke={AMBER} strokeDasharray="6 5"
                        label={{ value: "field median", fill: AMBER, fontSize: 11, position: "insideTopRight" }} />
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
                      <CartesianGrid stroke="#1b2433" />
                      <XAxis dataKey="round" stroke="#66758a" tick={{ fontSize: 11, fontFamily: "Barlow Semi Condensed" }} />
                      <YAxis stroke="#66758a" tick={{ fontSize: 11, fontFamily: "Barlow Semi Condensed" }}
                        domain={["dataMin - 0.3", "dataMax + 0.3"]} width={52} tickFormatter={(v) => v.toFixed(1)}
                        ticks={(() => { const all = progression.data.flatMap((r) => Object.entries(r).filter(([k]) => k !== "round").map(([, v]) => v)).filter((v) => typeof v === "number"); if (!all.length) return undefined; const lo = Math.floor(Math.min(...all) * 2) / 2, hi = Math.ceil(Math.max(...all) * 2) / 2; const t = []; for (let v = lo; v <= hi + 0.001; v += 0.5) t.push(Math.round(v * 2) / 2); return t; })()}
                        label={{ value: "fastest lap vs field (s) — lower is better", angle: -90, position: "insideLeft", fill: "#66758a", fontSize: 10 }} />
                      <Tooltip formatter={(v) => (typeof v === "number" ? v.toFixed(2) + "s" : v)}
                        contentStyle={{ background: "#0d141c", border: "1px solid #2b3a4e", borderRadius: 8,
                        fontFamily: "Barlow Semi Condensed", fontSize: 12 }} labelStyle={{ color: AMBER }} />
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
                    <span className="mono" style={{ fontSize: 11, color: "#78889d" }}>SESSION</span>
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
                        border: `1px solid ${ratingScope === k ? AMBER : "#2b3a4e"}`,
                        background: ratingScope === k ? "#1a160a" : "#0b1017", color: ratingScope === k ? AMBER : "#9aa8bb" }}>
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
                        <tr style={{ color: "#78889d" }}>
                          {cols.map(([h, key], i) => (
                            <th key={h} onClick={() => clickSort(key)}
                              style={{ padding: "6px 10px", textAlign: i < 2 ? "left" : "right", borderBottom: "1px solid #1e2733",
                                fontWeight: 500, cursor: key ? "pointer" : "default", color: ratingSort.key === key ? AMBER : "#78889d", userSelect: "none" }}>
                              {h}{ratingSort.key === key ? (ratingSort.dir === "desc" ? " ▾" : " ▴") : ""}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((d, i) => {
                          const rc = (v) => v >= 7 ? "#2fd372" : v >= 4.5 ? "#ffce3a" : "#ff8a5b";
                          const bar = (v) => (<span style={{ color: rc(v) }}>{v.toFixed(2)}</span>);
                          return (
                            <tr key={d.name} style={{ borderBottom: "1px solid #11171f" }}>
                              <td style={{ padding: "7px 10px", color: "#66758a" }}>{i + 1}</td>
                              <td style={{ padding: "7px 10px", color: "#e6edf3", fontWeight: 600 }}>{d.name}</td>
                              <td style={{ padding: "7px 10px", textAlign: "right", color: "#9aa8bb" }}>{d.races}</td>
                              <td style={{ padding: "7px 10px", textAlign: "right" }}>
                                {d.hasPace ? bar(d.pace) : <span style={{ color: "#3a4655" }}>—</span>}
                                {d.wetDelta != null && <span style={{ color: "#3da9fc", fontSize: 11.5 }}> ({d.wetDelta <= 0 ? "" : "+"}{d.wetDelta.toFixed(2)})</span>}
                              </td>
                              <td style={{ padding: "7px 10px", textAlign: "right" }}>{d.hasCons ? bar(d.cons) : <span style={{ color: "#3a4655" }}>—</span>}</td>
                              {showRace && (
                                <td style={{ padding: "7px 10px", textAlign: "right" }}>
                                  {d.hasRace ? (
                                    <>{bar(d.race)} <span style={{ color: d.netGain >= 0 ? "#2fd372" : "#ff8a5b", fontSize: 11.5 }}>({d.netGain >= 0 ? "+" : ""}{d.netGain})</span></>
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
                    <div className="mono" style={{ fontSize: 11, color: "#66758a", marginTop: 12, lineHeight: 1.5 }}>
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
                    <label className="mono" style={{ fontSize: 11, color: "#78889d", display: "flex", flexDirection: "column", gap: 4 }}>
                      {label}
                      <select value={val} onChange={(e) => set(e.target.value)}
                        style={{ background: "#11171f", border: "1px solid #2b3a4e", borderRadius: 6, color: "#e6edf3", padding: "6px 8px", fontSize: 12.5, fontFamily: "Barlow Semi Condensed, sans-serif" }}>
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
                        <div style={{ background: "#0b0f15", borderLeft: `3px solid ${AMBER}`, border: "1px solid #2b3a4e", borderRadius: 8, padding: "18px 20px", whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.7, color: "#dbe2ea" }}>
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
                      <div className="mono" style={{ fontSize: 11, color: "#66758a", letterSpacing: "0.5px" }}>{label}</div>
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
                          <Stat label="POINTS" value={o.points} color="#2fd372" />
                          <Stat label="RACES" value={o.races} />
                          <Stat label="AVG FINISH" value={o.avgFinish != null ? o.avgFinish.toFixed(1) : "—"} />
                          <Stat label="NET +/-" value={posCh(o.totalPosCh)} color={o.totalPosCh >= 0 ? "#2fd372" : "#ff8a5b"} />
                          <Stat label="BEST LAP" value={o.bestLap != null ? fmt(o.bestLap) : "—"} color={AMBER} />
                          <Stat label="RACE PACE" value={o.racePace != null ? fmt(o.racePace) : "—"} />
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                        {[["drivers", "BY DRIVER"], ["teams", "BY TEAM"]].map(([k, l]) => (
                          <button key={k} onClick={() => setStatsView(k)} className="disp"
                            style={{ padding: "6px 14px", borderRadius: 7, fontWeight: 600, fontSize: 12.5, cursor: "pointer",
                              border: `1px solid ${statsView === k ? AMBER : "#2b3a4e"}`, background: statsView === k ? "#1a160a" : "#0b1017", color: statsView === k ? AMBER : "#9aa8bb" }}>{l}</button>
                        ))}
                        <span style={{ width: 14 }} />
                        {[["all", "ALL"], ["mains", "MAINS"], ["inters", "INTERS"], ...leedsTeamNames.map((t) => [t, t.toUpperCase()])].map(([k, l]) => (
                          <button key={k} onClick={() => setStatsCat(k)} className="disp"
                            style={{ padding: "6px 12px", borderRadius: 7, fontWeight: 600, fontSize: 12.5, cursor: "pointer",
                              border: `1px solid ${statsCat === k ? "#b06bff" : "#2b3a4e"}`, background: statsCat === k ? "#1a0f2a" : "#0b1017", color: statsCat === k ? "#b06bff" : "#9aa8bb" }}>{l}</button>
                        ))}
                        <span style={{ flex: 1 }} />
                        {[["cards", "CARDS"], ["chart", "CHART"], ["table", "TABLE"]].map(([k, l]) => (
                          <button key={k} onClick={() => setStatsMode(k)} className="disp"
                            style={{ padding: "6px 14px", borderRadius: 7, fontWeight: 600, fontSize: 12.5, cursor: "pointer",
                              border: `1px solid ${statsMode === k ? "#3da9fc" : "#2b3a4e"}`, background: statsMode === k ? "#0b2030" : "#0b1017", color: statsMode === k ? "#3da9fc" : "#9aa8bb" }}>{l}</button>
                        ))}
                      </div>

                      {list.length === 0 ? <Empty msg="Name drivers in the roster to build stats." /> : statsMode === "chart" ? (
                        <ResponsiveContainer width="100%" height={Math.max(260, list.length * 34)}>
                          <BarChart data={list} layout="vertical" margin={{ top: 4, right: 30, bottom: 4, left: 10 }}>
                            <CartesianGrid stroke="#1b2433" horizontal={false} />
                            <XAxis type="number" stroke="#66758a" tick={{ fontSize: 11, fontFamily: "Barlow Semi Condensed" }} />
                            <YAxis type="category" dataKey="name" width={110} stroke="#66758a" tick={{ fontSize: 12, fontFamily: "Barlow" }} />
                            <Tooltip cursor={{ fill: "#ffffff08" }} contentStyle={{ background: "#0d141c", border: "1px solid #2b3a4e", borderRadius: 8, fontFamily: "Barlow Semi Condensed", fontSize: 12 }} labelStyle={{ color: AMBER }} />
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
                              <tr style={{ color: "#78889d" }}>
                                {cols.map(([h, key], i) => (
                                  <th key={h} onClick={() => clickSort(key)} style={{ padding: "6px 10px", textAlign: i < 2 ? "left" : "right", borderBottom: "1px solid #1e2733",
                                    fontWeight: 500, cursor: key ? "pointer" : "default", color: statsSort.key === key ? AMBER : "#78889d", userSelect: "none" }}>
                                    {h}{statsSort.key === key ? (statsSort.dir === "desc" ? " ▾" : " ▴") : ""}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {sorted.map((d, i) => (
                                <tr key={d.name} style={{ borderBottom: "1px solid #11171f" }}>
                                  <td style={{ padding: "7px 10px", color: "#66758a" }}>{i + 1}</td>
                                  <td style={{ padding: "7px 10px", color: "#e6edf3", fontWeight: 600 }}>{d.name}</td>
                                  <td style={{ padding: "7px 10px", textAlign: "right", color: "#9aa8bb" }}>{d.races}</td>
                                  <td style={{ padding: "7px 10px", textAlign: "right", color: "#2fd372", fontWeight: 700 }}>{d.points}</td>
                                  <td style={{ padding: "7px 10px", textAlign: "right", color: "#c2cbd6" }}>{d.avgFinish != null ? d.avgFinish.toFixed(1) : "—"}</td>
                                  <td style={{ padding: "7px 10px", textAlign: "right", color: d.totalPosCh == null ? "#66758a" : d.totalPosCh >= 0 ? "#2fd372" : "#ff8a5b" }}>{posCh(d.totalPosCh)}</td>
                                  <td style={{ padding: "7px 10px", textAlign: "right", color: AMBER }}>{d.bestLap != null ? fmt(d.bestLap) : "—"}</td>
                                  <td style={{ padding: "7px 10px", textAlign: "right", color: "#c2cbd6" }}>{d.racePace != null ? fmt(d.racePace) : "—"}</td>
                                  <td style={{ padding: "7px 10px", textAlign: "right", color: "#9aa8bb" }}>{d.bestQualiPos != null ? "P" + d.bestQualiPos : "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                            );
                          })()}
                        </div>
                      ) : (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))", gap: 12 }}>
                          {list.map((d, i) => (
                            <div key={d.name} style={{ background: "#0b1017", border: "1px solid #1b2430", borderRadius: 10, padding: "14px 16px" }}>
                              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
                                <span className="disp" style={{ fontSize: 17, fontWeight: 700, color: "#e6edf3" }}>
                                  <span style={{ color: "#66758a", fontSize: 13 }}>{i + 1}. </span>{d.name}
                                </span>
                                <span className="mono" style={{ fontSize: 19, fontWeight: 700, color: "#2fd372" }}>{d.points}<span style={{ fontSize: 11, color: "#66758a" }}> pts</span></span>
                              </div>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                                <Stat label="RACES" value={d.races} />
                                <Stat label="AVG FINISH" value={d.avgFinish != null ? d.avgFinish.toFixed(1) : "—"} />
                                <Stat label="NET +/-" value={posCh(d.totalPosCh)} color={d.totalPosCh == null ? "#66758a" : d.totalPosCh >= 0 ? "#2fd372" : "#ff8a5b"} />
                                <Stat label="BEST LAP" value={d.bestLap != null ? fmt(d.bestLap) : "—"} color={AMBER} />
                                <Stat label="RACE PACE" value={d.racePace != null ? fmt(d.racePace) : "—"} />
                                <Stat label="BEST QUALI" value={d.bestQualiPos != null ? "P" + d.bestQualiPos : "—"} />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="mono" style={{ fontSize: 11, color: "#66758a", marginTop: 14, lineHeight: 1.5 }}>
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
                <div className="mono" style={{ fontSize: 11, color: "#66758a", marginBottom: 16 }}>
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
                            {s.winner && <span className="mono" style={{ fontSize: 11.5, color: "#9aa8bb" }}>Winner: <span style={{ color: AMBER }}>{s.winner}</span></span>}
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
              const races = convertedSessions.filter((s) => s.isRound && s.laps.length && (/race/i.test(s.raceLabel) || /quali/i.test(s.raceLabel) || /practice/i.test(s.raceLabel)));
              const hasOurs = (s) => (s.karts || []).some((k) => !removed.has(`${s.id}|${k.num}`) && s.sectorsByKart && s.sectorsByKart[k.num] && (s.sectorsByKart[k.num].best != null || s.sectorsByKart[k.num].s1 != null));
              const rep = races.find((s) => s.id === sectorSession) || races.find(hasOurs) || races[0];
              if (!rep) return <Panel title="SECTOR ANALYSIS"><Empty msg="No race session loaded." /></Panel>;
              const sb = rep.sectorsByKart || {};
              const allK = (rep.allKarts || []).map((k) => k.num);
              const fieldBest = (sec) => { const v = allK.map((n) => sb[n] && sb[n][sec]).filter((x) => x != null); return v.length ? Math.min(...v) : null; };
              const fb = { s1: fieldBest("s1"), s2: fieldBest("s2"), s3: fieldBest("s3") };
              const ours = rep.karts.filter((k) => !removed.has(`${rep.id}|${k.num}`))
                .map((k) => ({ num: k.num, name: assign[`${rep.id}|${k.num}`]?.trim() || k.teamName, ...(sb[k.num] || {}) }))
                .filter((o) => o.best != null || o.s1 != null);
              const dCell = (v, best) => v == null ? <span style={{ color: "#3a4655" }}>—</span> :
                <span style={{ color: best != null && v <= best + 0.001 ? "#b06bff" : "#c2cbd6" }}>{v.toFixed(3)}{best != null && v > best + 0.001 ? <span style={{ color: "#66758a", fontSize: 10 }}> +{(v - best).toFixed(2)}</span> : ""}</span>;
              return (
                <Panel title="SECTOR ANALYSIS — BEST SECTORS & ULTIMATE-LAP GAP">
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                    <span className="mono" style={{ fontSize: 11, color: "#78889d" }}>SESSION</span>
                    <select value={rep.id} onChange={(e) => setSectorSession(e.target.value)} style={{ ...inp(300) }}>
                      {races.map((s) => <option key={s.id} value={s.id}>{tidyLabel(s.raceLabel)}</option>)}
                    </select>
                  </div>
                  {ours.length === 0 ? <Empty msg="No Leeds sector data in this race." /> : (
                    <div style={{ overflowX: "auto" }}>
                      <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 560 }}>
                        <thead><tr style={{ color: "#78889d" }}>
                          {["DRIVER", "S1", "S2", "S3", "THEORETICAL", "BEST LAP", "GAP"].map((h, i) => (
                            <th key={h} style={{ padding: "6px 10px", textAlign: i === 0 ? "left" : "right", borderBottom: "1px solid #1e2733", fontWeight: 500 }}>{h}</th>
                          ))}
                        </tr></thead>
                        <tbody>
                          {ours.sort((a, b) => (a.best ?? 9e9) - (b.best ?? 9e9)).map((o) => {
                            const gap = (o.best != null && o.ult != null) ? o.best - o.ult : null;
                            return (
                              <tr key={o.num} style={{ borderBottom: "1px solid #11171f" }}>
                                <td style={{ padding: "7px 10px", color: "#e6edf3", fontWeight: 600 }}>{o.name} <span style={{ color: "#66758a" }}>#{o.num}</span></td>
                                <td style={{ padding: "7px 10px", textAlign: "right" }}>{dCell(o.s1, fb.s1)}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right" }}>{dCell(o.s2, fb.s2)}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right" }}>{dCell(o.s3, fb.s3)}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right", color: "#9aa8bb" }}>{o.ult != null ? fmt(o.ult) : "—"}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right", color: AMBER }}>{o.best != null ? fmt(o.best) : "—"}</td>
                                <td style={{ padding: "7px 10px", textAlign: "right", color: gap == null ? "#66758a" : gap > 0.3 ? "#ff8a5b" : "#2fd372" }}>{gap == null ? "—" : "+" + gap.toFixed(3)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      <div className="mono" style={{ fontSize: 11, color: "#66758a", marginTop: 12, lineHeight: 1.5 }}>
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
                          <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 12, background: "#0b1017", border: `1px solid ${promote ? "#2fd37255" : "#1b2430"}`, borderRadius: 8, padding: "8px 12px" }}>
                            <span className="mono" style={{ color: "#66758a", width: 24 }}>{i + 1}</span>
                            <span className="disp" style={{ fontWeight: 700, color: "#e6edf3", flex: 1 }}>{d.name}</span>
                            <span className="mono" style={{ fontSize: 11.5, padding: "2px 7px", borderRadius: 5, border: "1px solid #2a3543", color: c === "M" ? AMBER : "#3da9fc" }}>{c === "M" ? "MAINS" : c === "I" ? "INTERS" : "—"}</span>
                            {promote && <span className="mono" style={{ fontSize: 11.5, padding: "2px 7px", borderRadius: 5, background: "#0e2018", border: "1px solid #2fd37255", color: "#2fd372" }}>↑ PROMOTE</span>}
                            <span className="mono" style={{ fontSize: 15, fontWeight: 700, color: d.overall >= 7 ? "#2fd372" : d.overall >= 4.5 ? "#ffce3a" : "#ff8a5b", width: 48, textAlign: "right" }}>{d.overall.toFixed(2)}</span>
                          </div>
                        );
                      })}
                      <div className="mono" style={{ fontSize: 11, color: "#66758a", marginTop: 8, lineHeight: 1.5 }}>
                        Ranked on overall rating (follows the rating tab's round/season scope). Drivers tagged by the category they race most.
                        An Inters driver flagged ↑ PROMOTE is rated above your weakest Mains driver — a case to move them up.
                      </div>
                    </div>
                  )}
                </Panel>
              );
            })()}

            {tab === "h2h" && (() => {
              const r = Object.fromEntries(driverRatings.map((d) => [d.name, d]));
              const st = Object.fromEntries(stats.drivers.map((d) => [d.name, d]));
              const names = [...new Set([...driverRatings.map((d) => d.name), ...stats.drivers.map((d) => d.name)])].sort();
              if (names.length < 2) return <Panel title="HEAD-TO-HEAD"><Empty msg="Name at least two drivers to compare." /></Panel>;
              const A = names.includes(h2hA) ? h2hA : names[0];
              const B = names.includes(h2hB) ? h2hB : (names[1] || names[0]);
              const rows = [
                ["OVERALL RATING", r[A]?.overall, r[B]?.overall, true, (v) => v?.toFixed(2)],
                ["PACE", r[A]?.pace, r[B]?.pace, true, (v) => v?.toFixed(2)],
                ["CONSISTENCY", r[A]?.cons, r[B]?.cons, true, (v) => v?.toFixed(2)],
                ["RACECRAFT", r[A]?.race, r[B]?.race, true, (v) => v?.toFixed(2)],
                ["POINTS", st[A]?.points, st[B]?.points, true, (v) => v],
                ["AVG FINISH", st[A]?.avgFinish, st[B]?.avgFinish, false, (v) => v != null ? "P" + v.toFixed(1) : "—"],
                ["BEST LAP", st[A]?.bestLap, st[B]?.bestLap, false, (v) => v != null ? fmt(v) : "—"],
                ["BEST QUALI", st[A]?.bestQualiPos, st[B]?.bestQualiPos, false, (v) => v != null ? "P" + v : "—"],
              ];
              const sel = (val, set, other) => (
                <select value={val} onChange={(e) => set(e.target.value)} className="disp"
                  style={{ background: "#11171f", border: "1px solid #2b3a4e", borderRadius: 7, color: "#e6edf3", padding: "8px 10px", fontSize: 16, fontWeight: 700, fontFamily: "Barlow Condensed, sans-serif", width: "100%" }}>
                  {names.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              );
              return (
                <Panel title="HEAD-TO-HEAD">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 1fr", gap: 10, alignItems: "center", marginBottom: 14 }}>
                    <div>{sel(A, setH2hA)}</div>
                    <div className="disp" style={{ textAlign: "center", color: "#66758a", fontWeight: 700 }}>VS</div>
                    <div>{sel(B, setH2hB)}</div>
                  </div>
                  <div style={{ display: "grid", gap: 6 }}>
                    {rows.map(([label, av, bv, higher, f]) => {
                      const valid = av != null && bv != null;
                      const aWin = valid && (higher ? av > bv : av < bv);
                      const bWin = valid && (higher ? bv > av : bv < av);
                      const cell = (v, win) => (
                        <div style={{ textAlign: "center", padding: "10px", borderRadius: 8, background: win ? "#0e2018" : "#0b1017", border: `1px solid ${win ? "#2fd37255" : "#1b2430"}` }}>
                          <span className="mono" style={{ fontSize: 17, fontWeight: 700, color: win ? "#2fd372" : "#c2cbd6" }}>{f(v) ?? "—"}</span>
                        </div>
                      );
                      return (
                        <div key={label} style={{ display: "grid", gridTemplateColumns: "1fr 120px 1fr", gap: 10, alignItems: "center" }}>
                          {cell(av, aWin)}
                          <div className="mono" style={{ textAlign: "center", fontSize: 11.5, color: "#78889d", letterSpacing: "0.5px" }}>{label}</div>
                          {cell(bv, bWin)}
                        </div>
                      );
                    })}
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: "#66758a", marginTop: 12 }}>
                    Green = the better of the two on that metric. Ratings/points: higher wins. Avg finish, best lap, best quali: lower wins. Whole season.
                  </div>
                </Panel>
              );
            })()}

          </>
        )}

        {!hasData && (
          <div className="mono" style={{ color: "#66758a", fontSize: 13, textAlign: "center", padding: "40px 0" }}>
            Type an event identifier at the top and select load to populate dashboard layout
          </div>
        )}
        </>)}
      </div>
    </div>
  );
}

/* =======================================================================
   24 HOURS LIVE  —  separate section from the season telemetry dashboard.
   The BUKC 24 Hour is shared-kart endurance (multiple driver stints per
   kart), so the season model (one driver per kart, season-constant kart
   numbers, A-G team letters) does NOT apply here. Leeds run karts 19, 20
   and 57 under joke names; 56 is Leeds Beckett (a different uni) and is
   excluded by the existing !beckett rule.
   ======================================================================= */

const LIVE_SITE = (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("site")) || "bukc";
const LIVE_FILE = `/api/live?site=${LIVE_SITE}`;
const SEED_TEAMS = [
  { num: "18", name: "Buzzer's Huzz", drivers: ["Kai Askey", "Khaled Saab", "Arion Nela", "Lucas Burrow", "Iago Sierlecki"] },
  { num: "19", name: "Leeds (B)y a mile", drivers: ["Luca Wigley", "Morgan Driscoll", "Ben Jones", "Harrison Rowe", "Vivaan Baig", "Simon Wilkins", "Connor Morton", "Ademi Elukanlo"] },
  { num: "20", name: "Leeds Cartel", drivers: ["Hari Sukumar", "Vasilisa Borovskaya", "Daria Talinskaya", "Ethan Roberts", "Edward Williamson", "Oliver Hainsworth", "Alice Kingswood", "Charlie Holt"] },
  { num: "21", name: "DNFing Hell", drivers: ["Ho Chun Wong", "Harrison Wallis", "Benjamin Lees", "Finn Doherty", "Daniel Spiers", "Simon Kocsis", "Benjamin Laverack", "Anand Parmar"] },
  { num: "57", name: "Leeds Gramp Turismo", drivers: ["Kamran Davies", "Joe Milnes", "Sam Middleton", "Alex Harley", "Daniel Gilbert", "Tom Dent", "Yiorgos Meliotis", "Heathcliff Howard"] },
  { num: "58", name: "Out of Office", drivers: ["Luke Tyson", "Ben Jones", "Lewis White", "Neil Gandhi", "Thomas Wood", "Dominic Porter", "Joshua Humphreys", "Samuel Garbutt", "Igor Niedzielski"] },
];
const LIVE_SCHEMA = 2;
const DEFAULT_LIVE = { v: LIVE_SCHEMA, raceStartISO: "2026-06-13T15:03", raceHours: 24, defaultStintLen: 45,
  trackCond: "dry", teams: SEED_TEAMS.map((t) => ({ ...t, stints: [] })) };
const CLASH_MIN = 4;   // two of our teams pitting within this many minutes = a crew clash
// Teams that get their own dedicated command tab. Add { num, label } here to give
// another team the same page Leeds A has (e.g. { num: "20", label: "◈ CARTEL" }).
const COMMAND_TEAMS = [
  { num: "18", label: "◈ LEEDS A", color: TEAM_COLORS.A }, { num: "19", label: "LEEDS B", color: TEAM_COLORS.B }, { num: "20", label: "LEEDS C", color: TEAM_COLORS.C },
  { num: "21", label: "LEEDS D", color: TEAM_COLORS.D }, { num: "57", label: "GRADS A", color: TEAM_COLORS.E }, { num: "58", label: "GRADS B", color: TEAM_COLORS.F },
];
const teamColorOf = (num) => { const t = COMMAND_TEAMS.find((x) => String(x.num) === String(num)); return t ? t.color : AMBER; };
// passcodes are validated server-side (api/roster) so no secrets ship in the client bundle

const uid = () => Math.random().toString(36).slice(2, 9);
const pad2 = (n) => String(n).padStart(2, "0");
const fmtClock = (d) => (d instanceof Date && !isNaN(d)) ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : "--:--";
const fmtClockDay = (d, start) => {
  if (!(d instanceof Date) || isNaN(d)) return "--:--";
  const day = start && d.getDate() !== start.getDate() ? " +1" : "";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${day}`;
};
const fmtDur = (mins) => {
  if (mins == null || isNaN(mins)) return "—";
  const m = Math.round(mins), h = Math.floor(m / 60), r = m % 60;
  return h ? `${h}h ${pad2(r)}m` : `${r}m`;
};
const fmtGap = (ms) => {
  const neg = ms < 0; ms = Math.abs(ms);
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const body = h ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
  return (neg ? "-" : "") + body;
};

/* stint boundaries from a kart's lap-time sequence: a changeover/pit lap
   reads as an anomalously long lap. Anything > 1.6x the kart's own median
   is treated as a boundary (same idea as the 110% clean-lap filter, looser). */
function detectStints(laps) {
  const valid = laps.filter((x) => x != null && !isNaN(x));
  if (valid.length < 4) return { boundaries: [], thr: null };
  const med = quantile([...valid].sort((a, b) => a - b), 0.5);
  const thr = med * 1.6;
  const boundaries = [];
  laps.forEach((t, i) => { if (t != null && t > thr && i > 0) boundaries.push(i); });
  return { boundaries, thr };
}

/* Shared stint state for one team at the current race clock. One source of
   truth for the planner and the pit board. */
/* Live state for one team. The live timing gives no pit/stint times, so the
   crew logs each changeover by hand (team.pitLog = [{atMin, t}]). Everything
   downstream is anchored to the LAST ACTUAL pit, not the clock: if a stint
   runs short or long, the projected next pit and the finish margin reflow. */
function teamRaceState(team, raceStart, now) {
  const stints = team.stints || [];
  let acc = 0;
  const rows = stints.map((s) => { const startMin = acc; acc += Number(s.len) || 0; return { ...s, startMin, endMin: acc }; });
  const scheduledMin = acc;
  const nowMin = (now - raceStart) / 60000;

  const pits = (team.pitLog || []).map((p) => Number(p.atMin)).filter((x) => !isNaN(x)).sort((a, b) => a - b);
  const completed = pits.length;                              // changeovers logged
  const started = nowMin >= 0 || completed > 0;
  const finished = rows.length > 0 && completed >= rows.length;
  const onKartIdx = finished ? -1 : (rows.length ? Math.min(completed, rows.length - 1) : -1);
  const onKart = onKartIdx >= 0 ? rows[onKartIdx] : null;
  const onKartStart = completed > 0 ? pits[completed - 1] : 0; // elapsed-min the current stint began
  const nextPitMin = onKart ? onKartStart + onKart.len : null; // projected, anchored to the last actual pit
  const minsToPit = nextPitMin != null ? nextPitMin - nowMin : null;
  const stintElapsed = onKart && started ? nowMin - onKartStart : null;
  const incoming = onKartIdx >= 0 ? (rows[onKartIdx + 1]?.driver ?? null) : null;
  const incomingNote = onKartIdx >= 0 ? (rows[onKartIdx + 1]?.note ?? null) : null;

  // projected finish, anchored to the current actual stint start
  let projFinish = scheduledMin;
  if (onKartIdx >= 0) { let a = onKartStart; for (let i = onKartIdx; i < rows.length; i++) a += rows[i].len; projFinish = a; }
  const driftMin = onKartIdx >= 0 ? onKartStart - rows[onKartIdx].startMin : 0; // +behind plan / -ahead

  // last completed stint: actual vs planned
  let lastActual = null, lastPlanned = null, lastDriver = null;
  if (completed > 0 && rows[completed - 1]) {
    lastActual = pits[completed - 1] - (completed > 1 ? pits[completed - 2] : 0);
    lastPlanned = rows[completed - 1].len; lastDriver = rows[completed - 1].driver;
  }
  return { rows, scheduledMin, nowMin, started, finished, onKart, onKartIdx, onKartStart,
    currentDriver: onKart?.driver || null, nextPitMin, incoming, incomingNote, minsToPit, stintElapsed,
    projFinish, driftMin, lastActual, lastPlanned, lastDriver, completed,
    plannedPitsDone: completed, totalPits: Math.max(0, rows.length - 1) };
}

/* ---- master spreadsheet import (per-team sheet -> stints) ----
   Three layouts appear in the master sheet, all handled here:
   - "Stint Time (Clock)" with a "HH:MM-HH:MM" range in one cell (Leeds A)
   - "Stint Start Time" + a "Stint Length" time column (Grads A)
   - "Planned Stint" range + "Name" + "Pitstop Notes" (Leeds B/C/D, Grads B)
   Sheets map to karts by name; drivers and per-pit notes come across too. */
const SHEET_KART = { "Leeds A": "18", "Leeds B": "19", "Leeds C": "20", "Leeds D": "21", "Grads A": "57", "Grads B": "58" };
const excelMin = (v) => { const m = String(v || "").match(/(\d{1,2}):(\d{2})/); return m ? (+m[1] * 60 + +m[2]) : null; };
const parseStintRange = (v) => {
  const m = String(v || "").match(/(\d{1,2}):(\d{2})\s*[-\u2013]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  return { start: a, len: (((b - a) % 1440) + 1440) % 1440 };
};
function parseSheetStints(rows) {
  const reTime = /planned stint|stint start time|stint time \(clock\)/i;
  let hr = -1, tc = -1;
  for (let r = 0; r < Math.min(rows.length, 15) && hr < 0; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) { if (row[c] && reTime.test(String(row[c]))) { hr = r; tc = c; break; } }
  }
  if (hr < 0) return null;
  const hrow = rows[hr] || [];
  let dc = -1, lc = -1, nc = -1, leadC = -1, seatC = -1, pedC = -1, radC = -1, asstC = -1;
  for (let c = 0; c < hrow.length; c++) {
    const h = String(hrow[c] || "").trim().toLowerCase();
    if ((h === "driver" || h === "name") && dc < 0 && c >= tc) dc = c;
    if (h === "stint length" || h === "length") lc = c;
    if (h === "pitstop notes" || h === "notes") nc = c;
    if (leadC < 0 && (h === "total lead" || h === "lead needed" || h === "lead" || h.includes("lead (kg)"))) leadC = c;
    if (seatC < 0 && h.includes("seat insert")) seatC = c;
    if (pedC < 0 && (h === "pedals" || h.includes("pedal position"))) pedC = c;
    if (radC < 0 && h.includes("radio")) radC = c;
    if (asstC < 0 && h.includes("pit assist")) asstC = c;
  }
  if (dc < 0) return null;
  const num = (v) => { const n = parseFloat(String(v).replace(/[^\d.\-]/g, "")); return isNaN(n) ? null : n; };
  const stints = []; let startClock = null, began = false;
  for (let r = hr + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const tv = row[tc], dv = row[dc];
    const drv = dv != null ? String(dv).trim() : "";
    const blank = (tv == null || String(tv).trim() === "") && !drv;
    if (blank) { if (began) break; else continue; }
    let len = null, st = null;
    if (lc >= 0 && row[lc]) len = excelMin(row[lc]);
    const range = parseStintRange(tv);
    if (range) { st = range.start; if (len == null) len = range.len; }
    else if (tv) { st = excelMin(tv); }
    if (!drv || len == null) continue;
    began = true;
    if (startClock == null && st != null) startClock = st;
    const note = nc >= 0 && row[nc] != null ? String(row[nc]).trim() : null;
    const cell = (c) => c >= 0 && row[c] != null && String(row[c]).trim() !== "" ? String(row[c]).trim() : undefined;
    stints.push({ driver: drv, len, note: note || undefined,
      lead: leadC >= 0 ? num(row[leadC]) : undefined, seat: cell(seatC), pedals: cell(pedC), radio: cell(radC), assist: cell(asstC) });
  }
  // no explicit notes column (Leeds A / Grads A): synthesise a changeover note from
  // the lead/seat/assist/radio columns so the board + planner still show the pit actions
  if (nc < 0) {
    for (let i = 0; i < stints.length; i++) {
      const cur = stints[i], prev = stints[i - 1], bits = [];
      if (cur.lead != null && prev && prev.lead != null) {
        const d = Math.round((cur.lead - prev.lead) * 10) / 10;
        if (d > 0) bits.push(`add ${d}kg lead`); else if (d < 0) bits.push(`remove ${Math.abs(d)}kg lead`);
      }
      if (cur.seat && prev && cur.seat !== prev.seat) bits.push(`seat → ${cur.seat}`);
      else if (cur.seat && !prev) bits.push(`seat ${cur.seat}`);
      if (cur.assist) bits.push(`assist ${cur.assist}`);
      if (cur.radio) bits.push(`radio ${cur.radio}`);
      if (bits.length) { cur.note = bits.join(" · "); cur.auto = true; }
    }
  }
  return stints.length ? { stints, startClock } : null;
}
function parseMasterWorkbook(wb) {
  const byKart = {}, warn = []; let startClock = null;
  Object.entries(SHEET_KART).forEach(([sheet, kart]) => {
    const ws = wb.Sheets[sheet];
    if (!ws) { warn.push(`no sheet "${sheet}"`); return; }
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });
    const p = parseSheetStints(rows);
    if (!p) { warn.push(`couldn't read "${sheet}"`); return; }
    byKart[kart] = p;
    if (startClock == null) startClock = p.startClock;
  });
  return { byKart, startClock, warn };
}

function Live24({ knownDrivers = [] }) {
  const [sub, setSub] = useState(COMMAND_TEAMS.length ? "cmd:" + COMMAND_TEAMS[0].num : "board");
  const [cfg, setCfg] = useState(() => {
    const v = LS("live24", null);
    if (v && v.teams && v.v >= LIVE_SCHEMA) return { ...DEFAULT_LIVE, ...v };
    // pre-v2 (3-team default with no drivers): keep race settings, reseed the teams
    if (v && v.teams) return { ...DEFAULT_LIVE, raceStartISO: v.raceStartISO || DEFAULT_LIVE.raceStartISO,
      raceHours: v.raceHours || 24, defaultStintLen: v.defaultStintLen || 45 };
    return DEFAULT_LIVE;
  });
  const [now, setNow] = useState(() => new Date());
  const [live, setLive] = useState(null);
  const [liveErr, setLiveErr] = useState("");
  const [adminPw, setAdminPw] = useState("");
  const [syncMsg, setSyncMsg] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const [teleLocked, setTeleLocked] = useState(false);
  const [startPw, setStartPw] = useState("");
  const [startMsg, setStartMsg] = useState("");
  const [simLocked, setSimLocked] = useState(false);
  const [simOn, setSimOn] = useState(false);   // never auto-start the demo — data must be fresh
  const [simFast, setSimFast] = useState(() => LS("live24_simfast", false));
  const [testClock, setTestClock] = useState(false);
  const [clockStartAt, setClockStartAt] = useState(null);
  const [simModel, setSimModel] = useState(null);
  const [owned, setOwned] = useState(() => new Set(LS("live24_owned", [])));   // team nums this device can edit
  const ownPass = useRef(LS("live24_pass", {}));                                // num -> passcode
  const xlsxRef = useRef();

  useEffect(() => { saveLS("live24", cfg); }, [cfg]);
  useEffect(() => { saveLS("live24_sim", simOn); }, [simOn]);
  useEffect(() => { saveLS("live24_simfast", simFast); }, [simFast]);
  useEffect(() => { saveLS("live24_owned", [...owned]); }, [owned]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  // ===== GLOBAL SAVE (server-authoritative) =====
  // The server is the single source of truth. Every device pulls every 5s and
  // takes the merged state. Your own taps apply instantly (optimistic) and are
  // kept visible by a short pending overlay until the server confirms — so two
  // people logging the same team both stick, and a clear propagates to everyone.
  const ownedRef = useRef(owned); ownedRef.current = owned;
  const pendingRef = useRef({});        // num -> [{type:'add'|'remove'|'clear', entry?, id?, ts}]
  const planGuardRef = useRef({});      // num -> ts (suppress pulling plan right after a local edit)
  const seqRef = useRef(LS("live24_seq", {}));   // num -> last version pushed (monotonic, survives refresh)

  const applyPending = (log, ops) => {
    let out = (log || []).slice();
    (ops || []).slice().sort((a, b) => a.ts - b.ts).forEach((op) => {
      if (op.type === "clear") out = [];
      else if (op.type === "add") { if (!out.some((p) => p.id === op.entry.id)) out.push(op.entry); }
      else if (op.type === "remove") out = out.filter((p) => p.id !== op.id);
      else if (op.type === "edit") out = out.map((p) => (p.id === op.id ? { ...p, atMin: op.atMin } : p));
    });
    return out.sort((a, b) => (a.atMin || 0) - (b.atMin || 0));
  };
  const queue = (num, op) => {
    const n = String(num); op.ts = Date.now();
    pendingRef.current[n] = [...(pendingRef.current[n] || []).filter((o) => Date.now() - o.ts < 9000), op];
  };
  const sendTeam = (num, extra) => {
    const n = String(num);
    fetch("/api/roster", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamSync: { num: n, passcode: ownPass.current[n], ...extra } }) })
      .then(() => { setTimeout(pullNow, 600); setTimeout(pullNow, 2500); }).catch(() => {});
  };
  // monotonic version per team (survives refresh via clock floor) so the server
  // ignores out-of-order pushes — a fast log+undo can never resurrect a pit.
  const nextSeq = (n) => { const s = Math.max(Date.now(), (seqRef.current[n] || 0) + 1); seqRef.current[n] = s; saveLS("live24_seq", seqRef.current); return s; };
  const pushLog = (num, log) => { const n = String(num); sendTeam(n, { pitLog: log, seq: nextSeq(n) }); };

  const curLog = (num) => { const t = (cfg.teams || []).find((x) => String(x.num) === String(num)); return (t && t.pitLog) || []; };
  const setLog = (num, log) => setCfg((c) => ({ ...c, teams: c.teams.map((t) => String(t.num) === String(num) ? { ...t, pitLog: log } : t) }));

  const pitIn = (num, atMin) => { const log = [...curLog(num), { id: uid() + Date.now(), atMin, t: new Date().toISOString() }]; setLog(num, log); pushLog(num, log); };
  const pitUndo = (num) => { const pl = curLog(num); if (!pl.length) return; const log = pl.slice(0, -1); setLog(num, log); pushLog(num, log); };
  const pitClear = (num) => { setLog(num, []); pushLog(num, []); };
  const pitEdit = (num, id, atMin) => { const log = curLog(num).map((p) => (p.id === id ? { ...p, atMin } : p)); setLog(num, log); pushLog(num, log); };

  // plan (lineup / stint) edits push immediately for owned teams
  const pushPlan = (num, team) => { planGuardRef.current[String(num)] = Date.now();
    sendTeam(num, { plan: { name: team.name, drivers: team.drivers, stints: team.stints } }); };

  const pullNow = () => fetch("/api/roster").then((r) => r.json()).then((d) => {
    if (!d) return;
    setTeleLocked(!!d.telemetryLocked); setSimLocked(!!d.simLocked);
    if (d.simLocked) { setSimOn(false); setTestClock(false); }
    const g = d.stintPlan;
    if (!g) return;
    setCfg((c) => {
      let changed = false;
      const teams = (c.teams || []).map((t) => {
        const n = String(t.num);
        const gt = (g.teams || []).find((x) => String(x.num) === n);
        if (ownedRef.current.has(n)) {
          // I'm the authority for this team — but if ANOTHER device pushed a
          // NEWER version (higher seq) I adopt it, so co-captains see each other.
          // A lagging read carries an OLD seq (<= mine) so it can never wipe a
          // pit I just logged. This is the safe half of the version guard.
          if (gt && (gt._seq || 0) > (seqRef.current[n] || 0)) {
            seqRef.current[n] = gt._seq; saveLS("live24_seq", seqRef.current);
            const next = { ...t, pitLog: gt.pitLog || [] };
            if ((gt.stints || []).length) { next.name = gt.name || t.name; next.drivers = gt.drivers || t.drivers; next.stints = gt.stints; }
            if (JSON.stringify(next) !== JSON.stringify(t)) changed = true;
            return next;
          }
          return t;
        }
        if (!gt) return t;
        const next = { ...t };
        if ((gt.stints || []).length) { next.name = gt.name || t.name; next.drivers = gt.drivers || t.drivers; next.stints = gt.stints; }
        next.pitLog = gt.pitLog || [];
        if (JSON.stringify(next) !== JSON.stringify(t)) changed = true;
        return next;
      });
      let raceStartISO = c.raceStartISO;
      if (g.raceStartISO && g.raceStartISO !== c.raceStartISO && Date.now() - (planGuardRef.current.__start || 0) > 6000) { raceStartISO = g.raceStartISO; changed = true; }
      return changed ? { ...c, teams, raceStartISO } : c;
    });
  }).catch(() => {});

  useEffect(() => { pullNow(); const iv = setInterval(pullNow, 5000); return () => clearInterval(iv); }, []);

  const unlockTeam = async (num, code) => {
    const n = String(num);
    try {
      const res = await fetch("/api/roster", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verifyTeam: { num: n, passcode: code } }) });
      const d = await res.json();
      if (!(res.ok && d.ok)) return false;
    } catch { return false; }
    ownPass.current = { ...ownPass.current, [n]: code }; saveLS("live24_pass", ownPass.current);
    setOwned((s) => new Set([...s, n]));
    pullNow();
    return true;
  };
  const lockTeam = (num) => { const n = String(num); setOwned((s) => { const ns = new Set(s); ns.delete(n); return ns; }); };
  const setGlobalStart = async (iso) => {
    setStartMsg("Setting…");
    try {
      const res = await fetch("/api/roster", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setRaceStart: { iso, passcode: startPw } }) });
      const d = await res.json();
      if (res.ok && d.ok) { planGuardRef.current.__start = Date.now(); setCfg((c) => ({ ...c, raceStartISO: iso })); setStartMsg("✓ Race start set for everyone."); }
      else setStartMsg(d.error || "Wrong password.");
    } catch { setStartMsg("Couldn't reach the server (live site only)."); }
  };

  // poll the live snapshot
  useEffect(() => {
    let stop = false;
    const pull = () => {
      fetch(LIVE_FILE)
        .then((r) => { if (!r.ok) throw new Error("no file"); return r.text(); })
        .then((t) => { if (!stop) { const d = JSON.parse(t.replace(/\uFFFD/g, "\u00b7")); setLive(d); setLiveErr(d && d.error ? "Feed error: " + d.error : ""); } })
        .catch(() => { if (!stop) setLiveErr("No live snapshot yet."); });
    };
    pull();
    const iv = setInterval(pull, 5000);
    return () => { stop = true; clearInterval(iv); };
  }, []);

  const raceStart = useMemo(() => (testClock && clockStartAt ? new Date(clockStartAt) : new Date(cfg.raceStartISO)), [testClock, clockStartAt, cfg.raceStartISO]);
  const raceEnd = useMemo(() => new Date(raceStart.getTime() + cfg.raceHours * 3600000), [raceStart, cfg.raceHours]);
  const totalMin = cfg.raceHours * 60;
  const elapsedMin = (now - raceStart) / 60000;
  const started = now >= raceStart;
  const finished = now >= raceEnd;

  const setCfgField = (k, v) => setCfg((c) => ({ ...c, [k]: v }));
  const updateTeam = (idx, patch) => setCfg((c) => {
    const teams = c.teams.map((t, i) => i === idx ? { ...t, ...patch } : t);
    const t = teams[idx];
    if (ownedRef.current.has(String(t.num)) && (patch.stints || patch.drivers || patch.name)) pushPlan(t.num, t);
    return { ...c, teams };
  });

  const syncPlan = async () => {
    setSyncing(true); setSyncMsg("");
    try {
      const res = await fetch("/api/roster", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ stintPlan: cfg, adminPassword: adminPw }) });
      const d = await res.json();
      setSyncMsg(res.ok && d.ok ? "✓ Stint plan synced to the team." : (d.error || "Sync failed."));
    } catch { setSyncMsg("Couldn't reach the sync service (live site only)."); }
    setSyncing(false);
  };

  const onMaster = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        const { byKart, startClock, warn } = parseMasterWorkbook(wb);
        const got = Object.keys(byKart);
        if (!got.length) { setImportMsg("Imported nothing — " + (warn.join("; ") || "unrecognised layout.")); return; }
        setCfg((c) => {
          const teams = c.teams.map((t) => {
            const p = byKart[String(t.num)];
            if (!p) return t;
            const drivers = [...new Set(p.stints.map((s) => s.driver).filter(Boolean))];
            return { ...t, drivers, stints: p.stints.map((s) => ({ id: uid(), driver: s.driver, len: s.len, note: s.note, auto: s.auto,
              lead: s.lead, seat: s.seat, pedals: s.pedals, radio: s.radio, assist: s.assist })) };
          });
          let raceStartISO = c.raceStartISO;
          if (startClock != null) {
            const d = new Date(c.raceStartISO);
            raceStartISO = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(Math.floor(startClock / 60))}:${pad2(startClock % 60)}`;
          }
          return { ...c, teams, raceStartISO };
        });
        const sc = startClock != null ? `${pad2(Math.floor(startClock / 60))}:${pad2(startClock % 60)}` : null;
        const withExtras = got.filter((k) => byKart[k].stints.some((s) => s.lead != null || s.seat || s.note)).length;
        let msg = `✓ Imported ${got.length} team${got.length === 1 ? "" : "s"} (${got.map((k) => "#" + k).join(", ")}); lead/seat/notes captured for ${withExtras}.`;
        if (sc) msg += ` Start set to ${sc} from the sheet.` + (sc !== "15:03" ? " Timing site says 15:03 — change Race Start above if that's the real start." : "");
        msg += " Now press SYNC PLAN TO TEAM below so every device gets it.";
        if (warn.length) msg += "  (" + warn.join("; ") + ")";
        setImportMsg(msg);
      } catch (err) { setImportMsg("Couldn't read that file: " + err.message); }
    };
    reader.readAsArrayBuffer(file);
  };

  // ---- live parse (raw event schema, single race session) ----
  const ourNums = useMemo(() => new Set((cfg.teams || []).map((t) => String(t.num)).filter(Boolean)), [cfg.teams]);
  const realLiveModel = useMemo(() => {
    const s = live && live.sessions && live.sessions[0];
    if (!s) return null;
    const lapMap = {};
    (s.lap_times || []).forEach((d) => {
      const arr = (d.laps || []).map(parseSecs);
      if (d.kart) lapMap[String(d.kart)] = arr;
    });
    const field = (s.results || []).map((r) => ({
      pos: Number(r.position) || null, kart: String(r.kart || ""), team: r.team || "",
      gap: r.gap || null, diff: r.diff || null, best: parseSecs(r.best_lap_time),
      laps: lapMap[String(r.kart)] ? lapMap[String(r.kart)].filter((x) => x != null).length : null,
      penalty: r.penalty,
    }));
    const leeds = field.filter((r) => ourNums.has(r.kart) || isOurTeam(r.team)).map((r) => {
      const laps = lapMap[r.kart] || [];
      const clean = splitClean(laps).clean;
      const last5 = clean.slice(-5);
      const st = detectStints(laps);
      const stintStart = st.boundaries.length ? st.boundaries[st.boundaries.length - 1] + 1 : 0;
      const stintLaps = laps.slice(stintStart).filter((x) => x != null);
      const stintSecs = stintLaps.reduce((a, b) => a + b, 0);
      const pens = (s.penalties || []).filter((p) => String(p.kart) === r.kart).map((p) => {
        const m = String(p.penalty || p.time || "").match(/(\d+(?:\.\d+)?)\s*s/i); return { reason: p.reason || p.penalty || "Penalty", sec: m ? parseFloat(m[1]) : null, lap: p.lap != null ? Number(p.lap) : null, raw: p.penalty };
      });
      return { ...r, lapArr: laps, bestClean: getValidFastest(clean), recent: last5.length ? mean(last5) : null,
        stintLapCount: stintLaps.length, stintMin: stintSecs / 60, changeovers: st.boundaries.length, penalties: pens };
    });
    const allClean = field.flatMap((r) => splitClean(lapMap[r.kart] || []).clean);
    const fieldAvg = allClean.length ? mean(allClean) : null;
    const bests = field.map((r) => ({ kart: r.kart, b: getValidFastest(splitClean(lapMap[r.kart] || []).clean) ?? r.best })).filter((x) => x.b != null).sort((a, b) => a.b - b.b);
    return { session: s, field, leeds, scrapedAt: live.scraped_at || null, fieldAvg, fastestOverall: bests[0] || null };
  }, [live, ourNums]);

  const liveModel = simOn ? simModel : realLiveModel;

  // ---- TEST MODE: simulate a live race entirely in the browser ----
  const simFastRef = useRef(simFast); simFastRef.current = simFast;
  useEffect(() => {
    if (!simOn) { setSimModel(null); return; }
    const rivalNames = ["Fastest House","Liverpool A","Loughborough A","Imperial","Salford A","Birmingham A","Bath A","Cardiff A","Sheffield A","Nottingham A","Warwick A","Bristol A","Durham A","Exeter A","Newcastle A","Manchester A","Leeds Beckett","Glasgow A","Edinburgh A","Surrey A","Brunel A","Coventry A","Oxford A","Cambridge A","Southampton A","Lancaster A"];
    const rivals = []; let rn = 30;
    for (const nm of rivalNames) { rivals.push([String(rn), nm]); rivals.push([String(rn + 1), nm.replace(/ A$/, " B")]); rn += 2; }
    const ours = (cfg.teams || []).map((t) => [String(t.num), t.name]).filter((o) => o[0]);
    const seen = new Set(); const karts = [];
    [...ours, ...rivals].slice(0, 60).forEach(([num, name]) => { if (!seen.has(num)) { seen.add(num); karts.push({ kart: num, team: name, base: 66 + Math.random() * 5, frac: Math.random(), laps: 0, lapArr: [], pitEvery: 70 + Math.floor(Math.random() * 25), lastPit: 0, pen: [] }); } });
    const ourSet = new Set(ours.map((o) => o[0]));
    const bestOf = (arr) => getValidFastest(splitClean(arr).clean);
    const PENR = ["Contact", "Track limits", "Jump start", "Pit lane speeding"];
    let last = Date.now();
    const tick = () => {
      const t = Date.now(); let dt = (t - last) / 1000; last = t; if (simFastRef.current) dt *= 12;
      karts.forEach((k) => {
        const lapSec = k.base + Math.sin(t / 9000 + k.kart.length) * 0.4;
        k.frac += dt / lapSec;
        while (k.frac >= 1) {
          k.frac -= 1; k.laps++;
          const pit = k.laps % k.pitEvery === 0; if (pit) k.lastPit = k.laps;
          k.lapArr.push(pit ? lapSec * 1.8 + 24 : lapSec + (Math.random() * 0.8 - 0.2));
          if (ourSet.has(k.kart) && Math.random() < 0.015) k.pen.push({ lap: k.laps, reason: PENR[Math.floor(Math.random() * PENR.length)], sec: [3, 5, 10][Math.floor(Math.random() * 3)] });
        }
      });
      const prog = (k) => k.laps + k.frac;
      const sorted = [...karts].sort((a, b) => prog(b) - prog(a));
      const lead = prog(sorted[0]);
      const field = sorted.map((k, i) => { const d = lead - prog(k); return { pos: i + 1, kart: k.kart, team: k.team, gap: i === 0 ? "" : (d >= 1 ? `+${Math.floor(d)} lap${Math.floor(d) > 1 ? "s" : ""}` : `+${(d * k.base).toFixed(1)}s`), best: bestOf(k.lapArr), laps: k.laps, penalty: k.pen.length > 0 }; });
      const posOf = (num) => field.find((f) => f.kart === num) || {};
      const allClean = karts.flatMap((k) => splitClean(k.lapArr).clean);
      const fieldAvg = allClean.length ? mean(allClean) : null;
      const bests = karts.map((k) => ({ kart: k.kart, b: bestOf(k.lapArr) })).filter((x) => x.b != null).sort((a, b) => a.b - b.b);
      const fastestOverall = bests[0] || null;
      const leeds = sorted.filter((k) => ourSet.has(k.kart)).map((k) => { const clean = splitClean(k.lapArr).clean; const last5 = clean.slice(-5); const st = detectStints(k.lapArr); const p = posOf(k.kart); const slc = k.laps - k.lastPit;
        return { kart: k.kart, team: k.team, pos: p.pos, gap: p.gap, laps: k.laps, lapArr: k.lapArr, bestClean: bestOf(k.lapArr), recent: last5.length ? mean(last5) : null, changeovers: st.boundaries.length, stintLapCount: slc, stintMin: slc * k.base / 60, penalties: k.pen.slice(), penalty: k.pen.length > 0, lapFrac: k.frac, sector: Math.floor(k.frac * 3) + 1 }; });
      setSimModel({ session: { status: "sim" }, field, leeds, scrapedAt: new Date().toISOString(), fieldAvg, fastestOverall });
    };
    tick();
    const iv = setInterval(tick, 600);
    return () => clearInterval(iv);
  }, [simOn]);

  const staleMin = liveModel && liveModel.scrapedAt ? (Date.now() - new Date(liveModel.scrapedAt).getTime()) / 60000 : null;

  const tabs = [...COMMAND_TEAMS.map((c) => ["cmd:" + c.num, c.label]), ["board", "ALL TEAMS"], ["timing", "TIMING"], ["track", "TRACK MAP"], ["plan", "PLANNER"], ["live", "OUR KARTS"], ["pace", "PACE"]];

  return (
    <div>
      {/* race clock banner */}
      <div style={{ background: "linear-gradient(135deg,#1a0a0e,#0b1017)", border: "1px solid #ff2d4d30",
        borderRadius: 12, padding: "16px 18px", marginBottom: 14, display: "flex", flexWrap: "wrap",
        alignItems: "center", gap: 20 }}>
        <div>
          <div className="disp" style={{ fontSize: 11, color: "#9aa8bb", letterSpacing: 1, fontWeight: 600 }}>RACE CLOCK</div>
          <div className="mono" style={{ fontSize: 26, fontWeight: 700, color: finished ? "#2fd372" : started ? "#ff2d4d" : AMBER }}>
            {finished ? "FINISHED" : started
              ? fmtGap(Math.min(elapsedMin, totalMin) * 60000) + " / " + cfg.raceHours + "h"
              : "T- " + fmtGap((raceStart - now))}
          </div>
          {started && !finished && (
            <div style={{ marginTop: 6, height: 5, width: 200, maxWidth: "60vw", borderRadius: 3, background: "#11171f", border: "1px solid #1b2433", overflow: "hidden" }}>
              <div style={{ width: `${Math.min(100, (elapsedMin / totalMin) * 100)}%`, height: "100%", background: `linear-gradient(90deg, ${AMBER}, #ff2d4d)` }} />
            </div>
          )}
        </div>
        <div className="mono" style={{ fontSize: 11.5, color: "#78889d", lineHeight: 1.7 }}>
          {testClock ? <span style={{ color: "#ff8a5b" }}>TEST CLOCK (started now)<br /></span> : null}
          START {fmtClock(raceStart)} ({raceStart.toLocaleDateString("en-GB")})<br />
          FINISH {fmtClockDay(raceEnd, raceStart)} · {cfg.raceHours}h
        </div>
        <div style={{ flex: 1 }} />
        {simOn ? (
          <div className="mono" style={{ fontSize: 11, color: "#ff8a5b", textAlign: "right", fontWeight: 700 }}>
            ● TEST DATA (simulated)<br />
            <span style={{ color: "#78889d", fontWeight: 400 }}>not the real race</span>
          </div>
        ) : liveModel && (
          <div className="mono" style={{ fontSize: 11, color: staleMin != null && staleMin > 2 ? "#ff8a5b" : "#2fd372", textAlign: "right" }}>
            ● LIVE DATA<br />
            <span style={{ color: "#78889d" }}>updated {staleMin == null ? "—" : staleMin < 1 ? "just now" : Math.round(staleMin) + "m ago"}</span>
          </div>
        )}
      </div>

      {/* always-visible next-pits strip */}
      {started && !finished && (() => {
        const ups = cfg.teams.map((t) => ({ t, rs: teamRaceState(t, raceStart, now) }))
          .filter((x) => x.rs.minsToPit != null && !x.rs.finished && x.rs.rows.length)
          .sort((a, b) => a.rs.minsToPit - b.rs.minsToPit).slice(0, 4);
        return ups.length ? (
          <div className="apptabs" style={{ display: "flex", gap: 8, marginBottom: 12, overflowX: "auto" }}>
            {ups.map(({ t, rs }) => {
              const late = rs.minsToPit < 0;
              const c = late || rs.minsToPit <= 5 ? "#ff2d4d" : rs.minsToPit <= 15 ? "#ff8a5b" : "#2fd372";
              return (
                <div key={t.num} className="mono" style={{ flex: "0 0 auto", fontSize: 12, background: "#0b1017", border: `1px solid ${c}44`, borderRadius: 7, padding: "7px 11px", whiteSpace: "nowrap" }}>
                  <b style={{ color: c }}>#{t.num}</b> <span style={{ color: "#9aa8bb" }}>{late ? "PIT DUE" : "pit in"}</span> <b style={{ color: c }}>{late ? fmtDur(-rs.minsToPit) + " ago" : fmtDur(Math.max(0, rs.minsToPit))}</b>{rs.incoming ? <span style={{ color: "#78889d" }}> → {rs.incoming}</span> : null}
                </div>
              );
            })}
          </div>
        ) : null;
      })()}

      <div className="apptabs" style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", paddingBottom: 2 }}>
        {tabs.map(([k, l]) => {
          const tc = k.startsWith("cmd:") ? teamColorOf(k.slice(4)) : AMBER;
          const on = sub === k;
          return (
          <button key={k} onClick={() => setSub(k)} className="disp"
            style={{ padding: "8px 16px", borderRadius: 6, fontWeight: 600, fontSize: 15.5, cursor: "pointer",
              border: "1px solid", borderColor: on ? tc : "#2b3a4e",
              background: on ? tc + "22" : "#0b1017", color: on ? tc : "#9aa8bb",
              borderLeft: k.startsWith("cmd:") ? `3px solid ${tc}` : "1px solid " + (on ? tc : "#2b3a4e") }}>
            {l}
          </button>
          );
        })}
      </div>

      {sub.startsWith("cmd:") && (() => {
        const num = sub.slice(4);
        const ti = cfg.teams.findIndex((t) => String(t.num) === num);
        const team = ti >= 0 ? cfg.teams[ti] : null;
        const live = liveModel && team ? liveModel.leeds.find((l) => l.kart === String(team.num)) : null;
        return team ? <TeamCommand team={team} teamIdx={ti} raceStart={raceStart} totalMin={totalMin} now={now} live={live} setCfg={setCfg}
          model={liveModel} owned={owned.has(num)} onUnlock={unlockTeam} onLock={lockTeam}
          pitIn={pitIn} pitUndo={pitUndo} pitEdit={pitEdit} />
          : <Panel title="TEAM COMMAND"><Empty msg="That team isn't in the plan." /></Panel>;
      })()}

      {sub === "board" && (
        <PitBoard cfg={cfg} setCfg={setCfg} raceStart={raceStart} totalMin={totalMin} now={now} liveModel={liveModel} owned={owned} pitIn={pitIn} pitUndo={pitUndo} pitEdit={pitEdit} />
      )}

      {sub === "track" && <TrackMap model={liveModel} teams={cfg.teams} simOn={simOn} speedMul={simOn && simFast ? 12 : 1} onSim={() => { setSimOn(true); }} />}

      {sub === "plan" && (
        <>
          <Panel title="RACE SETUP">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-end" }}>
              <div>
                <Label>RACE START</Label>
                <input type="datetime-local" value={cfg.raceStartISO}
                  onChange={(e) => setCfgField("raceStartISO", e.target.value)}
                  style={{ ...inp(210), fontFamily: "Barlow Semi Condensed, sans-serif" }} />
              </div>
              <div>
                <Label>DURATION (HOURS)</Label>
                <input type="number" min="1" max="48" value={cfg.raceHours}
                  onChange={(e) => setCfgField("raceHours", Math.max(1, Number(e.target.value) || 24))}
                  style={inp(90)} />
              </div>
              <div>
                <Label>DEFAULT STINT (MIN)</Label>
                <input type="number" min="5" max="240" value={cfg.defaultStintLen}
                  onChange={(e) => setCfgField("defaultStintLen", Math.max(5, Number(e.target.value) || 45))}
                  style={inp(90)} />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap", padding: "10px 12px", borderRadius: 8, background: "#0b1017", border: "1px solid #2b3a4e" }}>
              <span className="disp" style={{ fontSize: 12, color: AMBER, fontWeight: 700 }}>SET RACE START FOR EVERYONE</span>
              <input type="password" value={startPw} onChange={(e) => setStartPw(e.target.value)} placeholder="control password" style={{ ...inp(190), fontFamily: "Barlow, sans-serif" }} />
              <button onClick={() => setGlobalStart(cfg.raceStartISO)} className="disp"
                style={{ background: "#1a160a", color: AMBER, border: `1px solid ${AMBER}`, borderRadius: 7, padding: "8px 13px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                PUSH {fmtClock(raceStart)} TO ALL DEVICES
              </button>
              <button onClick={() => { const d = new Date(); const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; setCfgField("raceStartISO", iso); setGlobalStart(iso); }} className="mono"
                style={{ background: "none", color: "#9aa8bb", border: "1px solid #2a3543", borderRadius: 7, padding: "8px 12px", fontSize: 12, cursor: "pointer" }}>
                start NOW
              </button>
              <span className="mono" style={{ fontSize: 11, color: startMsg.startsWith("✓") ? "#2fd372" : "#9aa8bb", flexBasis: "100%" }}>
                {startMsg || "Set the time above then push it, or hit ‘start NOW’ if the race goes green late. Every device pulls this within 5s."}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
              <button onClick={() => xlsxRef.current?.click()} className="disp"
                style={{ background: "#1a160a", color: AMBER, border: `1px solid ${AMBER}`, borderRadius: 7,
                  padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                ⬆ IMPORT MASTER SPREADSHEET
              </button>
              <input ref={xlsxRef} type="file" accept=".xlsx,.xlsm" hidden onChange={(ev) => { onMaster(ev.target.files?.[0]); ev.target.value = ""; }} />
              <span className="mono" style={{ fontSize: 11, color: "#66758a" }}>reads each team tab (Leeds A-D, Grads A-B) into stints, drivers and pit notes</span>
              {importMsg && <span className="mono" style={{ fontSize: 11.5, color: importMsg.startsWith("✓") ? "#2fd372" : "#ff8a5b", flexBasis: "100%" }}>{importMsg}</span>}
            </div>

            {/* test / simulation mode */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, flexWrap: "wrap", padding: "10px 12px", borderRadius: 8, background: simOn ? "#1a0a0e" : "#0b1017", border: `1px solid ${simOn ? "#ff8a5b" : "#2b3a4e"}` }}>
              <button disabled={simLocked} onClick={() => { if (simLocked) return; if (simOn) { setSimOn(false); setTestClock(false); } else { setSimOn(true); } }} className="disp"
                style={{ background: simLocked ? "#0b1017" : simOn ? "#ff2d4d" : "#11233a", color: simLocked ? "#66758a" : simOn ? "#fff" : "#2fd372", border: `1px solid ${simLocked ? "#2b3a4e" : simOn ? "#ff2d4d" : "#2fd37255"}`, borderRadius: 7, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: simLocked ? "not-allowed" : "pointer" }}>
                {simLocked ? "🔒 TEST MODE LOCKED (race day)" : simOn ? "■ STOP TEST" : "▶ TEST MODE (simulate a live race)"}
              </button>
              {simOn && (
                <button onClick={() => setSimFast((f) => !f)} className="disp"
                  style={{ background: simFast ? "#1a160a" : "#0b1017", color: simFast ? AMBER : "#9aa8bb", border: `1px solid ${simFast ? AMBER : "#2a3543"}`, borderRadius: 7, padding: "8px 12px", fontWeight: 600, fontSize: 12.5, cursor: "pointer" }}>
                  {simFast ? "FAST ×12 ON" : "speed ×12"}
                </button>
              )}
              {simOn && (
                <button onClick={() => { if (testClock) { setTestClock(false); } else { setClockStartAt(Date.now()); setTestClock(true); } }} className="disp"
                  style={{ background: testClock ? "#1a160a" : "#0b1017", color: testClock ? AMBER : "#9aa8bb", border: `1px solid ${testClock ? AMBER : "#2a3543"}`, borderRadius: 7, padding: "8px 12px", fontWeight: 600, fontSize: 12.5, cursor: "pointer" }}>
                  {testClock ? "TEST CLOCK ON (race running now)" : "run test clock (rehearse pit stops)"}
                </button>
              )}
              <button onClick={() => { if (confirm("Clear all logged pit stops for every team?")) { cfg.teams.forEach((t) => { if (owned.has(String(t.num))) pitClear(t.num); }); setCfg((c) => ({ ...c, teams: c.teams.map((t) => ({ ...t, pitLog: [] })) })); } }} className="mono"
                style={{ background: "none", color: "#9aa8bb", border: "1px solid #2a3543", borderRadius: 7, padding: "8px 12px", fontSize: 12, cursor: "pointer" }}>
                clear pit logs
              </button>
              <span className="mono" style={{ fontSize: 11, color: simOn ? "#ffb3a0" : "#66758a", flexBasis: "100%" }}>
                {simOn ? "⚠ SIMULATION — these are fake karts to rehearse the app, NOT real timing. Real race data comes from the live feed on the day. The real start (12:30) is unchanged unless you turn on the test clock. Clear pit logs + stop test before race day." : "Rehearse the whole app with made-up karts. This is a simulation, not real timing — it does not touch your plan or the real race clock."}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
              <input type="password" value={adminPw} onChange={(e) => setAdminPw(e.target.value)} placeholder="admin password"
                style={{ ...inp(150), fontFamily: "Barlow, sans-serif" }} />
              <button onClick={syncPlan} disabled={syncing} className="disp"
                style={{ background: "#11233a", color: "#3da9fc", border: "1px solid #3da9fc55", borderRadius: 7,
                  padding: "8px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                {syncing ? "SYNCING…" : "💾 SYNC PLAN TO TEAM"}
              </button>
              <span className="mono" style={{ fontSize: 11, color: "#66758a" }}>shares this stint plan with everyone (admin only)</span>
              {syncMsg && <span className="mono" style={{ fontSize: 11.5, color: syncMsg.startsWith("✓") ? "#2fd372" : "#ff8a5b" }}>{syncMsg}</span>}
              <button onClick={async () => {
                  const next = !teleLocked;
                  try {
                    const res = await fetch("/api/roster", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telemetryLocked: next, adminPassword: adminPw }) });
                    const d = await res.json();
                    if (res.ok && d.ok) { setTeleLocked(next); setSyncMsg(next ? "✓ Season telemetry locked." : "✓ Season telemetry unlocked."); }
                    else setSyncMsg(d.error || "Failed.");
                  } catch { setSyncMsg("Couldn't reach the server (live site only)."); }
                }} className="disp"
                style={{ background: teleLocked ? "#1a0a0e" : "#0b1017", color: teleLocked ? "#ff8a5b" : "#9aa8bb", border: `1px solid ${teleLocked ? "#ff8a5b55" : "#2a3543"}`, borderRadius: 7, padding: "8px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                {teleLocked ? "🔒 TELEMETRY LOCKED" : "🔓 LOCK SEASON TELEMETRY"}
              </button>
              <button onClick={async () => {
                  const next = !simLocked;
                  try {
                    const res = await fetch("/api/roster", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ simLocked: next, adminPassword: adminPw }) });
                    const d = await res.json();
                    if (res.ok && d.ok) { setSimLocked(next); if (next) { setSimOn(false); setTestClock(false); } setSyncMsg(next ? "✓ Test mode locked for everyone (race day)." : "✓ Test mode unlocked."); }
                    else setSyncMsg(d.error || "Failed.");
                  } catch { setSyncMsg("Couldn't reach the server (live site only)."); }
                }} className="disp"
                style={{ background: simLocked ? "#1a0a0e" : "#0b1017", color: simLocked ? "#ff8a5b" : "#9aa8bb", border: `1px solid ${simLocked ? "#ff8a5b55" : "#2b3a4e"}`, borderRadius: 7, padding: "8px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                {simLocked ? "🔒 TEST MODE LOCKED" : "🔓 LOCK TEST MODE (race day)"}
              </button>
            </div>
          </Panel>

          <datalist id="live24drivers">
            {[...new Set([...knownDrivers, ...cfg.teams.flatMap((t) => t.drivers)])].filter(Boolean).map((n) => <option key={n} value={n} />)}
          </datalist>

          {cfg.teams.map((team, ti) => (
            <StintTeamCard key={team.num || ti} team={team} ti={ti} raceStart={raceStart} totalMin={totalMin}
              defaultStintLen={cfg.defaultStintLen} now={now} started={started}
              owned={owned.has(String(team.num))} onUnlock={unlockTeam}
              onUpdate={(patch) => updateTeam(ti, patch)} />
          ))}
        </>
      )}

      {sub === "timing" && (
        <Panel title="LIVE TIMING — FULL FIELD">
          {!liveModel ? (
            <Empty msg={simOn ? "Loading…" : liveErr ? liveErr : `Waiting for a live ${LIVE_SITE.toUpperCase()} session. Standings appear automatically once a session goes live (practice, qualifying or race). Nothing showing during a live session? Open /api/live?site=${LIVE_SITE} to check the feed.`} />
          ) : liveModel.field.length === 0 ? (
            <Empty msg={`Connected to ${LIVE_SITE.toUpperCase()}, but no karts are out yet (session "${(liveModel.session && liveModel.session.label) || "—"}", ${(liveModel.session && liveModel.session.status) || "?"}).`} />
          ) : (
            <>
              <div className="mono" style={{ fontSize: 11.5, color: "#9aa8bb", marginBottom: 10 }}>
                {liveModel.field.length} karts · field avg {liveModel.fieldAvg != null ? fmt(liveModel.fieldAvg) : "—"} · fastest {liveModel.fastestOverall ? fmt(liveModel.fastestOverall.b) + " (#" + liveModel.fastestOverall.kart + ")" : "—"}{simOn ? " · TEST DATA" : ""}
              </div>
              <div className="scrollx">
                <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead><tr style={{ color: "#78889d", textAlign: "left" }}>
                    {["POS", "KART", "TEAM", "LAPS", "GAP", "BEST LAP"].map((h, i) => (
                      <th key={h} style={{ padding: "7px 10px", textAlign: i >= 3 ? "right" : "left", borderBottom: "1px solid #2b3a4e", fontWeight: 600, position: "sticky", top: 0, background: "#0a0f16" }}>{h}</th>))}
                  </tr></thead>
                  <tbody>
                    {[...liveModel.field].sort((a, b) => (a.pos || 999) - (b.pos || 999)).map((r) => {
                      const ours = ourNums.has(r.kart);
                      const fastest = liveModel.fastestOverall && r.best != null && Math.abs(r.best - liveModel.fastestOverall.b) < 0.001;
                      return (
                        <tr key={r.kart} style={{ borderBottom: "1px solid #11171f", background: ours ? "#ff2d4d12" : "transparent" }}>
                          <td style={{ padding: "7px 10px", color: AMBER, fontWeight: 700 }}>{r.pos || "—"}</td>
                          <td style={{ padding: "7px 10px", color: "#78889d" }}>#{r.kart}</td>
                          <td style={{ padding: "7px 10px", color: ours ? "#ff2d4d" : "#e6edf3", fontWeight: ours ? 700 : 400 }}>{r.team}{ours ? " ◄" : ""}</td>
                          <td style={{ padding: "7px 10px", textAlign: "right", color: "#c2cbd6" }}>{r.laps ?? "—"}</td>
                          <td style={{ padding: "7px 10px", textAlign: "right", color: "#9aa8bb" }}>{r.gap || "—"}</td>
                          <td style={{ padding: "7px 10px", textAlign: "right", color: fastest ? "#b06bff" : "#c2cbd6", fontWeight: fastest ? 700 : 400 }}>{r.best != null ? fmt(r.best) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mono" style={{ fontSize: 11, color: "#66758a", marginTop: 10 }}>Our karts highlighted in red. Purple = fastest lap of the field. This replaces having to watch AlphaRaceHub.</div>
            </>
          )}
        </Panel>
      )}

      {sub === "live" && (
        <Panel title="LIVE TRACKER — LEEDS TEAMS">
          {!liveModel ? (
            <Empty msg={started ? (liveErr || "Waiting for the first live snapshot…") : "Race hasn't started. The tracker fills once the live feed is running."} />
          ) : liveModel.leeds.length === 0 ? (
            <Empty msg="No Leeds karts found in the live feed yet." />
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%, 270px),1fr))", gap: 12 }}>
                {liveModel.leeds.sort((a, b) => (a.pos || 999) - (b.pos || 999)).map((r) => {
                  const planTeam = cfg.teams.find((t) => t.num === r.kart);
                  const isFastest = liveModel.fastestOverall && r.bestClean != null && Math.abs(r.bestClean - liveModel.fastestOverall.b) < 0.001;
                  const penSec = (r.penalties || []).reduce((a, p) => a + (p.sec || 0), 0);
                  const frac = r.lapFrac;
                  return (
                    <div key={r.kart} style={{ background: "#0b1017", border: "1px solid #1b2433", borderLeft: "3px solid #ff2d4d", borderRadius: 10, padding: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <span className="disp" style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>#{r.kart} {planTeam ? planTeam.name : r.team}</span>
                        <span className="mono" style={{ color: AMBER, fontWeight: 700, fontSize: 18 }}>P{r.pos || "—"}</span>
                      </div>
                      {/* lap position line from S/F */}
                      {frac != null && (
                        <div style={{ marginTop: 9 }}>
                          <div style={{ position: "relative", height: 8, borderRadius: 4, background: "#11171f", border: "1px solid #1e2733" }}>
                            <div style={{ position: "absolute", left: 0, top: -2, bottom: -2, width: 2, background: "#fff" }} />
                            <div style={{ position: "absolute", left: `calc(${Math.min(98, frac * 100)}% )`, top: -3, width: 11, height: 11, borderRadius: "50%", background: "#ff2d4d", border: "2px solid #05070b" }} />
                          </div>
                          <div className="mono" style={{ fontSize: 11, color: "#66758a", display: "flex", justifyContent: "space-between", marginTop: 2 }}><span>S/F</span><span>{Math.round(frac * 100)}% of lap</span></div>
                        </div>
                      )}
                      <div className="mono" style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 14px", fontSize: 12 }}>
                        <Stat label="LAPS" v={r.laps ?? "—"} />
                        <Stat label="GAP" v={r.gap || "—"} />
                        <Stat label="BEST LAP" v={r.bestClean != null ? fmt(r.bestClean) : "—"} c={isFastest ? "#b06bff" : "#e6edf3"} />
                        <Stat label="LAST 5" v={r.recent != null ? fmt(r.recent) : "—"} c={r.recent != null && liveModel.fieldAvg ? (r.recent <= liveModel.fieldAvg ? "#2fd372" : "#ff8a5b") : "#c2cbd6"} />
                        <Stat label="STINT LAPS" v={r.stintLapCount || 0} />
                        <Stat label="THIS STINT" v={fmtDur(r.stintMin)} />
                      </div>
                      {isFastest && <div className="mono" style={{ marginTop: 8, color: "#b06bff", fontSize: 11, fontWeight: 700 }}>★ FASTEST LAP OF THE FIELD</div>}
                      {penSec > 0 && <div className="mono" style={{ marginTop: 6, color: "#ff2d4d", fontSize: 11 }}>⚑ {r.penalties.length} penalt{r.penalties.length === 1 ? "y" : "ies"} · +{penSec}s</div>}
                    </div>
                  );
                })}
              </div>
              {liveModel.fieldAvg != null && <div className="mono" style={{ fontSize: 11, color: "#78889d", marginTop: 10 }}>Field average lap {fmt(liveModel.fieldAvg)} · fastest overall {liveModel.fastestOverall ? fmt(liveModel.fastestOverall.b) + " (#" + liveModel.fastestOverall.kart + ")" : "—"}. Green = at or under field average. Purple = fastest lap of the whole field.</div>}
              <Collapsible title="FULL FIELD" subtitle={`${liveModel.field.length} karts`} accent="#3da9fc">
                <div style={{ overflowX: "auto" }}>
                  <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead><tr style={{ color: "#78889d", textAlign: "left" }}>
                      {["POS", "KART", "TEAM", "LAPS", "GAP", "BEST"].map((h) => (
                        <th key={h} style={{ padding: "6px 8px", borderBottom: "1px solid #1e2733" }}>{h}</th>))}
                    </tr></thead>
                    <tbody>
                      {liveModel.field.sort((a, b) => (a.pos || 999) - (b.pos || 999)).map((r) => {
                        const ours = ourNums.has(r.kart) || isOurTeam(r.team);
                        return (
                          <tr key={r.kart} style={{ borderBottom: "1px solid #11171f", background: ours ? "#ff2d4d10" : "transparent" }}>
                            <td style={{ padding: "6px 8px", color: AMBER, fontWeight: 600 }}>{r.pos || "—"}</td>
                            <td style={{ padding: "6px 8px", color: "#78889d" }}>#{r.kart}</td>
                            <td style={{ padding: "6px 8px", color: ours ? "#ff2d4d" : "#c2cbd6", fontWeight: ours ? 600 : 400 }}>{r.team}</td>
                            <td style={{ padding: "6px 8px", color: "#c2cbd6" }}>{r.laps ?? "—"}</td>
                            <td style={{ padding: "6px 8px", color: "#9aa8bb" }}>{r.gap || "—"}</td>
                            <td style={{ padding: "6px 8px", color: liveModel.fastestOverall && r.best != null && Math.abs(r.best - liveModel.fastestOverall.b) < 0.001 ? "#b06bff" : "#c2cbd6", fontWeight: liveModel.fastestOverall && r.best != null && Math.abs(r.best - liveModel.fastestOverall.b) < 0.001 ? 700 : 400 }}>{r.best != null ? fmt(r.best) : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Collapsible>
            </>
          )}
        </Panel>
      )}

      {sub === "pace" && (
        <Panel title="TEAM PACE — CLEAN LAPS (LIVE)">
          {!liveModel || !liveModel.leeds.length ? (
            <Empty msg="Pace fills from the live feed once Leeds karts are putting in laps." />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead><tr style={{ color: "#78889d", textAlign: "right" }}>
                  {["TEAM", "LAPS", "BEST", "CLEAN AVG", "CONSISTENCY", "RECENT 5", "CHANGEOVERS"].map((h, i) => (
                    <th key={h} style={{ padding: "6px 10px", textAlign: i === 0 ? "left" : "right", borderBottom: "1px solid #1e2733", fontWeight: 500 }}>{h}</th>))}
                </tr></thead>
                <tbody>
                  {liveModel.leeds.map((r) => {
                    const clean = splitClean(r.lapArr).clean;
                    return (
                      <tr key={r.kart} style={{ borderBottom: "1px solid #11171f" }}>
                        <td style={{ padding: "6px 10px", color: "#ff2d4d", fontWeight: 600, textAlign: "left" }}>#{r.kart} {(cfg.teams.find((t) => t.num === r.kart) || {}).name || r.team}</td>
                        <td style={td}>{r.laps ?? "—"}</td>
                        <td style={td}>{r.bestClean != null ? fmt(r.bestClean) : "—"}</td>
                        <td style={td}>{clean.length ? fmt(mean(clean)) : "—"}</td>
                        <td style={td}>{clean.length > 1 ? sd(clean).toFixed(3) : "—"}</td>
                        <td style={td}>{r.recent != null ? fmt(r.recent) : "—"}</td>
                        <td style={td}>{r.changeovers}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="mono" style={{ fontSize: 11, color: "#66758a", marginTop: 12, lineHeight: 1.5 }}>
                Clean laps exclude anything above 110% of the kart's own median (incidents and changeover laps).
                Changeovers are inferred from laps over 1.6x median, so they're an estimate, not the official stint log.
              </div>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

function TeamCommand({ team, teamIdx, raceStart, totalMin, now, live, setCfg, model, owned, onUnlock, onLock, pitIn, pitUndo, pitEdit }) {
  const [code, setCode] = useState("");
  const [codeErr, setCodeErr] = useState("");
  const [armed, setArmed] = useState(false);
  const armRef = useRef(null);
  const [alertsOn, setAlertsOn] = useState(() => LS("live24_alerts", true));
  useEffect(() => { saveLS("live24_alerts", alertsOn); }, [alertsOn]);
  const firedRef = useRef({});
  const pitAlert = (title, body) => {
    try { navigator.vibrate && navigator.vibrate([300, 120, 300]); } catch {}
    try {
      const ctx = window.__pwAudio || (window.__pwAudio = new (window.AudioContext || window.webkitAudioContext)());
      [0, 0.25].forEach((d) => { const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination); o.frequency.value = 880;
        g.gain.setValueAtTime(0.15, ctx.currentTime + d); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + d + 0.2);
        o.start(ctx.currentTime + d); o.stop(ctx.currentTime + d + 0.22); });
    } catch {}
    try { if ("Notification" in window && Notification.permission === "granted") new Notification(title || "Pitwall", { body: body || "", tag: "pitwall-" + team.num }); } catch {}
  };
  const askNotify = () => { try { if ("Notification" in window && Notification.permission !== "granted") Notification.requestPermission(); } catch {} };
  const logPit = (atMin) => owned && pitIn(team.num, atMin);
  const undoPit = () => owned && pitUndo(team.num);
  const setLastPit = (atMin) => { if (!owned) return; const pl = team.pitLog || []; if (pl.length) pitEdit(team.num, pl[pl.length - 1].id, atMin); };
  const clockToMin = (hhmm) => { const m = String(hhmm).match(/(\d{1,2}):(\d{2})/); if (!m) return null; const base = raceStart.getHours() * 60 + raceStart.getMinutes(); let d = (+m[1] * 60 + +m[2]) - base; if (d < 0) d += 1440; return d; };

  if (!team || !(team.stints || []).length) {
    return <Panel title="TEAM COMMAND"><Empty msg="No plan for this team yet. Go to the Planner tab and import the master spreadsheet." /></Panel>;
  }

  const rs = teamRaceState(team, raceStart, now);
  const cur = rs.onKartIdx >= 0 ? rs.rows[rs.onKartIdx] : null;
  const inc = rs.onKartIdx >= 0 ? rs.rows[rs.onKartIdx + 1] : null;
  const toPit = rs.minsToPit;
  const overdue = rs.started && toPit != null && toPit < 0;
  const pitC = toPit == null ? "#66758a" : overdue || toPit <= 5 ? "#ff2d4d" : toPit <= 15 ? "#ff8a5b" : "#2fd372";
  const clockOf = (m) => fmtClockDay(new Date(raceStart.getTime() + m * 60000), raceStart);
  const projStart = (i) => { if (rs.onKartIdx < 0 || i < rs.onKartIdx) return null; let a = rs.onKartStart; for (let k = rs.onKartIdx; k < i; k++) a += rs.rows[k].len; return a; };
  const spare = totalMin - rs.projFinish;
  const isFinal = rs.onKartIdx === rs.rows.length - 1 && rs.onKartIdx >= 0;
  const toFlag = totalMin - rs.nowMin;
  const stintPct = cur && rs.stintElapsed != null ? Math.max(0, Math.min(1, rs.stintElapsed / cur.len)) : 0;
  const leadDelta = (inc && cur && inc.lead != null && cur.lead != null) ? Math.round((inc.lead - cur.lead) * 10) / 10 : null;
  const heavy = (v) => v && String(v).toUpperCase().includes("M/H");
  const planDrivers = [...new Set(rs.rows.map((r) => r.driver).filter(Boolean))];
  const anyHeavy = rs.rows.some((r) => heavy(r.seat));
  const card = { background: "#0b1017", border: "1px solid #1b2433", borderRadius: 12, padding: 16 };

  // --- per-driver pace: split the lap list at detected stints, assign by plan order ---
  const lapArr = (live && live.lapArr) || [];
  const segs = (() => {
    const b = detectStints(lapArr).boundaries;
    const cuts = [0, ...b, lapArr.length];
    const out = [];
    for (let k = 0; k < cuts.length - 1; k++) out.push(lapArr.slice(cuts[k], cuts[k + 1]).filter((x) => x != null));
    return out;
  })();
  const byDriver = {};
  segs.forEach((seg, k) => { const drv = rs.rows[k]?.driver; if (!drv) return; (byDriver[drv] = byDriver[drv] || []).push(...splitClean(seg).clean); });
  const driverStats = planDrivers.map((d) => { const c = byDriver[d] || []; return { d, n: c.length, fastest: c.length ? Math.min(...c) : null, consist: c.length > 1 ? sd(c) : null }; });
  const teamFastest = driverStats.reduce((m, x) => (x.fastest != null && (m == null || x.fastest < m) ? x.fastest : m), null);

  // --- pit window by laps (live) ---
  const recentSec = (live && live.recent) || (cur && cur.len ? cur.len * 60 / 14 : 30);
  const targetLaps = cur ? Math.max(1, Math.round((cur.len * 60) / recentSec)) : null;
  const stintLaps = live && live.stintLapCount != null ? live.stintLapCount : null;
  let windowState = null;
  if (targetLaps != null && stintLaps != null && rs.started && !rs.finished) {
    const openAt = Math.max(1, targetLaps - 2);
    if (stintLaps < openAt) windowState = { txt: `opens in ${openAt - stintLaps} lap${openAt - stintLaps === 1 ? "" : "s"} (lap ${openAt})`, c: "#9aa8bb" };
    else if (stintLaps <= targetLaps) windowState = { txt: `OPEN — pit by lap ${targetLaps} (${Math.max(0, targetLaps - stintLaps)} left)`, c: "#2fd372" };
    else windowState = { txt: `PAST WINDOW — ${stintLaps - targetLaps} lap${stintLaps - targetLaps === 1 ? "" : "s"} over`, c: "#ff2d4d" };
  }

  // --- penalties ---
  const pens = (live && live.penalties) || [];
  const totalPen = pens.reduce((a, p) => a + (p.sec || 0), 0);
  const penDriver = (p) => {
    if (p.lap == null) return null;                  // attribute by which stint segment the lap falls in
    let acc = 0; for (let k = 0; k < segs.length; k++) { acc += segs[k].length; if (p.lap <= acc) return rs.rows[k]?.driver || null; }
    return rs.currentDriver;
  };

  const Row = ({ label, value, accent, strong }) => (
    <div style={{ padding: "11px 0", borderBottom: "1px solid #11171f" }}>
      <div className="disp" style={{ fontSize: 11.5, color: "#78889d", letterSpacing: 0.5, fontWeight: 600, marginBottom: 2 }}>{label}</div>
      <div className="mono" style={{ fontSize: strong ? 16 : 14, color: accent || "#e6edf3", fontWeight: strong ? 700 : 500 }}>{value}</div>
    </div>
  );
  const leadLine = () => { if (inc?.lead == null) return null; if (leadDelta == null) return `Set lead to ${inc.lead} kg`; if (leadDelta > 0) return `Add ${leadDelta} kg of lead  (total ${inc.lead} kg)`; if (leadDelta < 0) return `Remove ${Math.abs(leadDelta)} kg of lead  (total ${inc.lead} kg)`; return `No lead change  (stays ${inc.lead} kg)`; };
  const seatLine = () => { if (!inc?.seat) return null; const changed = cur && cur.seat && cur.seat !== inc.seat; return `${changed ? "Change to" : "Keep"} ${inc.seat} insert${heavy(inc.seat) ? " (heavy)" : ""}`; };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* status */}
      <div className="panelpad" style={{ ...card, background: "linear-gradient(135deg,#11233a22,#0b1017)", border: "1px solid #2b3a4e", borderLeft: "4px solid " + AMBER }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <span className="disp" style={{ fontSize: 15, color: "#fff", fontWeight: 800 }}>{team.name} <span style={{ color: AMBER }}>#{team.num}</span></span>
          <span className="mono" style={{ fontSize: 11, color: owned ? "#2fd372" : "#78889d" }}>{owned ? "● you can log for this team" : "view only"}</span>
        </div>

        {rs.finished ? (
          <div className="disp" style={{ fontSize: 22, fontWeight: 800, color: "#2fd372", marginTop: 12 }}>RACE DONE · {rs.completed} pit stops made</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
              <div>
                <div className="disp" style={{ fontSize: 11, color: "#66758a", letterSpacing: 0.5 }}>DRIVING NOW</div>
                <div className="disp" style={{ fontSize: 24, fontWeight: 800, color: "#fff", lineHeight: 1.1 }}>{rs.currentDriver || "—"}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="disp" style={{ fontSize: 11, color: "#66758a", letterSpacing: 0.5 }}>{overdue ? "PIT DUE" : rs.started ? "NEXT PIT" : "RACE START"}</div>
                <div className="mono" style={{ fontSize: 24, fontWeight: 800, color: pitC, lineHeight: 1.1 }}>{rs.nextPitMin != null ? clockOf(rs.nextPitMin) : "—"}</div>
                <div className="mono" style={{ fontSize: 12, color: pitC }}>{rs.started && toPit != null ? (overdue ? fmtDur(-toPit) + " LATE" : "in " + fmtDur(Math.max(0, toPit))) : ""}</div>
              </div>
            </div>

            {cur && rs.started && (
              <div style={{ marginTop: 12 }}>
                <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#78889d" }}>
                  <span>stint {rs.onKartIdx + 1} of {rs.rows.length}{stintLaps != null ? ` · ${stintLaps} laps` : ""}</span>
                  <span>{fmtDur(Math.max(0, rs.stintElapsed))} of {fmtDur(cur.len)}</span>
                </div>
                <div style={{ height: 7, borderRadius: 4, background: "#11171f", marginTop: 5, overflow: "hidden" }}>
                  <div style={{ width: `${stintPct * 100}%`, height: "100%", background: pitC }} />
                </div>
              </div>
            )}

            {windowState && <div className="mono" style={{ marginTop: 8, fontSize: 12 }}><span style={{ color: "#78889d" }}>PIT WINDOW: </span><span style={{ color: windowState.c, fontWeight: 600 }}>{windowState.txt}</span></div>}

            {owned && (() => {
              const nm = inc ? inc.driver : null;
              if (alertsOn && rs.started && !rs.finished && toPit != null && toPit > -2) {
                const k = rs.onKartIdx;
                if (toPit <= 30 && toPit > 5 && !firedRef.current["30:" + k]) { firedRef.current["30:" + k] = 1; pitAlert(`#${team.num}: prepare ${nm || "next driver"}`, `Pit in ~30 min. Get ${nm || "the next driver"} ready.`); }
                if (toPit <= 5 && !firedRef.current["5:" + k]) { firedRef.current["5:" + k] = 1; pitAlert(`#${team.num}: pit in 5 min`, `${nm || "Next driver"} to the pit lane.`); }
                if (toPit <= 1 && !firedRef.current["1:" + k]) { firedRef.current["1:" + k] = 1; pitAlert(`#${team.num}: PIT NOW`, `Swap to ${nm || "next driver"}.`); }
              }
              // driver-change alert: fires when the current driver index advances
              if (alertsOn && rs.started && rs.currentDriver && firedRef.current.lastDriver && firedRef.current.lastDriver !== rs.currentDriver) {
                pitAlert(`#${team.num}: ${rs.currentDriver} is out`, `Driver change logged — ${rs.currentDriver} now driving.`);
              }
              firedRef.current.lastDriver = rs.currentDriver;
              return (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  <button onClick={() => { setAlertsOn((a) => !a); askNotify(); }} className="mono"
                    style={{ background: "none", border: `1px solid ${alertsOn ? "#2fd37255" : "#2b3a4e"}`, color: alertsOn ? "#2fd372" : "#78889d", borderRadius: 7, padding: "7px 11px", fontSize: 11.5, cursor: "pointer" }}>
                    {alertsOn ? "🔔 alerts ON — buzz + notify at 30/5/1 min & driver change" : "🔕 alerts off"}
                  </button>
                  <button onClick={() => { askNotify(); pitAlert(`#${team.num}: test alert`, "This is what a pit alert looks like."); }} className="mono"
                    style={{ background: "none", border: "1px solid #2b3a4e", color: "#9aa8bb", borderRadius: 7, padding: "7px 11px", fontSize: 11.5, cursor: "pointer" }}>
                    ▶ test alert
                  </button>
                </div>
              );
            })()}

            {owned ? (
              <button onClick={() => {
                  if (!armed) { setArmed(true); clearTimeout(armRef.current); armRef.current = setTimeout(() => setArmed(false), 4000); return; }
                  setArmed(false); clearTimeout(armRef.current);
                  logPit((Date.now() - raceStart.getTime()) / 60000);
                }} className="disp"
                style={{ width: "100%", marginTop: 12, background: armed ? "#fff" : "#ff2d4d", color: armed ? "#ff2d4d" : "#fff", border: armed ? "2px solid #ff2d4d" : "none", borderRadius: 10, padding: "16px", fontWeight: 800, fontSize: 17, cursor: "pointer", letterSpacing: 0.5 }}>
                {armed ? "TAP AGAIN TO CONFIRM PIT STOP" : "◉ PIT STOP NOW" + (rs.currentDriver ? " — " + rs.currentDriver + " comes in" : "")}
              </button>
            ) : (
              <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <input type="password" value={code} onChange={(e) => setCode(e.target.value)} placeholder="team passcode to log pits"
                  style={{ ...inp(200), fontFamily: "Barlow, sans-serif" }} onKeyDown={(e) => { if (e.key === "Enter") onUnlock(team.num, code).then((ok) => setCodeErr(ok ? "" : "Wrong passcode.")); }} />
                <button onClick={() => onUnlock(team.num, code).then((ok) => setCodeErr(ok ? "" : "Wrong passcode."))} className="disp"
                  style={{ background: "#11233a", color: "#2fd372", border: "1px solid #2fd37255", borderRadius: 7, padding: "9px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>UNLOCK</button>
                {codeErr && <span className="mono" style={{ fontSize: 11.5, color: "#ff8a5b" }}>{codeErr}</span>}
              </div>
            )}
            {owned && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, flexWrap: "wrap", gap: 8 }}>
                {rs.completed > 0 ? <button onClick={undoPit} className="mono" style={{ background: "none", border: "1px solid #2a3543", color: "#9aa8bb", borderRadius: 7, padding: "7px 12px", cursor: "pointer", fontSize: 12 }}>↩ undo last stop</button> : <span />}
                {rs.lastActual != null && (
                  <span className="mono" style={{ fontSize: 11.5, color: "#9aa8bb", textAlign: "right" }}>
                    Last: {rs.lastDriver} {fmtDur(rs.lastActual)}
                    <span style={{ color: rs.lastActual <= rs.lastPlanned ? "#2fd372" : "#ff8a5b" }}> ({fmtDur(Math.abs(rs.lastActual - rs.lastPlanned))} {rs.lastActual <= rs.lastPlanned ? "shorter" : "longer"})</span>
                  </span>
                )}
              </div>
            )}

            {rs.started && (
              <div className="mono" style={{ marginTop: 12, fontSize: 12.5, color: "#c2cbd6", background: "#080d13", borderRadius: 8, padding: "9px 11px" }}>
                {isFinal ? <span>Last stint — <b style={{ color: pitC }}>{fmtDur(Math.max(0, toFlag))} until the finish</b></span>
                  : <span>Finish ~<b>{clockOf(rs.projFinish)}</b> · <b style={{ color: spare >= 0 ? "#2fd372" : "#ff8a5b" }}>{spare >= 0 ? fmtDur(spare) + " spare before flag" : fmtDur(-spare) + " over the flag"}</b></span>}
                <br />
                <span style={{ color: "#9aa8bb" }}>Schedule: </span>
                <b style={{ color: rs.driftMin <= 0.5 ? "#2fd372" : "#ff8a5b" }}>{Math.abs(rs.driftMin) < 0.5 ? "on plan" : rs.driftMin < 0 ? fmtDur(-rs.driftMin) + " AHEAD of plan" : fmtDur(rs.driftMin) + " BEHIND plan"}</b>
              </div>
            )}
          </>
        )}
      </div>

      {/* next stop — what to change */}
      {inc && !rs.finished && (
        <div className="panelpad" style={{ ...card, border: "1px solid #ff2d4d40" }}>
          <div className="disp" style={{ fontSize: 12, color: "#ff2d4d", fontWeight: 800, letterSpacing: 0.5 }}>WHAT TO CHANGE AT THE NEXT STOP</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4, flexWrap: "wrap", gap: "2px 10px" }}>
            <span className="disp" style={{ fontSize: 21, fontWeight: 800, color: "#fff" }}>Next driver: {inc.driver}</span>
            <span className="mono" style={{ fontSize: 12.5, color: "#9aa8bb" }}>{clockOf(rs.nextPitMin)}</span>
          </div>
          <div style={{ marginTop: 6 }}>
            {inc.note && !inc.auto && <Row label="PIT NOTE FROM YOUR SHEET" value={inc.note} accent={AMBER} strong />}
            {(!inc.note || inc.auto) && leadLine() && <Row label="LEAD WEIGHT (BALLAST)" value={leadLine()} accent={leadDelta ? (leadDelta > 0 ? "#ff8a5b" : "#2fd372") : "#e6edf3"} strong={!!leadDelta} />}
            {seatLine() && <Row label="SEAT INSERT" value={seatLine()} accent={cur && inc.seat && cur.seat !== inc.seat ? AMBER : "#e6edf3"} strong={!!(cur && inc.seat && cur.seat !== inc.seat)} />}
            {inc.pedals && <Row label="PEDAL POSITION" value={inc.pedals} />}
            {inc.assist && <Row label="WHO HELPS THE STOP" value={inc.assist} accent="#3da9fc" />}
            {inc.radio && <Row label="STAYS ON RADIO" value={inc.radio} accent="#3da9fc" />}
          </div>
        </div>
      )}

      {/* lead & seat for every driver (only when the sheet has the data) */}
      {rs.rows.some((r) => r.lead != null || r.seat) && (
      <div className="panelpad" style={card}>
        <Label>LEAD &amp; SEAT BY DRIVER</Label>
        <div style={{ display: "grid", gap: 4 }}>
            {planDrivers.map((d) => { const st = rs.rows.find((r) => r.driver === d) || {}; return (
              <div key={d} className="mono" style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, background: "#080d13", borderRadius: 7, padding: "7px 10px" }}>
                <span style={{ color: "#e6edf3", fontWeight: 600, flex: "0 0 auto" }}>{d}</span>
                <span style={{ color: "#9aa8bb", textAlign: "right" }}>{st.lead != null ? <b style={{ color: "#fff" }}>{st.lead} kg</b> : "— kg"}{st.seat ? " · " + st.seat + (heavy(st.seat) ? " (heavy)" : "") : ""}{st.pedals ? " · " + st.pedals : ""}</span>
              </div>
            ); })}
        </div>
        {anyHeavy && <div className="mono" style={{ fontSize: 11, color: "#66758a", marginTop: 8 }}>M/H = the heavy seat insert. Lead = ballast added to the kart for that driver.</div>}
      </div>
      )}

      {/* penalties */}
      {pens.length > 0 && (
        <div className="panelpad" style={{ ...card, border: "1px solid #ff2d4d40" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="disp" style={{ fontSize: 12, color: "#ff2d4d", fontWeight: 800 }}>⚑ PENALTIES</span>
            <span className="mono" style={{ fontSize: 14, color: "#ff2d4d", fontWeight: 700 }}>+{totalPen}s total</span>
          </div>
          <div style={{ display: "grid", gap: 3, marginTop: 8 }}>
            {pens.map((p, i) => { const drv = penDriver(p); return (
              <div key={i} className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 4px" }}>
                <span style={{ color: "#c2cbd6" }}>{p.reason}{drv ? <span style={{ color: "#9aa8bb" }}> — {drv}</span> : ""}{p.lap != null ? <span style={{ color: "#66758a" }}> (lap {p.lap})</span> : ""}</span>
                <span style={{ color: "#ff8a5b" }}>{p.sec != null ? "+" + p.sec + "s" : (p.raw || "—")}</span>
              </div>
            ); })}
          </div>
        </div>
      )}

      {/* pace vs field + per driver */}
      {live && (
        <div className="panelpad" style={card}>
          <Label>PACE vs FIELD</Label>
          <div className="mono g3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px 14px", fontSize: 13 }}>
            <Stat label="OUR LAST 5" v={live.recent != null ? fmt(live.recent) : "—"} c={live.recent != null && model?.fieldAvg ? (live.recent <= model.fieldAvg ? "#2fd372" : "#ff8a5b") : "#e6edf3"} />
            <Stat label="FIELD AVG" v={model?.fieldAvg != null ? fmt(model.fieldAvg) : "—"} />
            <Stat label="vs FIELD" v={live.recent != null && model?.fieldAvg != null ? (live.recent <= model.fieldAvg ? "-" : "+") + (Math.abs(live.recent - model.fieldAvg)).toFixed(2) + "s" : "—"} c={live.recent != null && model?.fieldAvg ? (live.recent <= model.fieldAvg ? "#2fd372" : "#ff8a5b") : "#e6edf3"} />
            <Stat label="OUR BEST" v={live.bestClean != null ? fmt(live.bestClean) : "—"} c={model?.fastestOverall && live.bestClean != null && Math.abs(live.bestClean - model.fastestOverall.b) < 0.001 ? "#b06bff" : "#e6edf3"} />
            <Stat label="FASTEST (FIELD)" v={model?.fastestOverall ? fmt(model.fastestOverall.b) : "—"} c="#b06bff" />
            <Stat label="ON" v={model?.fastestOverall ? "#" + model.fastestOverall.kart : "—"} />
          </div>
          <div style={{ marginTop: 12 }}>
            <Label>EACH DRIVER (this kart)</Label>
            <div style={{ display: "grid", gap: 3 }}>
              {driverStats.map((s) => (
                <div key={s.d} className="mono" style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, padding: "5px 8px", background: "#080d13", borderRadius: 6 }}>
                  <span style={{ color: "#e6edf3" }}>{s.d}</span>
                  <span style={{ color: "#9aa8bb" }}>
                    {s.n} laps · best <b style={{ color: s.fastest != null && teamFastest != null && Math.abs(s.fastest - teamFastest) < 0.001 ? "#b06bff" : "#c2cbd6" }}>{s.fastest != null ? fmt(s.fastest) : "—"}</b> · consistency {s.consist != null ? "±" + s.consist.toFixed(2) + "s" : "—"}
                  </span>
                </div>
              ))}
            </div>
            <div className="mono" style={{ fontSize: 11, color: "#66758a", marginTop: 6 }}>Purple = holds the kart's fastest lap. Lower consistency number = more consistent. Laps split by stint, assigned in driver order.</div>
          </div>
        </div>
      )}

      {/* drivers + wake */}
      <div className="panelpad" style={card}>
        {inc && !rs.finished && (
          <div style={{ background: "#1a160a", border: "1px solid " + AMBER + "55", borderRadius: 8, padding: "10px 12px", marginBottom: 12 }}>
            <span className="disp" style={{ fontSize: 13, color: AMBER, fontWeight: 700 }}>⏰ WAKE UP {inc.driver}</span>
            <div className="mono" style={{ fontSize: 12, color: "#c2cbd6", marginTop: 2 }}>driving next at {clockOf(rs.nextPitMin)}{rs.started && toPit != null ? ` (in ${fmtDur(Math.max(0, toPit))})` : ""}</div>
          </div>
        )}
        <Label>DRIVERS</Label>
        <div style={{ display: "grid", gap: 4 }}>
          {planDrivers.map((d) => {
            const dsi = rs.rows.map((r, i) => ({ r, i })).filter((x) => x.r.driver === d);
            const total = dsi.reduce((a, x) => a + (Number(x.r.len) || 0), 0);
            const isOn = rs.currentDriver === d && rs.started && !rs.finished;
            const isNext = inc && inc.driver === d && !isOn;
            const nextOut = dsi.find((x) => x.i > rs.onKartIdx);
            const nextMin = nextOut ? projStart(nextOut.i) : null;
            const rest = nextMin != null && rs.started ? nextMin - rs.nowMin : null;
            const sDone = rs.started ? dsi.filter((x) => x.i < rs.onKartIdx).length : 0;
            const sLeft = dsi.length - sDone;
            const status = isOn ? "DRIVING NOW" : nextMin != null ? `drives at ${clockOf(nextMin)}${rest != null ? ` · rest ${fmtDur(Math.max(0, rest))}` : ""}` : rs.started ? "finished" : "waiting to start";
            return (
              <div key={d} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "9px 11px", borderRadius: 7, background: isOn ? "#ff2d4d18" : isNext ? AMBER + "15" : "#080d13" }}>
                <div className="mono" style={{ fontSize: 13, fontWeight: isOn || isNext ? 700 : 500, color: isOn ? "#ff2d4d" : isNext ? AMBER : "#e6edf3" }}>{isOn ? "● " : isNext ? "▶ " : ""}{d}</div>
                <div className="mono" style={{ fontSize: 11, color: "#9aa8bb", textAlign: "right" }}>{status}<br /><span style={{ color: "#66758a" }}>{sLeft} of {dsi.length} stints left · {fmtDur(total)} total</span></div>
              </div>
            );
          })}
        </div>
      </div>

      {/* live + log */}
      <div className="panelpad" style={card}>
        <Label>LIVE TIMING</Label>
        <div className="mono g3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px 14px", fontSize: 13 }}>
          <Stat label="POSITION" v={live && live.pos ? "P" + live.pos : "—"} />
          <Stat label="LAPS DONE" v={live && live.laps != null ? live.laps : "—"} />
          <Stat label="GAP" v={live && live.gap ? live.gap : "—"} />
          <Stat label="STINT LAPS" v={live && live.stintLapCount != null ? live.stintLapCount : "—"} />
          <Stat label="EST. FINAL LAPS" v={live && live.laps != null && live.recent != null && rs.started && !rs.finished && toFlag > 0 ? "~" + (live.laps + Math.floor((toFlag * 60) / live.recent)) : "—"} c="#9aa8bb" />
          <Stat label="AVG LAP (RACE)" v={live && live.lapArr ? (() => { const c = splitClean(live.lapArr).clean; return c.length ? fmt(mean(c)) : "—"; })() : "—"} />
        </div>
        {rs.completed > 0 && (
          <Collapsible title={`PIT STOP LOG — ${rs.completed} made`} accent="#ff2d4d">
            <div style={{ display: "grid", gap: 3 }}>
              {rs.rows.slice(0, rs.completed).map((r, i) => {
                const atMin = (team.pitLog || [])[i]?.atMin; const isLast = i === rs.completed - 1;
                return (
                  <div key={i} className="mono" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, fontSize: 12.5, padding: "5px 4px" }}>
                    <span style={{ color: "#9aa8bb" }}>{i + 1}. {r.driver} out, {rs.rows[i + 1]?.driver || "—"} in</span>
                    {isLast && owned ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <span style={{ color: "#66758a", fontSize: 10 }}>fix</span>
                        <input type="time" defaultValue={`${pad2(Math.floor((((atMin % 1440) + 1440) % 1440) / 60))}:${pad2(Math.round(((atMin % 60) + 60) % 60))}`}
                          onChange={(e) => { const v = clockToMin(e.target.value); if (v != null) setLastPit(v); }}
                          style={{ background: "#11171f", border: "1px solid #2b3a4e", borderRadius: 5, color: "#e6edf3", padding: "3px 6px", fontSize: 12, fontFamily: "Barlow Semi Condensed, sans-serif" }} />
                      </span>
                    ) : <span style={{ color: "#66758a" }}>{atMin != null ? clockOf(atMin) : "—"}</span>}
                  </div>
                );
              })}
            </div>
          </Collapsible>
        )}
        {owned && <div style={{ marginTop: 10 }}><button onClick={() => onLock(team.num)} className="mono" style={{ background: "none", border: "1px solid #2a3543", color: "#78889d", borderRadius: 7, padding: "6px 11px", fontSize: 11, cursor: "pointer" }}>lock this team (stop editing on this device)</button></div>}
        <div className="mono" style={{ fontSize: 11.5, color: "#66758a", marginTop: 10, lineHeight: 1.6 }}>
          Press PIT STOP NOW when the driver comes in — next pit, wake-ups and finish all update from the real time. Everything syncs to the shared save so other Leeds teams and spectators see it.
        </div>
      </div>
    </div>
  );
}

const TRACK_PATH = "M408.0,185.0 L364.0,185.0 L350.0,190.0 L339.0,201.0 L242.0,384.0 L231.0,400.0 L221.0,410.0 L213.0,414.0 L196.0,412.0 L176.0,393.0 L104.0,256.0 L103.0,246.0 L106.0,239.0 L125.0,224.0 L135.0,211.0 L136.0,203.0 L134.0,195.0 L126.0,187.0 L115.0,183.0 L60.0,183.0 L49.0,178.0 L42.0,171.0 L38.0,163.0 L37.0,146.0 L42.0,132.0 L53.0,119.0 L72.0,107.0 L154.0,89.0 L253.0,72.0 L317.0,72.0 L382.0,78.0 L463.0,90.0 L475.0,96.0 L488.0,114.0 L500.0,124.0 L506.0,126.0 L537.0,124.0 L542.0,126.0 L548.0,133.0 L551.0,152.0 L561.0,159.0 L591.0,167.0 L628.0,172.0 L636.0,171.0 L645.0,164.0 L648.0,152.0 L646.0,142.0 L638.0,133.0 L633.0,131.0 L592.0,128.0 L573.0,124.0 L565.0,115.0 L564.0,102.0 L571.0,90.0 L582.0,85.0 L810.0,111.0 L835.0,119.0 L847.0,126.0 L860.0,139.0 L868.0,156.0 L870.0,180.0 L867.0,199.0 L859.0,219.0 L845.0,236.0 L830.0,244.0 L816.0,247.0 L785.0,246.0 L748.0,235.0 L729.0,226.0 L723.0,219.0 L720.0,209.0 L722.0,197.0 L725.0,192.0 L734.0,183.0 L742.0,180.0 L754.0,180.0 L798.0,191.0 L807.0,192.0 L818.0,189.0 L824.0,182.0 L826.0,176.0 L824.0,160.0 L815.0,151.0 L793.0,144.0 L760.0,144.0 L729.0,152.0 L717.0,158.0 L701.0,170.0 L671.0,200.0 L659.0,206.0 L646.0,208.0 L602.0,205.0 L556.0,194.0 L542.0,186.0 L521.0,162.0 L507.0,157.0 L500.0,157.0 L487.0,162.0 L467.0,179.0 L455.0,185.0 L442.0,187.0 L409.0,186.0 Z";
const TRACK_VIEWBOX = "0 0 928 482";

function TrackMap({ model, teams, simOn, speedMul = 1, onSim }) {
  const pathRef = useRef(null);
  const [len, setLen] = useState(0);
  const stateRef = useRef({});
  const [, force] = useState(0);
  const lastRef = useRef(0);

  useEffect(() => { if (pathRef.current) setLen(pathRef.current.getTotalLength()); }, []);

  useEffect(() => {
    const st = stateRef.current;
    (model?.leeds || []).forEach((k, i) => {
      const lapSec = k.recent || k.bestClean || 30;
      const speed = 1 / lapSec;
      if (!st[k.kart]) st[k.kart] = { frac: k.lapFrac != null ? k.lapFrac : (i * 0.137) % 1, speed };
      else {
        st[k.kart].speed = speed;
        if (k.lapFrac != null) { const d = (((k.lapFrac - st[k.kart].frac) % 1) + 1) % 1; if (d > 0.12 && d < 0.88) st[k.kart].frac = k.lapFrac; }
      }
    });
    Object.keys(st).forEach((kk) => { if (!(model?.leeds || []).some((k) => k.kart === kk)) delete st[kk]; });
  }, [model]);

  useEffect(() => {
    let raf;
    const tick = (t) => {
      const dt = lastRef.current ? Math.min(0.1, (t - lastRef.current) / 1000) : 0;
      lastRef.current = t;
      const st = stateRef.current;
      Object.values(st).forEach((s) => { s.frac = (s.frac + s.speed * dt * speedMul) % 1; });
      force((n) => (n + 1) % 1000000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [speedMul]);

  const colorOf = (kart) => { const i = (teams || []).findIndex((t) => String(t.num) === String(kart)); return DRIVER_PALETTE[(i < 0 ? 0 : i) % DRIVER_PALETTE.length]; };
  const pt = (frac) => (len && pathRef.current) ? pathRef.current.getPointAtLength((((frac % 1) + 1) % 1) * len) : null;
  const karts = model?.leeds || [];

  if (!model) {
    return (
      <Panel title="TRACK MAP \u2014 TEESSIDE">
        <Empty msg={simOn ? "Waiting for data\u2026" : "No live data yet. Start Test Mode to watch the karts move, or wait for the race feed."} />
        {!simOn && <div style={{ textAlign: "center", marginTop: 12 }}>
          <button onClick={onSim} className="disp" style={{ background: "#11233a", color: "#2fd372", border: "1px solid #2fd37255", borderRadius: 8, padding: "10px 18px", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>\u25B6 START TEST MODE</button>
        </div>}
      </Panel>
    );
  }

  const sf = pt(0);
  return (
    <Panel title="TRACK MAP \u2014 TEESSIDE">
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ background: "#080d13", borderRadius: 12, padding: 10, maxWidth: 660, width: "100%", margin: "0 auto" }}>
          <svg viewBox={TRACK_VIEWBOX} style={{ width: "100%", height: "auto", display: "block" }}>
            <path ref={pathRef} d={TRACK_PATH} fill="none" stroke="#16202c" strokeWidth="13" strokeLinejoin="round" strokeLinecap="round" />
            <path d={TRACK_PATH} fill="none" stroke="#2a3a4d" strokeWidth="9" strokeLinejoin="round" strokeLinecap="round" />
            <path d={TRACK_PATH} fill="none" stroke="#3da9fc" strokeWidth="1.4" strokeDasharray="2 7" />
            {sf && <g>
              <circle cx={sf.x} cy={sf.y} r="6" fill="none" stroke="#fff" strokeWidth="2.5" />
              <text x={sf.x} y={sf.y - 11} fill="#fff" fontSize="13" fontWeight="700" fontFamily="Barlow Semi Condensed" textAnchor="middle">S/F</text>
            </g>}
            {len > 0 && karts.map((k) => { const p = pt(stateRef.current[k.kart]?.frac ?? 0); if (!p) return null; const c = colorOf(k.kart); return (
              <g key={k.kart}>
                <circle cx={p.x} cy={p.y} r="11" fill={c} stroke="#05070b" strokeWidth="2.5" />
                <text x={p.x} y={p.y + 4} fill="#05070b" fontSize="11" fontWeight="800" fontFamily="Barlow Semi Condensed" textAnchor="middle">{k.kart}</text>
              </g>
            ); })}
          </svg>
          <div className="mono" style={{ fontSize: 11, color: "#66758a", textAlign: "center", marginTop: 4 }}>
            Teesside Autodrome, clockwise from S/F. Karts move at their own pace \u2014 there's no live sector data, so position around the lap is predicted from lap times, not exact.
          </div>
        </div>

        <div>
          <Label>ON TRACK \u2014 OUR KARTS</Label>
          <div style={{ display: "grid", gap: 4 }}>
            {[...karts].sort((a, b) => (a.pos || 999) - (b.pos || 999)).map((k) => (
              <div key={k.kart} className="mono" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, background: "#080d13", borderRadius: 7, padding: "7px 10px" }}>
                <span style={{ width: 12, height: 12, borderRadius: "50%", background: colorOf(k.kart), flex: "0 0 auto" }} />
                <span style={{ color: "#fff", fontWeight: 600 }}>#{k.kart}</span>
                <span style={{ color: "#9aa8bb", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(teams.find((t) => String(t.num) === String(k.kart)) || {}).name || k.team}</span>
                <span style={{ color: AMBER }}>{k.pos ? "P" + k.pos : "\u2014"}</span>
                <span style={{ color: "#78889d" }}>{k.laps != null ? k.laps + " laps" : ""}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function PitBoard({ cfg, setCfg, raceStart, totalMin, now, liveModel, owned, pitIn, pitUndo, pitEdit }) {
  const canEdit = (num) => owned && owned.has(String(num));
  const teams = cfg.teams || [];
  const states = teams.map((t, i) => {
    const rs = teamRaceState(t, raceStart, now);
    const live = liveModel ? liveModel.leeds.find((l) => l.kart === String(t.num)) : null;
    return { team: t, idx: i, color: DRIVER_PALETTE[i % DRIVER_PALETTE.length], rs, live };
  });

  // crew clash: two of our teams due to pit within CLASH_MIN of each other
  const upcoming = states.filter((s) => s.rs.minsToPit != null && s.rs.minsToPit > 0 && s.rs.minsToPit <= 120 && !s.rs.finished);
  const clashNums = new Set();
  const clashPairs = [];
  for (let a = 0; a < upcoming.length; a++) {
    for (let b = a + 1; b < upcoming.length; b++) {
      if (Math.abs(upcoming[a].rs.minsToPit - upcoming[b].rs.minsToPit) <= CLASH_MIN) {
        clashNums.add(upcoming[a].team.num); clashNums.add(upcoming[b].team.num);
        clashPairs.push([upcoming[a], upcoming[b]]);
      }
    }
  }

  const condColor = { dry: "#2fd372", damp: "#3da9fc", wet: "#ff8a5b" };
  const pitClockOf = (s) => s.rs.nextPitMin != null ? fmtClockDay(new Date(raceStart.getTime() + s.rs.nextPitMin * 60000), raceStart) : "—";

  const logPit = (ti, atMin) => pitIn(cfg.teams[ti].num, atMin);
  const undoPit = (ti) => pitUndo(cfg.teams[ti].num);
  const setLastPit = (ti, atMin) => { const pl = cfg.teams[ti].pitLog || []; if (pl.length) pitEdit(cfg.teams[ti].num, pl[pl.length - 1].id, atMin); };
  const clockToMin = (hhmm) => { const m = String(hhmm).match(/(\d{1,2}):(\d{2})/); if (!m) return null;
    const base = raceStart.getHours() * 60 + raceStart.getMinutes(); let d = (+m[1] * 60 + +m[2]) - base; if (d < 0) d += 1440; return d; };

  return (
    <>
      {/* condition + clash banner */}
      <Panel title="PIT WALL">
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
          <div style={{ flex: 1 }} />
          {clashPairs.length > 0 && (
            <div style={{ background: "#1a0a0e", border: "1px solid #ff2d4d", borderRadius: 8, padding: "8px 12px", maxWidth: 460 }}>
              <span className="disp" style={{ color: "#ff2d4d", fontWeight: 700, fontSize: 12 }}>⚠ PIT CLASH</span>
              {clashPairs.map(([a, b], i) => (
                <div key={i} className="mono" style={{ fontSize: 11, color: "#ffb3a0", marginTop: 3 }}>
                  #{a.team.num} &amp; #{b.team.num} both due ~{pitClockOf(a)} / {pitClockOf(b)} — get both crews ready, they pit around the same time
                </div>
              ))}
            </div>
          )}
        </div>

        {/* next-pit timeline (next 2h) */}
        <div style={{ marginTop: 18 }}>
          <Label>NEXT PITS — NEXT 2 HOURS</Label>
          <div style={{ position: "relative", height: 56, marginTop: 18, borderTop: "1px solid #1e2733" }}>
            {[0, 30, 60, 90, 120].map((m) => (
              <div key={m} style={{ position: "absolute", left: `${(m / 120) * 100}%`, top: -1, height: 56 }}>
                <div style={{ width: 1, height: 8, background: "#1e2733" }} />
                <span className="mono" style={{ fontSize: 11, color: "#66758a", position: "absolute", top: 10, transform: "translateX(-50%)" }}>+{m}m</span>
              </div>
            ))}
            {upcoming.map((s) => {
              const clash = clashNums.has(s.team.num);
              return (
                <div key={s.team.num} title={`#${s.team.num} ${s.team.name} — pit ${pitClockOf(s)}`}
                  style={{ position: "absolute", left: `${Math.min(99, (s.rs.minsToPit / 120) * 100)}%`, top: 22, transform: "translateX(-50%)", textAlign: "center" }}>
                  <div style={{ width: 13, height: 13, borderRadius: "50%", background: s.color,
                    border: clash ? "2px solid #ff2d4d" : "2px solid #05070b", boxShadow: clash ? "0 0 6px #ff2d4d" : "none" }} />
                  <span className="mono" style={{ fontSize: 11, color: s.color, position: "absolute", top: 15, left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap" }}>#{s.team.num}</span>
                </div>
              );
            })}
            {upcoming.length === 0 && <span className="mono" style={{ fontSize: 11, color: "#66758a", position: "absolute", top: 20 }}>No pits scheduled in the next 2 hours.</span>}
          </div>
        </div>
      </Panel>

      {/* one card per team, in importance order */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%, 300px),1fr))", gap: 12 }}>
        {states.map((s) => {
          const { rs, live, color } = s;
          const clash = clashNums.has(s.team.num);
          const toPit = rs.minsToPit;
          const overdue = rs.started && toPit != null && toPit < 0;
          const pitC = toPit == null ? "#66758a" : overdue ? "#ff2d4d" : toPit <= 5 ? "#ff2d4d" : toPit <= 15 ? "#ff8a5b" : "#2fd372";
          const stintPct = rs.onKart && rs.stintElapsed != null ? Math.max(0, Math.min(1, rs.stintElapsed / rs.onKart.len)) : 0;
          const clockOf = (min) => fmtClockDay(new Date(raceStart.getTime() + min * 60000), raceStart);
          const projStart = (i) => { if (rs.onKartIdx < 0 || i < rs.onKartIdx) return null; let a = rs.onKartStart; for (let k = rs.onKartIdx; k < i; k++) a += rs.rows[k].len; return a; };
          const spare = totalMin - rs.projFinish;            // elapsed-min in hand to the flag
          const isFinal = rs.onKartIdx === rs.rows.length - 1 && rs.onKartIdx >= 0;
          const toFlag = totalMin - rs.nowMin;
          return (
            <div key={s.team.num} style={{ background: "#0b1017", border: `1px solid ${clash ? "#ff2d4d" : "#1b2433"}`,
              borderLeft: `4px solid ${color}`, borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span className="disp" style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>
                  <span style={{ color }}>#{s.team.num}</span> {s.team.name}
                </span>
                <span className="mono" style={{ color: AMBER, fontWeight: 700, fontSize: 16 }}>
                  {live && live.pos ? "P" + live.pos : "—"}{live && live.penalty ? <span style={{ color: "#ff2d4d", fontSize: 11 }}> ⚑</span> : null}
                </span>
              </div>

              {/* next pit hero */}
              <div style={{ marginTop: 10, background: "#080d13", borderRadius: 8, padding: "10px 12px" }}>
                {rs.rows.length === 0 ? (
                  <span className="mono" style={{ fontSize: 12, color: "#66758a" }}>No stint plan yet — set one in the planner or import the sheet.</span>
                ) : rs.finished ? (
                  <span className="disp" style={{ fontSize: 16, fontWeight: 700, color: "#2fd372" }}>FINISHED · {rs.completed} stops</span>
                ) : (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div className="disp" style={{ fontSize: 11, color: "#66758a", letterSpacing: 0.5 }}>{rs.started ? (overdue ? "PIT DUE" : "NEXT PIT") : "STARTS"}</div>
                        <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: pitC }}>
                          {pitClockOf(s)}{rs.started && toPit != null ? <span style={{ fontSize: 13, color: overdue ? "#ff2d4d" : "#9aa8bb" }}>  ({overdue ? "+" + fmtDur(-toPit) + " over" : Math.max(0, Math.ceil(toPit)) + "m"})</span> : null}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div className="disp" style={{ fontSize: 11, color: "#66758a", letterSpacing: 0.5 }}>{rs.started ? "→ IN" : "ON GRID"}</div>
                        <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>{rs.started ? (rs.incoming || "—") : (rs.currentDriver || "—")}</div>
                      </div>
                    </div>
                    {rs.incomingNote && (
                      <div className="mono" style={{ marginTop: 6, fontSize: 11, color: AMBER, background: "#1a160a", borderRadius: 5, padding: "4px 7px" }}>
                        ⚙ {rs.incomingNote}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* PIT IN — manual changeover log (only the team's own device) */}
              {rs.rows.length > 0 && !rs.finished && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  {canEdit(s.team.num) && (
                    <button onClick={() => logPit(s.idx, (Date.now() - raceStart.getTime()) / 60000)} className="disp"
                      style={{ background: "#ff2d4d", color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px",
                        fontWeight: 800, fontSize: 14, cursor: "pointer", letterSpacing: 0.5 }}>
                      ◉ PIT IN
                    </button>
                  )}
                  {canEdit(s.team.num) && rs.completed > 0 && (
                    <button onClick={() => undoPit(s.idx)} className="mono" title="undo last pit"
                      style={{ background: "none", border: "1px solid #2a3543", color: "#9aa8bb", borderRadius: 7, padding: "8px 11px", cursor: "pointer", fontSize: 12 }}>
                      ↩ undo
                    </button>
                  )}
                  {rs.lastActual != null && (
                    <span className="mono" style={{ fontSize: 11, color: "#9aa8bb" }}>
                      last: <span style={{ color: "#c2cbd6" }}>{rs.lastDriver}</span> {fmtDur(rs.lastActual)}
                      <span style={{ color: rs.lastActual <= rs.lastPlanned ? "#2fd372" : "#ff8a5b" }}> ({rs.lastActual <= rs.lastPlanned ? "-" : "+"}{fmtDur(Math.abs(rs.lastActual - rs.lastPlanned))} vs plan)</span>
                    </span>
                  )}
                </div>
              )}

              {/* projected finish / margin */}
              {rs.rows.length > 0 && !rs.finished && rs.started && (
                <div className="mono" style={{ marginTop: 8, fontSize: 11.5, color: "#9aa8bb" }}>
                  {isFinal ? (
                    <span>FINAL STINT · <span style={{ color: pitC }}>{fmtDur(Math.max(0, toFlag))} to flag</span></span>
                  ) : (
                    <span>PROJ. FINISH {clockOf(rs.projFinish)} · <span style={{ color: spare >= 0 ? "#2fd372" : "#ff8a5b" }}>{spare >= 0 ? fmtDur(spare) + " in hand" : fmtDur(-spare) + " over"}</span></span>
                  )}
                </div>
              )}

              {/* current driver + stint progress */}
              {rs.started && !rs.finished && rs.currentDriver && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }} className="mono">
                    <span style={{ color: "#9aa8bb" }}>IN KART: <span style={{ color, fontWeight: 600 }}>{rs.currentDriver}</span></span>
                    <span style={{ color: "#66758a" }}>{fmtDur(Math.max(0, rs.stintElapsed))} / {fmtDur(rs.onKart.len)}</span>
                  </div>
                  <div style={{ height: 5, borderRadius: 3, background: "#11171f", marginTop: 5, overflow: "hidden" }}>
                    <div style={{ width: `${stintPct * 100}%`, height: "100%", background: pitC }} />
                  </div>
                </div>
              )}

              {/* up next (projected, anchored to actual) */}
              {!rs.finished && rs.onKartIdx >= 0 && rs.rows.slice(rs.onKartIdx + 1, rs.onKartIdx + 3).length > 0 && (
                <div className="mono" style={{ marginTop: 10, fontSize: 11, color: "#78889d" }}>
                  UP NEXT: {rs.rows.slice(rs.onKartIdx + 1, rs.onKartIdx + 3).map((r, i) => {
                    const ps = projStart(rs.onKartIdx + 1 + i);
                    return <span key={r.id}>{i ? "  ·  " : " "}<span style={{ color: "#c2cbd6" }}>{r.driver || "—"}</span> {ps != null ? clockOf(ps) : ""}</span>;
                  })}
                </div>
              )}

              {/* stats */}
              <div className="mono" style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "11px 14px", fontSize: 12, borderTop: "1px solid #11171f", paddingTop: 10 }}>
                <Stat label="PIT STOPS" v={`${rs.plannedPitsDone}/${rs.totalPits}`} />
                <Stat label="LAPS" v={live && live.laps != null ? live.laps : "—"} />
                <Stat label="GAP" v={live && live.gap ? live.gap : "—"} />
                <Stat label="STINT PACE" v={live && live.recent != null ? fmt(live.recent) : "—"} c={live && live.recent != null && live.bestClean != null ? (live.recent <= live.bestClean * 1.03 ? "#2fd372" : "#ff8a5b") : "#e6edf3"} />
                <Stat label="BEST" v={live && live.bestClean != null ? fmt(live.bestClean) : "—"} />
                <Stat label="POS" v={live && live.pos ? "P" + live.pos : "—"} />
              </div>

              {/* pit log */}
              {rs.completed > 0 && (
                <Collapsible title={`PIT LOG (${rs.completed})`} accent="#ff2d4d">
                  <div style={{ display: "grid", gap: 3 }}>
                    {rs.rows.slice(0, rs.completed).map((r, i) => {
                      const atMin = (s.team.pitLog || [])[i]?.atMin;
                      const isLast = i === rs.completed - 1;
                      return (
                        <div key={i} className="mono" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5, padding: "2px 4px" }}>
                          <span style={{ color: "#9aa8bb" }}>{i + 1}. <span style={{ color: "#c2cbd6" }}>{r.driver}</span> out, <span style={{ color: "#c2cbd6" }}>{rs.rows[i + 1]?.driver || "—"}</span> in</span>
                          {isLast && canEdit(s.team.num) ? (
                            <input type="time" defaultValue={`${pad2(Math.floor(((atMin % 1440) + 1440) % 1440 / 60))}:${pad2(Math.round(((atMin % 60) + 60) % 60))}`}
                              onChange={(e) => { const v = clockToMin(e.target.value); if (v != null) setLastPit(s.idx, v); }}
                              style={{ background: "#11171f", border: "1px solid #2b3a4e", borderRadius: 5, color: "#e6edf3", padding: "2px 5px", fontSize: 11, fontFamily: "Barlow Semi Condensed, sans-serif" }} />
                          ) : (
                            <span style={{ color: "#66758a" }}>{atMin != null ? clockOf(atMin) : "—"}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Collapsible>
              )}

              {/* driver status */}
              {rs.rows.length > 0 && (
                <Collapsible title="DRIVER STATUS" accent={color}>
                  <div style={{ display: "grid", gap: 3 }}>
                    {[...new Set(rs.rows.map((r) => r.driver).filter(Boolean))].map((d) => {
                      const dsi = rs.rows.map((r, i) => ({ r, i })).filter((x) => x.r.driver === d);
                      const total = dsi.reduce((a, x) => a + (Number(x.r.len) || 0), 0);
                      const isOn = rs.currentDriver === d && rs.started && !rs.finished;
                      const nextOut = dsi.find((x) => x.i > rs.onKartIdx);
                      const nextMin = nextOut ? projStart(nextOut.i) : null;
                      const rest = nextMin != null && rs.started ? nextMin - rs.nowMin : null;
                      return (
                        <div key={d} className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5,
                          padding: "3px 6px", borderRadius: 5, background: isOn ? color + "18" : "transparent" }}>
                          <span style={{ color: isOn ? color : "#c2cbd6", fontWeight: isOn ? 700 : 400 }}>{isOn ? "● " : ""}{d}</span>
                          <span style={{ color: "#78889d" }}>
                            {dsi.length} stints · {fmtDur(total)}
                            {isOn ? " · IN" : nextMin != null ? ` · next ${clockOf(nextMin)}${rest != null ? ` (rest ${fmtDur(Math.max(0, rest))})` : ""}` : rs.started ? " · done" : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </Collapsible>
              )}
            </div>
          );
        })}
      </div>
      <div className="mono" style={{ fontSize: 11, color: "#66758a", marginTop: 4, lineHeight: 1.5 }}>
        Tap PIT IN the moment a driver comes in — everything below reflows off the actual time, so a short or long stint shifts the next pit and the finish margin automatically. Fix a mistap with the time field in PIT LOG, or undo. Teams are in your order of importance; the timing feed never gives pit times, so this log is the source of truth for stints.
      </div>
    </>
  );
}

function Stat({ label, v, c }) {
  return (
    <div>
      <div style={{ color: "#66758a", fontSize: 11.5, letterSpacing: 0.4, marginBottom: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
      <div style={{ color: c || "#e6edf3", fontWeight: 700, fontSize: 16 }}>{v}</div>
    </div>
  );
}

function StintTeamCard({ team, ti, raceStart, totalMin, defaultStintLen, now, started, onUpdate, owned, onUnlock }) {
  const [driverDraft, setDriverDraft] = useState("");
  const [code, setCode] = useState("");
  const [codeErr, setCodeErr] = useState("");
  const stints = team.stints || [];
  // cumulative start times
  let acc = 0;
  const rows = stints.map((s) => { const startMin = acc; acc += Number(s.len) || 0; return { ...s, startMin, endMin: acc }; });
  const scheduledMin = acc;
  const nowMin = (now - raceStart) / 60000;
  const activeIdx = started ? rows.findIndex((r) => nowMin >= r.startMin && nowMin < r.endMin) : -1;

  // per-driver totals
  const totals = {};
  rows.forEach((r) => { if (r.driver) { totals[r.driver] = totals[r.driver] || { min: 0, stints: 0 }; totals[r.driver].min += Number(r.len) || 0; totals[r.driver].stints += 1; } });
  const driverColor = {};
  team.drivers.forEach((d, i) => { driverColor[d] = DRIVER_PALETTE[i % DRIVER_PALETTE.length]; });

  const setStints = (next) => { if (owned) onUpdate({ stints: next }); };
  const generate = () => {
    if (!owned) return;
    if (!team.drivers.length) return;
    const out = []; let t = 0, i = 0;
    while (t < totalMin) { const len = Math.min(defaultStintLen, totalMin - t); out.push({ id: uid(), driver: team.drivers[i % team.drivers.length], len }); t += len; i++; }
    setStints(out);
  };
  const addDriver = () => { if (!owned) return; const d = driverDraft.trim(); if (d && !team.drivers.includes(d)) onUpdate({ drivers: [...team.drivers, d] }); setDriverDraft(""); };
  const renameDriver = (oldN) => {
    if (!owned) return;
    const nn = (typeof prompt === "function") ? prompt(`Rename "${oldN}" to:`, oldN) : null;
    if (!nn || !nn.trim() || nn.trim() === oldN) return;
    const n = nn.trim();
    onUpdate({ drivers: team.drivers.map((x) => (x === oldN ? n : x)), stints: stints.map((s) => (s.driver === oldN ? { ...s, driver: n } : s)) });
  };

  const coverWarn = Math.abs(scheduledMin - totalMin) > (defaultStintLen / 2);

  return (
    <Panel title={`#${team.num || "?"} · ${team.name.toUpperCase()}`} accent={teamColorOf(team.num)}>
      {!owned && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14, padding: "9px 11px", background: "#0b1017", border: "1px solid #2b3a4e", borderRadius: 8 }}>
          <span className="mono" style={{ fontSize: 12, color: "#9aa8bb", flex: "1 1 160px" }}>🔒 View only. Enter this team's passcode to edit the plan.</span>
          <input type="password" value={code} onChange={(e) => setCode(e.target.value)} placeholder="passcode" style={{ ...inp(140), fontFamily: "Barlow, sans-serif" }}
            onKeyDown={(e) => { if (e.key === "Enter") onUnlock(team.num, code).then((ok) => setCodeErr(ok ? "" : "Wrong passcode.")); }} />
          <button onClick={() => onUnlock(team.num, code).then((ok) => setCodeErr(ok ? "" : "Wrong passcode."))} className="disp"
            style={{ background: "#11233a", color: "#2fd372", border: "1px solid #2fd37255", borderRadius: 7, padding: "8px 13px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>UNLOCK</button>
          {codeErr && <span className="mono" style={{ fontSize: 11.5, color: "#ff8a5b" }}>{codeErr}</span>}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-end", marginBottom: 14 }}>
        <div>
          <Label>KART #</Label>
          <input value={team.num} disabled={!owned} onChange={(e) => owned && onUpdate({ num: e.target.value.replace(/\D/g, "") })} style={inp(70)} placeholder="19" />
        </div>
        <div>
          <Label>TEAM NAME</Label>
          <input value={team.name} disabled={!owned} onChange={(e) => owned && onUpdate({ name: e.target.value })} style={inp(220)} />
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={generate} className="disp"
          style={{ background: "#11233a", color: AMBER, border: `1px solid ${AMBER}55`, borderRadius: 7, padding: "7px 13px", fontWeight: 600, fontSize: 12.5, cursor: "pointer" }}>
          ↻ GENERATE ROTATION
        </button>
      </div>

      {/* drivers */}
      <Label>DRIVERS</Label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 16 }}>
        {team.drivers.map((d) => (
          <span key={d} className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12,
            background: "#0b1017", border: `1px solid ${driverColor[d]}55`, borderRadius: 6, padding: "4px 6px 4px 9px", color: driverColor[d], fontWeight: 600 }}>
            {d}
            {totals[d] && <span style={{ color: "#66758a", fontWeight: 400 }}>{fmtDur(totals[d].min)}</span>}
            <button onClick={() => renameDriver(d)} title="rename driver everywhere"
              style={{ background: "none", border: "none", color: "#78889d", cursor: "pointer", fontSize: 11, lineHeight: 1, padding: 0 }}>✎</button>
            <button onClick={() => owned && onUpdate({ drivers: team.drivers.filter((x) => x !== d), stints: stints.map((s) => s.driver === d ? { ...s, driver: "" } : s) })}
              style={{ background: "none", border: "none", color: "#ff8a5b", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}>✕</button>
          </span>
        ))}
        <input list="live24drivers" value={driverDraft} onChange={(e) => setDriverDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDriver(); } }}
          placeholder="add driver ↵" style={inp(160)} />
      </div>

      {/* coverage bar */}
      <div style={{ height: 8, borderRadius: 4, background: "#0b1017", border: "1px solid #1b2433", overflow: "hidden", display: "flex", marginBottom: 4 }}>
        {rows.map((r, i) => (
          <div key={r.id} title={`${r.driver || "unassigned"} · ${fmtDur(r.len)}`}
            style={{ width: `${(r.len / totalMin) * 100}%`, background: r.driver ? driverColor[r.driver] : "#2a3543",
              opacity: i === activeIdx ? 1 : 0.55, borderRight: "1px solid #05070b" }} />
        ))}
      </div>
      <div className="mono" style={{ fontSize: 11.5, color: coverWarn ? "#ff8a5b" : "#66758a", marginBottom: 14 }}>
        scheduled {fmtDur(scheduledMin)} / {fmtDur(totalMin)} race{coverWarn ? "  ⚠ doesn't cover the full race" : "  ✓"}
      </div>

      {/* stint list */}
      {rows.length === 0 ? (
        <div className="mono" style={{ fontSize: 12, color: "#66758a", padding: "10px 0" }}>
          No stints yet. Add drivers, then Generate Rotation, or add stints one at a time below.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          {rows.map((r, i) => {
            const startD = new Date(raceStart.getTime() + r.startMin * 60000);
            const active = i === activeIdx;
            const remain = active ? (r.endMin - nowMin) : null;
            return (
              <div key={r.id}>
              <div style={{ display: "grid", gridTemplateColumns: "26px 92px 1fr 84px 64px 30px", gap: 8, alignItems: "center",
                background: active ? "#1a0a0e" : "#080d13", border: `1px solid ${active ? "#ff2d4d" : "#11171f"}`, borderRadius: 7, padding: "6px 9px" }}>
                <span className="mono" style={{ color: "#66758a", fontSize: 11 }}>{i + 1}</span>
                <span className="mono" style={{ color: active ? "#ff2d4d" : "#c2cbd6", fontSize: 12, fontWeight: active ? 700 : 400 }}>
                  {fmtClockDay(startD, raceStart)}
                </span>
                <select value={r.driver || ""} onChange={(e) => setStints(stints.map((s) => s.id === r.id ? { ...s, driver: e.target.value } : s))}
                  className="mono" style={{ background: "#11171f", border: "1px solid #2b3a4e", borderRadius: 6,
                    color: r.driver ? (driverColor[r.driver] || "#e6edf3") : "#66758a", padding: "5px 7px", fontSize: 12.5, fontWeight: 600, width: "100%", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                  <option value="">— unassigned —</option>
                  {team.drivers.map((d) => <option key={d} value={d}>{d.length > 16 ? d.slice(0, 15) + "…" : d}</option>)}
                </select>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <input type="number" min="5" max="240" value={r.len}
                    onChange={(e) => setStints(stints.map((s) => s.id === r.id ? { ...s, len: Math.max(1, Number(e.target.value) || 0) } : s))}
                    className="mono" style={{ background: "#11171f", border: "1px solid #2b3a4e", borderRadius: 6, color: "#e6edf3", padding: "5px 6px", fontSize: 12, width: 56 }} />
                  <span className="mono" style={{ color: "#66758a", fontSize: 10 }}>min</span>
                </div>
                <span className="mono" style={{ fontSize: 11, color: active ? "#ff8a5b" : "#66758a", textAlign: "right" }}>
                  {active ? `${Math.max(0, Math.ceil(remain))}m left` : ""}
                </span>
                <button onClick={() => setStints(stints.filter((s) => s.id !== r.id))} className="mono"
                  style={{ background: "none", border: "none", color: "#ff6b6b", cursor: "pointer", fontSize: 13, padding: 0 }}>✕</button>
              </div>
              {r.note && <div className="mono" style={{ fontSize: 11.5, color: "#8b7a4a", padding: "2px 9px 0 36px" }}>⚙ {r.note}</div>}
              </div>
            );
          })}
        </div>
      )}
      <button onClick={() => setStints([...stints, { id: uid(), driver: team.drivers[0] || "", len: defaultStintLen }])}
        className="mono" style={{ marginTop: 8, background: "none", border: "1px dashed #2a3543", color: "#9aa8bb",
          borderRadius: 7, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>
        + add stint
      </button>
    </Panel>
  );
}

/* ---------- stats table ---------- */
function StatsTable({ boxes, fieldMed }) {
  const [sort, setSort] = useState({ key: "avg", dir: "asc" });
  if (!boxes || !boxes.length) return null;

  const clickSort = (key) => {
    if (!key) return;
    setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));
  };

  const ranked = [...boxes].sort((a, b) => {
    const m = sort.dir === "asc" ? 1 : -1;
    const k = sort.key;
    if (k === "label") return m * String(a.label).localeCompare(String(b.label));
    
    // push nulls to the bottom regardless of sort direction
    if (a[k] == null && b[k] == null) return 0;
    if (a[k] == null) return 1;
    if (b[k] == null) return -1;
    
    return m * (a[k] - b[k]);
  });

  const cols = [
    ["DRIVER/TEAM", "label"],
    ["BEST LAP", "best"],
    ["CLEAN AVG", "avg"],
    ["CONSISTENCY", "cons"],
    ["INCIDENTS", "inc"],
    ["VS FIELD", "gap"] // gap uses "avg" for the actual math logic
  ];

  return (
    <div style={{ marginTop: 12, overflowX: "auto" }}>
      <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ color: "#78889d", textAlign: "right" }}>
            {cols.map(([h, key], i) => {
              const activeKey = key === "gap" ? "avg" : key;
              const isActive = sort.key === activeKey;
              return (
                <th key={h} onClick={() => clickSort(activeKey)} 
                  style={{ padding: "6px 10px", textAlign: i === 0 ? "left" : "right",
                    borderBottom: "1px solid #1e2733", fontWeight: 500, cursor: "pointer", 
                    color: isActive ? AMBER : "#78889d", userSelect: "none" }}>
                  {h}{isActive ? (sort.dir === "desc" ? " ▾" : " ▴") : ""}
                </th>
              );
            })}
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
                <td style={{ padding: "6px 10px", textAlign: "right", color: gap == null ? "#66758a" : gap <= 0 ? "#2fd372" : "#ff2d4d" }}>
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
const inp = (w) => ({ background: "#11171f", border: "1px solid #2b3a4e", borderRadius: 6,
  color: "#e6edf3", padding: "5px 8px", fontSize: 12.5, width: "100%", maxWidth: w, fontFamily: "Barlow Semi Condensed, sans-serif" });
const Label = ({ children }) => (
  <div className="disp" style={{ fontSize: 12.5, color: "#9aa8bb", letterSpacing: "1px",
    fontWeight: 600, marginBottom: 9, textTransform: "uppercase" }}>{children}</div>
);
function Panel({ title, children, accent }) {
  const a = accent || AMBER;
  return (
    <div style={{ background: "#0a0f16", border: "1px solid #1b2433", borderLeft: accent ? `3px solid ${a}` : "1px solid #1b2433", borderRadius: 12, padding: 18, marginBottom: 16 }}>
      <div className="disp" style={{ fontSize: 13, color: a, letterSpacing: "1.5px",
        fontWeight: 600, marginBottom: 14 }}>{title}</div>
      {children}
    </div>
  );
}

function Collapsible({ title, subtitle, defaultOpen = false, accent = AMBER, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: "1px solid #1b2433", borderRadius: 10, marginBottom: 10,
      overflow: "hidden", background: "#0b1017" }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "11px 14px",
          background: open ? "#0d141c" : "none", border: "none", cursor: "pointer", textAlign: "left" }}>
        <span className="disp" style={{ color: accent, fontWeight: 700, fontSize: 13,
          display: "inline-block", transition: "transform .15s", transform: open ? "rotate(90deg)" : "none" }}>▸</span>
        <span className="disp" style={{ color: "#e6edf3", fontWeight: 600, fontSize: 14,
          letterSpacing: "0.5px", flex: 1 }}>{title}</span>
        {subtitle && <span className="mono" style={{ color: "#66758a", fontSize: 11 }}>{subtitle}</span>}
      </button>
      {open && <div style={{ padding: "6px 14px 16px" }}>{children}</div>}
    </div>
  );
}