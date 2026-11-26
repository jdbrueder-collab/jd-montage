"""Baut index.html aus der Claude-Version: Supabase-Ersatz einbinden, Bildpfade relativ machen, Claude-Hinweise anpassen."""
from pathlib import Path
import sys

here = Path(__file__).parent
# python build.py            → normale App (index.html) aus original-claude.html
# python build.py --vorschau → Vorschau (vorschau/index.html) aus vorschau/original.html – zum Ausprobieren, die normale App bleibt unverändert
VORSCHAU = "--vorschau" in sys.argv
html = (here / ("vorschau/original.html" if VORSCHAU else "original-claude.html")).read_text(encoding="utf-8")

HEAD = """<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="#1d3a5f">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="JD Montage">
<link rel="apple-touch-icon" href="icon-192.png">
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>
<script src="config.js"></script>
<script src="claude-shim.js"></script>
<style>
/* Fest wie eine App: kein Zoomen, kein seitliches Verrutschen, kein Gummiband-Effekt */
html,body{overflow-x:clip;overscroll-behavior:none;touch-action:pan-x pan-y;-webkit-text-size-adjust:100%;text-size-adjust:100%}
/* ab 16px zoomt das iPhone beim Antippen von Eingabefeldern nicht mehr rein */
input,select,textarea{font-size:16px!important}
img,canvas,table{max-width:100%}
</style>
<script>document.addEventListener("gesturestart",e=>e.preventDefault(),{passive:false});</script>
</head>"""

REPLACE = [
    ("</head>", HEAD),
    ('content="width=device-width, initial-scale=1, viewport-fit=cover"',
     'content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"'),
    ('"/_blob/', '"_blob/'),
    ("Diese App läuft nur, wenn sie über claude.ai geöffnet wird.", "App konnte nicht starten. Bitte Seite neu laden."),
    ("Bitte bei claude.ai angemeldet öffnen", "Bitte neu anmelden"),
    (" Entferne sie danach auch aus der Freigabe in claude.ai.", ""),
    ("Zum Senden muss Gmail in claude.ai verbunden sein.", "Gmail ist noch nicht eingerichtet."),
    ("Teile die App in claude.ai mit deinen Leuten und meta (als „Bearbeiter“).",
     "Schick deinen Leuten und meta den Link zur App. Nach der Anmeldung erscheinen sie hier zur Freigabe."),
    ("über das Gmail, das du in claude.ai verbunden hast.", "über das JD-Brüder-Gmail."),
    ("Gmail ist in claude.ai nicht verbunden (Einstellungen → Konnektoren).", "Gmail ist noch nicht eingerichtet."),
    ("Gmail-Verbindung abgelaufen – in claude.ai neu verbinden.", "Gmail-Verbindung abgelaufen, bitte neu einrichten."),
]
for old, new in REPLACE:
    assert old in html, f"nicht gefunden: {old}"
    html = html.replace(old, new)
assert "/_blob/" not in html.replace('"_blob/', "")
if VORSCHAU:
    # gleiche Daten wie die App, Dateien eine Ebene höher; deutlicher Hinweis „Vorschau“
    for old, new in [('href="manifest.webmanifest"', 'href="../manifest.webmanifest"'), ('href="icon-192.png"', 'href="../icon-192.png"'),
                     ('src="config.js"', 'src="../config.js"'), ('src="claude-shim.js"', 'src="../claude-shim.js"'), ('"_blob/', '"../_blob/'),
                     ('.replace(/[^/]*$/,"");', r'.replace(/[^/]*$/,"").replace(/vorschau\/$/,"");')]:
        assert old in html, f"Vorschau: nicht gefunden: {old}"
        html = html.replace(old, new)
    html = html.replace('<script src="../claude-shim.js"></script>', """<script>if(navigator.serviceWorker){const r=navigator.serviceWorker.register.bind(navigator.serviceWorker);navigator.serviceWorker.register=(u,o)=>r(u==="sw.js"?"../sw.js":u,{...(o||{}),scope:"../"});}</script>
<script src="../claude-shim.js"></script>
<style>.vorschau-band{position:fixed;left:0;right:0;top:0;z-index:9999;background:#7c3aed;color:#fff;font:700 12px/1.2 system-ui,sans-serif;text-align:center;padding:4px 8px calc(4px);padding-top:max(4px,env(safe-area-inset-top))}.vorschau-band a{color:#fff;margin-left:8px}body{padding-top:22px}</style>""", 1)
    html = html.replace("<body>", '<body><div class="vorschau-band">VORSCHAU – zum Ausprobieren, gleiche Daten wie die App <a href="../">zur normalen App ›</a></div>', 1)
    assert 'class="vorschau-band"' in html, "body-Tag nicht gefunden"
# Versionskennung: ändert sich mit App, Anmelde-Hülle und Service Worker → App zeigt „neue Version da“
import hashlib, json
build = hashlib.sha1((html + (here / "claude-shim.js").read_text(encoding="utf-8") + (here / "sw.js").read_text(encoding="utf-8")).encode("utf-8")).hexdigest()[:12]
html = html.replace("</head>", f'<script>window.JD_BUILD="{build}";</script>' + chr(10) + '</head>', 1)
ziel = here / ("vorschau" if VORSCHAU else ".")
(ziel / "version.json").write_text(json.dumps({"build": build}), encoding="utf-8")
(ziel / "index.html").write_text(html, encoding="utf-8")
print(("vorschau/" if VORSCHAU else "") + "index.html gebaut")
