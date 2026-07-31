#!/usr/bin/env python3
"""Static file server for the TFT Perfect Traits explorer.

Binds 0.0.0.0 so it's reachable over LAN and Tailscale.
Port defaults to 8808, override with TFT_PORT.
"""
import http.server, os, socketserver, sys

PORT = int(os.environ.get("TFT_PORT", "8808"))
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print(f"serving {ROOT} on 0.0.0.0:{PORT}", flush=True)
        httpd.serve_forever()
