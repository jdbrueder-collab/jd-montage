/* Nur Testumgebung: stellt eine Szene für das Erklärvideo her (…/dev/?…&szene=N).
   Wird von dev/server.py nur eingebunden, wenn „szene“ in der Adresse steht. */
(function () {
  const n = +(new URLSearchParams(location.search).get("szene") || 0);
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  const klick = (sel) => document.querySelector(sel)?.click();
  const fertig = async () => { for (let i = 0; i < 60 && !(window.S && S.loaded); i++) await w(100); await w(300); };
  const gemeinsamAufbauen = () => {
    const o = S.orders["17714-1"], jetzt = Date.now();
    Object.assign(o, { gemeinsam: true, monteure: ["u-chef", "u-zelt", "u-mon"], abschluss: { typ: "ok", am: jetzt - 3600e3, by: "u-chef" }, berichtStatus: "bereit", serie: "std",
      bericht: { ...(o.bericht || {}), geschosse: "EG, 1. OG", personen: "3", istKm: "90", uebernachtet: "nein", fertigAm: jetzt - 3600e3, reklaFertig: true },
      einsatz: { fahrzeug: "auto", abfahrtAm: jetzt - 9 * 3600e3, ankunftAm: jetzt - 8 * 3600e3, startAm: jetzt - 8 * 3600e3, bereit: "ja", fertigAm: jetzt - 3 * 3600e3, uebernachtungOk: true },
      subAnteil: { "u-zelt": { abgegebenAm: jetzt - 2 * 3600e3 } }, kontrolle: { "u-zelt": { plus: { feinsteinzeug: 6 } } } });
    S.lohn["17714-1__u-zelt"] = { id: "17714-1__u-zelt", auftragId: "17714-1", uid: "u-zelt", mengen: { aussparung: 4, vorhangschiene: "3" }, kuerzung: { aussparung: { alt: 5, neu: 4, am: jetzt } }, fahrtArt: "mit" };
    S.lohn["17714-1__u-chef"] = { id: "17714-1__u-chef", auftragId: "17714-1", uid: "u-chef", mengen: { aussparung: "1", trennwand: "2" } };
    S.lohn["17714-1__u-mon"] = { id: "17714-1__u-mon", auftragId: "17714-1", uid: "u-mon", mengen: { passschnitt: "3" } };
    o.mailAnzahl = 4; o.mailLetzte = jetzt - 20 * 3600e3;
  };
  const szenen = {
    1: async () => { S.filter = "arbeit"; render(); },
    2: async () => { S.filter = "arbeit"; render(); await w(200); klick("#tunDock"); },
    3: async () => { S.filter = "arbeit"; render(); await w(200); klick("#dockFab"); },
    4: async () => { location.hash = "#a-17801-2"; await w(500); },
    5: async () => { location.hash = "#a-TEST-1"; await w(500); scrollTo(0, 0); },
    6: async () => { const o = S.orders["TEST-1"], j = Date.now(); Object.assign(o, { einsatz: { fahrzeug: "auto", abfahrtAm: j - 7200e3, ankunftAm: j - 3600e3, startAm: j - 3500e3, bereit: "ja", personenVorOrt: 2 }, zeiten: [{ s: j - 3500e3, p: 2 }], terminOk: { "u-mon": String(o.termin) } }); location.hash = "#a-TEST-1"; await w(500); document.querySelector("#einsatzCard")?.scrollIntoView(); },
    7: async () => { location.hash = "#a-TEST-1"; await w(400); reklaSchnellDialog("TEST-1"); await w(300); const m = document.querySelector(".modal"); m.querySelector("[data-rt]")?.click(); m.querySelectorAll("[data-ra]")[0]?.click(); [...m.querySelectorAll("[data-vu]")].find((b) => b.dataset.vu === "meta")?.click(); m.querySelector("[data-vu]")?.scrollIntoView({ block: "center" }); },
    8: async () => { const o = S.orders["TEST-1"], j = Date.now(); Object.assign(o, { einsatz: { fahrzeug: "auto", abfahrtAm: j - 9e6, ankunftAm: j - 8e6, startAm: j - 8e6, bereit: "ja", fertigAm: j - 6e5, uebernachtungOk: true }, zeiten: [{ s: j - 8e6, e: j - 6e5, p: 2 }] }); S.lohn["TEST-1__u-mon"] = { id: "TEST-1__u-mon", auftragId: "TEST-1", uid: "u-mon", mengen: { passschnitt: "2", aussparung: "4" } }; location.hash = "#a-TEST-1"; await w(600); document.querySelector(".pl-tabs")?.scrollIntoView({ block: "start" }); scrollBy(0, -70); },
    9: async () => { const o = S.orders["TEST-1"], j = Date.now(); Object.assign(o, { einsatz: { fahrzeug: "auto", abfahrtAm: j - 9e6, ankunftAm: j - 8e6, startAm: j - 8e6, bereit: "ja", fertigAm: j - 6e5, uebernachtungOk: true }, zeiten: [{ s: j - 8e6, e: j - 6e5, p: 2 }], bericht: { geschosse: "EG", fertigAm: j, reklaFertig: true, abnahmeFrage: "ja", uebernachtet: "nein" }, serie: "std" }); location.hash = "#a-TEST-1"; await w(600); document.querySelector("#einsatzCard")?.scrollIntoView(); },
    10: async () => { gemeinsamAufbauen(); S.orders["17714-1"].subAnteil = {}; S.orders["17714-1"].abschluss = null; S.orders["17714-1"].berichtStatus = null; delete S.lohn["17714-1__u-zelt"].kuerzung; S.lohn["17714-1__u-zelt"].mengen.aussparung = 5; location.hash = "#a-17714-1"; await w(600); document.querySelector("#preisliste")?.closest(".card")?.scrollIntoView(); },
    11: async () => { gemeinsamAufbauen(); location.hash = "#a-17714-1"; await w(600); scrollTo(0, 0); },
    12: async () => { gemeinsamAufbauen(); location.hash = "#a-17714-1"; await w(600); pruefDialog("17714-1", "sub:u-zelt"); },
    13: async () => { gemeinsamAufbauen(); S.orders["17714-1"].subAnteil["u-zelt"].bestaetigtAm = Date.now(); S.orders["17714-1"].eigenOk = { am: Date.now() }; location.hash = "#a-17714-1"; await w(600); scrollTo(0, 0); },
    14: async () => { gemeinsamAufbauen(); location.hash = "#a-17714-1"; await w(600); pruefDialog("17714-1", "gesamt"); },
    15: async () => { gemeinsamAufbauen(); const o = S.orders["17714-1"]; o.abgerechnet = true; S.fin["17714-1"] = { id: "17714-1", nr: o.nr, summe: 1890.4, datum: Date.now() - 864e5, kunde: "de", rechnungStatus: "offen", positionen: [{ artikel: "Montage WC-Trennwand", menge: 9, ep: 160, gp: 1440 }, { artikel: "KM", menge: 180, ep: 0.6, gp: 108 }] }; location.hash = "#a-17714-1"; await w(600); const k = [...document.querySelectorAll("details.card,.card")].find((c) => /Abrechnung/.test(c.textContent) && c.querySelector("#rgFrei")); if (k) { if (k.tagName === "DETAILS") k.open = true; k.scrollIntoView(); } },
    16: async () => { gemeinsamAufbauen(); const o = S.orders["17714-1"]; S.fin["17714-1"] = { id: "17714-1", nr: o.nr, summe: 1890.4, datum: Date.now() - 864e5, kunde: "de", rechnungStatus: "offen" }; location.hash = "#a-17714-1"; await w(500); beanstandenDialog("17714-1"); await w(300); const m = document.querySelector(".modal"); m.querySelector("[data-bg]")?.click(); const t = m.querySelector("#bgText"); t.value = "Es fehlen 90 km (2. Fahrt am 25.11.)"; t.dispatchEvent(new Event("input")); },
    17: async () => { gemeinsamAufbauen(); location.hash = "#a-17714-1"; await w(500); mailsDialog("17714-1"); await w(700); document.querySelector(".modal .mail-z")?.click(); },
    18: async () => { location.hash = "#setup"; await w(500); const email = "neu@beispiel.de"; await zugangCode(email, "sub", { name: "Max Muster", firma: "Muster Montage", am: Date.now() }); },
  };
  window.addEventListener("load", async () => { await fertig(); try { await (szenen[n] || (async () => {}))(); } catch (e) { console.error("Szene", n, e); } await w(600); document.title = "SZENE-FERTIG"; });
})();
