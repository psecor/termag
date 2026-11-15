# termag-preview: the confining launcher

`termag preview run -- <command>` has the box agent start a dev server confined to a
copy of its checkout, so a preview link can be shared beyond the project's own members
(security review SR9). This is the binary the agent runs for it. Ported from the
prototype in #1108 (pl-L), whose report has the transcripts behind each rule.

One static Go binary, on `golang.org/x/sys/unix` only, baked into the box image at
`/usr/local/bin/termag-preview`, root-owned (`packer/scripts/box-lib.sh`,
`install_preview_launcher`). The bake then checks the kernel the image boots
against `syscalls-arm64.txt` and for Landlock ABI 4
(`packer/scripts/check-preview-launcher.sh`, after the GA-kernel pin), not the
builder's, since a full bake runs on a newer kernel than the box boots.

A running box gets it, or a newer one, on its next box update or boot:
`termag-reconcile` runs `deploy/termag-preview-launcher-setup` through `sudo -n`,
which builds it from the box's checkout as the box user, installs it root's at
`/usr/local/bin/termag-preview`, and runs the same kernel check, removing the binary
if the boot kernel fails it. A box with no launcher refuses every confined run
(`launcher_missing`); "only me" links need none.

The launcher's modes:

| Mode | What it does |
|---|---|
| `launch` | Marks inherited descriptors close-on-exec, joins the run's cgroup (for `cgroup.kill`), applies Landlock (`rules.go`, the one list, and `net.go`'s TCP connect allowlist) and seccomp (`seccomp.go`), checks instance metadata is unreachable (`imds.go`), and execs the app with the `--env` allowlist (`env.go`) in `<run>/work` |
| `sync` | Under its own ruleset (read the checkout, write `<run>/work`): copies `git ls-files -co --exclude-standard` and root `.env*` files, builds the `node_modules` overlay or copy, says `ready`, then follows inotify. Never follows a symlink (`sync.go`) |
| `clean` | Under a ruleset of the run directory only: empties it without following anything |
| `peercred` | Prints `SO_PEERCRED` of fd 3, for the agent (Node has no getsockopt) |
| `abi` | Prints the kernel's Landlock ABI (the launcher needs 4) |

TCP connect is an allowlist (`net.go`; SR9, settled in row 5b): Landlock ABI 4 allows
port 443 and the ports given to `termag preview run --allow`, nothing else, on loopback or
off it. So the app can't reach the owner's unconfined debuggers and servers, nor port 80,
where instance metadata listens (the 2026-11-02 decision; 80 can't be declared). The
launcher still probes IMDS before exec and refuses to start if it answers, and prints
`TCPNotice` in the run's log at every start, so the agent can name a refused connect.

TCP Fast Open is refused outright (seccomp: `MSG_FASTOPEN` in `sendto`, `sendmsg` or
`sendmmsg` is `EOPNOTSUPP`): its send connects without `connect()`, which Landlock's rule
didn't see on 6.8.0-1067-aws. Box images and box updates turn client Fast Open off too
(`deploy/termag-preview-sysctl-setup`), and the launcher refuses to start if a Fast Open send
reaches IMDS or a loopback canary. The canary tests the seccomp rule only while client Fast Open
is on; where it's off, as on boxes, the kernel refuses first. `TestSendRule`, which evaluates the
filter in-process and runs everywhere, CI included, is the test that pins the rule.

The launcher also refuses to start unless Yama's `kernel.yama.ptrace_scope` is at least 1
(`yama.go`): the ptrace, `pidfd_getfd` and `PR_SET_PTRACER` refusals rest on it. Ubuntu sets 1,
and box images and box updates make sure of it.

`syscalls-arm64.txt` is the system calls the box kernel has, each reviewed against the
seccomp deny list. The filter allows by default, so the bake fails on a kernel with a call
that isn't in the file. The file also records the kernel package it was reviewed against, which
must be the GA kernel `packer/scripts/enable-hibernation.sh` pins: `packer/scripts/check-kernel-pin.sh`
fails the PR when they differ, and prints the commands that list a new kernel's calls.

## Tests

```sh
cd preview-launcher && go test ./...
```

The `confine_test.go` and `sync_test.go` tests run the built launcher on the real kernel
and need Landlock ABI 4 (a box: Ubuntu 24.04, 6.8); the launch tests skip below 4 and the sync tests below 3, and
`TestConfinedIMDS` skips where IMDS doesn't answer the owner.
Box AMI CI's `preview-launcher` job runs them all on GitHub's runner, which has Landlock ABI 4 (and an
IMDS-like endpoint at 169.254.169.254:80, so `TestConfinedIMDS` runs there too), after making the
launcher's system paths root's as on a box; it names each failing test, with why, and each skip, as
annotations. The runner is x86_64 on Azure's kernel, not a box's arm64 6.8, so still run them on a box
before pushing a change here: the box kernel is where Landlock's behaviour has differed (TCP Fast Open
passed it on 6.8.0-1067-aws).
