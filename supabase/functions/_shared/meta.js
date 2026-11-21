// Auswertung der meta-Mails (Wochenübersicht, Montagezusage, Montageabrechnung, Disposition mit Unterlagen).
// Reines JavaScript ohne Abhängigkeiten: den HTML-Parser bekommt jede Funktion übergeben (parseHTML),
// damit derselbe Code auf dem Server (Deno) und in Tests (Node) läuft.

export const txt = (el) => (el?.textContent || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
export const num = (s) => { const v = parseFloat(String(s).replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".")); return isNaN(v) ? 0 : v; };
export const idOf = (nr) => String(nr).trim().replace(/\//g, "-").replace(/[^A-Za-z0-9_\-.~:@+]/g, "");
export function splitBV(s) { const i = s.lastIndexOf(","); return i > 0 ? { bauvorhaben: s.slice(0, i).trim(), plzOrt: s.slice(i + 1).trim() } : { bauvorhaben: s, plzOrt: "" }; }
// "Fwd: Re: AW: WG: …" entfernen
export const cleanSubject = (s) => String(s || "").replace(/^\s*((fwd?|wg|aw|re|fw)\s*:\s*)+/i, "").trim();

function htmlDoc(m, parseHTML) {
  const h = (m.htmlBody || "").replace(/<br\s*\/?>/gi, " ");
  if (!h || !parseHTML) return null;
  return parseHTML(h);
}

/** Eigener Montagebericht an meta (aus der App oder direkt aus Gmail an montagebericht@meta.de) */
export function istEigenerBericht(m) {
  return /montagebericht@meta\.de/i.test(m.to || "") && !/meta\.de/i.test(m.sender || "");
}

/** Absender ist meta – direkt oder als weitergeleitete Mail */
export function vonMeta(m) {
  if (/meta\.de/i.test(m.sender || "")) return true;
  const body = m.plaintextBody || "";
  return /(Von|From):\s*[^\n]*@meta\.de/i.test(body) || /(Von|From):\s*meta Trennwandanlagen/i.test(body);
}

/** Art der Mail bestimmen */
export function art(m) {
  const s = cleanSubject(m.subject);
  // „Widerruf des Montageauftrags R-46775 in KW 46/2026“ = Stornierung (vor der Wochenübersicht prüfen!)
  if (/Widerruf/i.test(s) && /Montage/i.test(s)) return "storno";
  if (/Montageauftr/i.test(s)) return "uebersicht";
  if (/Montagezusage/i.test(s)) return "zusage";
  if (/Montageabrechnung/i.test(s)) return "abrechnung";
  if (istStorno(m)) return "storno";
  if (/Rechnung|Zahlung|Mahnung|Gutschrift|Berufskleidung|Luxemburg/i.test(s)) return null; // nichts für die Auftragsliste
  return "dispo";
}

/** Nur der eigene Text der Mail – ohne Zitate älterer Mails und ohne Signatur */
export function eigenerText(m) {
  const b = String(m.plaintextBody || "");
  const ende = b.search(/^\s*(>|-{3,}|Am .{5,80}schrieb|Von:|From:|-----Urspr|Mit freundlichen|Viele Grüße|Freundliche Grüße|Gruß)/im);
  return (ende > 0 ? b.slice(0, ende) : b).slice(0, 1500);
}
const STORNO = /\b(storniert|stornieren|stornierung|storno|annulliert|abgesagt|zurückgezogen)\b|auftrag\s+(wird|wurde|ist)\s+(gestrichen|aufgehoben|gelöscht)/i;
/** Storno: Formulierung im Betreff oder im eigenen Text der Mail (nicht in Zitaten) */
export function istStorno(m) {
  return STORNO.test(cleanSubject(m.subject)) || STORNO.test(eigenerText(m));
}

// Auftragsnummern wie 17714/1, 12403, R-42259
// auch „R 46659“ und „R - 47017“ (Leerzeichen statt Bindestrich) – wird zu „R-46659“ vereinheitlicht
const NR = /((?:R\s?-\s?|R\s)?\d{4,6}(?:\/\d{1,2})?)/;
const normNr = (x) => String(x).replace(/^R\s*-?\s*/i, "R-");
/** Auftragsnummer aus Betreff oder weitergeleitetem Betreff/Text ("Scans zu Auftrag Nr. 16872") */
export function nrAusMail(m) {
  const s = cleanSubject(m.subject);
  const body = m.plaintextBody || "";
  const kandidaten = [
    s.match(new RegExp("Auftrag(?:s)?(?:\\s*-?\\s*Nr\\.?)?\\s*['\"„“]?" + NR.source, "i")),
    body.match(new RegExp("Subject:\\s*[^\\n]*Auftrag(?:\\s*Nr\\.?)?\\s*" + NR.source, "i")),
    body.match(new RegExp("Betreff:\\s*[^\\n]*Auftrag(?:\\s*Nr\\.?)?\\s*" + NR.source, "i")),
    eigenerText(m).match(new RegExp("Auftrag(?:s)?(?:\\s*-?\\s*Nr\\.?)?\\s*['\"„“]?" + NR.source, "i")),
    s.match(new RegExp("^" + NR.source + "\\b")),
    s.match(new RegExp("\\b" + NR.source + "\\s+KW\\s*\\d", "i")),
  ];
  for (const k of kandidaten) if (k && !/^(19|20)\d\d$/.test(k[1])) return normNr(k[1]);
  return "";
}
/** "KW 18" aus dem Betreff, Jahr aus dem Mail-Datum */
export function kwAusMail(m) {
  const s = cleanSubject(m.subject) + " " + (m.plaintextBody || "").slice(0, 600);
  const k = s.match(/KW\s*(\d{1,2})(?:\s*\/\s*(\d{4}))?/i);
  if (!k) return null;
  const kw = +k[1]; if (kw < 1 || kw > 53) return null;
  let jahr = k[2] ? +k[2] : new Date(m.date).getFullYear();
  if (!k[2]) { const mailKw = isoWeek(new Date(m.date)).kw; if (kw < mailKw - 20) jahr++; }
  return { kw, jahr };
}
export function isoWeek(d) { d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - day); const y = d.getUTCFullYear(); const w = Math.ceil(((d - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7); return { kw: w, jahr: y }; }

/** Brauchbare Anhänge: PDFs und Bilder, aber keine Signatur-Logos (image001.png usw., sehr kleine Bilder) */
export function unterlagen(m) {
  return (m.attachments || []).filter((a) => {
    const t = a.mimeType || "", n = a.filename || "";
    if (/pdf/i.test(t) || /\.pdf$/i.test(n)) return true;
    if (!/^image\//i.test(t)) return false;
    if (/^image0\d\d\.(png|jpe?g|gif)$/i.test(n)) return false;
    if (a.size && a.size < 25000) return false;
    return true;
  });
}

export function parseUebersicht(m, parseHTML) {
  const doc = htmlDoc(m, parseHTML); const out = [];
  if (doc) {
    const tbl = doc.querySelector("table"); if (!tbl) return out;
    const heads = [...tbl.querySelectorAll("th")].map((th) => txt(th).toLowerCase());
    const ix = (k) => heads.findIndex((h) => h.startsWith(k));
    const iA = ix("aufnr"), iV = ix("vorgang"), iB = ix("bauvorhaben"), iK = ix("kabinen"), iS = ix("status");
    let kw = null, jahr = null;
    tbl.querySelectorAll("tr").forEach((tr) => {
      const tds = [...tr.querySelectorAll("td")];
      if (tds.length === 1) { const mm = txt(tds[0]).match(/KW\s*(\d+)\s*\/\s*(\d{4})/i); if (mm) { kw = +mm[1]; jahr = +mm[2]; } return; }
      if (tds.length >= 4 && iA >= 0) {
        const nr = txt(tds[iA]); if (!nr) return;
        out.push({ nr, vorgang: iV >= 0 ? txt(tds[iV]).replace(/^-$/, "") : "", ...splitBV(txt(tds[iB])), kabinen: iK >= 0 ? txt(tds[iK]) : "", versand: iS >= 0 ? txt(tds[iS]) : "", kw, jahr });
      }
    });
    if (out.length) return out;
  }
  // Fallback Klartext
  let kw = null, jahr = null;
  (m.plaintextBody || "").split(/\n/).forEach((l) => {
    const k = l.match(/^\s*KW\s*(\d+)\/(\d{4})/); if (k) { kw = +k[1]; jahr = +k[2]; return; }
    const r = l.match(/^\s*((?:R-)?\d{4,6}(?:\/\d+)?)\s+(?:(\d{5,7}|-)\s+)?(.+?,\s*\d{4,5}\s+[^\d]+?)\s+(\d+)?\s*(versendet|noch nicht)/);
    if (r) out.push({ nr: r[1], vorgang: r[2] && r[2] !== "-" ? r[2] : "", ...splitBV(r[3].trim()), kabinen: r[4] || "", versand: r[5] === "noch nicht" ? "noch nicht versendet" : "versendet", kw, jahr });
  });
  return out;
}

export function parseZusage(m) {
  const s = cleanSubject(m.subject);
  const body = m.plaintextBody || "";
  const mm = s.match(/Auftrag\s+(\S+)\s+in\s+KW\s+(\d+)\/(\d{4})/i) || body.match(/Montagezusage für Auftrag\s+(\S+)\s+in\s+KW\s+(\d+)\/(\d{4})/i);
  if (!mm) return null;
  const kab = (body.match(/\((\d+)\s+Kabine/) || [])[1] || "";
  const ab = (body.match(/Der Auftrag kann (.*?) abgeholt werden/s) || [])[1] || "";
  return { nr: mm[1], kw: +mm[2], jahr: +mm[3], kabinen: kab, abholung: ab ? ab.replace(/\s+/g, " ").trim() : "" };
}

export function parseAbrechnung(m, parseHTML) {
  const doc = htmlDoc(m, parseHTML); const pos = []; let summe = 0, bem = "";
  if (doc) {
    doc.querySelectorAll("tr").forEach((tr) => {
      const tds = [...tr.querySelectorAll("td")]; const t = txt(tr);
      if (/^Bem\.?:/i.test(t)) bem = t.replace(/^Bem\.?:\s*/i, "");
      if (/Summe/i.test(t)) { const v = num(txt(tds[tds.length - 1])); if (v) summe = v; return; }
      if (tds.length === 4) { const [a, me, ep, gp] = tds.map(txt); if (a && /^[\d.,]+$/.test(gp)) pos.push({ artikel: a, menge: num(me), ep: num(ep), gp: num(gp) }); }
    });
  }
  if (!summe) { const mm = (m.plaintextBody || "").match(/Summe:\s*([\d.,]+)/); if (mm) summe = num(mm[1]); }
  if (!pos.length && m.plaintextBody) { m.plaintextBody.split("\n").forEach((l) => { const r = l.match(/^\s*(.+?)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s*$/); if (r && !/Summe/.test(r[1])) pos.push({ artikel: r[1].trim(), menge: num(r[2]), ep: num(r[3]), gp: num(r[4]) }); }); }
  const nr = (cleanSubject(m.subject).match(/Auftrag\s+(\S+)/i) || [])[1] || "";
  const mm = (m.plaintextBody || txt(doc?.body)).match(/Auftrag\s+\S+\s+\(([^)]+)\)/);
  return { nr: nr.replace(/[^\w\/\-]/g, ""), positionen: pos, summe, bemerkung: bem, bv: mm ? mm[1] : "" };
}

/** Passenden Auftrag finden: exakt, sonst eindeutig über die Grundnummer (16872 ↔ 16872/1) */
export function findeAuftrag(orders, nr) {
  if (!nr) return null;
  const id = idOf(nr);
  if (orders[id]) return id;
  const base = String(nr).split("/")[0];
  const treffer = Object.keys(orders).filter((k) => String(orders[k].nr || k).split("/")[0] === base);
  return treffer.length === 1 ? treffer[0] : null;
}

export const DECK_PROMPT = `Du bekommst ALLE Unterlagen eines Montageauftrags der Firma meta Trennwandanlagen (Aufmaß-Deckblatt, Produktdeckblatt, Zeichnungen, Grundrisse, Stücklisten, Fotos oder Scans) als PDF oder Bild. Vor jeder Datei steht „Datei N: Name“.
Lies JEDE Seite vollständig: auch Kleingedrucktes, Stempel, Tabellen, Planköpfe, Legenden, gedrehte oder schief gescannte Seiten und handschriftliche Notizen. Die Monteure sollen später nichts mehr in den PDFs suchen müssen.
Antworte NUR mit einem JSON-Objekt mit diesen Schlüsseln (leerer String bzw. leere Liste, wenn nicht vorhanden):
{"fertigungsNr":"Fertigungs-Auftrags-Nr. z.B. 17714/1","vorgang":"Auftrags-Vorgangs-Nr.","berater":"meta-Berater mit Telefon","adresse":"Baustellenanschrift: Straße Nr, PLZ Ort","bauvorhabenName":"z.B. Wohnquartier","bauleiterName":"","bauleiterTel":"","bauleiterMail":"","oeffnungszeiten":"","geschosse":"Montage in Geschoss","aufzug":"","montageHinweise":"","kaufmHinweise":"Kaufmännische Hinweise kurz","technHinweise":"Technische Hinweise vom Produktdeckblatt","aufbau":"Was aufgebaut wird: Modell/Design, Anzahl Kabinen, Anlagenhöhe, Farben, Bodenanschluss – kurz in einer Zeile","kabinen":"Anzahl Kabinen als Zahl","zahlungspflichtiger":"Firma, Ort","kw":"gewünschte Montage-KW als Zahl",
"kontakte":[{"rolle":"z.B. Bauleiter, Polier, Architekt, Hausmeister, Ansprechpartner vor Ort, meta-Berater, Auftraggeber","name":"","firma":"","tel":"mit Vorwahl","mail":""}],
"anlagen":[{"raum":"Raum/Bereich, z.B. WC Damen","geschoss":"z.B. EG, 1. OG","kabinen":"Anzahl","modell":"Serie/Modell/Design","hoehe":"Anlagenhöhe","farbe":"Farbe/Dekor","besonderes":"Türanschlag, Urinaltrennwand, Sonderteile, Maße …"}],
"hinweise":[{"titel":"Stichwort, z.B. Anlieferung, Zufahrt, Parken, Schlüssel, Arbeitszeiten, Boden, Befestigung, Wandaufbau, Maße, Sonderteile, Termin","text":"vollständig, wie im Dokument","wichtig":true/false}],
"achtung":["höchstens 5 kurze Sätze: was die Monteure auf dieser Baustelle UNBEDINGT beachten müssen, z.B. Zugang nur nach telefonischer Anmeldung, Räume noch nicht gefliest, Versiegelung bauseits, besondere Befestigung, Sperr- oder Ruhezeiten, Material fehlt. Allgemeines (Arbeitsschutz-Standards, Rechnungsadressen) gehört NICHT hierher."],
"dateien":[{"nr":1,"name":"Dateiname","art":"Aufmaß-Deckblatt | Produktdeckblatt | Zeichnung | Grundriss | Stückliste | Foto | Sonstiges","seiten":"Anzahl Seiten","inhalt":"was drinsteht, ein kurzer Satz"}],
"unsicher":[]}
Regeln: Handschriftliches mit lesen. Nichts erfinden. Telefonnummern vollständig mit Vorwahl. Gleiche Kontakte nur einmal. Alles, was für Montage, Anfahrt, Material oder Abrechnung wichtig sein könnte und in kein Feld passt, kommt unter "hinweise" – lieber einmal zu viel als zu wenig.
"unsicher": Liste der Schlüssel, die du NICHT sicher lesen konntest (unleserlich, abgeschnitten, mehrdeutig) oder die in den Unterlagen fehlen, aber wichtig wären – besonders "bauleiterTel" und "adresse". Beispiel: "unsicher":["bauleiterTel"].`;
// Welche Deckblatt-Felder in den Auftrag übernommen werden (nur wenn dort noch leer)
export const DECK_FELDER = ["vorgang", "berater", "adresse", "bauleiterName", "bauleiterTel", "bauleiterMail", "oeffnungszeiten", "geschosse", "aufzug", "montageHinweise", "kaufmHinweise", "technHinweise", "aufbau", "kabinen", "zahlungspflichtiger"];

/** Abrechnung für mehrere Aufträge: In der Bemerkung stehen die mit abgerechneten Aufträge,
 *  z. B. „/1 + /2 + /3 + 5 kompett“ (Teilaufträge derselben Nummer) oder „R-47197/R-47143“. */
export function mitAbgerechnet(nr, bem, orders) {
  const out = new Set(); const b = String(bem || ""); const base = String(nr || "").split("/")[0];
  for (const m of b.matchAll(new RegExp(NR.source, "g"))) { const id = findeAuftrag(orders, normNr(m[1])); if (id) out.add(id); }
  // Liste von mindestens zwei Teilnummern, verbunden mit + , & oder „und“
  if (/(^|[\s(])\/?\d{1,2}\s*(\+|,|&|und)\s*\/?\d{1,2}(?!\d)/i.test(b)) {
    for (const m of b.matchAll(/(?:^|[\s+,&(])\/?(\d{1,2})(?!\d)/g)) { const id = idOf(`${base}/${+m[1]}`); if (orders[id]) out.add(id); }
  }
  return [...out];
}

/** Vergütung nur für die Sichtabnahme (z. B. Bemerkung „Abnahme“, Position „Abnahme 51 ×“) –
 *  das ist NICHT die Abrechnung der Montage. Eine Montage-Abrechnung trägt in der Bemerkung die Auftragsnummer. */
export function istAbnahmeVerguetung(a) {
  const pos = (a?.positionen || []).filter((p) => p && p.artikel);
  if (/^\s*(sicht)?abnahme/i.test(String(a?.bemerkung || ""))) return true;
  return pos.length > 0 && pos.every((p) => /abnahme/i.test(p.artikel));
}

/** Abrechnung einer Reklamation: meta antwortet im Verlauf „R 47006“ mit „Hier die Aufstellung/Abrechnung“
 *  (Bild im Anhang) oder nur mit dem Betrag („359.00“). Liefert { nr, summe } oder null. */
export function reklaAufstellung(m) {
  const nr = nrAusMail(m);
  if (!/^R-/.test(nr)) return null;
  const own = eigenerText(m).split(/\bschrieb\b/i)[0];
  const betrag = (own.replace(/\r/g, "").match(/^[ \t*_]*(\d{1,5}[.,]\d{2})[ \t*_]*(?:€|EUR)?[ \t*_]*$/m) || [])[1];
  if (!betrag && !/Aufstellung|Abrechnung/i.test(own)) return null;
  return { nr, summe: betrag ? num(betrag) : 0 };
}
