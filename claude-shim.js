/* Ersatz für window.claude auf Basis von Supabase.
   Stellt dieselben Funktionen bereit, die die App in claude.ai genutzt hat
   (db, user, assets, mcp, sample, dictation, downloads), damit der App-Code fast unverändert bleibt. */
(() => {
  "use strict";
  const { url: URL_, key: KEY } = window.JD_CONFIG;
  const sb = supabase.createClient(URL_, KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  const fail = (code, message) => Object.assign(new Error(message || code), { code });

  /* ---------- Anmeldung per 6-stelligem Code (klappt auch in der installierten Handy-App) ---------- */
  function loginScreen() {
    return new Promise(resolve => {
      const d = document.createElement("div");
      d.style.cssText = "position:fixed;inset:0;z-index:100;background:var(--bg,#f3f4f6);display:flex;align-items:center;justify-content:center;padding:16px";
      d.innerHTML = `<div class="card" style="max-width:400px;width:100%">
        <h2 style="margin:0 0 6px">JD Brüder Montage</h2>
        <p class="mute small" id="lh">Gib deine E-Mail-Adresse ein. Du bekommst einen Code zum Anmelden.</p>
        <label class="f" for="le">E-Mail</label><input class="i" id="le" type="email" autocomplete="email" inputmode="email">
        <div id="lc" class="hide"><label class="f" for="lt">Code aus der Mail</label><input class="i" id="lt" inputmode="numeric" autocomplete="one-time-code" maxlength="8"></div>
        <div id="lm" class="small" style="color:var(--bad);min-height:18px;margin-top:6px" role="alert"></div>
        <button class="btn pri block" id="lb" style="margin-top:8px">Code senden</button></div>`;
      document.body.appendChild(d);
      const $ = s => d.querySelector(s), msg = t => ($("#lm").textContent = t || "");
      let sent = false;
      const go = async () => {
        const email = $("#le").value.trim().toLowerCase();
        if (!/^\S+@\S+\.\S+$/.test(email)) return msg("Bitte eine gültige E-Mail-Adresse eingeben.");
        $("#lb").disabled = true; msg("");
        try {
          if (!sent) {
            const { error } = await sb.auth.signInWithOtp({ email });
            if (error) throw error;
            sent = true; $("#lc").classList.remove("hide"); $("#le").disabled = true;
            $("#lh").textContent = "Wir haben dir einen Code geschickt. Schau auch im Spam-Ordner nach.";
            $("#lb").textContent = "Anmelden"; $("#lt").focus();
          } else {
            const { data, error } = await sb.auth.verifyOtp({ email, token: $("#lt").value.trim(), type: "email" });
            if (error) throw error;
            d.remove(); resolve(data.session);
          }
        } catch (e) {
          msg(/rate|seconds/i.test(e.message) ? "Bitte kurz warten und dann nochmal versuchen." : sent ? "Der Code stimmt nicht oder ist abgelaufen." : "Senden hat nicht geklappt: " + e.message);
        }
        $("#lb").disabled = false;
      };
      $("#lb").onclick = go;
      d.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
      $("#le").focus();
    });
  }

  /* Token für den Service Worker hinterlegen, damit Bilder (_blob/<id>) geladen werden können */
  const saveToken = s => caches.open("jd-auth").then(c => c.put("token", new Response(s ? s.access_token : ""))).catch(() => {});
  sb.auth.onAuthStateChange((_e, s) => saveToken(s));

  const ready = (async () => {
    let { data: { session } } = await sb.auth.getSession();
    if (!session) session = await loginScreen();
    await saveToken(session);
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
        const { error } = await sb.rpc("doc_update", { p_col: col, p_id: id, p_patch: patch });
        if (error) throw fail("write_failed", error.message);
        local(col, id, { ...(cache[col]?.get(id) || {}), ...clone(patch) });
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

  const services = { db, user, assets, mcp, sample, downloads };
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
