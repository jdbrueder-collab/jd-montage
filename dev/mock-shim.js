/* Test-Ersatz für window.claude: Daten im Browser (localStorage), keine echte Datenbank, keine echten Mails.
   ?reset in der Adresse setzt die Beispieldaten zurück. ?rolle=sub testet die Subunternehmer-Sicht. */
(() => {
  "use strict";
  const KEY = "jdmock-v1";
  const ME = "u-chef", SUB = "u-zelt", MON = "u-mon", META = "u-meta";
  const params = new URLSearchParams(location.search);
  const rolle = params.get("rolle") || "chef";
  const myId = rolle === "sub" ? SUB : rolle === "monteur" ? MON : rolle === "meta" ? META : ME;
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const deepMerge = (a, b) => { const o = { ...a }; for (const k of Object.keys(b)) o[k] = isObj(b[k]) && isObj(a[k]) ? deepMerge(a[k], b[k]) : b[k]; return o; };
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const T = Date.now(), D = 86400000;

  function seed() {
    const lohnPos = [
      { k: "vorderfront", label: "Vorderfront", einheit: "Stück", haeufig: true },
      { k: "trennwand", label: "Trennwand", einheit: "Stück", haeufig: true },
      { k: "seitenwand", label: "Seitenwand", einheit: "Stück" },
      { k: "aussparung", label: "Aussparung", einheit: "Stück" },
      { k: "feinsteinzeug", label: "Feinsteinzeugfliesen bohren", einheit: "Stück" },
      { k: "vorhangschiene", label: "Vorhangschiene", einheit: "lfm" },
      { k: "passschnitt", label: "Passschnitt", einheit: "Stück" },
      { k: "urinaltrennwand", label: "Urinaltrennwand", einheit: "Stück" },
      { k: "kabine_demontage", label: "Kabine demontieren", einheit: "Stück" },
      { k: "spiegel", label: "Spiegel montieren", einheit: "Stück" },
      { k: "ablage", label: "Ablage montieren", einheit: "Stück" },
      { k: "stunden", label: "Stunden (Zusatzarbeit)", einheit: "Std." }
    ];
    const preise = { vorderfront: 38, trennwand: 22, seitenwand: 18, aussparung: 12, feinsteinzeug: 6, vorhangschiene: 9, passschnitt: 5, urinaltrennwand: 15, kabine_demontage: 20, spiegel: 8, ablage: 6, stunden: 35 };
    const zelt = { name: "Zeltwald", preise: { ...preise, vorderfront: 33, trennwand: 19, aussparung: 10 }, stockSatz: 4, kmSelbst: 0.3, kmMit: 0.1 };
    const docs = {
      "einstellungen/allgemein": { firmenAdresse: "Hauptstraße 1, 56305 Puderbach", monteurName: "JD Brüder GbR", monteurNr: "286", antwortEmail: "test-antwort@example.com", berichtEmail: "test-bericht@example.com" },
      "einstellungen/rollen": { map: { [SUB]: "sub", [MON]: "monteur", [META]: "hersteller" }, info: { [SUB]: { firma: "Zeltwald" }, [META]: { firma: "meta Trennwandanlagen" } } },
      "einstellungen/lohnpositionen": { items: lohnPos },
      "lohn/preise": { preise, stockSatz: 5, kmSelbst: 0.3, kmMit: 0.1, listen: { lz: zelt }, zuordnung: { [SUB]: "lz" }, sichtbarFuer: [], subSicht: [SUB] },
      [`lohnsicht/${SUB}`]: { name: "Zeltwald", preise: zelt.preise, stockSatz: 4, kmSelbst: 0.3, kmMit: 0.1 },
      "auftraege/17714-1": { nr: "17714/1", bauvorhaben: "Wohnquartier Rheinblick", plzOrt: "67059 Ludwigshafen", adresse: "Rheinallee 12, 67059 Ludwigshafen", kw: 47, jahr: 2026, kabinen: "9", terminStatus: "fest", termin: T, prodStatus: "abholbereit", bauleiterName: "Herr Bauer", bauleiterTel: "0621 123456", bauleiterMail: "test-kunde@example.com", zahlungspflichtiger: "Musterbau GmbH, Industriestr. 5, 67059 Ludwigshafen", geschosse: "EG, 1. OG, 2. OG", monteure: [ME, SUB], erstelltAm: T - 5 * D },
      "auftraege/17801-2": { nr: "17801/2", bauvorhaben: "Schule am Park", plzOrt: "56068 Koblenz", kw: 48, jahr: 2026, terminStatus: "zu_terminieren", prodStatus: "produziert", monteure: [ME], erstelltAm: T - 2 * D },
      "auftraege/17650-1": { nr: "17650/1", bauvorhaben: "Bürohaus Nord", plzOrt: "57610 Altenkirchen", kw: 45, jahr: 2026, terminStatus: "fest", monteure: [ME], bericht: { taetigkeit: "6 Kabinen montiert", istKm: "80", personen: "2", personenMit: "0", geschosse: "EG" }, abschluss: { typ: "ok", am: T - 10 * D, by: ME }, berichtStatus: "gesendet", berichtGesendetAm: T - 8 * D, berichtAn: "test-bericht@example.com", erstelltAm: T - 20 * D },
      "auftraege/17722-1": { nr: "17722/1", bauvorhaben: "Kita Sonnenschein", plzOrt: "53111 Bonn", kw: 47, jahr: 2026, kabinen: "6", terminStatus: "fest", termin: T - 1 * D, prodStatus: "abholbereit", monteure: [ME], einsatz: { fahrzeug: "anhaenger", abfahrtAm: T - 5 * 3600000, ankunftAm: T - 4 * 3600000, bereit: "ja", startAm: T - 3 * 3600000, personenVorOrt: 2 }, zeiten: [{ s: T - 3 * 3600000 }], erstelltAm: T - 9 * D },
      "auftraege/17840-1": { nr: "17840/1", bauvorhaben: "Sporthalle West", plzOrt: "50667 Köln", kw: 49, jahr: 2026, kabinen: "12", terminStatus: "zu_terminieren", prodStatus: "in_produktion", erstelltAm: T - 1 * D },
      "auftraege/17855-1": { nr: "17855/1", bauvorhaben: "Rathaus Neuwied", plzOrt: "56564 Neuwied", kw: 48, jahr: 2026, kabinen: "4", terminStatus: "fest", termin: T + 6 * D, prodStatus: "abholbereit", erstelltAm: T - 6 * D },
      // Nutzung in anderen Aufträgen: Aussparung und Feinsteinzeug wurden oft gebraucht
      "lohnberichte/a1__u-chef": { auftragId: "a1", uid: ME, mengen: { aussparung: 4, feinsteinzeug: 6, vorderfront: 3 } },
      "lohnberichte/a2__u-chef": { auftragId: "a2", uid: ME, mengen: { aussparung: 2, feinsteinzeug: 2, vorhangschiene: 3 } },
      "lohnberichte/a3__u-chef": { auftragId: "a3", uid: ME, mengen: { aussparung: 1, feinsteinzeug: 8 } },
      "lohnberichte/a4__u-chef": { auftragId: "a4", uid: ME, mengen: { aussparung: 1, vorhangschiene: 2 } }
    };
    return docs;
  }
  let store;
  try { store = params.has("reset") ? null : JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { store = null; }
  if (!store) store = seed();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {} };
  save();
  if (params.has("reset")) { params.delete("reset"); history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params : "") + location.hash); }

  const subs = new Set();
  const notify = col => setTimeout(() => subs.forEach(s => s.col === col && s.fn()), 0);
  const colDocs = col => Object.entries(store).filter(([p]) => p.split("/")[0] === col).map(([p, d]) => [p.split("/")[1], d]);
  const snap = (id, d) => ({ id, exists: d !== undefined, data: () => clone(d) });
  const can = (col, id) => rolle === "chef" || (!["finanzen", "mails", "lohn", "lohnsicht", "anfragen"].includes(col)) || (col === "lohnsicht" && id === myId);
  function docRef(col, id) {
    const p = col + "/" + id;
    return {
      id,
      onSnapshot(cb) { const s = { col, fn: () => cb(snap(id, can(col, id) ? store[p] : undefined)) }; subs.add(s); s.fn(); return () => subs.delete(s); },
      async get() { return snap(id, store[p]); },
      async set(data) { store[p] = clone(data); save(); notify(col); },
      async update(patch) { const cur = store[p] || {}; const full = {}; for (const k of Object.keys(patch)) full[k] = isObj(patch[k]) && isObj(cur[k]) ? deepMerge(cur[k], patch[k]) : patch[k]; store[p] = { ...cur, ...clone(full) }; save(); notify(col); },
      async delete() { delete store[p]; save(); notify(col); }
    };
  }
  function colRef(col, filters = []) {
    const pick = () => colDocs(col).filter(([, d]) => filters.every(([f, v]) => d?.[f] === v)).map(([id, d]) => snap(id, d));
    return {
      doc: id => docRef(col, id || Math.random().toString(36).slice(2)),
      where: (f, op, v) => colRef(col, [...filters, [f, v]]),
      onSnapshot(cb) { const s = { col, fn: () => { const docs = can(col) ? pick() : []; cb({ docs, size: docs.length, empty: !docs.length }); } }; subs.add(s); s.fn(); return () => subs.delete(s); },
      async get() { const docs = pick(); return { docs, size: docs.length, empty: !docs.length }; }
    };
  }
  const db = { collection: colRef, doc: path => { const [c, i] = path.split("/"); return docRef(c, i); } };
  const names = { [ME]: "Jonathan (Test)", [SUB]: "Zeltwald (Test)", [MON]: "Monteur (Test)", [META]: "meta Disposition (Test)" };
  const user = {
    me: async () => ({ id: myId, name: names[myId], email: myId + "@example.com" }),
    isOwner: async () => rolle === "chef",
    profiles: async ids => Object.fromEntries(ids.map(i => [i, { id: i, name: names[i] || i }])),
    search: async () => []
  };
  const assets = {
    async upload(blob) { const r = await fetch("/_upload", { method: "POST", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob }); return r.json(); },
    async delete() {}
  };
  window.__sent = [];
  const mcp = { async callTool(_s, tool, args) { window.__sent.push({ tool, to: args.to, subject: args.subject, body: args.body, attachments: (args.attachments || []).map(a => ({ filename: a.filename, mimeType: a.mimeType, kb: Math.round(a.content.length * 3 / 4 / 1024) })) }); console.log("[TEST] Mail NICHT gesendet (Testumgebung):", args.subject, args.to); return { payload: { id: "test-" + Date.now() } }; } };
  const sample = {
    limits: async () => ({ images: true }),
    async json(prompt) {
      // Feste Testantwort: so würde die KI das Beispiel-Diktat zerlegen
      return { taetigkeit: "9 Kabinen in EG, 1. und 2. OG montiert, Passschnitte vor Ort", personenVorOrt: 3, personenMit: 1, istKm: 390, geschosse: "EG, 1. OG, 2. OG", uebernachtungen: 1, mengen: { vorderfront: 9, trennwand: 6, aussparung: 2 }, sonder: [{ arbeit: "Füße geklebt und gebohrt", personen: 2, stunden: 1 }] };
    }
  };
  window.__downloads = [];
  const downloads = { async save({ filename, data }) { window.__downloads.push({ filename, size: data.size, url: URL.createObjectURL(data) }); console.log("[TEST] Download:", filename, data.size); } };
  // Simulierter Server-Abruf: legt eine Anfrage der Disposition mit Dokumente.pdf an
  const sync = {
    async run(body = {}) {
      if (body.pushTest || body.abholbereit || body.reklamation || body.subBericht || body.subFreigabe) { console.log("[TEST] Benachrichtigung (nicht gesendet):", body); window.__push = (window.__push || []).concat([body]); return { gesendet: 1, geraete: 1 }; }
      if (body.erinnerung) { console.log("[TEST] Erinnerung NICHT gesendet (Testumgebung) an", body.an); return { gesendet: true, an: [body.an], offen: 3 }; }
      const pdf = new Blob(["%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 595 842]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF"], { type: "application/pdf" });
      const a = await assets.upload(pdf);
      store["auftraege/16872"] = { nr: "16872", kw: 33, jahr: 2026, terminStatus: "zu_terminieren", prodStatus: "offen", erstelltAm: Date.now(), quelle: "mail-dispo", anfrageAm: Date.now(), anfrageBetreff: "Auftrag Nr. 16872", bauvorhaben: "Testbau Regensburg", plzOrt: "93047 Regensburg", bauleiterName: "Frau Test", deckblattGelesenAm: Date.now() };
      store["fotos/pdf1"] = { auftragId: "16872", kat: "unterlagen", assetId: a.id, name: "Dokumente.pdf", typ: "application/pdf", mailAtt: "Dokumente.pdf|x", am: Date.now(), von: null, quelle: "mail" };
      store["einstellungen/allgemein"] = { ...store["einstellungen/allgemein"], letzterAbruf: Date.now(), autoAbruf: { am: Date.now(), quelle: "manuell", neu: 1, aktualisiert: 0, abrechnungen: 0, dateien: 1, gelesen: 1, fehler: 0 } };
      save(); notify("auftraege"); notify("fotos"); notify("einstellungen");
      return { log: ["12 Mail-Verläufe gefunden (TEST).", "1 neue Nachrichten.", "📨 Neue Anfrage von meta: Auftrag 16872", "📎 1 Unterlage(n) zu Auftrag 16872", "🔎 Deckblatt 16872: 4 Felder übernommen", "\nFertig: 1 neu, 0 aktualisiert, 0 Abrechnungen, 1 Unterlagen gespeichert, 1 Deckblätter gelesen."], neu: 1 };
    }
  };
  const services = { db, user, assets, mcp, sample, downloads, sync };
  window.claude = { async use(n) { if (services[n]) return services[n]; throw Object.assign(new Error("unavailable"), { code: "unavailable" }); } };
  window.__store = () => store;
})();
