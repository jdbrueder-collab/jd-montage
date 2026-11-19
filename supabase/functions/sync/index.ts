// Automatischer Mail-Abruf für die Montage-App.
// Läuft alle 15 Minuten über den Zeitplan in der Datenbank (pg_cron) und auf Knopfdruck durch Admins.
// Holt meta-Mails aus dem verbundenen Postfach, legt Aufträge an / aktualisiert sie, speichert
// PDF- und Bild-Anhänge im Auftrag und lässt Claude das Aufmaß-Deckblatt auslesen.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "jsr:@supabase/supabase-js@2.119.1";
import { DOMParser } from "npm:linkedom@0.18.5";
import { b64urlToStd, gmail, message, mime } from "../_shared/gmail.ts";
import {
  art, cleanSubject, DECK_FELDER, DECK_PROMPT, eigenerText, findeAuftrag, idOf, kwAusMail, nrAusMail,
  parseAbrechnung, parseUebersicht, parseZusage, splitBV, unterlagen, vonMeta,
} from "../_shared/meta.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const DEFAULT_QUERY = "(from:meta.de OR \"@meta.de\") newer_than:60d";
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
    // Zugriff: Zeitplan mit Geheimnis aus der Datenbank, sonst nur Admins
    const secret = req.headers.get("x-sync-secret");
    if (secret) {
      const { data } = await db.from("app_secrets").select("value").eq("name", "sync").maybeSingle();
      if (!data || data.value !== secret) return json({ code: "forbidden", message: "Kein Zugriff." }, 403);
      quelle = "zeitplan";
      // Nur lesen: Mails im Postfach suchen (z. B. um neue Mail-Arten wie Stornos kennenzulernen)
      const body = await req.json().catch(() => ({}));
      if (body?.suche) return json(await suche(String(body.suche), Math.min(+body.anzahl || 10, 25)));
      if (body?.erinnerung) return json(await metaErinnerung(db, false));
    } else {
      const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
      });
      const { data: owner } = await user.rpc("is_owner");
      if (!owner) return json({ code: "approval_required", message: "Nur Admins dürfen Mails abrufen." }, 403);
      const body = await req.json().catch(() => ({}));
      // Admin: Erinnerung zum Testen sofort senden (an die eigene Adresse oder an alle Empfänger)
      if (body?.erinnerung) return json(await metaErinnerung(db, true, body.an ? String(body.an) : ""));
    }
    return json(await abruf(db, quelle));
  } catch (e: any) {
    console.error(e);
    return json({ code: e.code || "upstream_error", message: e.message || String(e) }, e.code === "server_not_connected" || e.code === "needs_reauth" ? 409 : 502);
  }
});

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
      out.push({ datum: m.date, von: m.sender, betreff: m.subject, text: (m.plaintextBody || "").slice(0, 1500), anhaenge: m.attachments.map((a: any) => a.filename) });
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
async function abruf(db: any, quelle: string) {
  const start = Date.now();
  const log: string[] = [];
  const zeit = () => Date.now() - start > MAX_LAUFZEIT;

  const st = (await getDoc(db, "mails", "status")) || {};
  st.threads = st.threads || {}; st.msgs = st.msgs || {};
  if (st.lauf && Date.now() - st.lauf < SPERRE && quelle === "zeitplan") return { log: ["Läuft gerade schon – übersprungen."], uebersprungen: true };
  await updDoc(db, "mails", "status", { lauf: Date.now() });

  const settings = (await getDoc(db, "einstellungen", "allgemein")) || {};
  const query = settings.gmailQuery || DEFAULT_QUERY;
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
      if (st.threads[t.id] && t.historyId && st.threads[t.id] === t.historyId) continue;
      const th = await gmail(`threads/${t.id}?format=full`);
      const ids = (th.messages || []).map((r: any) => r.id);
      for (const raw of th.messages || []) if (!st.msgs[raw.id]) neu.push(message(raw));
      offen.push({ id: t.id, historyId: th.historyId || t.historyId, ids });
    }
    neu.sort((a, b) => +new Date(a.date) - +new Date(b.date));
    log.push(`${neu.length} neue Nachrichten.`);

    // 3. Verarbeiten
    const lesen = new Set<string>(); // Aufträge, deren Unterlagen Claude lesen soll
    for (const m of neu) {
      if (zeit()) { weitere = true; break; }
      try {
        if (!vonMeta(m)) { st.msgs[m.id] = 1; continue; }
        const typ = art(m);
        const d = +new Date(m.date);
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
            if (!orders[id]) { const doc = { nr: zs.nr, ...data, terminStatus: "zu_terminieren", prodStatus: "in_produktion", erstelltAm: Date.now(), quelle: "mail" }; await setDoc(db, "auftraege", id, doc); orders[id] = doc; z.neu++; }
            else { await updDoc(db, "auftraege", id, data); Object.assign(orders[id], data); z.aktualisiert++; }
            const n = await anhaenge(db, m, id, log, z);
            if (n) lesen.add(id);
            log.push(`✅ Montagezusage ${zs.nr} für KW ${zs.kw}${n ? ` – ${n} Unterlage(n)` : ""}`);
          }
        } else if (typ === "abrechnung") {
          const a = parseAbrechnung(m, parseHTML);
          if (a.nr && a.summe) {
            const id = findeAuftrag(orders, a.nr) || idOf(a.nr); const ex = fin[id];
            if (!ex || (ex.datum || 0) <= d) {
              const doc = { nr: a.nr, bauvorhaben: a.bv, summe: a.summe, positionen: a.positionen, bemerkung: a.bemerkung, datum: d, mailId: m.id, rechnungStatus: ex?.rechnungStatus || "offen", rechnungsNr: ex?.rechnungsNr || "", quelle: "mail" };
              await setDoc(db, "finanzen", id, doc); fin[id] = doc;
            }
            if (!orders[id]) { const bv = splitBV(a.bv); const doc = { nr: a.nr, bauvorhaben: bv.bauvorhaben, plzOrt: bv.plzOrt, terminStatus: "fest", prodStatus: "abholbereit", erstelltAm: Date.now(), quelle: "mail", abgerechnet: true, abschluss: { typ: "ok", am: d, by: null }, berichtStatus: "gesendet", berichtGesendetAm: d }; await setDoc(db, "auftraege", id, doc); orders[id] = doc; }
            else if (!orders[id].abgerechnet) await updDoc(db, "auftraege", id, { abgerechnet: true });
            z.abrechnungen++; log.push(`💶 Abrechnung ${a.nr}: ${a.summe.toFixed(2)} €`);
          } else if (a.nr) log.push(`⚠ Abrechnung ${a.nr}: Summe nicht lesbar`);
        } else if (typ === "storno") {
          // Auftrag wurde von meta storniert: kennzeichnen (bleibt sichtbar unter „Storniert“)
          const nr = nrAusMail(m);
          if (!nr) { log.push(`⚠ Storno-Mail „${cleanSubject(m.subject)}“ ohne Auftragsnummer – bitte von Hand markieren`); }
          else {
            const id = findeAuftrag(orders, nr) || idOf(nr);
            const storniert = { am: d, quelle: "mail", betreff: cleanSubject(m.subject), grund: eigenerText(m).replace(/\s+\n/g, "\n").trim().slice(0, 600), mailId: m.id };
            if (!orders[id]) { const doc = { nr, storniert, terminStatus: "zu_terminieren", prodStatus: "offen", erstelltAm: Date.now(), quelle: "mail-storno" }; await setDoc(db, "auftraege", id, doc); orders[id] = doc; z.neu++; }
            else if (!orders[id].storniert) { await updDoc(db, "auftraege", id, { storniert }); orders[id].storniert = storniert; z.aktualisiert++; }
            z.storniert = (z.storniert || 0) + 1;
            log.push(`❌ Storniert: Auftrag ${orders[id].nr || nr}`);
          }
        } else if (typ === "dispo") {
          // Disposition: z. B. „Auftrag Nr. 16872“ oder „15845 KW 18“ mit Dokumente.pdf
          const att = unterlagen(m);
          if (!att.length) { st.msgs[m.id] = 1; continue; }
          const nr = nrAusMail(m);
          let id = nr ? findeAuftrag(orders, nr) || idOf(nr) : "";
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
        z.fehler++; log.push(`⚠ Fehler bei „${m.subject}“: ${e.message || e}`);
        if (e.code === "server_not_connected" || e.code === "needs_reauth") throw e;
      }
      verlaeufeAbhaken();
      await updDoc(db, "mails", "status", { threads: st.threads, msgs: st.msgs, lauf: Date.now() });
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
    await updDoc(db, "mails", "status", { threads: st.threads, msgs: st.msgs, lauf: null, letzterLauf: ergebnis });
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
    if (z.dateien >= MAX_DATEIEN) break;
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
  if (Object.keys(p).length) { await updDoc(db, "auftraege", id, { ...p, deckblattGelesenAm: Date.now() }); Object.assign(o, p); }
  return Object.keys(p).length;
}
