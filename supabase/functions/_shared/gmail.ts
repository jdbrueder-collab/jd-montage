// Gemeinsamer Gmail-Zugang für die Server-Funktionen (gmail, sync).
// Zugang zum Postfach über GMAIL_* Secrets (siehe connect-gmail.mjs).
let token: { value: string; until: number } | null = null;
export async function accessToken() {
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

export async function gmail(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error?.message || `Gmail ${r.status}`), { code: r.status >= 500 ? "server_unavailable" : "upstream_error" });
  return d;
}

// --- Hilfen für Nachrichten ---
export const b64urlToBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
export const b64urlToStd = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/");
export const header = (p: any, name: string) => (p.headers || []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

export function walk(part: any, out: { plain: string; html: string; att: any[] }) {
  if (part.filename && part.body?.attachmentId) {
    out.att.push({ id: part.body.attachmentId, filename: part.filename, mimeType: part.mimeType, size: part.body.size });
  } else if (part.body?.data && part.mimeType === "text/plain" && !out.plain) {
    out.plain = new TextDecoder().decode(b64urlToBytes(part.body.data));
  } else if (part.body?.data && part.mimeType === "text/html" && !out.html) {
    out.html = new TextDecoder().decode(b64urlToBytes(part.body.data));
  }
  (part.parts || []).forEach((p: any) => walk(p, out));
}

export function message(m: any) {
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
export const enc = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
export const wrap = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");
export function mime({ to, subject, body, attachments = [] }: any) {
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

