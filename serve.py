#!/usr/bin/env python3
"""Dev server that never caches, so edits always show up on reload."""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

# --csp reproduces the kind of Content-Security-Policy a published artifact is
# served under, so the sandboxed-host behaviour can be tested locally.
CSP_MODE = "--csp" in sys.argv
STRICT_CSP = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "img-src 'self' data: blob:; "
    "connect-src 'self'; "
    "worker-src 'self' blob:; "
    "frame-ancestors *"
)
# --csp-noworker is the worst case: the host forbids workers entirely.
NOWORKER_CSP = STRICT_CSP.replace("worker-src 'self' blob:", "worker-src 'none'")
NOWORKER_MODE = "--csp-noworker" in sys.argv


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        if NOWORKER_MODE:
            self.send_header("Content-Security-Policy", NOWORKER_CSP)
        elif CSP_MODE:
            self.send_header("Content-Security-Policy", STRICT_CSP)
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter output
        if "304" not in (fmt % args):
            super().log_message(fmt, *args)


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), NoCacheHandler) as httpd:
    mode = " [worker-src none]" if NOWORKER_MODE else (" [artifact-like CSP]" if CSP_MODE else "")
    print(f"Chess Coach serving {DIRECTORY} at http://localhost:{PORT}{mode}")
    httpd.serve_forever()
