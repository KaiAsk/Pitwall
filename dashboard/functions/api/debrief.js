// Cloudflare Pages Function: POST /api/debrief
export async function onRequestPost({ request, env }) {
  try {
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "No API key set. Add ANTHROPIC_API_KEY in Cloudflare Pages settings." }, 500);
    }
    const { prompt } = await request.json();
    if (!prompt) return json({ error: "Missing prompt" }, 400);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const d = await r.json();

    if (!r.ok) {
      return json({ error: `Anthropic API Error: ${d.error?.message || JSON.stringify(d)}` }, r.status);
    }

    const text = (d.content || []).map((b) => b.text || "").join("").trim();
    return json({ text: text || "(no response)" });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });