#!/usr/bin/env python3
"""
Static file server for the PrintKiosk kiosk.

`python3 -m http.server` sends no Cache-Control header at all, so Chromium
falls back to heuristic caching. The kiosk reloads itself on an idle timer and
on every deploy, and each reload re-fetched from localhost -- which meant the
screen could keep running a stale walkin.html from disk while the live site had
already moved on. That produced impossible-looking states: a page with the new
camera button calling helpers that did not exist in the copy it was running.

This server sends no-store on everything, so what is on disk is always what
the kiosk runs.

Usage: kiosk-serve.py <root-dir> <port>
"""

import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    """Serves files, but never lets anything be cached."""

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        # The kiosk syncs these from the live site mid-run; a cached copy would
        # hide the update until a manual restart.
        self.send_header("Last-Modified", "")
        super().end_headers()

    def send_response(self, code, message=None):
        # SimpleHTTPRequestHandler logs to stderr, which ends up in the journal
        # and buries real errors. Keep it to warnings.
        super().send_response(code, message)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1

    root = os.path.abspath(sys.argv[1])
    port = int(sys.argv[2])

    if not os.path.isdir(root):
        print("not a directory: %s" % root)
        return 1

    handler = partial(NoCacheHandler, directory=root)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    print("serving %s on http://127.0.0.1:%d (no-store)" % (root, port))
    sys.stdout.flush()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
