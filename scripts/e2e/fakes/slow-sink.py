#!/usr/bin/env python3
"""A slow box-side reader for forward.test.sh's uploads, and the laptop-side
sender. The sink has a small, fixed receive buffer (as slow-client.py does, so
the kernel can't soak up the upload on loopback and the agent really is held
back) and reads at most RATE bytes a second.

usage: slow-sink.py sink <port> <bytes per second> <log file> [<answer after seconds>]
           each connection: read to EOF, append "<bytes> <eof|reset> <sha256>"
           to the log, wait <answer after seconds> (default 0), as a service
           still working on its answer, then answer "done\\n" and close
       slow-sink.py send <port> <MiB>
           send MiB of the t3-blob pattern (byte i = (31i + 7) mod 256) as fast
           as the socket takes it, half-close, and print "sent <answer>" or
           "error <what>"
"""
import hashlib
import socket
import sys
import threading
import time

MIB = 1024 * 1024
PATTERN = bytes((i * 31 + 7) & 0xFF for i in range(MIB))


def sink(port, rate, log, answer_after=0.0):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 32 * 1024)
    srv.bind(("127.0.0.1", port))
    srv.listen(16)
    lock = threading.Lock()

    def serve(conn):
        start, n, how, h = time.monotonic(), 0, "eof", hashlib.sha256()
        try:
            while True:
                chunk = conn.recv(16 * 1024)
                if not chunk:
                    break
                n += len(chunk)
                h.update(chunk)
                wait = start + n / rate - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
        except OSError:
            how = "reset"
        with lock, open(log, "a") as f:
            f.write(f"{n} {how} {h.hexdigest()}\n")
        time.sleep(answer_after)
        try:
            conn.sendall(b"done\n")
            conn.close()
        except OSError:
            pass

    while True:
        conn, _ = srv.accept()
        threading.Thread(target=serve, args=(conn,), daemon=True).start()


def send(port, mb):
    s = socket.create_connection(("127.0.0.1", port))
    try:
        for _ in range(mb):
            s.sendall(PATTERN)
        s.shutdown(socket.SHUT_WR)
        print("sent", s.recv(100).decode().strip() or "-")
    except OSError as e:
        print("error", e.strerror or e)


if __name__ == "__main__":
    if sys.argv[1] == "sink":
        sink(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], float(sys.argv[5]) if len(sys.argv) > 5 else 0.0)
    else:
        send(int(sys.argv[2]), int(sys.argv[3]))
