// Global roster, weather, extra entries & team-removals sync — Cloudflare Pages Function
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// Per-team passcodes for the 24h global save. Anyone with a team's code can
// push that team's stints + pit log; everyone else just reads. Casual gate to
// stop accidental edits, not real security.
const TEAM_PASSCODES = { "9": "huZZ", "10": "bee", "11": "cunty", "12": "wth", "57": "unc", "58": "free" };
const CONTROL_PW = "footjob";   // admin-lite: set the race start time on the day

async function loadState(env) {
  const v = env.PITWALL_KV ? await env.PITWALL_KV.get("global_state") : null;
  return v ? JSON.parse(v) : {};
}

export async function onRequestGet(context) {
  const { env } = context;
  const cache = caches.default;
  const ckey = new Request("https://pitwall.cache/roster");
  try {
    const hit = await cache.match(ckey);
    if (hit) return hit;
  } catch {}
  const finish = (obj) => {
    const res = new Response(JSON.stringify(obj), { headers: {
      "content-type": "application/json", "cache-control": "public, max-age=3", "access-control-allow-origin": "*" } });
    try { context.waitUntil(cache.put(ckey, res.clone())); } catch {}
    return res;
  };
  try {
    if (!env.PITWALL_KV) return finish({ roster: {}, wetSessions: [], extraList: [], removed: [], stintPlan: null, telemetryLocked: false, simLocked: false, raceStartISO: null });
    const v = await env.PITWALL_KV.get("global_state");
    if (!v) {
      const oldRoster = await env.PITWALL_KV.get("global_roster");
      return finish({ roster: oldRoster ? JSON.parse(oldRoster) : {}, wetSessions: [], extraList: [], removed: [], stintPlan: null, telemetryLocked: false, simLocked: false, raceStartISO: null });
    }
    const parsed = JSON.parse(v);
    return finish({ roster: parsed.roster || {}, wetSessions: parsed.wetSessions || [], extraList: parsed.extraList || [], removed: parsed.removed || [], stintPlan: parsed.stintPlan || null, telemetryLocked: !!parsed.telemetryLocked, simLocked: !!parsed.simLocked, raceStartISO: (parsed.stintPlan && parsed.stintPlan.raceStartISO) || null });
  } catch (e) {
    return finish({ roster: {}, stintPlan: null, error: String(e) });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();

    if (body.verifyTeam) {
      const { num, passcode } = body.verifyTeam;
      return json({ ok: TEAM_PASSCODES[String(num)] != null && TEAM_PASSCODES[String(num)] === passcode });
    }
    if (body.verifyControl) {
      return json({ ok: body.verifyControl.passcode === CONTROL_PW || (env.ADMIN_PASSWORD && body.verifyControl.passcode === env.ADMIN_PASSWORD) });
    }

    // set the global race start time on the day (control password)
    if (body.setRaceStart) {
      const { iso, passcode } = body.setRaceStart;
      if (passcode !== CONTROL_PW && passcode !== env.ADMIN_PASSWORD) return json({ error: "Wrong control password." }, 401);
      if (!env.PITWALL_KV) return json({ error: "KV not bound." }, 500);
      const state = await loadState(env);
      state.stintPlan = state.stintPlan || { teams: [] };
      state.stintPlan.raceStartISO = iso;
      await env.PITWALL_KV.put("global_state", JSON.stringify(state));
      return json({ ok: true, raceStartISO: iso });
    }

    // granular team sync — pit ops are MERGED by the server so multiple people
    // logging the same team don't clobber each other, and clears propagate.
    if (body.teamSync) {
      const { num, passcode } = body.teamSync;
      const n = String(num);
      if (TEAM_PASSCODES[n] == null || TEAM_PASSCODES[n] !== passcode) return json({ error: "Wrong team passcode." }, 401);
      if (!env.PITWALL_KV) return json({ error: "KV not bound." }, 500);
      const state = await loadState(env);
      state.stintPlan = state.stintPlan || { teams: [] };
      state.stintPlan.teams = state.stintPlan.teams || [];
      let i = state.stintPlan.teams.findIndex((t) => String(t.num) === n);
      if (i < 0) { state.stintPlan.teams.push({ num: n, pitLog: [] }); i = state.stintPlan.teams.length - 1; }
      const T = state.stintPlan.teams[i];
      T.pitLog = T.pitLog || [];
      const b = body.teamSync;
      if (b.plan) { T.name = b.plan.name ?? T.name; T.drivers = b.plan.drivers ?? T.drivers; T.stints = b.plan.stints ?? T.stints; }
      // owner pushes its WHOLE pit log + a version (seq). Only accept newer
      // versions, so out-of-order requests (fast log+undo) can't resurrect a pit.
      if (Array.isArray(b.pitLog)) {
        if (b.seq == null || T._seq == null || b.seq > T._seq) {
          T.pitLog = b.pitLog.slice().sort((a, c) => (a.atMin || 0) - (c.atMin || 0));
          T._seq = b.seq != null ? b.seq : Date.now();
        }
      }
      // legacy granular ops (kept as a fallback, also version-guarded off)
      else {
        if (b.pitAppend) { if (!T.pitLog.some((p) => p.id === b.pitAppend.id)) T.pitLog.push(b.pitAppend); }
        if (b.pitRemove != null) T.pitLog = T.pitLog.filter((p) => p.id !== b.pitRemove);
        if (b.pitClear) T.pitLog = [];
        if (b.pitEdit) T.pitLog = T.pitLog.map((p) => (p.id === b.pitEdit.id ? { ...p, atMin: b.pitEdit.atMin } : p));
        T.pitLog.sort((a, c) => (a.atMin || 0) - (c.atMin || 0));
      }
      T._updated = Date.now();
      await env.PITWALL_KV.put("global_state", JSON.stringify(state));
      return json({ ok: true, pitLog: T.pitLog });
    }

    // admin flows (full roster / plan / locks)
    const { roster, wetSessions, extraList, removed, stintPlan, telemetryLocked, verify, adminPassword } = body;
    if (!env.ADMIN_PASSWORD) return json({ error: "Server has no ADMIN_PASSWORD set." }, 500);
    if (adminPassword !== env.ADMIN_PASSWORD) return json({ error: "Wrong admin password." }, 401);
    if (verify) return json({ ok: true });
    if (!env.PITWALL_KV) return json({ error: "KV namespace PITWALL_KV not bound." }, 500);

    const existing = await loadState(env);
    const statePayload = { ...existing };
    if (roster && typeof roster === "object") statePayload.roster = roster;
    if (Array.isArray(wetSessions)) statePayload.wetSessions = wetSessions;
    if (Array.isArray(extraList)) statePayload.extraList = extraList;
    if (Array.isArray(removed)) statePayload.removed = removed;
    if (stintPlan && typeof stintPlan === "object") {
      // preserve server-merged pit logs when the captain republishes the plan
      const prev = existing.stintPlan && existing.stintPlan.teams || [];
      const merged = { ...stintPlan, teams: (stintPlan.teams || []).map((t) => {
        const old = prev.find((x) => String(x.num) === String(t.num));
        return { ...t, pitLog: (old && old.pitLog && old.pitLog.length) ? old.pitLog : (t.pitLog || []) };
      }) };
      statePayload.stintPlan = merged;
    }
    if (typeof telemetryLocked === "boolean") statePayload.telemetryLocked = telemetryLocked;
    if (typeof body.simLocked === "boolean") statePayload.simLocked = body.simLocked;
    statePayload.roster = statePayload.roster || {};
    statePayload.wetSessions = statePayload.wetSessions || [];
    statePayload.extraList = statePayload.extraList || [];
    statePayload.removed = statePayload.removed || [];

    await env.PITWALL_KV.put("global_state", JSON.stringify(statePayload));
    await env.PITWALL_KV.put("global_roster", JSON.stringify(statePayload.roster));
    return json({ ok: true, count: Object.keys(statePayload.roster).length });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
