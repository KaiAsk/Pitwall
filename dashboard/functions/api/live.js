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

// find the competitor array (real key is "Competitors"; fall back to any array
// of objects that look like timing rows)
function findRows(o) {
  if (o && Array.isArray(o.Competitors)) return o.Competitors;
  let best = [];
  (function walk(x) {
    if (Array.isArray(x)) {
      if (x.length && x.every((e) => e && typeof e === "object") &&
          x.some((e) => "CompetitorNumber" in e || "Position" in e || "competitorNumber" in e)) {
        if (x.length > best.length) best = x;
      }
      x.forEach(walk);
    } else if (x && typeof x === "object") { Object.values(x).forEach(walk); }
  })(o);
  return best;
}
const pick = (o, ...k) => { for (const x of k) if (o && o[x] != null && o[x] !== "") return o[x]; return null; };
const msToSec = (v) => (typeof v === "number" && v > 0 ? (v / 1000).toFixed(3) : null);

function transform(api) {
  const rows = findRows(api);
  const results = rows.map((r) => {
    const name = pick(r, "TeamName", "CompetitorName", "DriverName", "name") || "";
    const behind = pick(r, "Behind", "Gap", "gap");
    const pos = pick(r, "Position", "position", "pos");
    let gap = "";
    if (pos !== 1 && behind != null) gap = /^[\d.]+$/.test(String(behind)) ? "+" + behind + "s" : String(behind);
    return {
      position: pos,
      kart: String(pick(r, "CompetitorNumber", "competitorNumber", "number", "kart") || "").trim(),
      name: String(name).trim(), team: String(name).trim(),
      laps: pick(r, "NumberOfLaps", "laps", "lapCount"),
      gap,
      best_lap_time: msToSec(pick(r, "BestLaptime", "bestLapTime", "best")),
      last_lap_time: msToSec(pick(r, "LastLaptime", "lastLapTime", "last")),
      in_pit: !!pick(r, "InPit"),
      penalty: !!pick(r, "penalty", "Penalty"),
    };
  }).filter((r) => r.kart);

  // per-kart lap history (LapTime is in ms) -> seconds strings for the analytics
  const lap_times = rows.map((r) => {
    const kart = String(pick(r, "CompetitorNumber", "competitorNumber", "number") || "").trim();
    const L = pick(r, "Laps", "lapTimes", "lapList");
    if (!kart || !Array.isArray(L) || !L.length) return null;
    const laps = L.map((x) => (typeof x === "object" ? msToSec(x.LapTime) : msToSec(x))).filter(Boolean);
    return laps.length ? { kart, laps } : null;
  }).filter(Boolean);

  const st = String(pick(api, "State", "Status", "status") || "live").toLowerCase();
  const live = ["live", "running", "green", "started", "active"].includes(st);
  return {
    scraped_at: new Date().toISOString(),
    sessions: [{
      label: pick(api, "SessionName", "sessionName", "name") || "Live",
      type: String(pick(api, "SessionType", "sessionType", "type") || "race").toLowerCase(),
      state: pick(api, "State"),
      status: live ? "live" : st,
      results, lap_times, penalties: [],
    }],
  };
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const site = (url.searchParams.get("site") || "bukc").replace(/[^a-z]/gi, "");
  const debug = url.searchParams.get("debug");

  // shared edge cache: all viewers get one upstream fetch every few seconds
  const cache = caches.default;
  const ckey = new Request(`https://pitwall.cache/live/${site}${debug ? "/debug" : ""}`);
  if (!debug) {
    const hit = await cache.match(ckey);
    if (hit) return hit;
  }

  const finish = (obj, maxAge) => {
    const res = new Response(JSON.stringify(obj), { headers: {
      "content-type": "application/json",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
      "access-control-allow-origin": "*",
    } });
    if (!debug && maxAge) context.waitUntil(cache.put(ckey, res.clone()));
    return res;
  };

  try {
    const tk = await token(site);
    const headers = { "user-agent": "pitwall", "at-site": site };
    if (tk) headers["at-pst"] = tk;
    const r = await fetch(`${BASE}/api/v1/${site}/live/current`, { headers });
    if (r.status === 204) return finish({ sessions: [], noSession: true }, 3);
    if (r.status !== 200) return finish({ sessions: [], error: `upstream ${r.status}`, hadToken: !!tk }, 2);
    const body = await r.text();
    if (!body.trim()) return finish({ sessions: [], noSession: true }, 3);
    let api; try { api = JSON.parse(body); } catch { return finish({ sessions: [], noSession: true }, 3); }
    if (debug) return finish({ rawKeys: Object.keys(api), raw: api }, 0);
    return finish(transform(api), 3);
  } catch (e) {
    return finish({ sessions: [], error: String(e) }, 2);
  }
}
