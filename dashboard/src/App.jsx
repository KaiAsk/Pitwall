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

/* display-only: tidy an over-grabbed session label for grouping/headers. */
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
            <text x={padL - 12} y={y(tv) + 4} textAnchor="end" fill="#64748b" fontSize="11" fontFamily="IBM Plex Mono">{tv.toFixed(1)}s</text>
          </g>
        ))}
        {fieldMedian != null && y(fieldMedian) >= padT && y(fieldMedian) <= H - padB && (
          <g>
            <line x1={padL} x2={W - padR} y1={y(fieldMedian)} y2={y(fieldMedian)} stroke={AMBER} strokeWidth="2" strokeDasharray="6 4" opacity="0.9" />
            <text x={W - padR - 6} y={y(fieldMedian) - 8} textAnchor="end" fill={AMBER} fontSize="11" fontWeight="600" fontFamily="IBM Plex Mono">FIELD MEDIAN {fieldMedian.toFixed(3)}s</text>
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
  <div style={{ padding: "48px 20px", textAlign: "center", color: "#5b6776", fontSize: 14 }}>{msg}</div>
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
      penalties: (s.penalties || []).filter((p) => isOurTeam(p.team, extraTeams) || extraNums.includes(String(p.kart || ""))),
      posByKart: Object.fromEntries((s.results || []).map((r) => [String(r.kart), Number(r.position_change) || 0])),
      finByKart: Object.fromEntries((s.results || []).map((r) => [String(r.kart), Number(r.position) || null])),
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
  const [extraList, setExtraList] = useState(() => LS("extra", []));
  const [extraDraft, setExtraDraft] = useState("");
  const [compareIds, setCompareIds] = useState(() => LS("compareIds", []));
  const [compareCache, setCompareCache] = useState({});
  const [seasonRaws, setSeasonRaws] = useState({});
  const [removed, setRemoved] = useState(() => new Set(LS("removed", [])));
  const [compareOpen, setCompareOpen] = useState(false);
  const [wetSessions, setWetSessions] = useState(() => new Set(LS("wet", [])));

  // pull shared network states on mount
  useEffect(() => {
    fetch("/api/roster").then((r) => r.json())
      .then((d) => { 
        if (d && d.roster && Object.keys(d.roster).length) setAssign((prev) => ({ ...prev, ...d.roster }));
        if (d && d.wetSessions && Array.isArray(d.wetSessions)) setWetSessions(new Set(d.wetSessions));
        if (d && d.extraList && Array.isArray(d.extraList)) setExtraList(d.extraList);
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
          adminPassword: adminPw 
        }) 
      });
      const d = await res.json();
      setSyncMsg(res.ok && d.ok ? `✓ Synced global roster, weather toggles, and extra entries.` : (d.error || "Sync failed."));
    } catch { setSyncMsg("Couldn't reach sync server (only works live)."); }
    setSyncing(false);
  };

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
      .catch(() => { setEventIndex([]); setLoadError("No index.json found."); });
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
    const tokens = extraList.map((t) => t.trim()).filter(Boolean);
    return { extraTeams: tokens.filter((t) => !/^\d+$/.test(t)), extraNums: tokens.filter((t) => /^\d+$/.test(t)) };
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
          sid: s.id, session: s, num: k.num, teamLetter, teamName: k.teamName, key: `${s.id}|${k.num}`,
        });
      });
    });
    return rows;
  }, [convertedSessions]);

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
      if (!/race/i.test(e.session.raceLabel) || /quali/i.test(e.session.raceLabel)) return;
      const raceName = e.session.raceLabel;
      if (!groups[raceName]) groups[raceName] = [];
      const { clean, incidents } = kartLaps(e.session, e.num, e.teamName);
      const driver = assign[e.key]?.trim();
      if (clean.length || incidents.length) {
        groups[raceName].push({
          ...e, clean, incidents, color: colorOf(e.key), label: driver || `${e.teamName}`, sub: `#${e.num}`,
          best: clean.length ? Math.min(...clean) : null, avg: mean(clean), cons: sd(clean), inc: incidents.length,
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
          ...e, clean: [], incidents: [], label: trackableIdentity, sub: assignedDriverName ? `Leeds ${e.teamLetter} Overall` : "Stint pooled"
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
          ...db, color: namedDriver ? (driverColorMap[namedDriver] || "#fff") : (TEAM_COLORS[db.teamLetter] || "#8b97a7"),
          best: db.clean.length ? Math.min(...db.clean) : null, avg: mean(db.clean), cons: sd(db.clean), inc: db.incidents.length,
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
      }).filter((x) => x != null).sort((a, b) => a - b);
      const fieldMedFast = quantile(fieldFastest, 0.5);
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
      if (!s.isRound) return;
      const isQuali = /quali/i.test(s.raceLabel);
      const isRace = /race/i.test(s.raceLabel) && !isQuali;
      if (!isQuali && !isRace) return;
      const bests = (s.allKarts || []).map((k) => s.sectorsByKart && s.sectorsByKart[k.num] && s.sectorsByKart[k.num].best).filter((x) => x != null);
      const fastest = bests.length ? Math.min(...bests) : null;
      s.karts.forEach((k) => {
        const key = `${s.id}|${k.num}`;
        if (removed.has(key)) return;
        const name = assign[key]?.trim();
        if (!name) return;
        const a = agg[name] || (agg[name] = { name, qPos: [], qGap: [], rGap: [], penPos: 0, pens: 0 });
        const best = s.sectorsByKart && s.sectorsByKart[k.num] ? s.sectorsByKart[k.num].best : null;
        const gap = (best != null && fastest != null) ? best - fastest : null;
        if (isQuali) {
          if (s.finByKart && s.finByKart[k.num] != null) a.qPos.push(s.finByKart[k.num]);
          if (gap != null) a.qGap.push(gap);
        } else if (gap != null) a.rGap.push(gap);
        (s.penalties || []).filter((p) => String(p.kart) === k.num).forEach((p) => {
          a.pens += 1;
          const m = String(p.penalty || "").match(/(\d+)\s*grid/i);
          if (m) a.penPos += Number(m[1]);
        });
      });
    });
    const avg = (x) => (x.length ? x.reduce((p, c) => p + c, 0) / x.length : null);
    return Object.values(agg).map((d) => ({ name: d.name, avgQpos: avg(d.qPos), avgQgap: avg(d.qGap), avgRgap: avg(d.rGap), penPos: d.penPos, pens: d.pens }))
      .sort((a, b) => (a.avgQpos ?? 99) - (b.avgQpos ?? 99));
  }, [seasonSessions, assign, removed]);

  const signedOverview = !!scrapedEventData && (scrapedEventData.sessions || []).some((s) => (s.results || []).some((r) => (r.position_change || 0) < 0));

  /* ---------- Driver rating /10 from pace, consistency, and racecraft ---------- */
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

      report.rows.forEach((r) => {
        if (!r.isLeeds) return;
        const name = assign[`${s.id}|${r.num}`]?.trim();
        if (!name) return;
        
        const ls = s.laps.map((l) => l.times[r.num]).filter((x) => x != null);
        const clean = splitClean(ls).clean;
        const cavg = mean(clean), csd = clean.length > 1 ? sd(clean) : 0;
        const cv = cavg ? (csd / cavg) * 100 : 5;
        const isWet = wetSessions.has(s.id);
        
        agg[name] = agg[name] || { name, team: r.teamLetter, pace: [], cons: [], race: [], gain: [], wet: [], decaySlopes: [], races: 0 };
        
        // Linear regression stint degradation slope calculation
        if (clean.length > 5) {
          let sx = 0, sy = 0, sxy = 0, sxx = 0;
          clean.forEach((t, i) => { const lapIdx = i + 1; sx += lapIdx; sy += t; sxy += lapIdx * t; sxx += lapIdx * lapIdx; });
          const slope = (clean.length * sxy - sx * sy) / (clean.length * sxx - sx * sx);
          if (slope > 0) agg[name].decaySlopes.push(slope);
        }

        if (isWet) {
          const sessionFieldMed = fieldStats(s).median;
          if (sessionFieldMed && cavg) agg[name].wet.push(cavg - sessionFieldMed);
        } else {
          const baseline = roundBaselines[s.round];
          const pacePct = (baseline && cavg) ? (cavg / baseline - 1) * 100 : null;
          let calculatedPaceScore = pacePct != null ? clamp(6 - pacePct * paceScale) : clamp(5 - (r.z ?? 0) * 2.5);
          
          // Split-Class Anomaly protections
          if (s.category === "Mains" && calculatedPaceScore < 6.5 && csd < 0.12) {
            calculatedPaceScore = Math.max(calculatedPaceScore, 7.8); // Chassis Deficit protection
          }
          if (s.category === "Inters" && s.sectorsByKart && s.sectorsByKart[r.num]) {
            const qBest = s.sectorsByKart[r.num].best;
            if (qBest && cavg && (cavg - qBest) > 1.2 && csd < 0.15) {
              calculatedPaceScore = Math.max(calculatedPaceScore, 8.0); // Horsepower mismatch validation protection
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
          else if (start <= 3 && fin <= 3) sc = 9.5; // Unbiased podium retention
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
      const cons = d.cons.length ? clamp(avg(d.cons) - (decayIndex * 35)) : 0; // apply stint decay slope modifier directly onto consistency metric
      
      const hasPace = d.pace.length > 0, hasRace = d.race.length > 0, hasCons = d.cons.length > 0;
      let tot = 0, w = 0;
      if (hasPace) { tot += pace * 0.65; w += 0.65; }
      if (hasRace) { tot += race * 0.20; w += 0.20; }
      if (hasCons) { tot += cons * 0.15; w += 0.15; }
      
      // If round is completely wet, gracefully switch to 100% racecraft weight metric logic fallback
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
        ? `Imported ${filled} names from ${rows.length} rows.`
        : `Read ${rows.length} rows but matched none.`);
    } catch (e) { setImportMsg(`Error: ${e.message}`); }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#07090d", color: "#e6edf3", zoom: 1.18, fontFamily: "IBM Plex Sans, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
        html, body, #root { margin: 0 !important; padding: 0 !important; max-width: none !important; width: 100% !important; display: block !important; place-items: initial !important; text-align: left !important; background: #07090d; }
        * { box-sizing: border-box; }
        .mono { font-family: 'IBM Plex Mono', monospace; }
        .disp { font-family: 'Archivo', sans-serif; letter-spacing: 0.2px; }
        ::-webkit-scrollbar { height: 8px; width: 8px; }
        ::-webkit-scrollbar-thumb { background:#1e2733; border-radius: 4px; }
        .appwrap { padding: 24px 28px; max-width: 1380px; margin: 0 auto; }
        .apphead { padding: 16px 28px; max-width: 1380px; margin: 0 auto; display: flex; alignItems: center; gap: 16px; background: linear-gradient(180deg,#0b0f15,#07090d); border-bottom: 1px solid #161d27; }
      `}</style>

      {/* header */}
      <div className="apphead">
        <div style={{ width: 10, height: 30, background: AMBER, borderRadius: 2 }} />
        <div style={{ flex: 1 }}>
          <div className="disp" style={{ fontSize: 23, fontWeight: 700, lineHeight: 1 }}>
            LEEDS MOTORSPORT <span style={{ color: AMBER }}>· TELEMETRY</span>
          </div>
          <div className="mono" style={{ fontSize: 11, color: loadError ? "#ff8a5b" : "#6b7685", marginTop: 4 }}>
            {scrapedEventData?.title ? scrapedEventData.title.toUpperCase() : (loadError || "BUKC PIPELINE ENGINE")}
          </div>
        </div>
        
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#0d141c", border: "1px solid #222c38", padding: "5px 10px", borderRadius: 8 }}>
          <span className="disp" style={{ fontSize: 11.5, color: "#6b7685", fontWeight: 600 }}>ROUND:</span>
          <select className="mono" value={activeEventId || ""} onChange={(e) => setActiveEventId(e.target.value)}
            style={{ background: "#11171f", border: "1px solid #222c38", borderRadius: 6, color: "#e6edf3", padding: "5px 8px", fontSize: 12.5, minWidth: 180, cursor: "pointer" }}>
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
              style={{ display: "flex", alignItems: "center", gap: 8, background: "#0d141c", border: `1px solid ${compareIds.length ? AMBER : "#222c38"}`, padding: "6px 12px", borderRadius: 8, cursor: "pointer", color: compareIds.length ? AMBER : "#8b97a7", fontSize: 12, fontWeight: 600 }}>
              + COMPARE{compareIds.length ? ` (${compareIds.length})` : ""} ▾
            </button>
            {compareOpen && (
              <div style={{ position: "absolute", top: "112%", left: 0, zIndex: 50, background: "#0d141c", border: "1px solid #222c38", borderRadius: 8, padding: 10, minWidth: 210, maxHeight: 300, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
                {["Mains", "Inters"].filter((cat) => eventIndex.some((e) => e.category === cat && e.id !== activeEventId)).map((cat) => (
                  <div key={cat} style={{ marginBottom: 8 }}>
                    <div className="mono" style={{ fontSize: 10, color: "#5b6776", marginBottom: 4 }}>{cat.toUpperCase()}</div>
                    {eventIndex.filter((e) => e.category === cat && e.id !== activeEventId).sort((a, b) => a.round - b.round).map((e) => {
                      const on = compareIds.includes(e.id);
                      return (
                        <label key={e.id} className="mono" style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 12, color: on ? AMBER : "#c2cbd6", cursor: "pointer" }}>
                          <input type="checkbox" checked={on} onChange={() => setCompareIds((p) => on ? p.filter((x) => x !== e.id) : [...p, e.id])} />
                          {e.category} Round {e.round === 999 ? "?" : e.round}
                        </label>
                      );
                    })}
                  </div>
                ))}
                {compareIds.length > 0 && ( <button onClick={() => setCompareIds([])} className="mono" style={{ marginTop: 2, fontSize: 11, color: "#ff8a5b", background: "none", border: "none", cursor: "pointer", padding: 0 }}>clear all</button> )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="appwrap">
        {/* PANEL 1: ROSTER */}
        {allEntries.length > 0 && (
          <Panel title="01 · ROSTER ASSIGNMENT">
            <div style={{ marginBottom: 14 }}>
              <Label>EXTRA ENTRIES <span style={{ color: "#5b6776" }}>(paid seats under another uni)</span></Label>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <input value={extraDraft} onChange={(e) => setExtraDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addExtra(); } }} placeholder="e.g. Lancaster B  ↵" style={{ ...inp(220) }} />
                {extraList.map((t) => (
                  <span key={t} className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, background: "#11233a", border: "1px solid #3da9fc55", borderRadius: 6, padding: "4px 6px 4px 9px", color: "#cfe3ff" }}>
                    {t} <button onClick={() => setExtraList((p) => p.filter((x) => x !== t))} style={{ background: "none", border: "none", color: "#ff8a5b", cursor: "pointer", fontSize: 13, padding: 0 }}>✕</button>
                  </span>
                ))}
              </div>
            </div>
            <Label>TEAM LINEUPS</Label>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
              <button onClick={() => csvRef.current?.click()} className="disp" style={{ background: "#11233a", color: AMBER, border: `1px solid ${AMBER}55`, borderRadius: 7, padding: "7px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>⬆ IMPORT LINEUP CSV</button>
              <input ref={csvRef} type="file" accept=".csv,.txt" hidden onChange={(ev) => onLineupCsv(ev.target.files?.[0])} />
              {importMsg && <span className="mono" style={{ fontSize: 11.5, color: "#43d977" }}>{importMsg}</span>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
              <input type="password" value={adminPw} onChange={(e) => setAdminPw(e.target.value)} placeholder="admin password" style={{ ...inp(150), fontFamily: "IBM Plex Sans" }} />
              <button onClick={syncRoster} disabled={syncing} className="disp" style={{ background: "#11233a", color: "#3da9fc", border: "1px solid #3da9fc55", borderRadius: 7, padding: "7px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>{syncing ? "SYNCING…" : "💾 SYNC GLOBAL ROSTER"}</button>
              {syncMsg && <span className="mono" style={{ fontSize: 11.5, color: syncMsg.startsWith("✓") ? "#43d977" : "#ff8a5b" }}>{syncMsg}</span>}
            </div>
            <datalist id="driverNames">
              {[...new Set(Object.values(assign).map((v) => v && v.trim()).filter(Boolean))].map((n) => <option key={n} value={n} />)}
            </datalist>
            {Object.entries( allEntries.reduce((acc, e) => { const g = `${e.session.round}||${e.teamName}`; (acc[g] = acc[g] || []).push(e); return acc; }, {}) ).sort(([a], [b]) => a.localeCompare(b)).map(([groupKey, teamEntries]) => {
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
                <Collapsible key={groupKey} accent={col} title={`${roundName} · ${teamName}`} subtitle={`#${teamEntries[0].num} · ${named}/${drivers.length} named`}>
                  <button onClick={() => setRemoved((p) => { const n = new Set(p); const allRem = teamEntries.every((e) => p.has(e.key)); teamEntries.forEach((e) => allRem ? n.delete(e.key) : n.add(e.key)); return n; })} className="mono" style={{ marginBottom: 8, fontSize: 10.5, cursor: "pointer", background: "none", border: "1px solid #3a2530", borderRadius: 5, padding: "3px 9px", color: "#ff8a5b" }}>Toggle Active State</button>
                  <div style={{ display: "grid", gap: 6 }}>
                    {drivers.map((d, di) => (
                      <div key={di} style={{ display: "flex", alignItems: "center", gap: 10, background: "#080d13", borderRadius: 7, padding: "6px 10px", borderLeft: `3px solid ${col}` }}>
                        <span className="disp" style={{ color: col, fontWeight: 700, width: 64 }}>{d.label}</span>
                        <input list="driverNames" placeholder="driver name…" value={assign[d.rows[0].key] || ""} onChange={(ev) => { const v = ev.target.value; setAssign((p) => { const n = { ...p }; d.rows.forEach((r) => { n[r.key] = v; }); return n; }); }} style={{ ...inp(180), flex: 1 }} />
                      </div>
                    ))}
                  </div>
                </Collapsible>
              );
            })}
          </Panel>
        )}

        {/* TAB MATRIX CONTROL PANELS */}
        {hasData && (
          <>
            <div className="apptabs" style={{ display: "flex", gap: 8, margin: "20px 0 16px", flexWrap: "wrap", alignItems: "center" }}>
              {[
                ["scraped", "LIVE EVENT OVERVIEW"], ["summary", "SUMMARY"], ["field", "FIELD COMPARISON"], 
                ["trace", "LAP TRACES"], ["prog", "PROGRESSION"], ["report", "DRIVER REPORT"],
                ["rating", "DRIVER RATING"], ["debrief", "AI DEBRIEF"], ["stats", "STATS"],
                ["special", "SPECIAL EVENTS"], ["sectors", "SECTORS"]
              ].map(([k, l]) => (
                <button key={k} onClick={() => setTab(k)} className="disp" style={{ padding: "8px 16px", borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: "pointer", border: "1px solid", borderColor: tab === k ? AMBER : "#222c38", background: tab === k ? "#1a160a" : "#0b1017", color: tab === k ? AMBER : "#8b97a7" }}>{l}</button>
              ))}
            </div>

            {/* TAB: EVENT OVERVIEW (F1 Race Priority Sorting Layout Active) */}
            {tab === "scraped" && (
              <Panel title={`EVENT METRICS — ${scrapedEventData.title.toUpperCase()}`}>
                <div style={{ display: "grid", gap: 24 }}>
                  {leedsOverallStandings.length > 0 && (
                    <div style={{ background: "linear-gradient(135deg, #0f172a, #0b1017)", borderRadius: 10, padding: "16px", border: "1px solid #334155" }}>
                      <div className="disp" style={{ color: AMBER, fontSize: 15, fontWeight: 700, marginBottom: 10 }}>🏆 OVERALL CHAMPIONSHIP ROUND STANDINGS</div>
                      <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ color: "#6b7685", textAlign: "left" }}>
                            <th style={{ padding: "6px 8px" }}>POS</th><th style={{ padding: "6px 8px" }}>TEAM</th><th style={{ padding: "6px 8px" }}>KART</th><th style={{ padding: "6px 8px" }}>POINTS</th>
                          </tr>
                        </thead>
                        <tbody>
                          {leedsOverallStandings.map((row, idx) => (
                            <tr key={idx} style={{ borderBottom: "1px solid #1e2733" }}>
                              <td style={{ padding: "8px", color: AMBER, fontWeight: "700" }}>{row.position}</td>
                              <td style={{ padding: "8px", color: "#fff", fontWeight: "600" }}>{row.team}</td>
                              <td style={{ padding: "8px", color: "#6b7685" }}>#{row.kart || "—"}</td>
                              <td style={{ padding: "8px", color: "#43d977", fontWeight: "700" }}>{row.total_points || "—"} pts</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {[...scrapedEventData.sessions].sort((a, b) => {
                    // Sorting absolute priorities: Race (0) -> Quali (1) -> Practice (2)
                    const rank = (s) => { const l = (s.label || s.title || "").toLowerCase(); return /quali/.test(l) ? 1 : /practice/.test(l) ? 2 : 0; };
                    return rank(a) - rank(b);
                  }).map((session) => {
                    const leedsSessionRows = session.results.filter(row => row.team && row.team.toLowerCase().includes("leeds") && !row.team.toLowerCase().includes("beckett"));
                    if (leedsSessionRows.length === 0) return null;
                    const sid = `scraped__${session.session_id}`;
                    const wet = wetSessions.has(sid);
                    return (
                      <div key={session.session_id} style={{ background: "#0b1017", borderRadius: 10, padding: "18px", border: "1px solid #161d27" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                          <div className="disp" style={{ color: AMBER, fontSize: 14.5, fontWeight: 700 }}>🏁 {session.label.toUpperCase()}</div>
                          <button onClick={() => setWetSessions((p) => { const n = new Set(p); wet ? n.delete(sid) : n.add(sid); return n; })} style={{ cursor: "pointer", borderRadius: 5, padding: "3px 8px", fontSize: 10.5, border: `1px solid ${wet ? "#3da9fc" : "#2a3543"}`, background: wet ? "#0b2030" : "#0b1017", color: wet ? "#3da9fc" : "#5b6776" }}>{wet ? "🌧 WET" : "DRY"}</button>
                        </div>
                        <table className="mono" style={{ width: "100%", fontSize: 12.5 }}>
                          <thead>
                            <tr style={{ color: "#6b7685", textAlign: "left" }}>
                              <th>POS</th>{signedOverview && <th>+/-</th>}<th>TEAM</th><th>KART</th><th>BEST LAP</th><th>POINTS</th>
                            </tr>
                          </thead>
                          <tbody>
                            {leedsSessionRows.map((row, rIdx) => (
                              <tr key={rIdx} style={{ borderBottom: "1px solid #11171f" }}>
                                <td style={{ padding: "6px 0", color: AMBER, fontWeight: 700 }}>{row.position || "—"}</td>
                                {signedOverview && <td style={{ color: row.position_change > 0 ? "#43d977" : row.position_change < 0 ? "#ff3355" : "#4b5563" }}>{row.position_change}</td>}
                                <td style={{ color: "#fff", fontWeight: 600 }}>{row.team}</td>
                                <td style={{ color: "#6b7685" }}>#{row.kart}</td>
                                <td>{row.best_lap_time}s</td>
                                <td style={{ color: "#43d977" }}>{row.points || "0"} pts</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>
              </Panel>
            )}

            {/* TAB: ARION'S CRITICAL SUMMARY LOGS */}
            {tab === "summary" && (
              <Panel title="SUMMARY — QUALIFYING, PACE GAP & PENALTIES (WHOLE SEASON)">
                {arionSummary.length === 0 ? <Empty msg="Name drivers to build logs summary." /> : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="mono" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                      <thead>
                        <tr style={{ color: "#6b7685" }}>
                          <th style={{ textAlign: "left", padding: "6px 10px" }}>#</th>
                          <th style={{ textAlign: "left", padding: "6px 10px" }}>DRIVER</th>
                          <th style={{ textAlign: "right", padding: "6px 10px" }}>AVG QUALI POS</th>
                          <th style={{ textAlign: "right", padding: "6px 10px" }}>QUALI GAP</th>
                          <th style={{ textAlign: "right", padding: "6px 10px" }}>RACE GAP</th>
                          <th style={{ textAlign: "right", padding: "6px 10px" }}>POS LOST (PENALTY)</th>
                          <th style={{ textAlign: "right", padding: "6px 10px" }}>PENALTIES</th>
                        </tr>
                      </thead>
                      <tbody>
                        {arionSummary.map((d, i) => (
                          <tr key={d.name} style={{ borderBottom: "1px solid #11171f" }}>
                            <td style={{ padding: "7px 10px", color: "#5b6776" }}>{i + 1}</td>
                            <td style={{ padding: "7px 10px", color: "#e6edf3", fontWeight: 600 }}>{d.name}</td>
                            <td style={{ padding: "7px 10px", textAlign: "right", color: AMBER }}>{d.avgQpos != null ? "P" + d.avgQpos.toFixed(1) : "—"}</td>
                            <td style={{ padding: "7px 10px", textAlign: "right" }}>{d.avgQgap != null ? "+" + d.avgQgap.toFixed(3) + "s" : "—"}</td>
                            <td style={{ padding: "7px 10px", textAlign: "right" }}>{d.avgRgap != null ? "+" + d.avgRgap.toFixed(3) + "s" : "—"}</td>
                            <td style={{ padding: "7px 10px", textAlign: "right", color: d.penPos > 0 ? "#ff8a5b" : "#5b6776" }}>{d.penPos > 0 ? "-" + d.penPos : "0"}</td>
                            <td style={{ padding: "7px 10px", textAlign: "right", color: d.pens > 0 ? "#ff6b6b" : "#5b6776" }}>{d.pens}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            )}

            {/* TAB: FIELD COMPARISONS */}
            {tab === "field" && (
              <Panel title="RACE PACE — DISTRIBUTION AND HEATS SUMMARY">
                {Object.entries(fieldComparisonGroups).sort(([a], [b]) => (b.includes("SUMMARY") ? 1 : 0) - (a.includes("SUMMARY") ? 1 : 0)).map(([groupName, groupBoxes]) => {
                  const isSummary = groupName.includes("SUMMARY");
                  return (
                    <Collapsible key={groupName} defaultOpen={isSummary} accent={isSummary ? AMBER : "#8b97a7"} title={`${isSummary ? "🏆" : "📊"} ${tidyLabel(groupName)}`} subtitle={`${groupBoxes.length} drivers`}>
                      <BoxPlot boxes={groupBoxes} fieldMedian={cleanOnly ? fieldMed : null} />
                      <StatsTable boxes={groupBoxes} fieldMed={fieldMed} />
                    </Collapsible>
                  );
                })}
              </Panel>
            )}

            {/* TAB: LAP TRACES */}
            {tab === "trace" && (
              <Panel title="LAP-BY-LAP TRACE">
                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  {["all", "race", "quali", "practice"].map((k) => ( <button key={k} onClick={() => setTraceType(k)} style={{ padding: "6px 14px", border: `1px solid ${traceType === k ? AMBER : "#222c38"}`, background: traceType === k ? "#1a160a" : "#0b1017", color: traceType === k ? AMBER : "#8b97a7" }}>{k.toUpperCase()}</button> ))}
                </div>
                <ResponsiveContainer width="100%" height={400}>
                  <LineChart data={traceData}>
                    <CartesianGrid stroke="#161d27" />
                    <XAxis dataKey="lap" stroke="#5b6776" />
                    <YAxis stroke="#5b6776" domain={["dataMin - 0.5", "dataMax + 0.5"]} width={52} />
                    <Tooltip contentStyle={{ background: "#0d141c" }} />
                    {entries.filter((e) => activeTrace.includes(e.key)).map((e) => ( <Line key={e.key} dataKey={e.key} name={assign[e.key] || e.teamName} stroke={colorOf(e.key)} dot={{ r: 2 }} connectNulls isAnimationActive={false} /> ))}
                  </LineChart>
                </ResponsiveContainer>
              </Panel>
            )}

            {/* TAB: PROGRESSION */}
            {tab === "prog" && (
              <Panel title="DRIVER PROGRESSION">
                <ResponsiveContainer width="100%" height={380}>
                  <LineChart data={progression.data}>
                    <CartesianGrid stroke="#161d27" />
                    <XAxis dataKey="round" stroke="#5b6776" />
                    <YAxis stroke="#5b6776" width={52} />
                    <Tooltip contentStyle={{ background: "#0d141c" }} />
                    {progression.drivers.map((d, di) => ( <Line key={d.driver} dataKey={d.driver} stroke={DRIVER_PALETTE[di % DRIVER_PALETTE.length]} dot={{ r: 3 }} connectNulls isAnimationActive={false} /> ))}
                  </LineChart>
                </ResponsiveContainer>
              </Panel>
            )}

            {/* TAB: DRIVER REPORT */}
            {tab === "report" && (() => {
              const races = convertedSessions.filter((s) => s.laps.length && !/practice/i.test(s.raceLabel));
              const rep = races.find((s) => s.id === reportSession) || races[0];
              if (!rep) return <Panel title="DRIVER REPORT"><Empty msg="No data loaded." /></Panel>;
              return (
                <Panel title="DRIVER REPORT — STATISTICS MATRIX">
                  <select value={rep.id} onChange={(e) => setReportSession(e.target.value)} style={{ ...inp(280), marginBottom: 16 }}>{races.map((s) => <option key={s.id} value={s.id}>{tidyLabel(s.raceLabel)}</option>)}</select>
                  <ReportTable report={driverReport(rep, extraTeams, extraNums, removed)} nameOf={(num) => assign[`${rep.id}|${num}`]} />
                </Panel>
              );
            })()}

            {/* TAB: INTERACTIVE DRIVER RATINGS */}
            {tab === "rating" && (
              <Panel title="DRIVER RATINGS LEADERBOARD">
                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  {["round", "season"].map((k) => ( <button key={k} onClick={() => setRatingScope(k)} style={{ padding: "6px 14px", border: `1px solid ${ratingScope === k ? AMBER : "#222c38"}`, background: ratingScope === k ? "#1a160a" : "#0b1017", color: ratingScope === k ? AMBER : "#8b97a7" }}>{k === "round" ? "THIS ROUND" : "WHOLE SEASON"}</button> ))}
                </div>
                <table className="mono" style={{ width: "100%" }}>
                  <thead>
                    <tr style={{ color: "#6b7685" }}>
                      {/* Active column buttons sorting hooks */}
                      { [["#", null], ["DRIVER", "name"], ["RACES", "races"], ["PACE", "pace"], ["CONSISTENCY", "cons"], ["RACECRAFT", "race"], ["RATING", "overall"] ].map(([h, k]) => (
                        <th key={h} onClick={() => k && setRatingSort((s) => ({ key: k, dir: s.key === k && s.dir === "desc" ? "asc" : "desc" }))} style={{ cursor: k ? "pointer" : "default", color: ratingSort.key === k ? AMBER : "#6b7685", textAlign: k === "name" || !k ? "left" : "right" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...driverRatings].sort((a, b) => { const k = ratingSort.key, m = ratingSort.dir === "asc" ? 1 : -1; if (k === "name") return m * String(a.name).localeCompare(b.name); return m * ((a[k] ?? 0) - (b[k] ?? 0)); }).map((d, i) => (
                      <tr key={d.name} style={{ borderBottom: "1px solid #11171f" }}>
                        <td style={{ padding: "6px 0", color: "#5b6776" }}>{i + 1}</td>
                        <td style={{ fontWeight: 600, color: "#fff" }}>{d.name}</td>
                        <td style={{ textAlign: "right", color: "#8b97a7" }}>{d.races}</td>
                        <td style={{ textAlign: "right", color: "#43d977" }}>{d.hasPace ? d.pace.toFixed(2) : "—"}</td>
                        <td style={{ textAlign: "right", color: "#ffce3a" }}>{d.hasCons ? d.cons.toFixed(2) : "—"}</td>
                        <td style={{ textAlign: "right", color: "#3da9fc" }}>{d.hasRace ? d.race.toFixed(2) : "—"}</td>
                        <td style={{ textAlign: "right", fontWeight: 700, fontSize: 14, color: AMBER }}>{d.overall.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )}

            {/* TAB: STANDALONE AI DEBRIEF MODULE */}
            {tab === "debrief" && (
              <Panel title="AI DEBRIEF ENGINE">
                <div style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "flex-end" }}>
                  <select value={debriefScope} onChange={(e) => setDebriefScope(e.target.value)} style={{ ...inp(180) }}>
                    <option value="overall">Overall Team Summary</option>
                    <option value="mains">Mains Only</option>
                    <option value="inters">Inters Only</option>
                  </select>
                  <select value={debriefTime} onChange={(e) => setDebriefTime(e.target.value)} style={{ ...inp(140) }}>
                    <option value="round">This Round</option>
                    <option value="season">Whole Season</option>
                  </select>
                  <button onClick={async () => {
                    setDebriefLoading(true); setDebrief("");
                    const sessions = debriefTime === "season" ? seasonSessions : convertedSessions;
                    const byDriver = {};
                    sessions.forEach((s) => {
                      if (!/race/i.test(s.raceLabel) || /quali/i.test(s.raceLabel)) return;
                      const rep = driverReport(s, extraTeams, extraNums, removed); if (!rep) return;
                      rep.rows.forEach((r) => {
                        if (!r.isLeeds) return;
                        const n = assign[`${s.id}|${r.num}`]?.trim(); if (!n) return;
                        const d = byDriver[n] || (byDriver[n] = { name: n, avg: [], sd: [], z: [], gain: 0, races: 0 });
                        if (r.avg) d.avg.push(r.avg); if (r.sd != null) d.sd.push(r.sd); if (r.z != null) d.z.push(r.z);
                        if (s.posByKart && s.posByKart[r.num] != null) d.gain += s.posByKart[r.num];
                        d.races += 1;
                      });
                    });
                    const lines = Object.values(byDriver).map((d) => `${d.name}: avg lap ${fmt(mean(d.avg))}s, spread sd ±${(mean(d.sd) || 0).toFixed(3)}s, z-score ${(mean(d.z) ?? 0).toFixed(2)}, net positions ${d.gain} across ${d.races} races`).join("\n");
                    try {
                      const res = await fetch("/api/debrief", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: `Debriefing profile inputs:\n${lines}` }) });
                      const j = await res.json(); setDebrief(j.text || j.error || "No response.");
                    } catch { setDebrief("Endpoint error. Check Cloudflare Secrets configuration."); }
                    setDebriefLoading(false);
                  }} style={{ background: AMBER, color: "#000", padding: "8px 16px", borderRadius: 6, fontWeight: 700, cursor: "pointer" }}>{debriefLoading ? "ANALYSING STINTS…" : "✦ GENERATE DEBRIEF"}</button>
                </div>
                {debrief && ( <div style={{ borderLeft: `3px solid ${AMBER}`, background: "#0b0f15", border: "1px solid #222c38", padding: 18, whiteSpace: "pre-wrap", fontSize: 13.5, color: "#dbe2ea", borderRadius: 8 }}>{debrief}</div> )}
              </Panel>
            )}

            {/* TAB: STATS */}
            {tab === "stats" && (
              <Panel title="SEASON STATS">
                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  {["drivers", "teams"].map((k) => ( <button key={k} onClick={() => setStatsView(k)} style={{ padding: "6px 14px", border: `1px solid ${statsView === k ? AMBER : "#222c38"}`, background: statsView === k ? "#1a160a" : "#0b1017", color: statsView === k ? AMBER : "#8b97a7" }}>{k.toUpperCase()}</button> ))}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
                  {(statsView === "teams" ? stats.teams : stats.drivers).map((d, i) => (
                    <div key={d.name} style={{ background: "#0b1017", border: "1px solid #1b2430", padding: 16, borderRadius: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><span style={{ fontWeight: 700 }}>{i + 1}. {d.name}</span><span style={{ color: "#43d977", fontWeight: 700 }}>{d.points} pts</span></div>
                      <div style={{ fontSize: 11.5, color: "#8b97a7" }}>Races: {d.races} · Avg Finish: {d.avgFinish?.toFixed(1) || "—"} · Best Lap: {fmt(d.bestLap)}</div>
                    </div>
                  ))}
                </div>
              </Panel>
            )}

            {/* TAB: SECTORS (Quali & Practice parsing enabled with key-sniffing fallback mappings) */}
            {tab === "sectors" && (() => {
              const races = convertedSessions.filter((s) => s.isRound && s.laps.length && (/race/i.test(s.raceLabel) || /quali/i.test(s.raceLabel) || /practice/i.test(s.raceLabel)));
              const rep = races.find((s) => s.id === sectorSession) || races[0];
              if (!rep) return <Panel title="SECTOR ANALYSIS"><Empty msg="No telemetry sector maps found." /></Panel>;
              const sb = rep.sectorsByKart || {};
              const ours = rep.karts.filter((k) => !removed.has(`${rep.id}|${k.num}`)).map((k) => ({ num: k.num, name: assign[`${rep.id}|${k.num}`] || k.teamName, ...(sb[k.num] || {}) })).filter((o) => o.best != null || o.s1 != null);
              return (
                <Panel title="SECTOR TIMING RECORD MATRIX">
                  <select value={rep.id} onChange={(e) => setSectorSession(e.target.value)} style={{ ...inp(300), marginBottom: 16 }}>{races.map((s) => <option key={s.id} value={s.id}>{tidyLabel(s.raceLabel)}</option>)}</select>
                  <table className="mono" style={{ width: "100%" }}>
                    <thead>
                      <tr style={{ color: "#6b7685", borderBottom: "1px solid #1e2733" }}><th>DRIVER</th><th style={{ textAlign: "right" }}>S1</th><th style={{ textAlign: "right" }}>S2</th><th style={{ textAlign: "right" }}>S3</th><th style={{ textAlign: "right" }}>THEORETICAL</th><th style={{ textAlign: "right" }}>BEST LAP</th></tr>
                    </thead>
                    <tbody>
                      {ours.map((o) => (
                        <tr key={o.num} style={{ borderBottom: "1px solid #11171f" }}>
                          <td style={{ padding: "6px 0", color: "#fff", fontWeight: 600 }}>{o.name} <span style={{ color: "#5b6776" }}>#{o.num}</span></td>
                          <td style={{ textAlign: "right" }}>{fmt(o.s1)}</td><td style={{ textAlign: "right" }}>{fmt(o.s2)}</td><td style={{ textAlign: "right" }}>{fmt(o.s3)}</td>
                          <td style={{ textAlign: "right", color: "#8b97a7" }}>{o.ult ? o.ult.toFixed(3) : "—"}</td>
                          <td style={{ textAlign: "right", color: AMBER }}>{o.best ? o.best.toFixed(3) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Panel>
              );
            })()}

          </>
        )}
      </div>
    </div>
  );
}

function StatsTable({ boxes, fieldMed }) {
  if (!boxes || !boxes.length) return null;
  return (
    <table className="mono" style={{ width: "100%", fontSize: 12, marginTop: 12 }}>
      <thead>
        <tr style={{ color: "#6b7685" }}><th style={{ textAlign: "left" }}>DRIVER/TEAM</th><th style={{ textAlign: "right" }}>BEST LAP</th><th style={{ textAlign: "right" }}>CLEAN AVG</th><th style={{ textAlign: "right" }}>CONSISTENCY</th><th style={{ textAlign: "right" }}>VS FIELD</th></tr>
      </thead>
      <tbody>
        {[...boxes].sort((a, b) => (a.avg ?? 9e9) - (b.avg ?? 9e9)).map((b, idx) => {
          const gap = fieldMed != null && b.avg != null ? b.avg - fieldMed : null;
          return (
            <tr key={idx} style={{ borderBottom: "1px solid #11171f" }}>
              <td style={{ color: b.color, fontWeight: 600 }}>{b.label}</td>
              <td style={{ textAlign: "right" }}>{fmt(b.best)}</td><td style={{ textAlign: "right" }}>{fmt(b.avg)}</td><td style={{ textAlign: "right" }}>{fmt(b.cons)}</td>
              <td style={{ textAlign: "right", color: gap <= 0 ? "#43d977" : "#ff3355" }}>{gap == null ? "—" : gap <= 0 ? `${gap.toFixed(3)}s` : `+${gap.toFixed(3)}s`}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const inp = (w) => ({ background: "#11171f", border: "1px solid #222c38", borderRadius: 6, color: "#e6edf3", padding: "5px 8px", fontSize: 12.5, width: w, fontFamily: "IBM Plex Mono" });
const Label = ({ children }) => ( <div className="disp" style={{ fontSize: 12.5, color: "#8b97a7", fontWeight: 600, marginBottom: 9 }}>{children}</div> );
function Panel({ title, children }) { return ( <div style={{ background: "#0a0f16", border: "1px solid #161d27", borderRadius: 12, padding: 18, marginBottom: 14 }}> <div className="disp" style={{ fontSize: 13, color: AMBER, fontWeight: 600, marginBottom: 14 }}>{title}</div> {children} </div> ); }
function Collapsible({ title, subtitle, defaultOpen = false, accent = AMBER, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: "1px solid #161d27", borderRadius: 10, marginBottom: 10, background: "#0b1017", overflow: "hidden" }}>
      <button onClick={() => setOpen(!open)} style={{ width: "100%", display: "flex", padding: "11px 14px", background: open ? "#0d141c" : "none", border: "none", cursor: "pointer" }}>
        <span style={{ color: accent, fontWeight: 700, marginRight: 8, transform: open ? "rotate(90deg)" : "none", display: "inline-block" }}>▸</span>
        <span style={{ color: "#e6edf3", fontWeight: 600, flex: 1, textAlign: "left" }}>{title}</span>
        {subtitle && <span className="mono" style={{ color: "#5b6776", fontSize: 11 }}>{subtitle}</span>}
      </button>
      {open && <div style={{ padding: "6px 14px 16px" }}>{children}</div>}
    </div>
  );
}