// Global roster sync — Cloudflare Pages Function
// GET  /api/roster                          -> { roster: {...} }
// POST /api/roster { roster, adminPassword } -> saves if the password matches
// Needs: KV namespace bound as PITWALL_KV, and env var ADMIN_PASSWORD.

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export async function onRequestGet({ env }) {
  try {
    if (!env.PITWALL_KV) return json({ roster: {} });
    const v = await env.PITWALL_KV.get("global_roster");
    return json({ roster: v ? JSON.parse(v) : {} });
  } catch (e) {
    return json({ roster: {}, error: String(e) });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const { roster, adminPassword } = await request.json();
    if (!env.ADMIN_PASSWORD) return json({ error: "Server has no ADMIN_PASSWORD set." }, 500);
    if (adminPassword !== env.ADMIN_PASSWORD) return json({ error: "Wrong admin password." }, 401);
    if (!env.PITWALL_KV) return json({ error: "KV namespace PITWALL_KV not bound." }, 500);
    const clean = roster && typeof roster === "object" ? roster : {};
    await env.PITWALL_KV.put("global_roster", JSON.stringify(clean));
    return json({ ok: true, count: Object.keys(clean).length });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
