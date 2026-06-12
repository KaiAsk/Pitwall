// Global roster, weather, extra entries & team-removals sync — Cloudflare Pages Function
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// Per-team passcodes for the 24h global save. Anyone with a team's code can
// push that team's stints + pit log; everyone else just reads. Casual gate to
// stop accidental edits, not real security.
const TEAM_PASSCODES = { "18": "huZZ", "19": "bee", "20": "cunty", "21": "wth", "57": "unc", "58": "free" };

async function loadState(env) {
  const v = env.PITWALL_KV ? await env.PITWALL_KV.get("global_state") : null;
  return v ? JSON.parse(v) : {};
}

export async function onRequestGet({ env }) {
  try {
    if (!env.PITWALL_KV) return json({ roster: {}, wetSessions: [], extraList: [], removed: [], stintPlan: null, telemetryLocked: false });
    const v = await env.PITWALL_KV.get("global_state");
    if (!v) {
      const oldRoster = await env.PITWALL_KV.get("global_roster");
      return json({ roster: oldRoster ? JSON.parse(oldRoster) : {}, wetSessions: [], extraList: [], removed: [], stintPlan: null, telemetryLocked: false });
    }
    const parsed = JSON.parse(v);
    return json({ roster: parsed.roster || {}, wetSessions: parsed.wetSessions || [], extraList: parsed.extraList || [], removed: parsed.removed || [], stintPlan: parsed.stintPlan || null, telemetryLocked: !!parsed.telemetryLocked, simLocked: !!parsed.simLocked });
  } catch (e) {
    return json({ roster: {}, wetSessions: [], extraList: [], removed: [], stintPlan: null, telemetryLocked: false, error: String(e) });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();

    // --- per-team passcode flows (24h global save) ---
    if (body.verifyTeam) {
      const { num, passcode } = body.verifyTeam;
      return json({ ok: TEAM_PASSCODES[String(num)] != null && TEAM_PASSCODES[String(num)] === passcode });
    }
    if (body.teamSync) {
      const { num, passcode, team } = body.teamSync;
      const n = String(num);
      if (TEAM_PASSCODES[n] == null || TEAM_PASSCODES[n] !== passcode) return json({ error: "Wrong team passcode." }, 401);
      if (!env.PITWALL_KV) return json({ error: "KV not bound." }, 500);
      const state = await loadState(env);
      state.stintPlan = state.stintPlan || { teams: [] };
      state.stintPlan.teams = state.stintPlan.teams || [];
      const i = state.stintPlan.teams.findIndex((t) => String(t.num) === n);
      const merged = { ...(i >= 0 ? state.stintPlan.teams[i] : {}), ...team, num: n, _updated: Date.now() };
      if (i >= 0) state.stintPlan.teams[i] = merged; else state.stintPlan.teams.push(merged);
      await env.PITWALL_KV.put("global_state", JSON.stringify(state));
      return json({ ok: true });
    }

    // --- admin flows (roster / full plan / telemetry lock) ---
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
    if (stintPlan && typeof stintPlan === "object") statePayload.stintPlan = stintPlan;
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
