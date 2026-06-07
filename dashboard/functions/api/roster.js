// Global roster, weather, extra entries & team-removals sync — Cloudflare Pages Function
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export async function onRequestGet({ env }) {
  try {
    if (!env.PITWALL_KV) return json({ roster: {}, wetSessions: [], extraList: [], removed: [] });
    const v = await env.PITWALL_KV.get("global_state");
    if (!v) {
      const oldRoster = await env.PITWALL_KV.get("global_roster");
      return json({ roster: oldRoster ? JSON.parse(oldRoster) : {}, wetSessions: [], extraList: [], removed: [] });
    }
    const parsed = JSON.parse(v);
    return json({ roster: parsed.roster || {}, wetSessions: parsed.wetSessions || [], extraList: parsed.extraList || [], removed: parsed.removed || [] });
  } catch (e) {
    return json({ roster: {}, wetSessions: [], extraList: [], removed: [], error: String(e) });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const { roster, wetSessions, extraList, removed, adminPassword } = await request.json();
    if (!env.ADMIN_PASSWORD) return json({ error: "Server has no ADMIN_PASSWORD set." }, 500);
    if (adminPassword !== env.ADMIN_PASSWORD) return json({ error: "Wrong admin password." }, 401);
    if (!env.PITWALL_KV) return json({ error: "KV namespace PITWALL_KV not bound." }, 500);

    const statePayload = {
      roster: roster && typeof roster === "object" ? roster : {},
      wetSessions: Array.isArray(wetSessions) ? wetSessions : [],
      extraList: Array.isArray(extraList) ? extraList : [],
      removed: Array.isArray(removed) ? removed : [],
    };
    await env.PITWALL_KV.put("global_state", JSON.stringify(statePayload));
    await env.PITWALL_KV.put("global_roster", JSON.stringify(statePayload.roster));
    return json({ ok: true, count: Object.keys(statePayload.roster).length });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
