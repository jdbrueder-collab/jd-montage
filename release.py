"""Vorschau übernehmen oder auf eine frühere Live-Version zurücksetzen.

  python release.py status            → welche Live-Versionen es gibt, was in der Vorschau anders ist
  python release.py uebernehmen       → Vorschau wird die normale App (mit Markierung live-…)
  python release.py zurueck [MARKE]   → normale App auf die vorige (oder genannte) Live-Version zurück

Jede Live-Version bekommt eine git-Markierung „live-JJJJ-MM-TT-HHMM“. Zurücksetzen holt original-claude.html
aus dieser Markierung, baut neu, lädt hoch und markiert das Ergebnis wieder – nichts geht verloren.
Daten (Datenbank) werden dabei nie verändert, nur die Darstellung/App-Dateien.
"""
import subprocess, sys, shutil, datetime
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
from pathlib import Path

here = Path(__file__).parent


def git(*a, check=True):
    return subprocess.run(["git", *a], cwd=here, check=check, capture_output=True, text=True, encoding="utf-8").stdout.strip()


def bauen():
    for arg in ([], ["--vorschau"]):
        subprocess.run([sys.executable, "build.py", *arg], cwd=here, check=True)


def marken():
    return sorted([t for t in git("tag", "--list", "live-*").splitlines() if t], key=lambda t: git("log", "-1", "--format=%ct", t))


def hochladen(nachricht, marke_text):
    git("add", "original-claude.html", "index.html", "version.json", "vorschau/original.html", "vorschau/index.html", "vorschau/version.json")
    git("commit", "-q", "-m", nachricht + "\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>", check=False)
    marke = "live-" + datetime.datetime.now().strftime("%Y-%m-%d-%H%M")
    git("tag", "-a", marke, "-m", marke_text)
    git("push", "-q")
    git("push", "-q", "origin", marke)
    print(f"✓ hochgeladen und markiert als {marke}")


cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
if cmd == "status":
    m = marken()
    print("Live-Versionen (älteste zuerst):", *m[-10:], sep="\n  ")
    unterschied = git("diff", "--stat", "--no-index", "original-claude.html", "vorschau/original.html", check=False)
    print("Vorschau gleich wie App" if not unterschied else "Vorschau weicht ab:\n" + unterschied)
elif cmd == "uebernehmen":
    shutil.copyfile(here / "vorschau/original.html", here / "original-claude.html")
    bauen()
    hochladen("Vorschau übernommen: wird die normale App", "Vorschau übernommen")
elif cmd == "zurueck":
    m = marken()
    ziel = sys.argv[2] if len(sys.argv) > 2 else (m[-2] if len(m) > 1 else m[-1])
    (here / "original-claude.html").write_text(git("show", f"{ziel}:original-claude.html"), encoding="utf-8")
    bauen()
    hochladen(f"Zurückgesetzt auf {ziel}", f"zurückgesetzt auf {ziel}")
else:
    print(__doc__)
