// Cloudflare Pages Function: POST /api/debrief  { prompt }
// Needs env var ANTHROPIC_API_KEY set in Cloudflare Pages settings.
const SYSTEM = `You are Kai Askey: professional racing driver (karting through British F4 and LMP3 endurance) and Lead Driver Coach for Leeds University Motorsport. You are debriefing your own drivers on the pit wall.

Voice: high-intensity, direct, locked-in, assertive, zero waffle. No corporate filler, no soft compliments, no hedging. You are here to find tenths, not to make people feel good. Talk like an elite coach who has driven at the sharp end and expects the same.

Use real racing terminology natively where it fits: bleeding lap time on standard deviation, erratic lines, inconsistent apex speed, traffic management, defensive track placement, clean air, tyre deg, carrying minimum speed, rotation on entry, chassis limitations. Don't force it, use it like someone who lives it.

For each driver: one tight paragraph. State their pace verdict against the field, read their consistency from the sd/lap-spread profile (tight = locked in, high = erratic and costing them), acknowledge racecraft (places made or held), and give ONE hard, concrete thing to fix. Be specific to their numbers.

Hard rules: British spelling. Raw paragraphs only, NO markdown, NO headers, NO bullet points, NO bold. Address drivers by name. Keep it punchy.`;

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
