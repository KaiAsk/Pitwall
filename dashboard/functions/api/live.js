// /api/live — server-side live relay (Cloudflare Pages Function).
// The browser polls THIS (same origin); the edge fetches AlphaRaceHub's
// /api/v1/<site>/live/current, maps it, and returns JSON. No PC, no commits,
// updates in real time. Test:  /api/live?site=ukc   Race day default: bukc.
// Add &debug=1 to see the raw upstream payload.
const BASE = "https://www.alpharacehub.com";

const J = (o, s = 200) => new Response(JSON.stringify(o), {
  status: s,
  headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
});

async function token(site) {
  try {
    const r = await fetch(`${BASE}/${site}/live`, { headers: { "user-agent": "pitwall" } });
    const t = await r.text();
    const m = t.match(/data-pusherToken="([^"]+)"/);
    return m ? m[1].replace(/&#x2B;/g, "+") : null;
  } catch { return null; }
}

// find the biggest array of competitor-like objects anywhere in the payload
function findRows(o) {
  let best = [];
  (function walk(x) {
    if (Array.isArray(x)) {
      if (x.length && x.every((e) => e && typeof e === "object") &&
          x.some((e) => "position" in e || "competitorNumber" in e || "number" in e || "name" in e)) {
        if (x.length > best.length) best = x;
      }
      x.forEach(walk);
    } else if (x && typeof x === "object") { Object.values(x).forEach(walk); }
  })(o);
  return best;
}
const pick = (o, ...k) => { for (const x of k) if (o && o[x] != null && o[x] !== "") return o[x]; return null; };
function findStr(o, ...names) {
  let hit = null;
  (function walk(x) {
    if (hit) return;
    if (x && typeof x === "object" && !Array.isArray(x)) {
      for (const n of names) if (typeof x[n] === "string" && x[n]) { hit = x[n]; return; }
      Object.values(x).forEach(walk);
    } else if (Array.isArray(x)) x.forEach(walk);
  })(o);
  return hit;
}

function transform(api) {
  const rows = findRows(api);
  const clean = (s) => String(s || "").replace(/\*pen|\[\+penalty\]/gi, "").trim();
  const results = rows.map((r) => {
    const name = pick(r, "name", "teamName", "team", "competitor") || "";
    return {
      position: pick(r, "position", "pos", "rank"),
      kart: String(pick(r, "competitorNumber", "number", "kart", "num") || "").trim(),
      name: clean(name), team: clean(name),
      laps: pick(r, "laps", "lapCount", "lapsCompleted", "lap"),
      gap: (pick(r, "gap", "gapToLeader", "interval") || null) && String(pick(r, "gap", "gapToLeader", "interval")),
      best_lap_time: (pick(r, "bestLapTime", "bestLap", "best") || null) && String(pick(r, "bestLapTime", "bestLap", "best")),
      last_lap_time: (pick(r, "lastLapTime", "lastLap", "last") || null) && String(pick(r, "lastLapTime", "lastLap", "last")),
      penalty: !!pick(r, "penalty", "hasPenalty") || /\*pen|\[\+penalty\]/i.test(name),
    };
  }).filter((r) => r.kart);
  const lap_times = rows.map((r) => {
    const ll = pick(r, "lapTimes", "lapList", "lapsList");
    return Array.isArray(ll) && ll.length ? { kart: String(pick(r, "competitorNumber", "number", "kart") || ""), laps: ll.map(String) } : null;
  }).filter(Boolean);
  const st = (findStr(api, "status") || "live").toLowerCase();
  return {
    scraped_at: new Date().toISOString(),
    sessions: [{
      label: findStr(api, "sessionName", "session", "name") || "Live",
      type: (findStr(api, "sessionType", "type") || "race").toLowerCase(),
      status: ["live", "running", "green"].includes(st) ? "live" : st,
      results, lap_times, penalties: [],
    }],
  };
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const site = (url.searchParams.get("site") || "bukc").replace(/[^a-z]/gi, "");
  const debug = url.searchParams.get("debug");
  try {
    const tk = await token(site);
    const headers = { "user-agent": "pitwall", "at-site": site };
    if (tk) headers["at-pst"] = tk;
    const r = await fetch(`${BASE}/api/v1/${site}/live/current`, { headers });
    if (r.status !== 200) return J({ sessions: [], error: `upstream ${r.status}`, hadToken: !!tk }, 200);
    const api = await r.json();
    if (debug) return J({ rawKeys: Object.keys(api), raw: api });
    return J(transform(api));
  } catch (e) {
    return J({ sessions: [], error: String(e) }, 200);
  }
}
