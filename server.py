# -*- coding: utf-8 -*-
"""
נקדן לקריינים — שרת מקומי (ללא תלויות)
Local, zero-dependency server. Serves the UI and exposes /api/nikud.

Run:  python3 server.py           (default port 8788)
      PORT=9000 python3 server.py
Open: http://localhost:8788
"""
import json
import os
import sys
import traceback
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Engine selection: local standalone model (default) or dicta (online fallback).
_MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', 'phonikud-1.0.int8.onnx')
_CLOUD = any(k.startswith('RAILWAY_') for k in os.environ)
# default engine: the local model when it is installed, otherwise Dicta (cloud hosting has no model)
ENGINE = os.environ.get('NIKUD_ENGINE', 'local' if os.path.exists(_MODEL) else 'dicta').lower()
if ENGINE == 'dicta':
    import nikud_engine_dicta as E     # online version: Dicta's Nakdan, no local model
else:
    import nikud_engine_local as E

try:
    import pdf_extract
except Exception:
    pdf_extract = None

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get('PORT', '8788'))
HOST = os.environ.get('HOST', '0.0.0.0' if _CLOUD else '127.0.0.1')   # cloud hosting listens on all interfaces
PASSWORD = os.environ.get('NAKDAN_PASSWORD', '')        # the owner's password (user: pele)


def _load_users():
    """NAKDAN_USERS = "dana:code1, yossi:code2"  — one personal code per person.
    Remove a pair to revoke that person. NAKDAN_PASSWORD keeps working for the owner."""
    import re
    users = {}
    for part in re.split(r'[,;\n]+', os.environ.get('NAKDAN_USERS', '')):
        name, sep, code = part.strip().partition(':')
        if sep and name.strip() and code.strip():
            users[name.strip()] = code.strip()
    return users


USERS = _load_users()
AUTH_ON = bool(PASSWORD or USERS)
MAX_CHARS = 16000      # per nikud call; the textarea is editable so users pick a section


def _build():
    """short fingerprint of the client files, to tell which version is deployed"""
    import hashlib
    h = hashlib.sha1()
    for name in ('app.js', 'nikud_core.js', 'index.html'):
        try:
            with open(os.path.join(HERE, name), 'rb') as f:
                h.update(f.read())
        except OSError:
            pass
    return h.hexdigest()[:8]


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype='application/json; charset=utf-8'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        data = body.encode('utf-8') if isinstance(body, str) else body
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass  # quiet

    user = ''

    def _authorized(self):
        """HTTP Basic Auth. Personal codes (NAKDAN_USERS) are matched by name;
        the owner password (NAKDAN_PASSWORD) is accepted under any name."""
        if not AUTH_ON:
            return True
        import base64, hmac
        h = self.headers.get('Authorization', '')
        if h.startswith('Basic '):
            try:
                raw = base64.b64decode(h[6:])
                try:
                    cred = raw.decode('utf-8')
                except UnicodeDecodeError:
                    cred = raw.decode('latin-1')
                name, _, pw = cred.partition(':')
                name = name.strip()
                code = USERS.get(name) or next((c for n, c in USERS.items() if n.lower() == name.lower()), None)
                if code and hmac.compare_digest(pw.encode('utf-8'), code.encode('utf-8')):
                    self.user = name
                    return True
                if PASSWORD and hmac.compare_digest(pw.encode('utf-8'), PASSWORD.encode('utf-8')):
                    self.user = 'pele'
                    return True
            except Exception:
                pass
        data = 'נדרשים שם משתמש וקוד אישי'.encode('utf-8')
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="nikud", charset="UTF-8"')
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        return False

    def do_OPTIONS(self):
        self._send(204, '')

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/health':
            ready = getattr(E, 'model_ready', lambda: True)()
            return self._send(200, {'ok': True, 'engine': ENGINE, 'model_ready': ready, 'build': _build()})
        if not self._authorized():
            return
        if path == '/api/whoami':
            return self._send(200, {'user': self.user})
        if path in ('/', '/index.html'):
            return self._serve_file('index.html', 'text/html; charset=utf-8')
        # static: only web assets that sit next to index.html
        safe = path.lstrip('/')
        ctypes = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                  '.css': 'text/css; charset=utf-8'}
        ext = os.path.splitext(safe)[1].lower()
        if safe and '/' not in safe and '..' not in safe and ext in ctypes \
                and os.path.isfile(os.path.join(HERE, safe)):
            return self._serve_file(safe, ctypes[ext])
        return self._send(404, {'error': 'not found'})

    def _serve_file(self, name, ctype):
        try:
            with open(os.path.join(HERE, name), 'rb') as f:
                return self._send(200, f.read(), ctype)
        except FileNotFoundError:
            return self._send(404, {'error': 'missing ' + name})

    def do_POST(self):
        if not self._authorized():
            return
        full = self.path
        path = full.split('?', 1)[0]
        qs = {}
        if '?' in full:
            from urllib.parse import parse_qs
            qs = {k: v[0] for k, v in parse_qs(full.split('?', 1)[1]).items()}
        length = int(self.headers.get('Content-Length', '0') or '0')
        raw = self.rfile.read(length) if length else b''
        if AUTH_ON:                                   # who used what (shows in the hosting logs)
            print(f"[use] {self.user or '-'} {path} {length}b", flush=True)

        # --- PDF paginated extraction (for book navigation) ---
        if path == '/api/pdf_pages':
            if pdf_extract is None:
                return self._send(500, {'error': 'pdf extractor unavailable (pymupdf)'})
            if not raw:
                return self._send(400, {'error': 'empty file'})
            try:
                res = pdf_extract.extract_pages(raw)
                for pg in res['pages']:
                    pg.pop('text', None)                 # the client rebuilds text from the lines
                return self._send(200, res)
            except Exception as ex:
                traceback.print_exc()
                return self._send(502, {'error': 'pdf extract failed', 'detail': str(ex)})

        # --- PDF extraction (raw binary body) ---
        if path == '/api/extract_pdf':
            if pdf_extract is None:
                return self._send(500, {'error': 'pdf extractor unavailable (pymupdf)'})
            if not raw:
                return self._send(400, {'error': 'empty file'})
            try:
                first = int(qs['first']) if qs.get('first') else None
                last = int(qs['last']) if qs.get('last') else None
                text, pages = pdf_extract.extract(raw, first, last)
                return self._send(200, {'text': text, 'pages': pages, 'chars': len(text)})
            except Exception as ex:
                traceback.print_exc()
                return self._send(502, {'error': 'pdf extract failed', 'detail': str(ex)})

        # --- nikud (JSON body) ---
        try:
            payload = json.loads(raw.decode('utf-8')) if raw else {}
        except Exception:
            return self._send(400, {'error': 'bad json'})

        if path == '/api/nikud_lines':
            lines = payload.get('lines') or []
            if not isinstance(lines, list) or not lines:
                return self._send(400, {'error': 'no lines'})
            lines = [str(x) for x in lines][:400]
            if sum(len(x) for x in lines) > MAX_CHARS:
                return self._send(413, {'error': 'page too long'})
            try:
                return self._send(200, {'lines': E.process_lines(lines, payload.get('para'))})
            except Exception as ex:
                traceback.print_exc()
                return self._send(502, {'error': 'nikud failed', 'detail': str(ex)})

        if path == '/api/nikud':
            text = (payload.get('text') or '').strip()
            opts = payload.get('opts') or {}
            if not text:
                return self._send(400, {'error': 'empty text'})
            truncated = len(text) > MAX_CHARS
            if truncated:
                text = text[:MAX_CHARS]
            try:
                tokens = E.process(text, opts)
                return self._send(200, {'tokens': tokens, 'truncated': truncated,
                                        'max_chars': MAX_CHARS})
            except Exception as ex:
                traceback.print_exc()
                return self._send(502, {'error': 'nikud failed', 'detail': str(ex)})

        return self._send(404, {'error': 'not found'})


def main():
    # warm the local model in the background so the first request is fast
    if hasattr(E, 'warm'):
        threading.Thread(target=lambda: (print("טוען מודל ניקוד מקומי…"),
                                         E.warm(), print("המודל מוכן ✓")),
                         daemon=True).start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"נקדן לקריינים ✦ מנוע: {ENGINE} ✦ http://{HOST}:{PORT}" + (f" ✦ כניסה בקוד אישי ({len(USERS)} משתמשים" + (" + בעלים" if PASSWORD else "") + ")" if AUTH_ON else ""))
    print("Ctrl+C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
        srv.shutdown()


if __name__ == '__main__':
    main()
