package main

// Landlock, through the raw system calls. Every rule path is opened here, by
// the launcher, and the descriptor goes straight to landlock_add_rule: a rule
// binds to the inode it is given, so a rule path that is a symlink would
// grant its target (go-landlock's helpers open with O_PATH and follow).

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

// The kernel's structs for ABI 4. x/sys's LandlockRulesetAttr has grown fields
// newer kernels read; 6.8 takes these sizes.
type rulesetAttr struct {
	handledFS  uint64
	handledNet uint64
}

type pathBeneathAttr struct { // __attribute__((packed)) in the kernel: 12 bytes
	allowed  uint64
	parentFD int32
}

type netPortAttr struct {
	allowed uint64
	port    uint64
}

const (
	llRuleNetPort = 2

	fsRead  = unix.LANDLOCK_ACCESS_FS_READ_FILE | unix.LANDLOCK_ACCESS_FS_READ_DIR
	fsExec  = unix.LANDLOCK_ACCESS_FS_EXECUTE
	fsWrite = unix.LANDLOCK_ACCESS_FS_WRITE_FILE | unix.LANDLOCK_ACCESS_FS_REMOVE_DIR |
		unix.LANDLOCK_ACCESS_FS_REMOVE_FILE | unix.LANDLOCK_ACCESS_FS_MAKE_DIR |
		unix.LANDLOCK_ACCESS_FS_MAKE_REG | unix.LANDLOCK_ACCESS_FS_MAKE_SOCK |
		unix.LANDLOCK_ACCESS_FS_MAKE_FIFO | unix.LANDLOCK_ACCESS_FS_MAKE_SYM
	fsDevices = unix.LANDLOCK_ACCESS_FS_MAKE_CHAR | unix.LANDLOCK_ACCESS_FS_MAKE_BLOCK
	fsV1      = fsRead | fsExec | fsWrite | fsDevices
	fsRefer   = unix.LANDLOCK_ACCESS_FS_REFER    // ABI 2
	fsTrunc   = unix.LANDLOCK_ACCESS_FS_TRUNCATE // ABI 3

	// The rights Landlock accepts on a non-directory.
	fsFileRights = unix.LANDLOCK_ACCESS_FS_EXECUTE | unix.LANDLOCK_ACCESS_FS_WRITE_FILE |
		unix.LANDLOCK_ACCESS_FS_READ_FILE | fsTrunc
)

// MinABI is the oldest Landlock ABI the launcher runs on: 3 adds TRUNCATE,
// without which a read-only file could still be truncated. 6.8 has 4.
const MinABI = 3

// LandlockABI returns the running kernel's Landlock ABI version, 0 if none.
func LandlockABI() int {
	v, _, e := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, 0, 0, unix.LANDLOCK_CREATE_RULESET_VERSION)
	if e != 0 {
		return 0
	}
	return int(v)
}

func handledFS(abi int) uint64 {
	h := uint64(fsV1)
	if abi >= 2 {
		h |= fsRefer
	}
	if abi >= 3 {
		h |= fsTrunc
	}
	return h
}

func rights(a Access, abi int) uint64 {
	switch a {
	case ReadExec:
		return fsRead | fsExec
	case ReadWrite:
		return handledFS(abi) &^ fsDevices
	case ReadFile:
		return unix.LANDLOCK_ACCESS_FS_READ_FILE
	case DevNode:
		return unix.LANDLOCK_ACCESS_FS_READ_FILE | unix.LANDLOCK_ACCESS_FS_WRITE_FILE | fsTrunc
	case ListDir:
		return unix.LANDLOCK_ACCESS_FS_READ_DIR
	}
	panic("unknown access")
}

// OpenedGrant is a grant whose path the launcher has opened and checked.
type OpenedGrant struct {
	Grant
	FD       int
	Resolved string // where the descriptor points
	IsDir    bool
}

// openGrant opens one rule path the way its origin requires, or says why not.
// A missing optional path returns (nil, nil).
func openGrant(g Grant, home string, uid int) (*OpenedGrant, error) {
	var fd int
	var err error
	switch g.Origin {
	case FromHome:
		// No component may be a symlink: a committed `dist -> .git/hooks` or
		// a checkout reached through `../../.aws` would bind the rule to its
		// target.
		fd, err = unix.Openat2(unix.AT_FDCWD, g.Path, &unix.OpenHow{
			Flags:   unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC,
			Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS,
		})
		if err != nil {
			if g.Optional && errors.Is(err, unix.ENOENT) {
				return nil, nil
			}
			if errors.Is(err, unix.ELOOP) {
				return nil, fmt.Errorf("refusing %s: a component is a symlink", g.Path)
			}
			return nil, fmt.Errorf("refusing %s: %w", g.Path, err)
		}
	case FromSystem:
		flags := unix.O_PATH | unix.O_CLOEXEC
		if g.Access == ReadExec || g.Access == ListDir {
			flags |= unix.O_DIRECTORY
		}
		fd, err = unix.Open(g.Path, flags, 0)
		if err != nil {
			if g.Optional && errors.Is(err, unix.ENOENT) {
				return nil, nil
			}
			return nil, fmt.Errorf("refusing %s: %w", g.Path, err)
		}
	}
	og := &OpenedGrant{Grant: g, FD: fd}
	if og.Resolved, err = os.Readlink(fmt.Sprintf("/proc/self/fd/%d", fd)); err != nil {
		unix.Close(fd)
		return nil, err
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		unix.Close(fd)
		return nil, err
	}
	og.IsDir = st.Mode&unix.S_IFMT == unix.S_IFDIR
	if err := checkOpened(og, st, home, uid); err != nil {
		unix.Close(fd)
		return nil, err
	}
	return og, nil
}

// systemUIDMax: on Ubuntu, accounts below 1000 are the system's. resolv.conf
// resolves to a file owned by systemd-resolve (not root) on a stock box.
const systemUIDMax = 1000

func checkOpened(og *OpenedGrant, st unix.Stat_t, home string, uid int) error {
	g := og.Grant
	kind := st.Mode & unix.S_IFMT
	switch g.Access {
	case ReadExec, ReadWrite, ListDir:
		if kind != unix.S_IFDIR {
			return fmt.Errorf("refusing %s: not a directory", g.Path)
		}
	case ReadFile:
		if kind != unix.S_IFREG {
			return fmt.Errorf("refusing %s: not a regular file", g.Path)
		}
	case DevNode:
		if kind != unix.S_IFCHR {
			return fmt.Errorf("refusing %s: not a character device", g.Path)
		}
	}
	if g.Origin == FromHome {
		if og.Resolved != g.Path {
			return fmt.Errorf("refusing %s: resolves to %s", g.Path, og.Resolved)
		}
		if int(st.Uid) != uid {
			return fmt.Errorf("refusing %s: owned by uid %d, not %d", g.Path, st.Uid, uid)
		}
		return nil
	}
	// A system path: only an account of the system's may own its target, the
	// user may not write it (device nodes excepted), and it may not be in $HOME.
	if within(og.Resolved, home) {
		return fmt.Errorf("refusing %s: resolves into $HOME (%s)", g.Path, og.Resolved)
	}
	if int(st.Uid) == uid || st.Uid >= systemUIDMax {
		return fmt.Errorf("refusing %s: %s is owned by uid %d, not a system account", g.Path, og.Resolved, st.Uid)
	}
	if g.Access != DevNode && unix.Access(og.Resolved, unix.W_OK) == nil {
		return fmt.Errorf("refusing %s: %s is writable by this user", g.Path, og.Resolved)
	}
	return nil
}

// Ruleset is an opened, checked set of grants, ready to apply.
type Ruleset struct {
	ABI    int
	Grants []*OpenedGrant
	// HandleTCP makes Landlock handle TCP connect (ABI 4), allowing only
	// TCPConnect (net.go). The app's ruleset sets it; the helpers' don't.
	HandleTCP  bool
	TCPConnect []int
}

// OpenRuleset opens and checks every grant. Any failure refuses the start.
func OpenRuleset(grants []Grant, home string) (*Ruleset, error) {
	abi := LandlockABI()
	if abi < MinABI {
		return nil, fmt.Errorf("landlock ABI %d, need %d or later", abi, MinABI)
	}
	rs := &Ruleset{ABI: abi}
	uid := os.Getuid()
	for _, g := range grants {
		og, err := openGrant(g, home, uid)
		if err != nil {
			rs.Close()
			return nil, err
		}
		if og != nil {
			rs.Grants = append(rs.Grants, og)
		}
	}
	return rs, nil
}

func (rs *Ruleset) Close() {
	for _, g := range rs.Grants {
		unix.Close(g.FD)
	}
}

// Describe lists the ruleset, one rule per line, for the run's log.
func (rs *Ruleset) Describe() string {
	var b strings.Builder
	fmt.Fprintf(&b, "landlock ABI %d\n", rs.ABI)
	for _, g := range rs.Grants {
		via := ""
		if g.Resolved != g.Path {
			via = " -> " + g.Resolved
		}
		fmt.Fprintf(&b, "  %-10s %s%s\n", g.Access, g.Path, via)
	}
	if rs.HandleTCP {
		fmt.Fprintf(&b, "  tcp connect: only %s\n", joinPorts(rs.TCPConnect))
	}
	return b.String()
}

// Apply builds the ruleset and restricts the calling thread, which must be
// the one that then execs (Landlock on 6.8 has no thread sync). The caller
// has set PR_SET_NO_NEW_PRIVS.
func (rs *Ruleset) Apply() error {
	attr := rulesetAttr{handledFS: handledFS(rs.ABI)}
	if rs.HandleTCP {
		if rs.ABI < 4 {
			return fmt.Errorf("tcp port rules need landlock ABI 4, have %d", rs.ABI)
		}
		attr.handledNet = unix.LANDLOCK_ACCESS_NET_CONNECT_TCP
	}
	rfd, _, e := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, uintptr(unsafe.Pointer(&attr)), unsafe.Sizeof(attr), 0)
	if e != 0 {
		return fmt.Errorf("landlock_create_ruleset: %w", e)
	}
	defer unix.Close(int(rfd))
	for _, g := range rs.Grants {
		allowed := rights(g.Access, rs.ABI)
		if !g.IsDir {
			allowed &= fsFileRights
		}
		pb := pathBeneathAttr{allowed: allowed, parentFD: int32(g.FD)}
		if _, _, e := unix.Syscall6(unix.SYS_LANDLOCK_ADD_RULE, rfd, unix.LANDLOCK_RULE_PATH_BENEATH, uintptr(unsafe.Pointer(&pb)), 0, 0, 0); e != 0 {
			return fmt.Errorf("landlock_add_rule %s: %w", g.Path, e)
		}
	}
	if rs.HandleTCP {
		for _, port := range rs.TCPConnect {
			if port == IMDSPort {
				return fmt.Errorf("tcp port %d can't be allowed", IMDSPort)
			}
			np := netPortAttr{allowed: unix.LANDLOCK_ACCESS_NET_CONNECT_TCP, port: uint64(port)}
			if _, _, e := unix.Syscall6(unix.SYS_LANDLOCK_ADD_RULE, rfd, llRuleNetPort, uintptr(unsafe.Pointer(&np)), 0, 0, 0); e != 0 {
				return fmt.Errorf("landlock_add_rule port %d: %w", port, e)
			}
		}
	}
	if _, _, e := unix.Syscall(unix.SYS_LANDLOCK_RESTRICT_SELF, rfd, 0, 0); e != 0 {
		return fmt.Errorf("landlock_restrict_self: %w", e)
	}
	return nil
}

// cleanAbs is filepath.Clean for an absolute path, or an error.
func cleanAbs(p string) (string, error) {
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("%q is not absolute", p)
	}
	return filepath.Clean(p), nil
}
