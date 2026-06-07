// Global roster, weather, & extra entries sync — Cloudflare Pages Function
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export async function onRequestGet({ env }) {
  try {
    if (!env.PITWALL_KV) return json({ roster: {}, wetSessions: [], extraList: [] });
    
    const v = await env.PITWALL_KV.get("global_state");
    if (!v) {
      // Fallback for older deployments
      const oldRoster = await env.PITWALL_KV.get("global_roster");
      return json({ roster: oldRoster ? JSON.parse(oldRoster) : {}, wetSessions: [], extraList: [] });
    }
    return json(JSON.parse(v));
  } catch (e) {
    return json({ roster: {}, wetSessions: [], extraList: [], error: String(e) });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const { roster, wetSessions, extraList, adminPassword } = await request.json();
    
    if (!env.ADMIN_PASSWORD) return json({ error: "Server has no ADMIN_PASSWORD set." }, 500);
    if (adminPassword !== env.ADMIN_PASSWORD) return json({ error: "Wrong admin password." }, 401);
    if (!env.PITWALL_KV) return json({ error: "KV namespace PITWALL_KV not bound." }, 500);
    
    const cleanRoster = roster && typeof roster === "object" ? roster : {};
    const cleanWet = Array.isArray(wetSessions) ? wetSessions : [];
    const cleanExtra = Array.isArray(extraList) ? extraList : [];
    
    const statePayload = { roster: cleanRoster, wetSessions: cleanWet, extraList: cleanExtra };
    
    await env.PITWALL_KV.put("global_state", JSON.stringify(statePayload));
    await env.PITWALL_KV.put("global_roster", JSON.stringify(cleanRoster));
    
    return json({ ok: true, count: Object.keys(cleanRoster).length, wetCount: cleanWet.length, extraCount: cleanExtra.length });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}