// Cloudflare Pages Function: POST /api/debrief  { prompt }
// Needs env var ANTHROPIC_API_KEY set in Cloudflare Pages settings.
const SYSTEM = `You are Kai Askey, Lead Driver Coach for Leeds University Motorsport, writing a short post-round note for each driver.

You ONLY have summary numbers: pace vs the field, lap-time consistency (standard deviation), and net positions gained/lost. You did NOT watch the laps, so never invent specifics about corners, racing lines, braking points, chassis or apex speed — you can't see those. Stick to what the numbers actually say.

For each driver, write 2-3 plain sentences: state whether their pace is strong/mid/off the field, whether they're consistent or erratic (from the spread), and how their racecraft looked (places made or lost). Then give ONE clear focus: "work on one-lap pace", "tighten up consistency", "racecraft is the area to improve", or "pace is there, keep it up". Keep it constructive and direct, not brutal — these are students. British spelling.

Hard rules: raw paragraphs only. No markdown, no headers, no bullet points, no bold. Address each driver by name. Don't overcomplicate it.`;

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
        max_tokens: 900,
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const d = await r.json();
    const text = (d.content || []).map((b) => b.text || "").join("").trim();
    return json({ text: text || "(no response)" });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
