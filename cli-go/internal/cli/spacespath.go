package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// spacesPath.ts: where the CLI may write or delete for spaces, only inside ~/.termag/spaces and
// never through a symlink.

func spacesDir(home string) string { return filepath.Join(home, ".termag", "spaces") }

func absPath(p string) string {
	a, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	return a
}

// refuseLinks refuses p if it, or any folder between from and it, is a symlink.
func refuseLinks(from, p string) error {
	rel, err := filepath.Rel(from, p)
	if err != nil {
		rel = ""
	}
	parts := []string{""}
	for _, s := range strings.Split(rel, string(filepath.Separator)) {
		if s != "" && s != "." {
			parts = append(parts, s)
		}
	}
	at := from
	for _, part := range parts {
		if part != "" {
			at = filepath.Join(at, part)
		}
		st, err := os.Lstat(at)
		if err != nil {
			return nil
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return newErr("failed", fmt.Sprintf("Refusing to touch %s: %s is a symlink; remove it and run again", p, at))
		}
	}
	return nil
}

// checkInSpaces is dir, resolved, if it is inside ~/.termag/spaces with no symlink on the way.
func checkInSpaces(home, dir string) (string, error) {
	root := absPath(spacesDir(home))
	target := absPath(dir)
	if target != root && !strings.HasPrefix(target, root+string(filepath.Separator)) {
		return "", newErr("failed", fmt.Sprintf("Refusing to touch %s: it is outside %s", target, root))
	}
	if err := refuseLinks(absPath(filepath.Join(home, ".termag")), target); err != nil {
		return "", err
	}
	return target, nil
}

// checkNotLinked: for a file the caller names outside the spaces folder (the chat runner's --session).
func checkNotLinked(file string) (string, error) {
	target := absPath(file)
	for _, p := range []string{filepath.Dir(target), target} {
		st, err := os.Lstat(p)
		if err != nil {
			continue
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return "", newErr("failed", fmt.Sprintf("Refusing to write %s: %s is a symlink", target, p))
		}
	}
	return target, nil
}
