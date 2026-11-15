package main

// Yama. A confined app can't ptrace or pidfd_getfd another process only while
// kernel.yama.ptrace_scope is at least 1: at 0, any process of the same user
// may be ptraced, so a confined app could take a descriptor from the agent or
// from an unconfined process of the owner's (seccomp refuses ptrace and
// pidfd_getfd to the app itself, and PR_SET_PTRACER, but not to the processes it
// would reach). Ubuntu sets 1 (procps, /etc/sysctl.d/10-ptrace.conf), and box
// images and box updates make sure of it (deploy/termag-preview-sysctl-setup);
// the launcher refuses to start without it, as it does without the IMDS
// refusal (#1520).

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// ptraceScopePath is where the kernel says it; a variable for the tests.
var ptraceScopePath = "/proc/sys/kernel/yama/ptrace_scope"

// CheckPtraceScope refuses unless Yama's ptrace_scope is 1 or more. A kernel
// without Yama (no such file) can't confirm it, so it is refused too.
func CheckPtraceScope() error {
	b, err := os.ReadFile(ptraceScopePath)
	if err != nil {
		return fmt.Errorf("can't read kernel.yama.ptrace_scope (%v): without Yama, a confined app could take another process's descriptors; refusing to start", err)
	}
	v, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || v < 1 {
		return fmt.Errorf("kernel.yama.ptrace_scope is %q, not 1 or more: a confined app could ptrace the box user's other processes and take their descriptors; refusing to start", strings.TrimSpace(string(b)))
	}
	return nil
}
