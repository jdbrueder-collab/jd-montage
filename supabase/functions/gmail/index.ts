// Gmail für die Montage-App: liefert dieselben Antworten wie der Gmail-Konnektor in claude.ai.
// Nur Admins dürfen sie aufrufen. Zugang zum Postfach über GMAIL_* Secrets (siehe connect-gmail.mjs).
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (code: string, message: string, status = 400) => json({ code, message }, status);

let token: { value: string; until: number } | null = null;
async function accessToken() {
  if (token && token.until > Date.now() + 60_000) return token.value;
  const refresh = Deno.env.get("GMAIL_REFRESH_TOKEN");
  if (!refresh) throw Object.assign(new Error("Gmail ist noch nicht verbunden."), { code: "server_not_connected" });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: Deno.env.get("GMAIL_CLIENT_ID")!,
      client_secret: Deno.env.get("GMAIL_CLIENT_SECRET")!,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const d = await r.json();
  if (!r.ok) throw Object.assign(new Error(d.error_description || d.error), { code: d.error === "invalid_grant" ? "needs_reauth" : "upstream_error" });
  token = { value: d.access_token, until: Date.now() + d.expires_in * 1000 };
  return token.value;
}

async function gmail(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error?.message || `Gmail ${r.status}`), { code: r.status >= 500 ? "server_unavailable" : "upstream_error" });
  return d;
}

// --- Hilfen für Nachrichten ---
const b64urlToBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const b64urlToStd = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/");
const header = (p: any, name: string) => (p.headers || []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

function walk(part: any, out: { plain: string; html: string; att: any[] }) {
  if (part.filename && part.body?.attachmentId) {
    out.att.push({ id: part.body.attachmentId, filename: part.filename, mimeType: part.mimeType, size: part.body.size });
  } else if (part.body?.data && part.mimeType === "text/plain" && !out.plain) {
    out.plain = new TextDecoder().decode(b64urlToBytes(part.body.data));
  } else if (part.body?.data && part.mimeType === "text/html" && !out.html) {
    out.html = new TextDecoder().decode(b64urlToBytes(part.body.data));
  }
  (part.parts || []).forEach((p: any) => walk(p, out));
}

function message(m: any) {
  const out = { plain: "", html: "", att: [] as any[] };
  walk(m.payload, out);
  return {
    id: m.id,
    threadId: m.threadId,
    subject: header(m.payload, "Subject"),
    sender: header(m.payload, "From"),
    date: new Date(Number(m.internalDate)).toISOString(),
    plaintextBody: out.plain,
    htmlBody: out.html,
    attachments: out.att,
    viewUrl: `https://mail.google.com/mail/#all/${m.threadId}`,
  };
}

// RFC 2047 für Umlaute im Betreff, Base64 mit Zeilenumbrüchen für MIME
const enc = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const wrap = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");
function mime({ to, subject, body, attachments = [] }: any) {
  const b = "jd" + crypto.randomUUID().replace(/-/g, "");
  const lines = [
    `To: ${(Array.isArray(to) ? to : [to]).join(", ")}`,
    `Subject: =?UTF-8?B?${enc(subject || "")}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap(enc(body || "")),
  ];
  for (const a of attachments) {
    const name = `=?UTF-8?B?${enc(a.filename || "Anhang")}?=`;
    lines.push(`--${b}`, `Content-Type: ${a.mimeType || "application/octet-stream"}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", wrap(a.content));
  }
  lines.push(`--${b}--`, "");
  return btoa(lines.join("\r\n")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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
    const { data: owner } = await sb.rpc("is_owner");
    if (!owner) return fail("approval_required", "Nur Admins dürfen Gmail nutzen.", 403);
    const { tool, args } = await req.json();
    if (!tools[tool]) return fail("bad_request", `Unbekannt: ${tool}`);
    return json(await tools[tool](args || {}));
  } catch (e: any) {
    console.error(e);
    return fail(e.code || "upstream_error", e.message || String(e), e.code === "server_not_connected" || e.code === "needs_reauth" ? 409 : 502);
  }
});
