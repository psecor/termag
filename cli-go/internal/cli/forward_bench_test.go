package cli

import (
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// FWD_BENCH=<MiB>: time an echo of that many random bytes through each CLI against the fake
// (both ways, so twice the bytes cross the relay), and check its sha256.
func TestForwardBenchNodeVsGo(t *testing.T) {
	mib := os.Getenv("FWD_BENCH")
	if mib == "" {
		t.Skip("set FWD_BENCH=<MiB>")
	}
	var n int
	fmt.Sscanf(mib, "%d", &n)
	payload := make([]byte, n<<20)
	rand.Read(payload)
	want := sha256.Sum256(payload)
	for _, argv := range [][]string{fwdNodeCLI(t), {fwdGoBinary(t)}} {
		f := fwdNewFake(t)
		var took time.Duration
		var sum [32]byte
		fwdRunCLI(t, argv, f, fwdFreePort(t), false, func(local int) {
			start := time.Now()
			got := fwdEcho(t, local, "127.0.0.1", payload)
			took = time.Since(start)
			sum = sha256.Sum256(got)
		})
		t.Logf("%s: %d MiB echoed in %v (%.0f MiB/s each way), sha256 match %v", filepath.Base(argv[len(argv)-1]), n, took.Round(time.Millisecond), float64(n)/took.Seconds(), sum == want)
	}
}
