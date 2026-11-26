/* Ersatz für window.claude auf Basis von Supabase.
   Stellt dieselben Funktionen bereit, die die App in claude.ai genutzt hat
   (db, user, assets, mcp, sample, dictation, downloads), damit der App-Code fast unverändert bleibt. */
(() => {
  "use strict";
  const { url: URL_, key: KEY } = window.JD_CONFIG;
  const sb = supabase.createClient(URL_, KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  const fail = (code, message) => Object.assign(new Error(message || code), { code });

  /* ---------- App auf den Startbildschirm: Anleitung je Gerät ---------- */
  let installEvent = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvent = e; document.querySelectorAll("[data-jd-install]").forEach(b => b.classList.remove("hide")); });
  const istInstalliert = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  function erkannt() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
    if (/Android/.test(ua)) return "android";
    return "pc";
  }
  // Gerät: selbst gewählt (bei der Anmeldung oder unter Setup → Mein Konto), sonst erkannt
  const GERAETE = { ios: "iPhone", android: "Android", pc: "Computer" };
  function gewaehlt() { try { const g = localStorage.getItem("jdGeraet"); return GERAETE[g] ? g : ""; } catch (e) { return ""; } }
  function geraet() { return gewaehlt() || erkannt(); }
  window.jdGeraet = geraet;
  window.jdGeraetSetzen = g => { try { localStorage.setItem("jdGeraet", g); } catch (e) {} document.documentElement.dataset.geraet = g; };
  document.documentElement.dataset.geraet = geraet();
  function installHtml() {
    const g = geraet();
    const inApp = /FBAN|FBAV|Instagram|WhatsApp|GSA\/|Line\//.test(navigator.userAgent);
    const teil = (k, titel, schritte) => `<details ${g === k ? "open" : ""} style="margin-top:8px"><summary style="cursor:pointer;font-weight:650">${titel}${g === k ? " <span class=\"small mute\">(dein Gerät)</span>" : ""}</summary>
      <ol style="margin:6px 0 0;padding-left:20px;line-height:1.55">${schritte.map(s => `<li>${s}</li>`).join("")}</ol></details>`;
    const video = location.pathname.replace(/vorschau\/?(index\.html)?$/, "").replace(/index\.html$/, "") + "video/jd-montage-app.mp4";
    return `<a class="btn block" href="${video}" target="_blank" rel="noopener" style="margin-bottom:10px">🎬 Video: So funktioniert die App</a>
      <h3 style="margin:0 0 4px">📲 App auf den Startbildschirm holen</h3>
      <div class="small mute">Dann öffnest du die Montage-App mit einem Tipp wie jede andere App – ohne Link suchen.</div>
      ${inApp ? `<div class="small" style="margin-top:8px;color:var(--warn)">⚠️ Du hast den Link in einer anderen App geöffnet (z. B. WhatsApp). Öffne ihn zuerst im Browser: oben/unten auf ⋯ bzw. ⋮ tippen → „Im Browser öffnen“.</div>` : ""}
      <button class="btn pri block ${installEvent ? "" : "hide"}" data-jd-install style="margin-top:10px">📲 Jetzt installieren</button>
      ${g === "ios" ? `<div class="small" style="margin-top:8px">🔔 Auf dem iPhone kommen Benachrichtigungen <b>nur</b>, wenn die App auf dem Home-Bildschirm liegt und von dort geöffnet wird (ab iOS 16.4).</div>` : ""}
      ${teil("ios", "iPhone / iPad", ["Link in <b>Safari</b> öffnen.", "Unten auf <b>Teilen</b> tippen (Viereck mit Pfeil nach oben ⬆️).", "Etwas nach unten scrollen → <b>„Zum Home-Bildschirm“</b>.", "Oben rechts <b>„Hinzufügen“</b> – fertig, das Symbol „JD Montage“ ist da."])}
      ${teil("android", "Android-Handy", ["Link in <b>Chrome</b> öffnen.", "Oben rechts auf <b>⋮</b> (drei Punkte) tippen.", "<b>„App installieren“</b> oder <b>„Zum Startbildschirm hinzufügen“</b> wählen.", "<b>„Installieren“</b> bestätigen – das Symbol „JD Montage“ ist da."])}
      ${teil("pc", "Computer (Chrome / Edge)", ["Rechts in der Adresszeile auf das <b>Installieren-Symbol</b> klicken (Bildschirm mit Pfeil).", "Oder Menü <b>⋮</b> → „Streamen, speichern und teilen“ → <b>„Seite als App installieren“</b> (Edge: ⋯ → „Apps“ → „Diese Seite als App installieren“).", "<b>„Installieren“</b> – die App liegt dann auf dem Desktop bzw. in der Taskleiste.", "Mac mit Safari: Menü <b>Ablage → „Zum Dock hinzufügen“</b>."])}`;
  }
  function installBinden(root) {
    root.querySelectorAll("[data-jd-install]").forEach(b => b.onclick = async () => { if (!installEvent) return; installEvent.prompt(); try { await installEvent.userChoice; } catch (e) {} installEvent = null; b.classList.add("hide"); });
  }
  // Anleitung als Fenster (einmal nach der Anmeldung, und jederzeit über Setup)
  window.jdInstallHilfe = (immer = true) => {
    if (!immer && (istInstalliert() || (() => { try { return localStorage.getItem("jdInstallGesehen"); } catch (e) { return "1"; } })())) return;
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;inset:0;z-index:120;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px";
    d.innerHTML = `<div class="card" style="max-width:440px;width:100%;max-height:90vh;overflow:auto">${installHtml()}<button class="btn block" id="jdInstOk" style="margin-top:14px">Verstanden</button></div>`;
    document.body.appendChild(d); installBinden(d);
    d.querySelector("#jdInstOk").onclick = () => { try { localStorage.setItem("jdInstallGesehen", "1"); } catch (e) {} d.remove(); };
  };

  /* ---------- Anmeldung ----------
     Bekannte Nutzer bekommen den Code per Mail. Neue Leute fragen den Zugang an –
     JD Brüder legt die Rolle fest, erzeugt den Code und gibt ihn persönlich heraus. */
  const zugangFn = async body => {
    const { data, error } = await sb.functions.invoke("sync", { body: { zugang: body } });
    if (error) throw new Error("Server nicht erreichbar – bitte Internet prüfen.");
    return data || {};
  };
  const hEsc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function loginScreen() {
    return new Promise(resolve => {
      const d = document.createElement("div");
      d.style.cssText = "position:fixed;inset:0;z-index:100;background:var(--bg,#f3f4f6);overflow:auto;padding:16px";
      d.innerHTML = `<div style="max-width:420px;margin:24px auto">
        <div class="card"><h2 style="margin:0 0 6px">JD Brüder Montage</h2>
        <div id="lv"></div>
        <div id="lm" class="small" style="color:var(--bad);min-height:18px;margin-top:6px" role="alert"></div></div>
        ${istInstalliert() ? "" : `<div class="card" id="jdInstKarte" style="margin-top:12px">${installHtml()}</div>`}</div>`;
      document.body.appendChild(d); installBinden(d);
      const $ = s => d.querySelector(s), msg = t => ($("#lm").textContent = t || "");
      let email = ""; try { email = localStorage.getItem("jdLoginMail") || ""; } catch (e) {}
      try { const ein = new URLSearchParams(location.search).get("e"); if (ein && /^\S+@\S+\.\S+$/.test(ein)) email = ein.trim().toLowerCase(); } catch (e) {} // Einladungslink
      let modus = "persoenlich"; // „mail“ = Code kam per Mail
      const knopf = (id, text) => `<button class="btn pri block" id="${id}" style="margin-top:12px">${text}</button>`;
      const busy = async (b, fn) => { b.disabled = true; msg(""); try { await fn(); } catch (e) { msg(e.message || String(e)); } b.disabled = false; };
      const zeigeGeraet = () => {
        const e = erkannt(), g = gewaehlt() || e;
        const k = (id, sym, titel, text) => `<button class="btn block geraet-k ${g === id ? "on" : ""}" data-g="${id}"><span class="gk-sym">${sym}</span><span style="text-align:left;flex:1"><b>${titel}</b><span class="small mute" style="display:block;font-weight:500">${text}${e === id ? " · erkannt" : ""}</span></span></button>`;
        $("#lv").innerHTML = `<p class="mute small">Welches Gerät nutzt du? Die App passt sich daran an.</p>
          <div style="display:grid;gap:8px;margin-top:8px">
          ${k("ios", "📱", "iPhone", "Ansicht und Benachrichtigungen fürs iPhone")}
          ${k("android", "🤖", "Android", "Samsung, Pixel, Xiaomi …")}
          ${k("pc", "💻", "Computer", "Windows-PC oder Mac")}</div>`;
        d.querySelectorAll("[data-g]").forEach(b => b.onclick = () => { window.jdGeraetSetzen(b.dataset.g); const ic = d.querySelector("#jdInstKarte"); if (ic) { ic.innerHTML = installHtml(); installBinden(ic); } zeigeMail(); });
      };
      const zeigeMail = () => {
        $("#lv").innerHTML = `<p class="mute small">Melde dich mit deiner E-Mail-Adresse an. <a href="#" id="lg">${GERAETE[geraet()]} · ändern</a></p>
          <label class="f" for="le">E-Mail</label><input class="i" id="le" type="email" autocomplete="email" inputmode="email" value="${hEsc(email)}">${knopf("lb", "Weiter")}`;
        const go = () => busy($("#lb"), async () => {
          const e = $("#le").value.trim().toLowerCase();
          if (!/^\S+@\S+\.\S+$/.test(e)) throw new Error("Bitte eine gültige E-Mail-Adresse eingeben.");
          email = e; try { localStorage.setItem("jdLoginMail", e); } catch (x) {}
          const r = await zugangFn({ art: "pruefen", email });
          if (r.fehler) throw new Error(r.fehler);
          if (r.bekannt) {
            const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
            if (error) throw new Error(/rate|seconds/i.test(error.message) ? "Bitte kurz warten und dann nochmal versuchen." : "Senden hat nicht geklappt: " + error.message);
            modus = "mail"; zeigeCode("Wir haben dir einen Code per Mail geschickt. Schau auch im Spam-Ordner nach.");
          } else if (r.wartet) { modus = "persoenlich"; zeigeCode(r.hatCode ? "Gib den Code ein, den du von JD Brüder bekommen hast." : "Deine Anfrage ist bei JD Brüder. Du bekommst deinen Code persönlich – dann hier eingeben."); }
          else zeigeAnfrage();
        });
        $("#lb").onclick = go; $("#le").onkeydown = e => { if (e.key === "Enter") go(); }; $("#le").focus();
        $("#lg").onclick = e => { e.preventDefault(); zeigeGeraet(); };
      };
      const zeigeAnfrage = () => {
        $("#lv").innerHTML = `<p class="small" style="margin:0 0 4px"><b>${hEsc(email)}</b> ist noch nicht freigeschaltet.</p>
          <p class="mute small">Frag deinen Zugang an. JD Brüder legt fest, was du in der App siehst, und gibt dir deinen Code persönlich.</p>
          <label class="f">Ich bin</label><select class="i" id="aw"><option value="monteur">Mitarbeiter von JD Brüder</option><option value="sub">Subunternehmer</option><option value="hersteller">meta Trennwandanlagen</option></select>
          <label class="f">Dein Name *</label><input class="i" id="an" autocomplete="name">
          <label class="f">Firma</label><input class="i" id="af" placeholder="nur bei Subunternehmern">
          <label class="f">Telefon</label><input class="i" id="at" inputmode="tel" autocomplete="tel">
          ${knopf("ab", "Zugang anfragen")}
          <div class="row between small" style="margin-top:10px"><a href="#" id="lx">Andere E-Mail</a><a href="#" id="lhc">Ich habe schon einen Code</a></div>`;
        $("#ab").onclick = () => busy($("#ab"), async () => {
          if (!$("#an").value.trim()) throw new Error("Bitte deinen Namen eintragen.");
          const r = await zugangFn({ art: "anfrage", email, name: $("#an").value, firma: $("#af").value, tel: $("#at").value, wunsch: $("#aw").value });
          if (r.fehler) throw new Error(r.fehler);
          modus = "persoenlich"; zeigeCode("✓ Anfrage gesendet. JD Brüder gibt dir deinen Code persönlich – dann hier eingeben. Du kannst die Seite so lange schließen.");
        });
        $("#lx").onclick = e => { e.preventDefault(); zeigeMail(); };
        $("#lhc").onclick = e => { e.preventDefault(); modus = "persoenlich"; zeigeCode("Gib den Code ein, den du von JD Brüder bekommen hast."); };
        $("#an").focus();
      };
      const zeigeCode = text => {
        $("#lv").innerHTML = `<p class="small" style="margin:0 0 4px">${text}</p><div class="small mute">${hEsc(email)}</div>
          <label class="f" for="lt">Code</label><input class="i" id="lt" inputmode="numeric" autocomplete="one-time-code" maxlength="8" style="font-size:22px;letter-spacing:4px;text-align:center;font-weight:700">
          ${knopf("lc", "Anmelden")}<div class="small" style="margin-top:10px"><a href="#" id="lx">Andere E-Mail</a></div>`;
        const go = () => busy($("#lc"), async () => {
          const code = $("#lt").value.replace(/\D/g, "");
          if (code.length < 6) throw new Error("Bitte den 6-stelligen Code eingeben.");
          if (modus === "mail") {
            const { data, error } = await sb.auth.verifyOtp({ email, token: code, type: "email" });
            if (!error) { fertig(data.session); return; }
          }
          const r = await zugangFn({ art: "einloesen", email, code });
          if (r.fehler) throw new Error(modus === "mail" ? "Der Code stimmt nicht oder ist abgelaufen." : r.fehler);
          const { data, error } = await sb.auth.verifyOtp({ token_hash: r.token_hash, type: "magiclink" });
          if (error) throw new Error("Anmelden hat nicht geklappt: " + error.message);
          fertig(data.session);
        });
        $("#lc").onclick = go; $("#lt").onkeydown = e => { if (e.key === "Enter") go(); };
        $("#lx").onclick = e => { e.preventDefault(); zeigeMail(); }; $("#lt").focus();
      };
      const fertig = s => { d.remove(); resolve(s); };
      if (gewaehlt()) zeigeMail(); else zeigeGeraet();
    });
  }

  // Antippen einer Benachrichtigung bei offener App: zum Auftrag springen
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", e => {
    if (!e.data?.jdOpen) return;
    try { const h = new URL(e.data.jdOpen).hash; if (h && h !== location.hash) location.hash = h; else if (h) window.dispatchEvent(new HashChangeEvent("hashchange")); } catch (x) {}
  });

  /* Token für den Service Worker hinterlegen, damit Bilder (_blob/<id>) geladen werden können */
  const saveToken = s => caches.open("jd-auth").then(c => c.put("token", new Response(s ? s.access_token : ""))).catch(() => {});
  sb.auth.onAuthStateChange((_e, s) => saveToken(s));

  const ready = (async () => {
    let { data: { session } } = await sb.auth.getSession();
    if (!session) session = await loginScreen();
    await saveToken(session);
    window.jdEmail = session.user.email; // Abmelden steht jetzt unter Setup → Mein Konto
    // Einmal nach der Anmeldung zeigen, wie die App auf den Startbildschirm kommt
    setTimeout(() => window.jdInstallHilfe(false), 1500);
    if ("serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register("sw.js");
        if (!navigator.serviceWorker.controller)
          await new Promise(r => { navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }); setTimeout(r, 3000); });
      } catch (e) { console.warn("Service Worker:", e); }
    }
    return session;
  })();
  const uid = async () => (await ready).user.id;

  /* ---------- Datenbank: Sammlungen im Speicher, Live-Updates per Realtime ---------- */
  const cache = {};      // col -> Map(id -> data)
  const loading = {};    // col -> Promise
  const subs = new Set(); // { col, fn }
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const deepMerge = (a, b) => {
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = isObj(b[k]) && isObj(a[k]) ? deepMerge(a[k], b[k]) : b[k];
    return out;
  };
  const docSnap = (id, data) => ({ id, exists: data !== undefined, data: () => clone(data) });
  const notify = col => subs.forEach(s => s.col === col && s.fn());

  function loadCol(col) {
    if (!loading[col]) loading[col] = (async () => {
      await ready;
      const m = new Map(); let from = 0;
      for (;;) {
        const { data, error } = await sb.from("docs").select("id,data").eq("col", col).range(from, from + 999);
        if (error) { delete loading[col]; throw fail("read_failed", error.message); }
        data.forEach(r => m.set(r.id, r.data));
        if (data.length < 1000) break; from += 1000;
      }
      cache[col] = m;
      return m;
    })();
    return loading[col];
  }

  ready.then(() => {
    sb.channel("docs").on("postgres_changes", { event: "*", schema: "public", table: "docs" }, p => {
      const row = p.eventType === "DELETE" ? p.old : p.new;
      const m = cache[row.col]; if (!m) return;
      if (p.eventType === "DELETE") m.delete(row.id); else m.set(row.id, row.data);
      notify(row.col);
    }).subscribe();
    // Nach Funkloch/Standby alles frisch laden
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      Object.keys(cache).forEach(col => { delete loading[col]; loadCol(col).then(() => notify(col)).catch(() => {}); });
    });
  });

  function listen(col, emit, onErr) {
    const s = { col, fn: () => cache[col] && emit(cache[col]) };
    subs.add(s);
    loadCol(col).then(s.fn, e => onErr && onErr(e));
    return () => subs.delete(s);
  }

  const local = (col, id, data) => { const m = cache[col]; if (!m) return; data === undefined ? m.delete(id) : m.set(id, data); notify(col); };

  function docRef(col, id) {
    return {
      id,
      onSnapshot(cb, onErr) { return listen(col, m => cb(docSnap(id, m.get(id))), onErr); },
      async get() { const m = await loadCol(col); return docSnap(id, m.get(id)); },
      async set(data) {
        await ready;
        const { error } = await sb.from("docs").upsert({ col, id, data, updated_at: new Date().toISOString() });
        if (error) throw fail("write_failed", error.message);
        local(col, id, clone(data));
      },
      async update(patch) {
        await ready;
        // Unterobjekte (z. B. bericht, vordruck, einsatz) zusammenführen statt ersetzen,
        // sonst gehen beim Ändern eines Feldes alle anderen Felder darin verloren.
        const cur = (await loadCol(col).catch(() => null))?.get(id) || {};
        const full = {};
        for (const k of Object.keys(patch)) full[k] = isObj(patch[k]) && isObj(cur[k]) ? deepMerge(cur[k], patch[k]) : patch[k];
        const { error } = await sb.rpc("doc_update", { p_col: col, p_id: id, p_patch: full });
        if (error) throw fail("write_failed", error.message);
        local(col, id, { ...(cache[col]?.get(id) || {}), ...clone(full) });
      },
      async delete() {
        await ready;
        const { error } = await sb.from("docs").delete().match({ col, id });
        if (error) throw fail("write_failed", error.message);
        local(col, id, undefined);
      }
    };
  }

  function colRef(col, filters = []) {
    const pick = m => [...m].filter(([, d]) => filters.every(([f, v]) => d?.[f] === v)).map(([id, d]) => docSnap(id, d));
    const snap = m => { const docs = pick(m); return { docs, size: docs.length, empty: !docs.length }; };
    return {
      doc: id => docRef(col, id || crypto.randomUUID()),
      where: (f, op, v) => { if (op !== "==") throw fail("unsupported", "Nur == wird unterstützt"); return colRef(col, [...filters, [f, v]]); },
      onSnapshot: (cb, onErr) => listen(col, m => cb(snap(m)), onErr),
      get: async () => snap(await loadCol(col))
    };
  }

  const db = {
    collection: colRef,
    doc: path => { const [col, id] = path.split("/"); return docRef(col, id); }
  };

  /* ---------- Nutzer ---------- */
  const user = {
    async me() {
      const id = await uid();
      const { data } = await sb.from("profiles").select("id,name,email").eq("id", id).maybeSingle();
      return data || { id, name: "", email: (await ready).user.email };
    },
    async isOwner() {
      const { data } = await sb.from("app_owner").select("id").eq("id", await uid()).maybeSingle();
      return !!data;
    },
    async profiles(ids) {
      const { data } = await sb.from("profiles").select("id,name,email").in("id", ids);
      return Object.fromEntries((data || []).map(p => [p.id, p]));
    },
    async search(q) {
      q = (q || "").replace(/[%,()]/g, "");
      if (!q) return [];
      const { data } = await sb.from("profiles").select("id,name,email").or(`name.ilike.%${q}%,email.ilike.%${q}%`).limit(20);
      return data || [];
    }
  };

  /* ---------- Fotos, Unterschriften, PDFs ---------- */
  const assets = {
    async upload(blob) {
      await ready;
      const id = crypto.randomUUID();
      const { error } = await sb.storage.from("assets").upload(id, blob, { contentType: blob.type || "application/octet-stream" });
      if (error) throw fail("upload_failed", error.message);
      return { id };
    },
    async delete(id) {
      const { error } = await sb.storage.from("assets").remove([id]);
      if (error) throw fail("delete_failed", error.message);
    }
  };

  /* ---------- Server-Funktionen: Gmail und KI ---------- */
  async function callFn(name, body) {
    await ready;
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) {
      let detail = {}; try { detail = await error.context.json(); } catch (e) {}
      throw fail(detail.code || "upstream_error", detail.message || error.message);
    }
    return data;
  }
  const mcp = { callTool: (_server, tool, args) => callFn("gmail", { tool, args }) };
  // Mail-Abruf auf dem Server (läuft sonst automatisch alle 15 Minuten)
  const sync = { run: (body = {}) => callFn("sync", body) };
  const sample = {
    limits: async () => ({ images: true }),
    async json(prompt, opts = {}) {
      const images = [];
      for (const b of opts.images || []) {
        const buf = new Uint8Array(await b.arrayBuffer()); let s = "";
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        images.push({ type: b.type || "image/jpeg", data: btoa(s) });
      }
      return callFn("ai", { prompt, images });
    }
  };

  /* ---------- Spracheingabe über den Browser ---------- */
  function dictation() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const L = { partial: new Set(), final: new Set(), state: new Set() };
    const on = k => fn => (L[k].add(fn), () => L[k].delete(fn));
    const emit = (k, v) => L[k].forEach(f => { try { f(v); } catch (e) {} });
    let rec = null, done = null;
    return {
      onPartial: on("partial"), onFinal: on("final"), onState: on("state"),
      active: () => !!rec,
      start() {
        if (rec) return Promise.resolve();
        return new Promise((res, rej) => {
          rec = new SR(); rec.lang = "de-DE"; rec.continuous = true; rec.interimResults = true;
          let reason = "";
          emit("state", { state: "starting" });
          rec.onstart = () => { emit("state", { state: "listening" }); res(); };
          rec.onresult = e => {
            let part = "";
            for (let i = e.resultIndex; i < e.results.length; i++) {
              const t = e.results[i][0].transcript;
              e.results[i].isFinal ? emit("final", { text: " " + t.trim() }) : (part += t);
            }
            emit("partial", { text: part });
          };
          rec.onerror = e => {
            reason = e.error === "not-allowed" || e.error === "service-not-allowed" ? "not_granted" : e.error === "aborted" || e.error === "no-speech" ? "" : "upstream_error";
            if (reason) rej(fail(reason));
          };
          rec.onend = () => { rec = null; emit("state", { state: "idle", reason }); done && done(); done = null; };
          try { rec.start(); } catch (e) { rec = null; rej(fail("unavailable", e.message)); }
        });
      },
      stop() {
        if (!rec) return Promise.resolve();
        emit("state", { state: "finishing" });
        return new Promise(r => { done = r; rec.stop(); });
      }
    };
  }

  /* ---------- Dateien speichern / teilen ---------- */
  const downloads = {
    async save({ filename, data }) {
      const file = new File([data], filename, { type: data.type || "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
        try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === "AbortError") return; }
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
  };

  const services = { db, user, assets, mcp, sample, downloads, sync };
  window.claude = {
    async use(name) {
      await ready;
      if (name === "dictation") { const d = dictation(); if (!d) throw fail("unavailable"); return d; }
      if (services[name]) return services[name];
      throw fail("unavailable", name);
    }
  };
  window.jdLogout = async () => { await sb.auth.signOut(); await saveToken(null); await caches.delete("jd-blobs").catch(() => {}); location.reload(); };
})();
