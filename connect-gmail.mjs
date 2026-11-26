// Verbindet ein Gmail-Postfach mit der Montage-App.
// Aufruf im Projektordner:  node connect-gmail.mjs
// Öffnet Google im Browser, dort mit dem gewünschten Postfach anmelden. Zum Umstellen einfach erneut ausführen.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";

const { installed: c } = JSON.parse(readFileSync(new URL("google-client.json", import.meta.url)));
// modify = lesen + Labels setzen (Ordner „JD Aufträge/<Nr>“), send = Berichte verschicken. Löschen kann die App damit nicht endgültig.
const SCOPES = "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send";

const server = createServer();
server.listen(0, "127.0.0.1", () => {
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: c.client_id, redirect_uri: redirect, response_type: "code",
    scope: SCOPES, access_type: "offline", prompt: "consent select_account",
  });
  console.log("\nIm Browser öffnet sich Google. Mit dem Postfach anmelden, aus dem die App lesen und senden soll.\n");
  if (process.platform === "win32") execFileSync("cmd", ["/c", "start", "", url.replace(/&/g, "^&")]); else execFileSync("open", [url]);

  server.on("request", async (req, res) => {
    const code = new URL(req.url, redirect).searchParams.get("code");
    if (!code) { res.end("Kein Code erhalten. Bitte nochmal versuchen."); return; }
    try {
      const t = await (await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({ code, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirect, grant_type: "authorization_code" }),
      })).json();
      if (!t.refresh_token) throw new Error(t.error_description || t.error || "Kein Refresh-Token erhalten");
      const me = await (await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${t.access_token}` } })).json();

      const envFile = new URL(".gmail-secrets.env", import.meta.url);
      writeFileSync(envFile, `GMAIL_CLIENT_ID=${c.client_id}\nGMAIL_CLIENT_SECRET=${c.client_secret}\nGMAIL_REFRESH_TOKEN=${t.refresh_token}\nGMAIL_ADDRESS=${me.emailAddress}\n`, { mode: 0o600 });
      const envPfad = process.platform === "win32" ? decodeURIComponent(envFile.pathname).replace(/^\//, "") : envFile.pathname;
      try { execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", "supabase@3.2.0", "secrets", "set", "--env-file", envPfad, "--remote=glxnvjpoipcienngybmj", "--yes"], { stdio: "inherit", shell: process.platform === "win32" }); }
      finally { unlinkSync(envFile); }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h2>Fertig ✓</h2><p>${me.emailAddress} ist mit der Montage-App verbunden. Du kannst dieses Fenster schließen.</p>`);
      console.log(`\n✓ ${me.emailAddress} ist jetzt mit der Montage-App verbunden.\n`);
    } catch (e) {
      res.end("Fehler: " + e.message);
      console.error("\n✗ " + e.message);
      process.exitCode = 1;
    }
    server.close();
  });
});
