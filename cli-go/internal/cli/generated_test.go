package cli

import (
	"bytes"
	"go/format"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"testing"
)

// TestGeneratedFilesMatchTheNodeCLI is the drift check: it reruns both generators into a temporary
// directory, tools/genspec.mjs (cli/src/args.ts: spec_gen.go, the help and parser fixtures) and
// tools/genconnect.mjs (cli/src/connect/: testdata/connect.json), and fails when any file they
// write differs from the committed one, or when testdata/help has a file the generator no longer
// writes. A change to the Node CLI's commands, options or help that skipped `make generate` fails
// `go test ./...` here, with no CI workflow of its own. `make check-generated` runs this test.
//
// It needs node and cli/node_modules (`npm ci` in cli/); without them it skips, saying so, unless
// TERMAG_REQUIRE_GENSPEC=1, when it fails instead.
func TestGeneratedFilesMatchTheNodeCLI(t *testing.T) {
	repo, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	unavailable := func(why string) {
		if os.Getenv("TERMAG_REQUIRE_GENSPEC") == "1" {
			t.Fatalf("cannot check the generated files: %s", why)
		}
		t.Skipf("generated-file drift NOT checked: %s (set TERMAG_REQUIRE_GENSPEC=1 to fail instead)", why)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		unavailable("no node on PATH")
	}
	if _, err := os.Stat(filepath.Join(repo, "cli", "node_modules", "esbuild")); err != nil {
		unavailable("cli/node_modules has no esbuild; run `npm ci` in cli/")
	}

	out := t.TempDir()
	for _, gen := range []string{"genspec.mjs", "genconnect.mjs"} {
		cmd := exec.Command(node, filepath.Join(repo, "cli-go", "tools", gen), "--out", out)
		cmd.Dir = repo
		if b, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%s failed: %v\n%s", gen, err, b)
		}
	}
	if _, err := os.Stat(filepath.Join(out, "testdata", "connect.json")); err != nil {
		t.Fatalf("genconnect.mjs wrote no testdata/connect.json: %v", err)
	}

	var generated []string
	err = filepath.Walk(out, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			rel, _ := filepath.Rel(out, path)
			generated = append(generated, rel)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(generated) == 0 {
		t.Fatal("the generators wrote nothing")
	}
	for _, rel := range generated {
		want, err := os.ReadFile(filepath.Join(out, rel))
		if err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(rel)
		if err != nil {
			t.Errorf("%s: the generator writes it, and it is not committed (run `make -C cli-go generate`)", rel)
			continue
		}
		if filepath.Ext(rel) == ".go" {
			// genspec gofmts when gofmt is on PATH; compare formatted either way.
			if f, err := format.Source(want); err == nil {
				want = f
			}
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s differs from what the Node CLI generates (run `make -C cli-go generate`)", rel)
		}
	}

	// A help fixture for a command that no longer exists.
	writes := map[string]bool{}
	for _, rel := range generated {
		writes[rel] = true
	}
	committed, _ := filepath.Glob(filepath.Join("testdata", "help", "*"))
	sort.Strings(committed)
	for _, rel := range committed {
		if !writes[rel] {
			t.Errorf("%s: the generator no longer writes it (run `make -C cli-go generate`)", rel)
		}
	}
}
