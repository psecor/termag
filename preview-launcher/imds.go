package main

// Instance metadata. Decided 2026-11-02 (plans/preview-links.md, "Decisions";
// pl-L report §4.1): a Landlock ABI 4 rule handles TCP connect and never allows
// port 80, where IMDS listens on IPv4 and IPv6 (net.go), and the probe below makes
// the start fail closed if IMDS is reachable anyway. Nothing is loaded as root
// and nothing goes stale; the cost is that a confined app can't connect to
// port 80 anywhere. The nft `socket cgroupv2` rule was dropped: nft binds it to
// a cgroup id at load, so it stopped matching, silently, once the preview
// cgroup was made again.

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// IMDSPort is the TCP port instance metadata listens on, which the app may
// never connect to: it isn't in the app's allowed ports (net.go) and can't
// be declared.
const IMDSPort = 80

var imdsAddrs = []string{"169.254.169.254:80", "[fd00:ec2::254]:80"}

// ProbeIMDS refuses when a TCP connection to IMDS succeeds. A refusal, an
// unreachable network or a timeout all count as blocked.
func ProbeIMDS(timeout time.Duration) error { return probeAddrs(imdsAddrs, timeout) }

func probeAddrs(addrs []string, timeout time.Duration) error {
	for _, a := range addrs {
		// MPTCP too: Landlock's port rules don't cover it on 6.8, so it is seccomp that refuses it, and the probe
		// checks that refusal held (Cursor Security Agent, #1519).
		if mptcpConnects(a, timeout) {
			return fmt.Errorf("instance metadata at %s (MPTCP) is reachable from this process; refusing to start", a)
		}
		// TCP Fast Open too: its send connects without connect(), which Landlock didn't see on 6.8.0-1067-aws; the
		// seccomp rule refuses it (#1521), and the probe checks that refusal held.
		if tfoConnects(a, timeout) {
			return fmt.Errorf("instance metadata at %s (TCP Fast Open) is reachable from this process; refusing to start", a)
		}
		c, err := net.DialTimeout("tcp", a, timeout)
		if err == nil {
			c.Close()
			return fmt.Errorf("instance metadata at %s is reachable from this process; refusing to start", a)
		}
	}
	return nil
}

// JoinCgroup moves the calling process into dir (a cgroup v2 directory the
// agent made, under its own) and checks that it landed there. It runs before
// Landlock makes /sys/fs/cgroup read-only.
func JoinCgroup(dir string) error {
	dir = filepath.Clean(dir)
	if !strings.HasPrefix(dir, "/sys/fs/cgroup/") {
		return fmt.Errorf("cgroup %s is not under /sys/fs/cgroup", dir)
	}
	if err := os.WriteFile(filepath.Join(dir, "cgroup.procs"), []byte("0"), 0); err != nil {
		return fmt.Errorf("joining cgroup %s: %w", dir, err)
	}
	b, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return err
	}
	want := "0::" + strings.TrimPrefix(dir, "/sys/fs/cgroup")
	if strings.TrimSpace(string(b)) != want {
		return fmt.Errorf("in cgroup %q after joining, want %q", strings.TrimSpace(string(b)), want)
	}
	return nil
}

// mptcpConnects reports whether an IPPROTO_MPTCP stream connect to addr succeeds within timeout. Any failure,
// the socket itself refused or MPTCP absent from the kernel included, is false.
func mptcpConnects(addr string, timeout time.Duration) bool {
	fam, sa, ok := sockaddrFor(addr)
	if !ok {
		return false
	}
	fd, err := unix.Socket(fam, unix.SOCK_STREAM|unix.SOCK_NONBLOCK|unix.SOCK_CLOEXEC, ipprotoMPTCP)
	if err != nil {
		return false
	}
	defer unix.Close(fd)
	if err := unix.Connect(fd, sa); err == nil {
		return true
	} else if err != unix.EINPROGRESS {
		return false
	}
	return connectedWithin(fd, timeout)
}

// pollFn is unix.Poll; a variable so a test can interrupt it.
var pollFn = unix.Poll

// connectedWithin reports whether a non-blocking connect on fd completes within timeout. A poll interrupted by a
// signal (EINTR) is tried again for the time left, rather than read as "not connected", so the fail-closed checks
// stay strict (#1637).
func connectedWithin(fd int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		left := time.Until(deadline)
		if left <= 0 {
			return false
		}
		pfd := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLOUT}}
		n, err := pollFn(pfd, int(left.Milliseconds())+1)
		if err == unix.EINTR {
			continue
		}
		if err != nil || n == 0 {
			return false
		}
		soErr, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_ERROR)
		return err == nil && soErr == 0
	}
}

// ipprotoMPTCP is IPPROTO_MPTCP.
const ipprotoMPTCP = 262

// tfoConnects reports whether a TCP Fast Open send to addr (sendto with MSG_FASTOPEN, no connect()) connects
// within timeout. Any failure, the send refused (EOPNOTSUPP, seccomp's or a kernel's with client Fast Open off)
// included, is false.
func tfoConnects(addr string, timeout time.Duration) bool {
	fam, sa, ok := sockaddrFor(addr)
	if !ok {
		return false
	}
	fd, err := unix.Socket(fam, unix.SOCK_STREAM|unix.SOCK_NONBLOCK|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return false
	}
	defer unix.Close(fd)
	if err := unix.Sendto(fd, []byte{0}, unix.MSG_FASTOPEN, sa); err == nil {
		return true
	} else if err != unix.EINPROGRESS {
		return false
	}
	return connectedWithin(fd, timeout)
}

// sockaddrFor is host:port as a socket family and address.
func sockaddrFor(addr string) (int, unix.Sockaddr, bool) {
	host, portS, err := net.SplitHostPort(addr)
	if err != nil {
		return 0, nil, false
	}
	port, _ := strconv.Atoi(portS)
	ip := net.ParseIP(host)
	if ip == nil {
		return 0, nil, false
	}
	if ip4 := ip.To4(); ip4 != nil {
		s4 := &unix.SockaddrInet4{Port: port}
		copy(s4.Addr[:], ip4)
		return unix.AF_INET, s4, true
	}
	s6 := &unix.SockaddrInet6{Port: port}
	copy(s6.Addr[:], ip.To16())
	return unix.AF_INET6, s6, true
}

// TFOCanary is a loopback listener opened before the app is confined: once it is, a TCP Fast Open send to it must
// not connect, whatever the TCP rule allows. While client Fast Open is on (net.ipv4.tcp_fastopen bit 1, the kernel's
// default), only the seccomp rule that refuses MSG_FASTOPEN can stop it, so the canary checks that rule (#1521). With client Fast Open off, as on boxes, the kernel refuses the send itself, and the canary checks only
// that something does (#1637); TestSendRule pins the rule.
type TFOCanary struct{ ln net.Listener }

// OpenTFOCanary listens on a loopback port, unconfined.
func OpenTFOCanary() (*TFOCanary, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("the TCP Fast Open check's listener: %w", err)
	}
	return &TFOCanary{ln}, nil
}

// Check refuses when a TCP Fast Open send from this (confined) process reaches the canary; it closes the canary.
func (c *TFOCanary) Check(timeout time.Duration) error {
	defer c.ln.Close()
	if tfoConnects(c.ln.Addr().String(), timeout) {
		return fmt.Errorf("a TCP Fast Open send reaches a loopback listener from this process (%s), past the TCP rule; refusing to start", c.ln.Addr())
	}
	return nil
}
