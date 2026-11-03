#!/usr/bin/env python3
"""A slow HTTP client for t3-slow-relay.test.sh: GET a URL over plain HTTP/1.1
with a small, fixed receive buffer (so the kernel cannot soak up the body the
way curl's autotuned one does on loopback, and the relay really is held back),
reading at most RATE bytes a second. Prints `<status> <body bytes> <sha256>
<seconds> <how>`, how being `ended` (the whole Content-Length arrived),
`cut` (the connection closed short) or `hung` (nothing for IDLE seconds).
The bearer comes from $AUTH, never from argv.

usage: slow-client.py <url> <bytes per second> [idle seconds]
"""
import hashlib
import os
import socket
import sys
import time
from urllib.parse import urlsplit

url, rate = sys.argv[1], int(sys.argv[2])
idle = float(sys.argv[3]) if len(sys.argv) > 3 else 60
u = urlsplit(url)
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 32 * 1024)
s.connect((u.hostname, u.port or 80))
s.settimeout(idle)
path = u.path + (f"?{u.query}" if u.query else "")
s.sendall(f"GET {path} HTTP/1.1\r\nHost: {u.netloc}\r\nAuthorization: {os.environ['AUTH']}\r\nConnection: close\r\n\r\n".encode())

start = time.monotonic()
head = b""
while b"\r\n\r\n" not in head:
    chunk = s.recv(4096)
    if not chunk:
        print(f"0 0 - {time.monotonic() - start:.1f} cut")
        sys.exit(0)
    head += chunk
head, body = head.split(b"\r\n\r\n", 1)
lines = head.decode("latin-1").split("\r\n")
status = int(lines[0].split()[1])
length = next((int(l.split(":", 1)[1]) for l in lines[1:] if l.lower().startswith("content-length:")), None)
digest, got, how = hashlib.sha256(body), len(body), "cut"
try:
    while length is None or got < length:
        # Pace to `rate`: sleep until the bytes so far are due.
        ahead = got / rate - (time.monotonic() - start)
        if ahead > 0:
            time.sleep(ahead)
        chunk = s.recv(16 * 1024)
        if not chunk:
            break
        digest.update(chunk)
        got += len(chunk)
    else:
        how = "ended"
except socket.timeout:
    how = "hung"
print(f"{status} {got} {digest.hexdigest()} {time.monotonic() - start:.1f} {how}")
