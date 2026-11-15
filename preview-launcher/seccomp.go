package main

// Layer 2: a seccomp deny list over an allow default. Landlock on 6.8 doesn't
// govern connect() to Unix sockets (its abstract-socket scoping is ABI 6), so
// this refuses every way to get a new Unix socket or another process's
// resources. Nor do its network rules govern anything but TCP, so this limits
// the sockets an app can make to the ones those rules cover, plus UDP for DNS
// (socketRule).

import (
	"fmt"
	"runtime"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	bpfLD   = 0x00
	bpfW    = 0x00
	bpfABS  = 0x20
	bpfJMP  = 0x05
	bpfJEQ  = 0x10
	bpfJGE  = 0x30
	bpfJSET = 0x40
	bpfK    = 0x00
	bpfRET  = 0x06
	bpfALU  = 0x04
	bpfAND  = 0x50

	seccompRetAllow       = 0x7fff0000
	seccompRetKillProcess = 0x80000000

	offNr   = 0
	offArch = 4
	offArg0 = 16 // low 32 bits on a little-endian machine
	offArg1 = 24
	offArg2 = 32
	offArg3 = 40
)

func stmt(code uint16, k uint32) unix.SockFilter { return unix.SockFilter{Code: code, K: k} }
func jump(code uint16, k uint32, jt, jf uint8) unix.SockFilter {
	return unix.SockFilter{Code: code, Jt: jt, Jf: jf, K: k}
}
func retErrno(e unix.Errno) unix.SockFilter {
	return stmt(bpfRET|bpfK, unix.SECCOMP_RET_ERRNO|uint32(e))
}

// Denied system calls and the errno each gets.
type denial struct {
	nr    uintptr
	errno unix.Errno
	name  string
}

func denials() []denial {
	d := []denial{
		// io_uring's IORING_OP_SOCKET and IORING_OP_CONNECT make and connect
		// sockets without socket() or connect(). ENOSYS makes libuv fall back
		// to its thread pool.
		{unix.SYS_IO_URING_SETUP, unix.ENOSYS, "io_uring_setup"},
		{unix.SYS_IO_URING_ENTER, unix.ENOSYS, "io_uring_enter"},
		{unix.SYS_IO_URING_REGISTER, unix.ENOSYS, "io_uring_register"},
		// clone3's CLONE_INTO_CGROUP places the child in any cgroup the user
		// may write, which is a permission check Landlock doesn't see (it
		// never opens cgroup.procs). That would take a child out of the
		// preview cgroup the IMDS rule matches. Its arguments are behind a
		// pointer seccomp can't read, so clone3 is ENOSYS and glibc falls back
		// to clone, as under Docker.
		{unix.SYS_CLONE3, unix.ENOSYS, "clone3"},
		{unix.SYS_PTRACE, unix.EPERM, "ptrace"},
		{unix.SYS_PROCESS_VM_READV, unix.EPERM, "process_vm_readv"},
		{unix.SYS_PROCESS_VM_WRITEV, unix.EPERM, "process_vm_writev"},
		{unix.SYS_PIDFD_GETFD, unix.EPERM, "pidfd_getfd"},
		{unix.SYS_KEYCTL, unix.EPERM, "keyctl"},
		{unix.SYS_ADD_KEY, unix.EPERM, "add_key"},
		{unix.SYS_REQUEST_KEY, unix.EPERM, "request_key"},
		{unix.SYS_BPF, unix.EPERM, "bpf"},
		{unix.SYS_PERF_EVENT_OPEN, unix.EPERM, "perf_event_open"},
		{unix.SYS_USERFAULTFD, unix.EPERM, "userfaultfd"},
		{unix.SYS_MOUNT, unix.EPERM, "mount"},
		{unix.SYS_UMOUNT2, unix.EPERM, "umount2"},
		{unix.SYS_UNSHARE, unix.EPERM, "unshare"},
		{unix.SYS_SETNS, unix.EPERM, "setns"},
		{unix.SYS_OPEN_TREE, unix.EPERM, "open_tree"},
		{unix.SYS_MOVE_MOUNT, unix.EPERM, "move_mount"},
		{unix.SYS_FSOPEN, unix.EPERM, "fsopen"},
		{unix.SYS_FSMOUNT, unix.EPERM, "fsmount"},
		{unix.SYS_FSPICK, unix.EPERM, "fspick"},
		{unix.SYS_PIVOT_ROOT, unix.EPERM, "pivot_root"},
	}
	return d
}

// cloneNamespaces are clone() flags that make namespaces; unshare is refused,
// and so is clone with any of these.
const cloneNamespaces = unix.CLONE_NEWNS | unix.CLONE_NEWUTS | unix.CLONE_NEWIPC |
	unix.CLONE_NEWUSER | unix.CLONE_NEWPID | unix.CLONE_NEWNET | unix.CLONE_NEWCGROUP

func nativeArch() (uint32, error) {
	switch runtime.GOARCH {
	case "arm64":
		return unix.AUDIT_ARCH_AARCH64, nil
	case "amd64":
		return unix.AUDIT_ARCH_X86_64, nil
	}
	return 0, fmt.Errorf("no seccomp filter for %s", runtime.GOARCH)
}

// SeccompProgram builds the filter.
func SeccompProgram() ([]unix.SockFilter, error) {
	arch, err := nativeArch()
	if err != nil {
		return nil, err
	}
	p := []unix.SockFilter{
		// Another architecture's system call table (i386 on x86_64, arm32 on
		// arm64) would dodge every number below.
		stmt(bpfLD|bpfW|bpfABS, offArch),
		jump(bpfJMP|bpfJEQ|bpfK, arch, 1, 0),
		stmt(bpfRET|bpfK, seccompRetKillProcess),
		stmt(bpfLD|bpfW|bpfABS, offNr),
	}
	if runtime.GOARCH == "amd64" {
		// x32 numbers have bit 30 set.
		p = append(p, jump(bpfJMP|bpfJGE|bpfK, 0x40000000, 0, 1), retErrno(unix.ENOSYS))
	}
	for _, d := range denials() {
		p = append(p, jump(bpfJMP|bpfJEQ|bpfK, uint32(d.nr), 0, 1), retErrno(d.errno))
	}
	p = append(p, socketRule()...)
	p = append(p, sendRule()...)
	// clone(flags, ...) with a namespace flag: EPERM. arg0 is flags on arm64
	// and x86_64 alike.
	p = append(p,
		stmt(bpfLD|bpfW|bpfABS, offNr),
		jump(bpfJMP|bpfJEQ|bpfK, unix.SYS_CLONE, 0, 3),
		stmt(bpfLD|bpfW|bpfABS, offArg0),
		jump(bpfJMP|bpfJSET|bpfK, uint32(cloneNamespaces), 0, 1),
		retErrno(unix.EPERM),
		stmt(bpfRET|bpfK, seccompRetAllow),
	)
	return p, nil
}

// socketFlags are the flags socket() takes in its type argument, masked off before the type is compared.
const socketFlags = unix.SOCK_NONBLOCK | unix.SOCK_CLOEXEC

// socketRule is socket(family, type, protocol), with the syscall number loaded:
//
//   - AF_UNIX: EACCES, for pathname and abstract sockets alike. socketpair stays
//     allowed: an unnamed connected pair reaches nothing (and it makes no other
//     family's sockets: AF_INET's is EOPNOTSUPP).
//   - AF_INET and AF_INET6: a stream socket only with protocol 0 or IPPROTO_TCP,
//     a datagram socket only with 0 or IPPROTO_UDP (DNS), every other type
//     (SOCK_SEQPACKET, SOCK_RAW, SOCK_RDM, SOCK_DCCP) refused, EACCES. Landlock's
//     network rules on 6.8 cover TCP sockets alone: an IPPROTO_MPTCP stream
//     socket falls back to TCP with an ordinary server and reached instance
//     metadata and every port the rules refuse (Cursor Security Agent, #1519);
//     SCTP (stream or seqpacket) would too. Protocol 0 is TCP for a stream and
//     UDP for a datagram (the first, permanent, entry of each type), and
//     SOCK_NONBLOCK and SOCK_CLOEXEC are masked off first.
//   - AF_NETLINK: allowed (glibc and Node read interfaces and routes over it);
//     it reaches the kernel only.
//   - Every other family (AF_VSOCK, AF_PACKET, AF_ALG, AF_XDP, AF_TIPC, AF_RDS,
//     Bluetooth, CAN...): EAFNOSUPPORT, as if the kernel had none.
//
// io_uring, which makes and connects sockets without socket() or connect(), is
// ENOSYS above. TCP Fast Open, which connects from a send, is sendRule's.
func socketRule() []unix.SockFilter {
	return []unix.SockFilter{
		/* 0 */ jump(bpfJMP|bpfJEQ|bpfK, unix.SYS_SOCKET, 0, 22),
		/* 1 */ stmt(bpfLD|bpfW|bpfABS, offArg0),
		/* 2 */ jump(bpfJMP|bpfJEQ|bpfK, unix.AF_UNIX, 0, 1),
		/* 3 */ retErrno(unix.EACCES),
		/* 4 */ jump(bpfJMP|bpfJEQ|bpfK, unix.AF_NETLINK, 0, 1),
		/* 5 */ stmt(bpfRET|bpfK, seccompRetAllow),
		/* 6 */ jump(bpfJMP|bpfJEQ|bpfK, unix.AF_INET, 2, 0),
		/* 7 */ jump(bpfJMP|bpfJEQ|bpfK, unix.AF_INET6, 1, 0),
		/* 8 */ retErrno(unix.EAFNOSUPPORT),
		/* 9 */ stmt(bpfLD|bpfW|bpfABS, offArg1),
		/* 10 */ stmt(bpfALU|bpfAND|bpfK, ^uint32(socketFlags)),
		/* 11 */ jump(bpfJMP|bpfJEQ|bpfK, unix.SOCK_STREAM, 0, 5), // to 17
		/* 12 */ stmt(bpfLD|bpfW|bpfABS, offArg2),
		/* 13 */ jump(bpfJMP|bpfJEQ|bpfK, 0, 2, 0), // to 16
		/* 14 */ jump(bpfJMP|bpfJEQ|bpfK, unix.IPPROTO_TCP, 1, 0),
		/* 15 */ retErrno(unix.EACCES),
		/* 16 */ stmt(bpfRET|bpfK, seccompRetAllow),
		/* 17 */ jump(bpfJMP|bpfJEQ|bpfK, unix.SOCK_DGRAM, 0, 3), // to 21
		/* 18 */ stmt(bpfLD|bpfW|bpfABS, offArg2),
		/* 19 */ jump(bpfJMP|bpfJEQ|bpfK, 0, 2, 0), // to 22
		/* 20 */ jump(bpfJMP|bpfJEQ|bpfK, unix.IPPROTO_UDP, 1, 0),
		/* 21 */ retErrno(unix.EACCES),
		/* 22 */ stmt(bpfRET|bpfK, seccompRetAllow),
	}
}

// sendRule is TCP Fast Open and prctl(PR_SET_PTRACER), with the syscall number in
// the accumulator or not (it loads its own):
//
//   - sendto (flags in arg 3), sendmmsg (arg 3) and sendmsg (arg 2) with
//     MSG_FASTOPEN set: EOPNOTSUPP. A Fast Open send connects the socket itself,
//     without connect(), and Landlock's CONNECT_TCP rule didn't see that connect
//     on 6.8.0-1067-aws, a kernel boxes boot: a confined app reached the owner's
//     Node inspector on 127.0.0.1:9229 and instance metadata on
//     169.254.169.254:80 (#1521). 6.8.0-1069-aws refuses it with EACCES;
//     this doesn't depend on which. EOPNOTSUPP is what the kernel answers with
//     client Fast Open off (net.ipv4.tcp_fastopen without bit 1), so a library
//     falls back to connect(), which Landlock does see. The flags are their own
//     register in all three, so BPF reads them; sendmmsg's per-message flags
//     aren't used on send.
//   - prctl(PR_SET_PTRACER, ...): EPERM. It lets one named process ptrace this
//     one, and with pidfd_getfd (refused above) take its descriptors: a process
//     of the same user could hold a copy of a confined listener's socket and
//     still pass the agent's vouch (#1520). Every other prctl is allowed.
func sendRule() []unix.SockFilter {
	fastOpen := func(nr uint32, flagsAt uint32) []unix.SockFilter {
		return []unix.SockFilter{
			jump(bpfJMP|bpfJEQ|bpfK, nr, 0, 4),
			stmt(bpfLD|bpfW|bpfABS, flagsAt),
			jump(bpfJMP|bpfJSET|bpfK, unix.MSG_FASTOPEN, 0, 1),
			retErrno(unix.EOPNOTSUPP),
			stmt(bpfRET|bpfK, seccompRetAllow),
		}
	}
	p := []unix.SockFilter{stmt(bpfLD|bpfW|bpfABS, offNr)}
	p = append(p, fastOpen(unix.SYS_SENDTO, offArg3)...)
	p = append(p, fastOpen(unix.SYS_SENDMMSG, offArg3)...)
	p = append(p, fastOpen(unix.SYS_SENDMSG, offArg2)...)
	p = append(p,
		jump(bpfJMP|bpfJEQ|bpfK, unix.SYS_PRCTL, 0, 4),
		stmt(bpfLD|bpfW|bpfABS, offArg0),
		jump(bpfJMP|bpfJEQ|bpfK, unix.PR_SET_PTRACER, 0, 1),
		retErrno(unix.EPERM),
		stmt(bpfRET|bpfK, seccompRetAllow),
	)
	return p
}

// ApplySeccomp installs the filter on every thread of the process.
func ApplySeccomp() error {
	p, err := SeccompProgram()
	if err != nil {
		return err
	}
	prog := unix.SockFprog{Len: uint16(len(p)), Filter: &p[0]}
	if _, _, e := unix.Syscall(unix.SYS_SECCOMP, unix.SECCOMP_SET_MODE_FILTER, unix.SECCOMP_FILTER_FLAG_TSYNC, uintptr(unsafe.Pointer(&prog))); e != 0 {
		return fmt.Errorf("seccomp: %w", e)
	}
	return nil
}
