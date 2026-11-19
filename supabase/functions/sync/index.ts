// Automatischer Mail-Abruf für die Montage-App.
// Läuft alle 15 Minuten über den Zeitplan in der Datenbank (pg_cron) und auf Knopfdruck durch Admins.
// Holt meta-Mails aus dem verbundenen Postfach, legt Aufträge an / aktualisiert sie, speichert
// PDF- und Bild-Anhänge im Auftrag und lässt Claude das Aufmaß-Deckblatt auslesen.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "jsr:@supabase/supabase-js@2.119.1";
import { DOMParser } from "npm:linkedom@0.18.5";
import * as webpush from "jsr:@negrel/webpush@0.3.0";
import { b64urlToStd, gmail, message, mime } from "../_shared/gmail.ts";
import {
  art, cleanSubject, DECK_FELDER, DECK_PROMPT, eigenerText, findeAuftrag, idOf, istAbnahmeVerguetung, istEigenerBericht, kwAusMail, mitAbgerechnet, nrAusMail,
  parseAbrechnung, parseUebersicht, parseZusage, reklaAufstellung, splitBV, unterlagen, vonMeta,
} from "../_shared/meta.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const DEFAULT_QUERY = "(from:meta.de OR to:meta.de OR \"@meta.de\") newer_than:60d";
const MAX_NACHRICHTEN = 40;   // pro Lauf, Rest beim nächsten Lauf
const MAX_DATEIEN = 25;       // Anhänge pro Lauf
const MAX_LAUFZEIT = 110_000; // ms, danach sauber aufhören
const SPERRE = 10 * 60_000;   // ein Lauf gleichzeitig

const parseHTML = (h: string) => new DOMParser().parseFromString(h, "text/html");
const admin = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = admin();
  let quelle = "manuell";
  try {
    // Anmeldung neuer Leute (ohne Login): Zugang anfragen / persönlichen Code einlösen
    const vorab = await req.clone().json().catch(() => ({}));
    if (vorab?.zugang) return json(await zugang(db, vorab.zugang));
    // Zugriff: Zeitplan mit Geheimnis aus der Datenbank, sonst nur Admins
    const secret = req.headers.get("x-sync-secret");
    if (secret) {
      const { data } = await db.from("app_secrets").select("value").eq("name", "sync").maybeSingle();
      if (!data || data.value !== secret) return json({ code: "forbidden", message: "Kein Zugriff." }, 403);
      quelle = "zeitplan";
      // Nur lesen: Mails im Postfach suchen (z. B. um neue Mail-Arten wie Stornos kennenzulernen)
      const body = await req.json().catch(() => ({}));
      if (body?.suche) return json(await suche(String(body.suche), Math.min(+body.anzahl || 10, 25)));
      if (body?.nachholen) return json(await abruf(db, "nachholen", String(body.nachholen)));
      // Unterlagen/Zusagen für vorhandene Aufträge aus älteren Mails nachladen – legt keine neuen Aufträge an
      if (body?.ergaenzen) return json(await abruf(db, "ergaenzen", "", { abfrage: String(body.ergaenzen), nurBestehende: true }));
      if (body?.erinnerung) return json(await metaErinnerung(db, false));
    } else {
      const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
      });
      const body = await req.json().catch(() => ({}));
      // Benachrichtigungen: meta meldet „abholbereit“, oder Test an die eigenen Geräte (alle freigegebenen Nutzer)
      if (body?.abholbereit || body?.pushTest || body?.reklamation || body?.subBericht || body?.subFreigabe) {
        const { data: member } = await user.rpc("is_member");
        const { data: u } = await user.auth.getUser();
        if (!member || !u?.user) return json({ code: "approval_required", message: "Kein Zugriff." }, 403);
        if (body.reklamation) return json(await pushReklamation(db, String(body.reklamation)));
        if (body.subBericht) return json(await pushSubBericht(db, String(body.subBericht)));
        if (body.subFreigabe) return json(await pushSubFreigabe(db, String(body.subFreigabe)));
        return json(body.pushTest ? await pushTest(db, u.user.id) : await pushAbholbereit(db, String(body.abholbereit)));
      }
      const { data: owner } = await user.rpc("is_owner");
      if (!owner) return json({ code: "approval_required", message: "Nur Admins dürfen Mails abrufen." }, 403);
      // Admin: Erinnerung zum Testen sofort senden (an die eigene Adresse oder an alle Empfänger)
      if (body?.erinnerung) return json(await metaErinnerung(db, true, body.an ? String(body.an) : ""));
    }
    return json(await abruf(db, quelle));
  } catch (e: any) {
    console.error(e);
    return json({ code: e.code || "upstream_error", message: e.message || String(e) }, e.code === "server_not_connected" || e.code === "needs_reauth" ? 409 : 502);
  }
});

// ---------- Zugang für neue Leute: Code gibt JD Brüder persönlich heraus ----------
// Sammlung „zugang“ (nur für Admins lesbar), je E-Mail ein Eintrag: Name, Firma, Telefon, Wunsch,
// und – sobald der Chef ihn erzeugt hat – code, rolle, codeBis. Einlösen legt den Nutzer an, trägt die Rolle ein
// und gibt einen einmaligen Anmelde-Schlüssel zurück (es wird keine Mail verschickt).
const MAILRX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
async function nutzerIdVon(db: any, email: string) {
  const { data } = await db.from("profiles").select("id").ilike("email", email).limit(1);
  return data?.[0]?.id || "";
}
async function istBekannt(db: any, email: string) {
  const { data: adm } = await db.from("admin_emails").select("email").eq("email", email).limit(1);
  if (adm?.length) return true;
  const id = await nutzerIdVon(db, email);
  if (!id) return false;
  const { data: own } = await db.from("app_owner").select("id").eq("id", id).limit(1);
  if (own?.length) return true;
  const rollen = (await getDoc(db, "einstellungen", "rollen")) || {};
  return !!rollen.map?.[id];
}
async function zugang(db: any, z: any) {
  const email = String(z?.email || "").trim().toLowerCase();
  if (!MAILRX.test(email) || email.length > 120) return { fehler: "Bitte eine gültige E-Mail-Adresse eingeben." };
  const ex = await getDoc(db, "zugang", email);
  const kurz = (v: any, n = 80) => String(v || "").trim().slice(0, n);
  if (z.art === "pruefen") return { bekannt: await istBekannt(db, email), wartet: !!ex, hatCode: !!ex?.code };
  if (z.art === "anfrage") {
    if (!kurz(z.name)) return { fehler: "Bitte deinen Namen eintragen." };
    const wunsch = ["monteur", "sub", "hersteller"].includes(z.wunsch) ? z.wunsch : "sub";
    await setDoc(db, "zugang", email, { ...(ex || {}), email, name: kurz(z.name), firma: kurz(z.firma), tel: kurz(z.tel, 40), wunsch, am: Date.now() });
    if (!ex && !/@example\.(com|org)$/.test(email)) {
      try { await pushSenden(db, await chefIds(db), { titel: "Neue Anmeldung", text: `${kurz(z.name)}${kurz(z.firma) ? " (" + kurz(z.firma) + ")" : ""} möchte in die App – Code unter Setup erzeugen.`, url: "#setup" }); } catch (_) { /* Push ist optional */ }
    }
    return { wartet: true };
  }
  if (z.art === "einloesen") {
    const code = String(z.code || "").replace(/\D/g, "");
    if (!ex?.code) return { fehler: "Für diese Adresse gibt es noch keinen Code. JD Brüder gibt dir den Code persönlich." };
    if ((ex.versuche || 0) >= 5) return { fehler: "Zu viele falsche Versuche. Bitte bei JD Brüder einen neuen Code holen." };
    if (Date.now() > (ex.codeBis || 0)) return { fehler: "Der Code ist abgelaufen. Bitte bei JD Brüder einen neuen Code holen." };
    if (code !== String(ex.code)) {
      await setDoc(db, "zugang", email, { ...ex, versuche: (ex.versuche || 0) + 1 });
      return { fehler: "Der Code stimmt nicht." };
    }
    let id = await nutzerIdVon(db, email);
    if (!id) {
      const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true, user_metadata: { name: ex.name || "" } });
      if (error && !/already/i.test(error.message)) throw error;
      id = data?.user?.id || await nutzerIdVon(db, email);
    }
    if (!id) throw new Error("Nutzer konnte nicht angelegt werden.");
    if (ex.name) await db.from("profiles").update({ name: ex.name }).eq("id", id);
    const rollen = (await getDoc(db, "einstellungen", "rollen")) || {};
    const rolle = ["chef", "monteur", "sub", "hersteller"].includes(ex.rolle) ? ex.rolle : "monteur";
    await setDoc(db, "einstellungen", "rollen", { ...rollen, map: { ...(rollen.map || {}), [id]: rolle }, info: { ...(rollen.info || {}), [id]: { firma: ex.firma || "", name: ex.name || "", tel: ex.tel || "" } } });
    await db.from("docs").delete().match({ col: "zugang", id: email });
    await db.from("docs").delete().match({ col: "anfragen", id });
    const { data: link, error: le } = await db.auth.admin.generateLink({ type: "magiclink", email });
    if (le) throw le;
    return { ok: true, rolle, token_hash: link.properties.hashed_token };
  }
  return { fehler: "Unbekannte Aktion." };
}

// ---------- Handy-Benachrichtigungen (Web-Push) ----------
// Abos: Sammlung „push“ (je Gerät ein Eintrag mit uid und Push-Abo). Schlüssel: Secret VAPID_KEYS (JWK-Paar).
let pushServer: any = null;
async function pushServerHolen() {
  if (pushServer) return pushServer;
  const roh = Deno.env.get("VAPID_KEYS"); if (!roh) throw new Error("Benachrichtigungen sind noch nicht eingerichtet (VAPID_KEYS fehlt).");
  const keys = await webpush.importVapidKeys(JSON.parse(roh), { extractable: false });
  pushServer = await webpush.ApplicationServer.new({ contactInformation: "mailto:jd.brueder.meta@gmail.com", vapidKeys: keys });
  return pushServer;
}
async function pushSenden(db: any, uids: Set<string>, nachricht: { titel: string; text: string; url: string }) {
  const abos = Object.entries(await getCol(db, "push")).map(([id, a]: [string, any]) => ({ id, ...a })).filter((a: any) => uids.has(a.uid));
  const server = await pushServerHolen();
  let gesendet = 0;
  for (const a of abos) {
    try { await server.subscribe(a.sub).pushTextMessage(JSON.stringify(nachricht), { ttl: 24 * 3600, urgency: "high" }); gesendet++; }
    catch (e: any) { if (/\b(403|404|410)\b/.test(String(e?.response?.status ?? e?.message ?? ""))) await db.from("docs").delete().match({ col: "push", id: a.id }); }
  }
  return { gesendet, geraete: abos.length };
}
async function chefIds(db: any) {
  const rollen = (await getDoc(db, "einstellungen", "rollen")) || {};
  const { data } = await db.from("app_owner").select("id");
  return new Set<string>([...(data || []).map((r: any) => r.id), ...Object.entries(rollen.map || {}).filter(([, r]) => r === "chef").map(([id]) => id)]);
}
/** meta hat „abholbereit“ bestätigt → Chefs benachrichtigen (einmal je Bestätigung) */
async function pushAbholbereit(db: any, id: string) {
  const o = await getDoc(db, "auftraege", id);
  const b = o?.abholbereitBestaetigt;
  if (!o || o.prodStatus !== "abholbereit" || !b?.am) return { gesendet: 0, grund: "nicht abholbereit" };
  if (Date.now() - b.am > 15 * 60_000) return { gesendet: 0, grund: "Bestätigung zu alt" };
  if (o.abholbereitGemeldetAm && o.abholbereitGemeldetAm >= b.am) return { gesendet: 0, grund: "schon gemeldet" };
  await updDoc(db, "auftraege", id, { abholbereitGemeldetAm: Date.now() });
  const r = await pushSenden(db, await chefIds(db), {
    titel: `Abholbereit: ${o.nr}`,
    text: [o.bauvorhaben, o.plzOrt].filter(Boolean).join(", ") + (b.name ? `\nBestätigt von ${b.name}` : ""),
    url: APP_URL + "#a-" + id,
  });
  return r;
}
/** Neue Reklamation (oder Leerfahrt) → Chefs sofort benachrichtigen (einmal je Reklamation) */
const URSACHEN_TEXT: Record<string, string> = { selbst: "Selbst verursacht", baustelle: "Baustelle nicht montagefertig", teile: "Fehlerhafte Teile", sonst: "Sonstiges" };
async function pushReklamation(db: any, rid: string) {
  const r = await getDoc(db, "reklamationen", rid);
  if (!r || !r.am || Date.now() - r.am > 15 * 60_000) return { gesendet: 0, grund: "nicht gefunden oder zu alt" };
  if (r.gemeldetAm) return { gesendet: 0, grund: "schon gemeldet" };
  await updDoc(db, "reklamationen", rid, { gemeldetAm: Date.now() });
  const o = (await getDoc(db, "auftraege", r.auftragId)) || {};
  const rollen = (await getDoc(db, "einstellungen", "rollen")) || {};
  const von = rollen.info?.[r.von]?.firma || rollen.info?.[r.von]?.name || "";
  return await pushSenden(db, await chefIds(db), {
    titel: `${r.leerfahrt ? "Leerfahrt" : "Reklamation"}: ${o.nr || r.auftragId}`,
    text: `${URSACHEN_TEXT[r.ursache] || r.ursache || ""}${von ? " · " + von : ""}
${String(r.text || "").slice(0, 140)}`,
    url: APP_URL + "#a-" + r.auftragId,
  });
}
/** Subunternehmer hat seinen Bericht abgeschlossen → Chefs: bitte prüfen */
async function pushSubBericht(db: any, id: string) {
  const o = await getDoc(db, "auftraege", id);
  if (!o || o.berichtStatus !== "pruefung" || !o.abschluss?.am || Date.now() - o.abschluss.am > 15 * 60_000) return { gesendet: 0, grund: "nicht zur Prüfung" };
  if (o.subBerichtGemeldetAm && o.subBerichtGemeldetAm >= o.abschluss.am) return { gesendet: 0, grund: "schon gemeldet" };
  await updDoc(db, "auftraege", id, { subBerichtGemeldetAm: Date.now() });
  const rollen = (await getDoc(db, "einstellungen", "rollen")) || {};
  const von = rollen.info?.[o.berichtVonSub]?.firma || rollen.info?.[o.berichtVonSub]?.name || "Subunternehmer";
  return await pushSenden(db, await chefIds(db), {
    titel: `Bericht zu prüfen: ${o.nr}`,
    text: `${von} hat den Montagebericht abgeschlossen${o.bauvorhaben ? " – " + o.bauvorhaben : ""}. Bitte prüfen und freigeben.`,
    url: APP_URL + "#a-" + id,
  });
}
/** Chef hat den Bericht freigegeben → Subunternehmer: Rechnung schreiben */
async function pushSubFreigabe(db: any, id: string) {
  const o = await getDoc(db, "auftraege", id);
  if (!o?.subGeprueftAm || !o.berichtVonSub || Date.now() - o.subGeprueftAm > 15 * 60_000) return { gesendet: 0, grund: "keine neue Freigabe" };
  if (o.subFreigabeGemeldetAm && o.subFreigabeGemeldetAm >= o.subGeprueftAm) return { gesendet: 0, grund: "schon gemeldet" };
  await updDoc(db, "auftraege", id, { subFreigabeGemeldetAm: Date.now() });
  return await pushSenden(db, new Set([o.berichtVonSub]), {
    titel: `Freigegeben: ${o.nr}`,
    text: `JD Brüder hat deinen Bericht${o.bauvorhaben ? " (" + o.bauvorhaben + ")" : ""} geprüft. Du kannst jetzt deine Rechnung schreiben – Betrag siehe „Abrechnung“.`,
    url: APP_URL + "#meine",
  });
}
async function pushTest(db: any, uid: string) {
  return await pushSenden(db, new Set([uid]), { titel: "Benachrichtigungen sind an ✓", text: "Du bekommst Bescheid, sobald meta einen Auftrag als abholbereit meldet.", url: APP_URL });
}

// ---------- Morgendliche Erinnerung an meta ----------
// Einstellungen in einstellungen/allgemein.metaErinnerung = { aktiv, an: "a@meta.de, b@meta.de", uhrzeit: 7, tage: "werktags" }
const APP_URL = "https://jdbrueder-collab.github.io/jd-montage/";
const berlin = (d = new Date()) => {
  const t = Object.fromEntries(new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short", hour12: false }).formatToParts(d).map((p) => [p.type, p.value]));
  return { datum: `${t.year}-${t.month}-${t.day}`, stunde: +t.hour, wochentag: t.weekday };
};
async function metaErinnerung(db: any, sofort: boolean, testAn = "") {
  const settings = (await getDoc(db, "einstellungen", "allgemein")) || {};
  const e = settings.metaErinnerung || {};
  const jetzt = berlin();
  if (!sofort) {
    if (!e.aktiv) return { gesendet: false, grund: "ausgeschaltet" };
    if (jetzt.stunde !== (+e.uhrzeit || 7)) return { gesendet: false, grund: "nicht die eingestellte Uhrzeit" };
    if (/^(Sa|So)/.test(jetzt.wochentag) && (e.tage || "werktags") === "werktags") return { gesendet: false, grund: "Wochenende" };
    if (e.zuletzt === jetzt.datum) return { gesendet: false, grund: "heute schon gesendet" };
  }
  const an = (testAn || e.an || "").split(/[,;\s]+/).map((x: string) => x.trim()).filter((x: string) => /^\S+@\S+\.\S+$/.test(x));
  if (!an.length) return { gesendet: false, grund: "keine Empfänger eingetragen" };
  const orders = await getCol(db, "auftraege");
  const offen = Object.values(orders).filter((o: any) => !o.storniert && !o.abschluss && !o.abholbereitBestaetigt)
    .sort((a: any, b: any) => ((a.jahr || 0) * 100 + (a.kw || 0)) - ((b.jahr || 0) * 100 + (b.kw || 0)) || String(a.nr).localeCompare(String(b.nr), "de", { numeric: true }));
  const firma = settings.monteurName || "JD Brüder GbR";
  const text = `Guten Morgen,

bitte prüfen Sie heute in unserer Auftragsliste, welche Aufträge fertig produziert und abholbereit sind, und tippen Sie dort bei diesen Aufträgen auf „Abholbereit“ (mit Ihrem Namen bestätigen).

Zur Auftragsliste: ${APP_URL}

${offen.length ? `Noch offen (${offen.length}):\n${offen.map((o: any) => `- ${o.nr}${o.bauvorhaben ? " – " + o.bauvorhaben : ""}${o.kw ? ` (KW ${o.kw})` : ""}`).join("\n")}` : "Aktuell sind alle Aufträge als abholbereit gemeldet. Vielen Dank!"}

Vielen Dank!

Mit freundlichen Grüßen
${firma}`;
  const betreff = `Bitte prüfen: abholbereite Aufträge für ${firma} – ${new Date().toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" })}`;
  await gmail("messages/send", { method: "POST", body: JSON.stringify({ raw: mime({ to: an, subject: betreff, body: text }) }) });
  if (!testAn) await updDoc(db, "einstellungen", "allgemein", { metaErinnerung: { ...e, zuletzt: jetzt.datum, zuletztAm: Date.now(), zuletztAn: an.length, zuletztOffen: offen.length } });
  return { gesendet: true, an, offen: offen.length };
}

async function suche(q: string, anzahl: number) {
  const list = await gmail(`threads?q=${encodeURIComponent(q)}&maxResults=${anzahl}`);
  const out = [];
  for (const t of list.threads || []) {
    const th = await gmail(`threads/${t.id}?format=full`);
    for (const raw of th.messages || []) {
      const m = message(raw);
      const html = (m.htmlBody || "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<\/(td|th)>/gi, " | ").replace(/<\/(tr|p|div)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
      out.push({ datum: m.date, von: m.sender, betreff: m.subject, text: (m.plaintextBody || "").slice(0, 1500), html: html.slice(0, 3000), anhaenge: m.attachments.map((a: any) => a.filename) });
    }
  }
  return { postfach: (await gmail("profile")).emailAddress, anzahl: out.length, mails: out };
}

// ---------- Datenbank-Helfer (Tabelle docs: col/id/data) ----------
async function getDoc(db: any, col: string, id: string) {
  const { data } = await db.from("docs").select("data").eq("col", col).eq("id", id).maybeSingle();
  return data?.data ?? null;
}
async function getCol(db: any, col: string) {
  const out: Record<string, any> = {}; let from = 0;
  for (;;) {
    const { data, error } = await db.from("docs").select("id,data").eq("col", col).range(from, from + 999);
    if (error) throw error;
    (data || []).forEach((r: any) => (out[r.id] = r.data));
    if (!data || data.length < 1000) return out;
    from += 1000;
  }
}
async function setDoc(db: any, col: string, id: string, data: any) {
  const { error } = await db.from("docs").upsert({ col, id, data, updated_at: new Date().toISOString() });
  if (error) throw error;
}
async function updDoc(db: any, col: string, id: string, patch: any) {
  const { error } = await db.rpc("doc_update", { p_col: col, p_id: id, p_patch: { ...patch, geaendertAm: Date.now() } });
  if (error) throw error;
}

// ---------- Abruf ----------
async function abruf(db: any, quelle: string, nachholen = "", opt: { abfrage?: string; nurBestehende?: boolean } = {}) {
  const start = Date.now();
  const log: string[] = [];
  const zeit = () => Date.now() - start > MAX_LAUFZEIT;

  const st = (await getDoc(db, "mails", "status")) || {};
  st.threads = st.threads || {}; st.msgs = st.msgs || {}; st.erg = st.erg || {};
  if (st.lauf && Date.now() - st.lauf < SPERRE && quelle === "zeitplan") return { log: ["Läuft gerade schon – übersprungen."], uebersprungen: true };
  await updDoc(db, "mails", "status", { lauf: Date.now() });

  const settings = (await getDoc(db, "einstellungen", "allgemein")) || {};
  // Beim Nachholen werden die gefundenen Mails erneut ausgewertet, auch wenn sie schon gelesen wurden
  const query = opt.abfrage || nachholen || settings.gmailQuery || DEFAULT_QUERY;
  const orders = await getCol(db, "auftraege");
  const fin = await getCol(db, "finanzen");
  const z: any = { neu: 0, aktualisiert: 0, abrechnungen: 0, dateien: 0, gelesen: 0, fehler: 0, storniert: 0 };
  let weitere = false;
  let postfach = "";
  // Ein Verlauf gilt erst als erledigt, wenn alle seine Nachrichten verarbeitet sind
  const offen: { id: string; historyId: string; ids: string[] }[] = [];
  const verlaeufeAbhaken = () => { for (const t of offen) if (t.ids.every((i) => st.msgs[i])) st.threads[t.id] = t.historyId || true; };

  try {
    // Gelesen wird nur das mit der App verbundene Postfach (jd.brueder.meta@gmail.com)
    postfach = (await gmail("profile")).emailAddress || "";
    log.push(`Postfach: ${postfach}`);
    // 1. Mail-Verläufe suchen (alle Seiten)
    const threads: any[] = []; let pageToken = "";
    do {
      const list = await gmail(`threads?q=${encodeURIComponent(query)}&maxResults=100${pageToken ? "&pageToken=" + pageToken : ""}`);
      threads.push(...(list.threads || []));
      pageToken = list.nextPageToken || "";
    } while (pageToken && threads.length < 500);
    log.push(`${threads.length} Mail-Verläufe gefunden (${query}).`);

    // 2. Neue Nachrichten einsammeln – älteste zuerst, damit neuere Infos gewinnen
    const neu: any[] = [];
    for (const t of threads.reverse()) {
      if (zeit() || neu.length >= MAX_NACHRICHTEN) { weitere = true; break; }
      if (!nachholen && !opt.nurBestehende && st.threads[t.id] && t.historyId && st.threads[t.id] === t.historyId) continue;
      const th = await gmail(`threads/${t.id}?format=full`);
      const ids = (th.messages || []).map((r: any) => r.id);
      for (const raw of th.messages || []) {
        if (opt.nurBestehende) {
          // Ergänzen: nur Zusagen/Dispo-Mails, die hierbei noch nicht vollständig übernommen wurden
          if (st.erg[raw.id]) continue;
          const mm = message(raw); const t0 = art(mm);
          if (istEigenerBericht(mm) || (vonMeta(mm) && (t0 === "zusage" || t0 === "dispo" || t0 === "abrechnung"))) neu.push(mm); else st.erg[raw.id] = 1;
        } else if (nachholen || !st.msgs[raw.id]) neu.push(message(raw));
      }
      offen.push({ id: t.id, historyId: th.historyId || t.historyId, ids });
    }
    neu.sort((a, b) => +new Date(a.date) - +new Date(b.date));
    log.push(`${neu.length} neue Nachrichten.`);

    // 3. Verarbeiten
    const lesen = new Set<string>(); // Aufträge, deren Unterlagen Claude lesen soll
    for (const m of neu) {
      if (zeit()) { weitere = true; break; }
      if (opt.nurBestehende) st.erg[m.id] = 1;
      try {
        // Eigener Montagebericht an meta (auch direkt aus Gmail gesendet) → Auftrag ist erledigt
        if (istEigenerBericht(m)) {
          const nr = nrAusMail(m); const id = nr ? findeAuftrag(orders, nr) : null;
          if (id && orders[id].berichtStatus !== "gesendet") {
            const d0 = +new Date(m.date);
            const p: any = { berichtStatus: "gesendet", berichtGesendetAm: d0, berichtAn: "montagebericht@meta.de", berichtQuelle: "mail" };
            if (!orders[id].abschluss) p.abschluss = { typ: "ok", am: d0, by: null, quelle: "mail" };
            await updDoc(db, "auftraege", id, p); Object.assign(orders[id], p); z.aktualisiert++;
            log.push(`📤 Montagebericht gesendet: Auftrag ${orders[id].nr} → erledigt`);
          }
          st.msgs[m.id] = 1; continue;
        }
        if (!vonMeta(m)) { st.msgs[m.id] = 1; continue; }
        const typ = art(m);
        const d = +new Date(m.date);
        // Ergänzen: nur Montagezusagen und Unterlagen der Disposition (ältere Übersichten würden neuere Angaben überschreiben)
        if (opt.nurBestehende && typ !== "zusage" && typ !== "dispo" && typ !== "abrechnung") { st.msgs[m.id] = 1; continue; }
        if (typ === "uebersicht") {
          const rows = parseUebersicht(m, parseHTML);
          log.push(`📋 Wochenübersicht ${new Date(m.date).toLocaleDateString("de-DE")}: ${rows.length} Aufträge`);
          for (const r of rows) {
            const id = idOf(r.nr); const ex = orders[id];
            if (!ex) {
              const doc = { ...r, terminStatus: "zu_terminieren", prodStatus: /nicht/i.test(r.versand) ? "in_produktion" : "abholbereit", erstelltAm: Date.now(), quelle: "mail", uebersichtAm: d };
              await setDoc(db, "auftraege", id, doc); orders[id] = doc; z.neu++;
            } else {
              const p: any = {};
              ["vorgang", "bauvorhaben", "plzOrt", "kabinen", "versand", "kw", "jahr"].forEach((k) => { if (r[k] && r[k] !== ex[k]) p[k] = r[k]; });
              if (p.versand && !/nicht/i.test(p.versand) && (!ex.prodStatus || ["offen", "in_produktion", "produziert"].includes(ex.prodStatus))) p.prodStatus = "abholbereit";
              if (Object.keys(p).length) { await updDoc(db, "auftraege", id, { ...p, uebersichtAm: d }); Object.assign(ex, p); z.aktualisiert++; }
            }
          }
        } else if (typ === "zusage") {
          const zs = parseZusage(m);
          if (zs) {
            const id = findeAuftrag(orders, zs.nr) || idOf(zs.nr);
            const data: any = { kw: zs.kw, jahr: zs.jahr, zusage: true, abholung: zs.abholung, zusageMail: { msgId: m.id, viewUrl: m.viewUrl || "", am: d } };
            if (zs.kabinen) data.kabinen = zs.kabinen;
            // neue Montagezusage nach einem Widerruf/Storno: Auftrag ist wieder aktiv
            if (orders[id]?.storniert && (orders[id].storniert.am || 0) < d) { data.storniert = null; data.stornoAufgehobenAm = d; }
            if (!orders[id] && opt.nurBestehende) { st.msgs[m.id] = 1; continue; }
            if (!orders[id]) { const doc = { nr: zs.nr, ...data, terminStatus: "zu_terminieren", prodStatus: "in_produktion", erstelltAm: Date.now(), quelle: "mail" }; await setDoc(db, "auftraege", id, doc); orders[id] = doc; z.neu++; }
            else if (!((orders[id].zusageMail?.am || 0) > d)) { await updDoc(db, "auftraege", id, data); Object.assign(orders[id], data); z.aktualisiert++; }
            const n = await anhaenge(db, m, id, log, z);
            if (n) lesen.add(id);
            log.push(`✅ Montagezusage ${zs.nr} für KW ${zs.kw}${n ? ` – ${n} Unterlage(n)` : ""}`);
          }
        } else if (typ === "abrechnung") {
          const a = parseAbrechnung(m, parseHTML);
          if (a.nr && a.summe) {
            const id = findeAuftrag(orders, a.nr) || idOf(a.nr); const ex = fin[id];
            if (!orders[id] && opt.nurBestehende && !mitAbgerechnet(a.nr, a.bemerkung, orders).length) { st.msgs[m.id] = 1; continue; }
            // Nur die Sichtabnahme wurde vergütet: eigener Eintrag, der Auftrag gilt dadurch NICHT als abgerechnet
            if (istAbnahmeVerguetung(a)) {
              const fid = id + "~abnahme"; const exA = fin[fid];
              if (!exA || (exA.datum || 0) <= d) {
                const doc = { nr: a.nr, auftragId: id, art: "abnahme", bauvorhaben: a.bv, summe: a.summe, positionen: a.positionen, bemerkung: a.bemerkung, datum: d, mailId: m.id, rechnungStatus: exA?.rechnungStatus || "offen", rechnungsNr: exA?.rechnungsNr || "", quelle: "mail" };
                await setDoc(db, "finanzen", fid, doc); fin[fid] = doc;
              }
              if (orders[id]) { const p = { abnahmeVerguetet: { summe: a.summe, am: d } }; await updDoc(db, "auftraege", id, p); Object.assign(orders[id], p); z.aktualisiert++; }
              z.abrechnungen++; log.push(`💶 Sichtabnahme vergütet ${a.nr}: ${a.summe.toFixed(2)} € (keine Montage-Abrechnung)`);
              st.msgs[m.id] = 1; continue;
            }
            // Abrechnung nur für andere Aufträge (Bemerkung nennt z. B. „R-47197/R-47143“, nicht die eigene Nummer):
            // Geld gehört zu den genannten Aufträgen, der Auftrag selbst ist dadurch NICHT abgerechnet
            const mit = mitAbgerechnet(a.nr, a.bemerkung, orders);
            if (mit.length && !mit.includes(id) && /\d{4,6}/.test(String(a.bemerkung || ""))) {
              const fid = id + "~fuer"; const exF = fin[fid];
              if (!exF || (exF.datum || 0) <= d) {
                const doc = { nr: a.nr, auftragId: id, art: "andere", fuer: mit.map((r) => orders[r].nr || r), bauvorhaben: a.bv, summe: a.summe, positionen: a.positionen, bemerkung: a.bemerkung, datum: d, mailId: m.id, rechnungStatus: exF?.rechnungStatus || "offen", rechnungsNr: exF?.rechnungsNr || "", quelle: "mail" };
                await setDoc(db, "finanzen", fid, doc); fin[fid] = doc;
              }
              for (const rid of mit) {
                if (orders[rid].abgerechnet) continue;
                const p = { abgerechnet: true, abgerechnetMit: a.nr, abgerechnetAm: d };
                await updDoc(db, "auftraege", rid, p); Object.assign(orders[rid], p); z.aktualisiert++;
                log.push(`💶 ${orders[rid].nr} ist in der Abrechnung ${a.nr} enthalten → erledigt`);
              }
              z.abrechnungen++; log.push(`💶 Abrechnung ${a.nr} (für ${mit.map((r) => orders[r].nr || r).join(", ")}): ${a.summe.toFixed(2)} €`);
              st.msgs[m.id] = 1; continue;
            }
            if (!ex || (ex.datum || 0) <= d) {
              const doc = { nr: a.nr, bauvorhaben: a.bv, summe: a.summe, positionen: a.positionen, bemerkung: a.bemerkung, datum: d, mailId: m.id, rechnungStatus: ex?.rechnungStatus || "offen", rechnungsNr: ex?.rechnungsNr || "", quelle: "mail" };
              await setDoc(db, "finanzen", id, doc); fin[id] = doc;
            }
            if (!orders[id]) { const bv = splitBV(a.bv); const doc = { nr: a.nr, bauvorhaben: bv.bauvorhaben, plzOrt: bv.plzOrt, terminStatus: "fest", prodStatus: "abholbereit", erstelltAm: Date.now(), quelle: "mail", abgerechnet: true, abschluss: { typ: "ok", am: d, by: null }, berichtStatus: "gesendet", berichtGesendetAm: d }; await setDoc(db, "auftraege", id, doc); orders[id] = doc; }
            else if (!orders[id].abgerechnet) await updDoc(db, "auftraege", id, { abgerechnet: true });
            // In der Bemerkung genannte Aufträge sind mit abgerechnet (z. B. „/1 + /2 + /3 + 5 kompett“)
            for (const rid of mitAbgerechnet(a.nr, a.bemerkung, orders)) {
              if (rid === id || orders[rid].abgerechnet) continue;
              const p = { abgerechnet: true, abgerechnetMit: a.nr, abgerechnetAm: d };
              await updDoc(db, "auftraege", rid, p); Object.assign(orders[rid], p); z.aktualisiert++;
              log.push(`💶 ${orders[rid].nr} ist in der Abrechnung ${a.nr} enthalten → erledigt`);
            }
            z.abrechnungen++; log.push(`💶 Abrechnung ${a.nr}: ${a.summe.toFixed(2)} €`);
          } else if (a.nr) log.push(`⚠ Abrechnung ${a.nr}: Summe nicht lesbar`);
        } else if (typ === "storno") {
          // Auftrag wurde von meta storniert: kennzeichnen (bleibt sichtbar unter „Storniert“)
          const nr = nrAusMail(m);
          if (!nr) { log.push(`⚠ Storno-Mail „${cleanSubject(m.subject)}“ ohne Auftragsnummer – bitte von Hand markieren`); }
          else {
            const id = findeAuftrag(orders, nr) || idOf(nr);
            const grund = eigenerText(m).replace(/^\s*Sehr geehrte[^\n]*\n/i, "").replace(/\s+\n/g, "\n").trim().slice(0, 600);
            const storniert = { am: d, quelle: "mail", betreff: cleanSubject(m.subject), grund, mailId: m.id, widerruf: /Widerruf/i.test(m.subject || "") };
            // Gibt es schon eine neuere Montagezusage? Dann ist der Widerruf überholt.
            if (orders[id] && (orders[id].zusageMail?.am || 0) > d) {
              log.push(`↩ Widerruf ${orders[id].nr || nr} übersprungen – danach kam eine neue Montagezusage`);
            } else {
              if (!orders[id]) { const doc = { nr, storniert, terminStatus: "zu_terminieren", prodStatus: "offen", erstelltAm: Date.now(), quelle: "mail-storno" }; await setDoc(db, "auftraege", id, doc); orders[id] = doc; z.neu++; }
              else if (!orders[id].storniert) { await updDoc(db, "auftraege", id, { storniert }); orders[id].storniert = storniert; z.aktualisiert++; }
              z.storniert = (z.storniert || 0) + 1;
              log.push(`❌ Storniert: Auftrag ${orders[id].nr || nr}`);
            }
          }
        } else if (typ === "dispo") {
          // Reklamation abgerechnet: meta schickt im Verlauf „R 47006“ die Aufstellung (Bild) oder den Betrag → erledigt
          const rk = reklaAufstellung(m);
          if (rk) {
            const id = findeAuftrag(orders, rk.nr);
            if (id) {
              if (!orders[id].abgerechnet) {
                const p = { abgerechnet: true, abgerechnetMit: "Aufstellung von meta", abgerechnetAm: d };
                await updDoc(db, "auftraege", id, p); Object.assign(orders[id], p); z.aktualisiert++;
                log.push(`💶 Reklamation ${orders[id].nr}: Aufstellung von meta → erledigt`);
              }
              const ex = fin[id];
              if (rk.summe && (!ex || (ex.datum || 0) <= d)) {
                const doc = { nr: orders[id].nr || rk.nr, bauvorhaben: orders[id].bauvorhaben || "", summe: rk.summe, positionen: [], bemerkung: "Aufstellung von meta per Mail", datum: d, mailId: m.id, rechnungStatus: ex?.rechnungStatus || "offen", rechnungsNr: ex?.rechnungsNr || "", quelle: "mail" };
                await setDoc(db, "finanzen", id, doc); fin[id] = doc; z.abrechnungen++;
              }
            }
            st.msgs[m.id] = 1; continue;
          }
          // Disposition: z. B. „Auftrag Nr. 16872“ oder „15845 KW 18“ mit Dokumente.pdf
          const att = unterlagen(m);
          if (!att.length) { st.msgs[m.id] = 1; continue; }
          const nr = nrAusMail(m);
          let id = nr ? findeAuftrag(orders, nr) || idOf(nr) : "";
          if (!id && opt.nurBestehende) { st.msgs[m.id] = 1; continue; }
          if (!id) {
            // Nummer steht nur in den Unterlagen: Claude liest sie vom Deckblatt
            const res = await deckblatt(m, att, log);
            const fnr = String(res?.fertigungsNr || "").trim();
            if (!fnr) { log.push(`⚠ „${cleanSubject(m.subject)}“: keine Auftragsnummer gefunden – bitte von Hand zuordnen`); st.msgs[m.id] = 1; continue; }
            id = findeAuftrag(orders, fnr) || idOf(fnr);
            if (!orders[id]) { const doc = { nr: fnr, terminStatus: "zu_terminieren", prodStatus: "offen", erstelltAm: Date.now(), quelle: "mail-dispo", anfrageAm: d, anfrageBetreff: cleanSubject(m.subject) }; await setDoc(db, "auftraege", id, doc); orders[id] = doc; z.neu++; }
            await deckblattUebernehmen(db, id, orders[id], res); z.gelesen++;
            await anhaenge(db, m, id, log, z);
          } else {
            const kw = kwAusMail(m);
            if (!orders[id] && opt.nurBestehende) { st.msgs[m.id] = 1; continue; }
            if (!orders[id]) {
              const doc: any = { nr, terminStatus: "zu_terminieren", prodStatus: "offen", erstelltAm: Date.now(), quelle: "mail-dispo", anfrageAm: d, anfrageBetreff: cleanSubject(m.subject) };
              if (kw) Object.assign(doc, kw);
              await setDoc(db, "auftraege", id, doc); orders[id] = doc; z.neu++;
              log.push(`📨 Neue Anfrage von meta: Auftrag ${nr}${kw ? ` (KW ${kw.kw})` : ""}`);
            } else if (kw && !orders[id].kw) { await updDoc(db, "auftraege", id, kw); Object.assign(orders[id], kw); z.aktualisiert++; }
            const n = await anhaenge(db, m, id, log, z);
            if (n) { lesen.add(id); log.push(`📎 ${n} Unterlage(n) zu Auftrag ${orders[id].nr || nr}`); }
          }
        }
        st.msgs[m.id] = 1;
      } catch (e: any) {
        // Dateigrenze erreicht: Mail NICHT abhaken, im nächsten Lauf weiter (schon gespeicherte Anhänge werden erkannt)
        // … ebenso, wenn Google das Minuten-Kontingent für Gmail erreicht hat
        if (e.voll || /quota exceeded|rate ?limit|too many requests/i.test(String(e.message || e))) {
          if (!e.voll) log.push(`⏳ Gmail-Kontingent erreicht – „${m.subject}“ kommt im nächsten Lauf`);
          delete st.msgs[m.id]; delete st.erg[m.id]; weitere = true; break;
        }
        z.fehler++; log.push(`⚠ Fehler bei „${m.subject}“: ${e.message || e}`);
        if (e.code === "server_not_connected" || e.code === "needs_reauth") throw e;
      }
      verlaeufeAbhaken();
      await updDoc(db, "mails", "status", { threads: st.threads, msgs: st.msgs, erg: st.erg, lauf: Date.now() });
    }

    // 4. Deckblatt lesen: neue Unterlagen → leere Felder im Auftrag füllen
    for (const id of lesen) {
      if (zeit()) { weitere = true; break; }
      try {
        const n = await deckblattAusGespeicherten(db, id, orders[id], log);
        if (n >= 0) z.gelesen++;
      } catch (e: any) { log.push(`⚠ Deckblatt ${orders[id]?.nr}: ${e.message || e}`); }
    }
  } finally {
    verlaeufeAbhaken();
    const ergebnis = { am: Date.now(), quelle, postfach, ...z, weitere };
    await updDoc(db, "mails", "status", { threads: st.threads, msgs: st.msgs, erg: st.erg, lauf: null, letzterLauf: ergebnis });
    await updDoc(db, "einstellungen", "allgemein", { letzterAbruf: Date.now(), autoAbruf: ergebnis });
  }
  log.push(`\nFertig: ${z.neu} neu, ${z.aktualisiert} aktualisiert, ${z.abrechnungen} Abrechnungen, ${z.dateien} Unterlagen gespeichert, ${z.gelesen} Deckblätter gelesen.${weitere ? " Weitere Mails folgen beim nächsten Abruf." : ""}`);
  return { log, ...z, weitere };
}

// ---------- Anhänge ----------
async function laden(m: any, a: any) {
  const d = await gmail(`messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(a.id)}`);
  const b64 = b64urlToStd(d.data);
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, b64 };
}
const typVon = (a: any) => (/\.pdf$/i.test(a.filename || "") ? "application/pdf" : a.mimeType || "application/octet-stream");

/** Speichert die Unterlagen einer Mail im Auftrag (ohne Doppelte) */
async function anhaenge(db: any, m: any, auftragId: string, log: string[], z: any) {
  const att = unterlagen(m); if (!att.length) return 0;
  const { data: vorhanden } = await db.from("docs").select("data").eq("col", "fotos").eq("data->>auftragId", auftragId);
  const have = new Set((vorhanden || []).map((r: any) => r.data?.mailAtt).filter(Boolean));
  let n = 0;
  for (const a of att) {
    if (z.dateien >= MAX_DATEIEN) { const e: any = new Error("Dateigrenze für diesen Lauf erreicht"); e.voll = true; throw e; }
    const key = (a.filename || "") + "|" + m.id;
    if (have.has(key)) continue;
    const { bytes } = await laden(m, a);
    const assetId = crypto.randomUUID(); const typ = typVon(a);
    const { error } = await db.storage.from("assets").upload(assetId, bytes, { contentType: typ });
    if (error) throw error;
    await setDoc(db, "fotos", crypto.randomUUID(), { auftragId, kat: "unterlagen", assetId, name: a.filename || "", typ, mailAtt: key, mailId: m.id, am: Date.now(), von: null, quelle: "mail" });
    have.add(key); n++; z.dateien++;
  }
  return n;
}

// ---------- Claude liest das Deckblatt ----------
async function claudeLiest(blocks: any[]) {
  if (!Deno.env.get("ANTHROPIC_API_KEY") || !blocks.length) return null;
  const client = new Anthropic();
  const res = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium" },
    system: "Du hilfst der Montage-App von JD Brüder. Antworte ausschließlich mit einem einzigen gültigen JSON-Objekt, ohne Erklärung und ohne Markdown. Felder, die du nicht sicher erkennst, lässt du leer statt zu raten.",
    messages: [{ role: "user", content: [...blocks, { type: "text", text: DECK_PROMPT }] }],
  } as any);
  const text = (res.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("");
  const mm = text.match(/\{[\s\S]*\}/);
  return mm ? JSON.parse(mm[0]) : null;
}
const block = (typ: string, b64: string) =>
  typ === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : { type: "image", source: { type: "base64", media_type: typ, data: b64 } };

/** Direkt aus den Mail-Anhängen lesen (wenn die Auftragsnummer noch unbekannt ist) */
async function deckblatt(m: any, att: any[], log: string[]) {
  const blocks: any[] = []; let groesse = 0;
  for (const a of att.slice(0, 4)) {
    const { b64 } = await laden(m, a);
    if (groesse + b64.length > 25_000_000) break;
    groesse += b64.length; blocks.push(block(typVon(a), b64));
  }
  try { return await claudeLiest(blocks); } catch (e: any) { log.push(`⚠ Deckblatt nicht gelesen: ${e.message || e}`); return null; }
}

/** Aus den gespeicherten Unterlagen eines Auftrags lesen */
async function deckblattAusGespeicherten(db: any, id: string, o: any, log: string[]) {
  if (!Deno.env.get("ANTHROPIC_API_KEY")) return -1;
  const { data } = await db.from("docs").select("data").eq("col", "fotos").eq("data->>auftragId", id).eq("data->>kat", "unterlagen");
  const files = (data || []).map((r: any) => r.data).filter((f: any) => /pdf|image/.test(f.typ || ""))
    .sort((a: any, b: any) => (/pdf/.test(b.typ) ? 1 : 0) - (/pdf/.test(a.typ) ? 1 : 0)).slice(0, 4);
  const blocks: any[] = []; let groesse = 0;
  for (const f of files) {
    const { data: blob } = await db.storage.from("assets").download(f.assetId);
    if (!blob) continue;
    const u8 = new Uint8Array(await blob.arrayBuffer()); let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    const b64 = btoa(s);
    if (groesse + b64.length > 25_000_000) break;
    groesse += b64.length; blocks.push(block(f.typ, b64));
  }
  const res = await claudeLiest(blocks);
  const n = await deckblattUebernehmen(db, id, o, res);
  log.push(`🔎 Deckblatt ${o?.nr || id}: ${n} Felder übernommen`);
  return n;
}

/** Nur leere Felder füllen – von Hand Eingetragenes bleibt */
async function deckblattUebernehmen(db: any, id: string, o: any, res: any) {
  if (!res || !o) return 0;
  const p: any = {};
  for (const k of DECK_FELDER) { const v = String(res[k] ?? "").trim(); if (v && v !== "-" && !o[k]) p[k] = v; }
  if (!o.bauvorhaben && res.bauvorhabenName) p.bauvorhaben = String(res.bauvorhabenName).trim();
  if (!o.plzOrt && res.adresse) { const m = String(res.adresse).match(/(\d{5}\s+[^,]+)$/); if (m) p.plzOrt = m[1].trim(); }
  if (!o.kw && parseInt(res.kw, 10)) p.kw = parseInt(res.kw, 10);
  // Was Claude nicht sicher lesen konnte (oder was fehlt) – die App zeigt dort „bitte im Dokument nachsehen“
  const unsicher = (Array.isArray(res.unsicher) ? res.unsicher : []).map(String).filter((k: string) => [...DECK_FELDER, "bauvorhabenName"].includes(k));
  for (const k of ["bauleiterTel", "adresse"]) if (!o[k] && !p[k] && !unsicher.includes(k)) unsicher.push(k);
  p.deckUnsicher = unsicher;
  await updDoc(db, "auftraege", id, { ...p, deckblattGelesenAm: Date.now() }); Object.assign(o, p);
  return Object.keys(p).filter((k) => k !== "deckUnsicher").length;
}
