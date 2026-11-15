package main

// The confined app's TCP connects (SR9; decided 2026-11-04, settled in row 5b).
// Landlock's network rules (ABI 4) allowlist ports, not addresses, so they
// can't tell loopback from egress. The launcher handles CONNECT_TCP and allows
// two kinds of port only: 443, for https, and the ports the owner declares with
// `termag preview run --allow` (the app's API, its database). Every other TCP
// connect is refused, anywhere:
//
//   - loopback, so the app can't reach the owner's unconfined debuggers and
//     servers (a Node inspector, a Chrome debugging port, Jupyter, ttyd, the
//     t3 server), where one connection can be code execution outside the
//     sandbox;
//   - port 80, where instance metadata listens (the 2026-11-02 decision), so
//     80 can't be declared, and the launcher still probes IMDS before exec;
//   - egress on any other port: an app calling a service on, say, 5432 or
//     8443 declares it too.
//
// The other candidates the tech spec lists were a separate uid with an nft
// rule (a root helper per run, and the IMDS fallback's image change) and
// seccomp user notification on connect (a multithreaded app can change the
// address after the check). Landlock alone needs no root, can't go stale, and
// is inherited by every descendant whatever cgroup it lands in.

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Features is what `termag-preview features` prints. tcp-allowlist: TCP
// connect reaches only 443 and --allow-tcp. The agent refuses a launcher
// without it, which would still allow every port but 80.
var Features = []string{"tcp-allowlist"}

// HTTPSPort is the one port allowed without being declared.
const HTTPSPort = 443

// MaxAllowedPorts bounds --allow.
const MaxAllowedPorts = 32

// TCPNoticePrefix starts the line the launcher prints in the run's log at every
// start, so the agent can tell a refused connect from any other EACCES
// (agent/preview-runs.js, diagnose).
const TCPNoticePrefix = "termag-preview: TCP connect is allowed only to ports "

// ParseAllow reads --allow-tcp: comma-separated ports, each 1 to 65535, not 80.
func ParseAllow(s string) ([]int, error) {
	if strings.TrimSpace(s) == "" {
		return nil, nil
	}
	seen := map[int]bool{}
	var out []int
	for _, f := range strings.Split(s, ",") {
		p, err := strconv.Atoi(strings.TrimSpace(f))
		if err != nil || p < 1 || p > 65535 {
			return nil, fmt.Errorf("--allow-tcp %q: not a port", f)
		}
		if p == IMDSPort {
			return nil, fmt.Errorf("--allow-tcp: port %d can't be allowed: instance metadata listens there", IMDSPort)
		}
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	if len(out) > MaxAllowedPorts {
		return nil, fmt.Errorf("--allow-tcp: at most %d ports", MaxAllowedPorts)
	}
	sort.Ints(out)
	return out, nil
}

// AllowedTCPPorts is every port the app may connect to: 443 and the declared ones.
func AllowedTCPPorts(declared []int) []int {
	set := map[int]bool{HTTPSPort: true}
	for _, p := range declared {
		set[p] = true
	}
	out := make([]int, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	sort.Ints(out)
	return out
}

func joinPorts(ports []int) string {
	s := make([]string, len(ports))
	for i, p := range ports {
		s[i] = strconv.Itoa(p)
	}
	return strings.Join(s, ", ")
}

// TCPNotice is the run log's line naming the allowed ports.
func TCPNotice(allowed []int) string {
	return TCPNoticePrefix + joinPorts(allowed) + " (443 and the ports given to termag preview run --allow); " +
		"any other, loopback and port 80 (instance metadata) included, is refused with EACCES"
}
