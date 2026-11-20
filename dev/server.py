"""Lokaler Testserver für die Montage-App (nur zum Ausprobieren, keine echten Daten).
Start:  python dev/server.py   →  http://localhost:8765/dev/
- liefert die Dateien aus dem Projektordner
- /_upload  speichert Fotos/Unterschriften im Arbeitsspeicher
- /_blob/<id> liefert sie wieder aus; unbekannte IDs (Vordruck-Hintergründe) bekommen eine leere Seite
"""
import http.server, os, struct, uuid, zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BLOBS = {}

def blank_png(w=910, h=1287):
    row = b"\x00" + b"\xff\xff\xff" * w
    raw = b"".join(row if (y % 60) else b"\x00" + b"\xdd\xe4\xf0" * w for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

BLANK = blank_png()

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT), **k)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0] in ("/dev/", "/dev/index.html"):
            html = (ROOT / "original-claude.html").read_text(encoding="utf-8")
            html = html.replace("</head>", '<script src="/dev/mock-shim.js"></script>\n</head>', 1).encode("utf-8")
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.send_header("Content-Length", str(len(html))); self.end_headers()
            self.wfile.write(html); return
        if self.path.startswith("/_blob/"):
            bid = self.path.split("/_blob/", 1)[1].split("?")[0]
            lokal = ROOT / "dev" / "blobs" / bid
            if lokal.is_file() and lokal.stat().st_size:  # z. B. die meta-Vordrucke (dev/blobs, nicht im Repo)
                data = lokal.read_bytes(); typ = "image/png" if data[:4] == bytes([0x89, 0x50, 0x4E, 0x47]) else "image/jpeg"
                self.send_response(200); self.send_header("Content-Type", typ); self.send_header("Content-Length", str(len(data))); self.end_headers()
                self.wfile.write(data); return
            typ, data = BLOBS.get(bid, ("image/png", BLANK))
            self.send_response(200); self.send_header("Content-Type", typ); self.send_header("Content-Length", str(len(data))); self.end_headers()
            self.wfile.write(data); return
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/_save/"):  # nur Testsystem: Datei in dev/blobs ablegen
            name = Path(self.path.split("/_save/", 1)[1]).name
            n = int(self.headers.get("Content-Length", 0)); data = self.rfile.read(n)
            (ROOT / "dev" / "blobs" / name).write_bytes(data)
            self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"ok"); return
        if self.path == "/_upload":
            n = int(self.headers.get("Content-Length", 0)); data = self.rfile.read(n)
            bid = uuid.uuid4().hex
            BLOBS[bid] = (self.headers.get("Content-Type", "application/octet-stream"), data)
            body = ('{"id":"%s"}' % bid).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers()
            self.wfile.write(body); return
        self.send_error(404)

    def log_message(self, fmt, *args):
        pass

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8765))
    print(f"Testserver läuft: http://localhost:{port}/dev/", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
