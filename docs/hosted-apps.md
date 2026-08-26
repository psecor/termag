# Hosting apps on the termag host (suburl routing)

The termag orchestrator host can serve extra web apps on path prefixes of the
same ALB — `https://<alb-host>/org`, `/okr`, `/moonshots`, etc. This doc is for
anyone (human or agent) working on the box who wants to add, change, or remove
one.

## How traffic flows

```
ALB :443  ──▶  instance :3040 (nginx gateway)  ──▶  localhost:<port> per app
                    │
                    ├── /termag  → 127.0.0.1:3100  (termag backend)
                    └── /<app>   → 127.0.0.1:<port> (your app)
```

There is exactly **one** ALB target group, pointing at nginx on :3040. nginx
fans out by path prefix. Routing lives on the box, on the persistent volume —
**never** add ALB target groups or listener rules for an app. Hand-made ALB
config is not in terraform, so it silently breaks every time the instance is
replaced (that's the failure mode this setup exists to end).

## Why this survives instance replacement

The root volume (and everything on it: `/etc/systemd/system`, ALB target
registrations of the old instance id) is destroyed on replacement. The EBS
volume mounted at `/srv/termag` survives. So an app's *entire* footprint must
live under `/srv/termag` (`/home` is a bind mount of `/srv/termag/home`, so
home directories count):

```
/srv/termag/apps/<name>/
├── nginx.conf        # route snippet, picked up by the gateway's wildcard include
└── <name>.service    # systemd unit for the app process
```

At boot, `termag-apps.service` runs `/usr/local/bin/termag-apps-boot`, which
re-links + starts every `*.service` under `/srv/termag/apps/*/` and reloads
nginx. On the first boot of a replacement instance, cloud-init runs the same
script after mounting `/srv/termag`. Nothing to re-provision by hand.

## Adding an app

1. **Pick a port.** Check what's listening (`ss -ltn`) and take a free port
   ≥ 3101. Reserved: 3040 (nginx gateway), 3100 (termag backend), 3041 (okr),
   3042 (org), 3043 (moonshots). Bind to `127.0.0.1` — nothing but nginx
   should be reachable from off-box.

2. **Serve under your prefix.** nginx passes the full path through, so the app
   must handle `/myapp/...` itself (a base-path setting in most frameworks).
   Keep the app's code somewhere persistent, e.g. `/home/<you>/myapp`.

3. **Create the app dir** and the two files:

   ```bash
   sudo mkdir -p /srv/termag/apps/myapp
   ```

   `/srv/termag/apps/myapp/nginx.conf`:

   ```nginx
   location /myapp {
       proxy_pass http://127.0.0.1:3101;
       include /etc/nginx/snippets/termag-proxy.conf;
   }
   ```

   The shared snippet covers websockets, streaming, long-lived idle
   connections, and `X-Termag-Peer-Addr`. Add app-specific directives (e.g.
   `client_max_body_size`) inside the `location` block if you need them.

   **Always include the shared snippet** — don't hand-roll `proxy_set_header`
   lines instead. Behind nginx every upstream sees a loopback TCP peer, so an
   app that grants same-host callers extra trust (termag's status writes do)
   would hand that trust to anyone who can reach `:3040`. The snippet's
   `X-Termag-Peer-Addr` is what lets the app recover the real peer, and because
   nginx sets it with `proxy_set_header` a client can't forge it. If your app
   makes any trust decision based on the caller's address, read that header
   and only believe it when your own socket peer is loopback.

   `/srv/termag/apps/myapp/myapp.service`:

   ```ini
   [Unit]
   Description=myapp — <what it is / who owns it>
   After=network.target

   [Service]
   User=<your-unix-user>
   WorkingDirectory=/home/<you>/myapp
   ExecStart=/usr/bin/node server.js
   Environment=PORT=3101
   Restart=on-failure
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

   Make the unit self-contained: absolute paths, explicit `User=`, everything
   it references on `/home` or `/srv/termag`. It will be started by root's
   systemd on a box that has none of your shell state.

4. **Register it** (this is also what runs at every boot):

   ```bash
   sudo termag-apps-boot
   ```

5. **Verify:**

   ```bash
   systemctl status myapp
   curl -sS http://localhost:3040/myapp/          # through the gateway
   ```

   Then hit `https://<alb-host>/myapp/` from a VPN'd browser.

## Changing routes

Edit the app's `nginx.conf` snippet, then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` failing means your snippet is broken — nginx keeps serving the old
config, so fix the snippet rather than restarting anything.

## Removing an app

```bash
sudo systemctl disable --now myapp.service
sudo rm -rf /srv/termag/apps/myapp
sudo nginx -t && sudo systemctl reload nginx
```

## Rules

- **Never** create ALB target groups, listener rules, or security-group rules
  for an app. If you think you need ALB-level behavior (auth, weighted
  routing), raise it — that's a terraform-modules change, not a box change.
- Everything an app needs must live under `/srv/termag` (incl. `/home`).
  Anything written elsewhere is gone on the next instance replacement.
- Don't edit `/etc/nginx/sites-available/termag-gateway.conf` on the box — it
  comes from the AMI (`deploy/nginx/termag-gateway.conf` in the termag repo).
  Per-app routing belongs in your snippet.
- Don't claim a `location` under `/termag` — that prefix is the backend's, and
  a snippet that shadows part of it would also bypass the gateway's
  `X-Termag-Peer-Addr` handling (see above).
