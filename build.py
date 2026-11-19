"""Baut index.html aus der Claude-Version: Supabase-Ersatz einbinden, Bildpfade relativ machen, Claude-Hinweise anpassen."""
from pathlib import Path

here = Path(__file__).parent
html = (here / "original-claude.html").read_text()

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
(here / "index.html").write_text(html)
print("index.html gebaut")
