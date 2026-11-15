package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// StoredLogin is what `termag login` keeps per orchestrator (credentials.ts). termag-desktop reads
// this file too ("Use CLI sign-in") and is stricter than the CLI: it needs email, unixUsername and
// expiresAt. The entry is kept as an ordered object so a rewrite keeps unknown fields and key order.
type StoredLogin struct {
	obj *Object
}

func (l *StoredLogin) str(k string) string {
	v, ok := l.obj.Get(k)
	if !ok {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case json.RawMessage:
		var s string
		if json.Unmarshal(t, &s) == nil {
			return s
		}
	}
	return ""
}

func (l *StoredLogin) Token() string                { return l.str("token") }
func (l *StoredLogin) AccessToken() string          { return l.str("accessToken") }
func (l *StoredLogin) AccessTokenExpiresAt() string { return l.str("accessTokenExpiresAt") }
func (l *StoredLogin) DeviceName() string           { return l.str("deviceName") }

// newStoredLogin builds an entry in the field order login.ts writes.
func newStoredLogin(token, accessToken, accessTokenExpiresAt, deviceName, email, unixUsername, expiresAt, maxExpiresAt string) *StoredLogin {
	o := newObject()
	o.Set("token", token)
	o.Set("accessToken", accessToken)
	o.Set("accessTokenExpiresAt", accessTokenExpiresAt)
	o.Set("deviceName", deviceName)
	o.Set("email", email)
	o.Set("unixUsername", unixUsername)
	o.Set("expiresAt", expiresAt)
	o.Set("maxExpiresAt", maxExpiresAt)
	return &StoredLogin{obj: o}
}

// CredentialsPath is ${XDG_CONFIG_HOME:-$HOME/.config}/termag/credentials.json, on macOS too
// (never os.UserConfigDir, which termag-desktop's import would not find).
func CredentialsPath(env map[string]string, home string) string {
	base := env["XDG_CONFIG_HOME"]
	if base == "" {
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "termag", "credentials.json")
}

type credentialsFile struct {
	hosts *Object
}

func readCredentials(path string) credentialsFile {
	empty := credentialsFile{hosts: newObject()}
	text, err := os.ReadFile(path)
	if err != nil {
		return empty
	}
	var top struct {
		Hosts json.RawMessage `json:"hosts"`
	}
	if json.Unmarshal(text, &top) != nil || len(top.Hosts) == 0 {
		return empty
	}
	hosts := newObject()
	if hosts.UnmarshalJSON(top.Hosts) != nil {
		return empty
	}
	return credentialsFile{hosts: hosts}
}

// LoadLogin is the entry for host, when it looks like a device login.
func LoadLogin(path, host string) *StoredLogin {
	f := readCredentials(path)
	v, ok := f.hosts.Get(host)
	if !ok {
		return nil
	}
	raw, _ := v.(json.RawMessage)
	o := newObject()
	if o.UnmarshalJSON(raw) != nil {
		return nil
	}
	l := &StoredLogin{obj: o}
	tok, tokOK := o.Get("token")
	dev, devOK := o.Get("deviceName")
	var tokS, devS any
	if tokOK {
		_ = json.Unmarshal(tok.(json.RawMessage), &tokS)
	}
	if devOK {
		_ = json.Unmarshal(dev.(json.RawMessage), &devS)
	}
	ts, isStr := tokS.(string)
	if _, devIsStr := devS.(string); !isStr || !strings.HasPrefix(ts, "tmcli_") || !devIsStr {
		return nil
	}
	return l
}

// writeCredentials: owner-only file in an owner-only directory, replaced atomically.
func writeCredentials(path string, f credentialsFile) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	top := newObject()
	top.Set("version", 1)
	top.Set("hosts", f.hosts)
	// A temp name of its own per save (never one per process: goroutines refreshing at once would
	// write the same file), then the atomic replace.
	tmpf, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := tmpf.Name()
	defer os.Remove(tmp) // gone once renamed; cleans up a failed save
	if _, err := tmpf.WriteString(JSONText(top) + "\n"); err != nil {
		tmpf.Close()
		return err
	}
	if err := tmpf.Chmod(0o600); err != nil {
		tmpf.Close()
		return err
	}
	if err := tmpf.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// credsMu serialises this process's read-modify-write of credentials.json, so two saves from
// goroutines don't drop each other's change.
var credsMu sync.Mutex

// SaveLogin stores the entry for host, keeping every other host's as it was.
func SaveLogin(path, host string, l *StoredLogin) error {
	credsMu.Lock()
	defer credsMu.Unlock()
	f := readCredentials(path)
	f.hosts.Set(host, l.obj)
	return writeCredentials(path, f)
}

// RemoveLogin removes host's entry; false when there was none.
func RemoveLogin(path, host string) (bool, error) {
	credsMu.Lock()
	defer credsMu.Unlock()
	f := readCredentials(path)
	if _, ok := f.hosts.Get(host); !ok {
		return false, nil
	}
	f.hosts.Delete(host)
	return true, writeCredentials(path, f)
}
