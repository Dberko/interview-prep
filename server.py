"""Local server for the interview practice app.

Serves the static files in this folder and forwards /lm/* to LM Studio, so the
browser never has to deal with CORS or hold the LM Studio API key.

    python server.py
    python server.py --port 8765 --lm http://localhost:1234
"""

import argparse
import http.server
import os
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
KEY_FILE = os.path.join(ROOT, "lmstudio_key.txt")


def load_api_key():
    key = os.environ.get("LMSTUDIO_API_KEY", "").strip()
    if not key and os.path.exists(KEY_FILE):
        with open(KEY_FILE, encoding="utf-8") as f:
            key = f.read().strip()
    return key


class Handler(http.server.SimpleHTTPRequestHandler):
    lm_url = "http://localhost:1234"
    api_key = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # always serve the latest edit of the static files
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/lm/"):
            self.proxy()
        elif self.path.split("?")[0].endswith("lmstudio_key.txt"):
            self.send_error(404)
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/lm/"):
            self.proxy()
        else:
            self.send_error(404)

    def proxy(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = "Bearer " + self.api_key
        req = urllib.request.Request(
            self.lm_url + self.path[len("/lm"):], data=body, method=self.command, headers=headers
        )

        try:
            resp = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            self.relay_error(e.code, e.read())
            return
        except (urllib.error.URLError, OSError):
            self.relay_error(502, b'{"error": "LM Studio is not reachable at %s"}' % self.lm_url.encode())
            return

        try:
            with resp:
                self.send_response(resp.status)
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.end_headers()
                # no Content-Length: the connection closing marks the end of the stream
                while True:
                    chunk = resp.read1(4096)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except OSError:
            pass  # the browser aborted the request (barge-in or a new message)

    def relay_error(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if self.path.startswith("/lm/"):
            super().log_message(fmt, *args)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--lm", default="http://localhost:1234", help="LM Studio server URL")
    args = parser.parse_args()

    Handler.lm_url = args.lm.rstrip("/")
    Handler.api_key = load_api_key()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Interview practice app: http://localhost:{args.port}")
    print(f"LM Studio: {Handler.lm_url} (API key {'loaded' if Handler.api_key else 'not set'})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
