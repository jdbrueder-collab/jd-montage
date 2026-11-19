// Gmail für die Montage-App: liefert dieselben Antworten wie der Gmail-Konnektor in claude.ai.
// Nur Admins dürfen sie aufrufen. Zugang zum Postfach über GMAIL_* Secrets (siehe connect-gmail.mjs).
import { createClient } from "jsr:@supabase/supabase-js@2.119.1";
import { b64urlToStd, gmail, header, message, mime } from "../_shared/gmail.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (code: string, message: string, status = 400) => json({ code, message }, status);

// --- Werkzeuge mit denselben Namen wie der Claude-Konnektor ---
const tools: Record<string, (a: any) => Promise<unknown>> = {
  async search_threads({ query, pageSize = 50 }) {
    const list = await gmail(`threads?q=${encodeURIComponent(query || "")}&maxResults=${Math.min(+pageSize || 50, 100)}`);
    const threads = await Promise.all((list.threads || []).map(async (t: any) => {
      const d = await gmail(`threads/${t.id}?format=metadata&metadataHeaders=Subject`);
      const messages = (d.messages || []).map((m: any) => ({ id: m.id, subject: header(m.payload, "Subject") }));
      return { id: t.id, messageCount: messages.length, messages };
    }));
    return { payload: { threads } };
  },
  async get_thread({ threadId }) {
    const d = await gmail(`threads/${encodeURIComponent(threadId)}?format=full`);
    return { payload: { id: d.id, messages: (d.messages || []).map(message) } };
  },
  async download_gmail_attachment({ messageId, attachmentId, mimeType }) {
    const d = await gmail(`messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    const type = /^image\//.test(mimeType || "") ? "image" : "resource";
    return { content: [{ type, data: b64urlToStd(d.data), mimeType }] };
  },
  async send_message(a) {
    if (!a.to || !(Array.isArray(a.to) ? a.to.length : a.to)) throw Object.assign(new Error("Empfänger fehlt"), { code: "bad_request" });
    const d = await gmail("messages/send", { method: "POST", body: JSON.stringify({ raw: mime(a) }) });
    return { payload: { id: d.id, threadId: d.threadId } };
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    });
    const { tool, args } = await req.json();
    if (!tools[tool]) return fail("bad_request", `Unbekannt: ${tool}`);
    // Postfach lesen: nur Admins. Senden (Montagebericht, Schreiben an Kunden): alle freigegebenen Nutzer.
    const { data: owner } = await sb.rpc("is_owner");
    const { data: member } = tool === "send_message" && !owner ? await sb.rpc("is_member") : { data: false };
    if (!owner && !member) return fail("approval_required", "Nur Admins dürfen Gmail nutzen.", 403);
    return json(await tools[tool](args || {}));
  } catch (e: any) {
    console.error(e);
    return fail(e.code || "upstream_error", e.message || String(e), e.code === "server_not_connected" || e.code === "needs_reauth" ? 409 : 502);
  }
});
