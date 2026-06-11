// Global roster, weather, extra entries & team-removals sync — Cloudflare Pages Function
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export async function onRequestGet({ env }) {
  try {
    if (!env.PITWALL_KV) return json({ roster: {}, wetSessions: [], extraList: [], removed: [], stintPlan: null, telemetryLocked: false });
    const v = await env.PITWALL_KV.get("global_state");
    if (!v) {
      const oldRoster = await env.PITWALL_KV.get("global_roster");
      return json({ roster: oldRoster ? JSON.parse(oldRoster) : {}, wetSessions: [], extraList: [], removed: [], stintPlan: null, telemetryLocked: false });
    }
    const parsed = JSON.parse(v);
    return json({ roster: parsed.roster || {}, wetSessions: parsed.wetSessions || [], extraList: parsed.extraList || [], removed: parsed.removed || [], stintPlan: parsed.stintPlan || null, telemetryLocked: !!parsed.telemetryLocked });
  } catch (e) {
    return json({ roster: {}, wetSessions: [], extraList: [], removed: [], stintPlan: null, telemetryLocked: false, error: String(e) });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { roster, wetSessions, extraList, removed, stintPlan, telemetryLocked, verify, adminPassword } = body;
    if (!env.ADMIN_PASSWORD) return json({ error: "Server has no ADMIN_PASSWORD set." }, 500);
    if (adminPassword !== env.ADMIN_PASSWORD) return json({ error: "Wrong admin password." }, 401);
    // verify-only: used to unlock the season telemetry without changing anything
    if (verify) return json({ ok: true });
    if (!env.PITWALL_KV) return json({ error: "KV namespace PITWALL_KV not bound." }, 500);

    // Merge over what's already stored so a roster sync doesn't wipe the stint
    // plan (and vice versa) — the telemetry app and the 24h section each only
    // send their own fields.
    const existingRaw = await env.PITWALL_KV.get("global_state");
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    const statePayload = { ...existing };

    if (roster && typeof roster === "object") statePayload.roster = roster;
    if (Array.isArray(wetSessions)) statePayload.wetSessions = wetSessions;
    if (Array.isArray(extraList)) statePayload.extraList = extraList;
    if (Array.isArray(removed)) statePayload.removed = removed;
    if (stintPlan && typeof stintPlan === "object") statePayload.stintPlan = stintPlan;
    if (typeof telemetryLocked === "boolean") statePayload.telemetryLocked = telemetryLocked;

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
