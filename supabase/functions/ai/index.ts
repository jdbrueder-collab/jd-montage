// KI für die Montage-App: Deckblatt auslesen und eingesprochene Berichte in Felder übertragen.
// Ersetzt sample.json aus claude.ai: bekommt einen Prompt (+ Bilder) und gibt ein JSON-Objekt zurück.
// Freigegebene Nutzer dürfen sie aufrufen. Schlüssel: Secret ANTHROPIC_API_KEY.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM =
  "Du hilfst der Montage-App von JD Brüder. Antworte ausschließlich mit einem einzigen gültigen JSON-Objekt, " +
  "ohne Erklärung und ohne Markdown. Felder, die du nicht sicher erkennst, lässt du leer statt zu raten.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    });
    const { data: member } = await sb.rpc("is_member");
    if (!member) return json({ code: "not_granted", message: "Kein Zugriff." }, 403);
    if (!Deno.env.get("ANTHROPIC_API_KEY")) return json({ code: "unavailable", message: "KI ist noch nicht eingerichtet." }, 409);

    const { prompt, images = [] } = await req.json();
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      ...images.slice(0, 4).map((i: { type: string; data: string }) => ({
        type: "image" as const,
        source: { type: "base64" as const, media_type: i.type as "image/jpeg", data: i.data },
      })),
      { type: "text", text: String(prompt || "") },
    ];

    const client = new Anthropic();
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
    if (res.stop_reason === "refusal") return json({ code: "refused", message: "Die KI hat das abgelehnt." }, 422);

    const text = res.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.Beta.BetaTextBlock).text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json({ code: "bad_output", message: "Antwort war kein JSON." }, 502);
    return json(JSON.parse(m[0]));
  } catch (e) {
    console.error(e);
    if (e instanceof Anthropic.AuthenticationError) return json({ code: "unavailable", message: "API-Schlüssel ungültig." }, 409);
    if (e instanceof Anthropic.RateLimitError) return json({ code: "rate_limited", message: "Zu viele Anfragen, gleich nochmal." }, 429);
    if (e instanceof Anthropic.APIError) return json({ code: "upstream_error", message: e.message }, 502);
    return json({ code: "upstream_error", message: String((e as Error)?.message || e) }, 502);
  }
});
