package cli

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The connect commands, Node vs Go, against one fake orchestrator and fake `ssh`, `aws`,
// `session-manager-plugin` and `infocmp` on PATH that log their argv. Each case runs in a fresh
// scratch HOME per CLI; stdout, stderr, the exit code, every logged argv and the files the case
// names must be byte-identical (with the scratch root written as $ROOT). Skipped without node and
// a built Node CLI (memoryNodeCLI: cli/dist, or TERMAG_PARITY_NODE_CLI).

const sshcFakeAws = `#!/bin/sh
PATH=/usr/bin:/bin
{ printf 'aws'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\n'; } >> "$SSHC_LOG"
case "$1 $2" in
  "configure list-profiles") for p in $SSHC_AWS_PROFILES; do echo "$p"; done; exit ${SSHC_LIST_EXIT:-0};;
  "--version ") echo "aws-cli/${SSHC_AWS_VERSION:-2.15.30} Python/3.11.8 Linux/6.8"; exit 0;;
  "sts get-caller-identity") if [ -n "$SSHC_STS_FAIL" ]; then echo "$SSHC_STS_FAIL" >&2; exit 255; fi; echo '{"Account":"1"}'; exit 0;;
  "ssm start-session") printf 'SSH-2.0-fake-box\r\n'; echo "ssm: session for $4" >&2; exit ${SSHC_SSM_EXIT:-0};;
  "sso login") exit ${SSHC_LOGIN_EXIT:-0};;
esac
exit 0
`

const sshcFakeSsh = `#!/bin/sh
PATH=/usr/bin:/bin
{ printf 'ssh'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\n'; } >> "$SSHC_LOG"
if [ "$1" = -G ]; then printf 'user x\nrequesttty auto\nremotecommand none\n'; exit 0; fi
echo "ssh: TERM=$TERM" >&2
if [ -n "$SSHC_SSH_SIGNAL" ]; then kill -$SSHC_SSH_SIGNAL $$; fi
exit ${SSHC_SSH_EXIT:-0}
`

type sshcCase struct {
	name  string
	argv  []string
	env   []string
	setup func(root string)
	files []string // relative to root
	// exitOnly: compare only the exit code and the argv log (the spawn error's wording differs).
	exitOnly bool
}

func sshcFakeOrchestrator(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch strings.TrimPrefix(r.URL.Path, "/termag/api/cli/v1") {
		case "/boxes":
			fmt.Fprint(w, `{"boxes":[
			 {"id":"b1","name":"dev","addressable":true,"kind":"ec2","state":"running","agentConnected":true,"error":null,"ec2InstanceId":"i-0dev","region":null,"hostUnixUser":"termag","projects":[]},
			 {"id":"b2","name":"sleepy","addressable":true,"kind":"ec2","state":"stopped","agentConnected":false,"error":null,"ec2InstanceId":"i-0sleepy","region":"eu-west-1","hostUnixUser":null,"projects":[]},
			 {"id":"b3","name":"mine","addressable":true,"kind":"ec2","state":"running","agentConnected":true,"error":null,"ec2InstanceId":"i-0123456789abcdef0","region":"us-west-2","hostUnixUser":null,"projects":[]},
			 {"id":"b4","name":"odd box","addressable":false,"kind":"ec2","state":"running","agentConnected":true,"error":null,"ec2InstanceId":"i-0odd","projects":[]}]}`)
		case "/projects":
			fmt.Fprint(w, `{"projects":[
			 {"id":"p1","name":"web","ref":"dev/web","box":{"id":"b1","name":"dev"},"directory":"termag/projects/web","sessions":{"agent":"ab-web-agent","ctrl":"ab-web-ctrl"}},
			 {"id":"p2","name":"api","ref":"mine/api","box":{"id":"b3","name":"mine"},"sessions":{"agent":"ab-api-agent","ctrl":"ab-api-ctrl"}},
			 {"id":"p3","name":"we.ird","ref":"mine/we.ird","box":{"id":"b3","name":"mine"},"sessions":{"agent":"x","ctrl":"y"}}]}`)
		case "/whoami":
			fmt.Fprint(w, `{"user":{"email":"a@b.c","unixUsername":"ab","displayName":"A"},"credential":{"kind":"box","boxId":"b1"}}`)
		default:
			w.WriteHeader(404)
			fmt.Fprint(w, `{"error":"no route"}`)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func sshcWrite(t *testing.T, path, text string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), mode); err != nil {
		t.Fatal(err)
	}
}

type sshcRun struct {
	stdout, stderr string
	code           int
	log            string
	files          map[string]string
}

func sshcRunOne(t *testing.T, cli []string, orch string, tc sshcCase) sshcRun {
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	sshcWrite(t, filepath.Join(bin, "aws"), sshcFakeAws, 0o755)
	sshcWrite(t, filepath.Join(bin, "ssh"), sshcFakeSsh, 0o755)
	sshcWrite(t, filepath.Join(bin, "session-manager-plugin"), "#!/bin/sh\nexit 0\n", 0o755)
	// A launcher on PATH, as install.sh leaves: both CLIs then name it in the ProxyCommand.
	sshcWrite(t, filepath.Join(bin, "termag"), "#!/bin/sh\n# termag-cli-launcher\nexit 0\n", 0o755)
	sshcWrite(t, filepath.Join(root, "agent.json"), fmt.Sprintf(`{"termag_url":"ws://%s/termag/ws/agent","token":"tmag_fakefakefakefakefake"}`, strings.TrimPrefix(orch, "http://")), 0o600)
	os.MkdirAll(filepath.Join(root, "home"), 0o755)
	if tc.setup != nil {
		tc.setup(root)
	}
	env := []string{
		"PATH=" + bin, "HOME=" + filepath.Join(root, "home"), "TERMAG_TELEMETRY=0", "TERMAG_TOOL_FALLBACK_DIRS=",
		"TERMAG_AGENT_CONFIG=" + filepath.Join(root, "agent.json"), "SSHC_LOG=" + filepath.Join(root, "log"), "TERM=xterm-256color",
	}
	for _, e := range tc.env {
		env = append(env, strings.ReplaceAll(e, "$ROOT", root))
	}
	cmd := exec.Command(cli[0], append(cli[1:], tc.argv...)...)
	cmd.Env = env
	cmd.Dir = root
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	// The root as written and as resolved: on macOS the temp folder is under /var, a link to
	// /private/var, and following ~/.ssh/config's links reports the resolved path.
	realRoot, _ := filepath.EvalSymlinks(root)
	norm := func(s string) string {
		if realRoot != "" && realRoot != root {
			s = strings.ReplaceAll(s, realRoot, "$ROOT")
		}
		return strings.ReplaceAll(s, root, "$ROOT")
	}
	log, _ := os.ReadFile(filepath.Join(root, "log"))
	r := sshcRun{stdout: norm(out.String()), stderr: norm(errb.String()), code: code, log: norm(string(log)), files: map[string]string{}}
	for _, f := range tc.files {
		b, err := os.ReadFile(filepath.Join(root, f))
		if err != nil {
			r.files[f] = "<missing>"
			continue
		}
		st, _ := os.Stat(filepath.Join(root, f))
		r.files[f] = fmt.Sprintf("%v\n%s", st.Mode().Perm(), norm(string(b)))
	}
	return r
}

const sshcNodeBlock = `# >>> termag ssh-config >>>
# Managed by ` + "`termag ssh-config --install`" + `, which replaces everything between these markers.
Host termag-*
  User ab
  ProxyCommand /usr/bin/node /home/ab/src/termag/cli/bin/termag.js ssh-proxy %h %p
  StrictHostKeyChecking accept-new
  ServerAliveInterval 30
Host *
# <<< termag ssh-config <<<
`

func sshcCases() []sshcCase {
	sshCfg := "home/.ssh/config"
	awsCfg := "home/.aws/config"
	return []sshcCase{
		{name: "ssh-config print", argv: []string{"ssh-config"}},
		{name: "ssh-config --json", argv: []string{"ssh-config", "--json"}},
		{name: "ssh-config --wake --host", argv: []string{"ssh-config", "--wake", "--host", "$ORCH"}},
		{name: "install into nothing", argv: []string{"ssh-config", "--install"}, files: []string{sshCfg, sshCfg + ".termag-backup"}},
		{name: "install --json over a file", argv: []string{"ssh-config", "--install", "--json"}, files: []string{sshCfg, sshCfg + ".termag-backup"},
			setup: func(root string) {
				os.MkdirAll(filepath.Join(root, "home/.ssh"), 0o700)
				os.WriteFile(filepath.Join(root, sshCfg), []byte("Host *\n  ForwardAgent no\n"), 0o640)
			}},
		{name: "install rewrites a node ProxyCommand", argv: []string{"ssh-config", "--install"}, files: []string{sshCfg, sshCfg + ".termag-backup"},
			setup: func(root string) {
				os.MkdirAll(filepath.Join(root, "home/.ssh"), 0o700)
				os.WriteFile(filepath.Join(root, sshCfg), []byte(sshcNodeBlock+"\nHost github.com\n  User git\n"), 0o600)
			}},
		{name: "install twice is unchanged", argv: []string{"ssh-config", "--install"}, files: []string{sshCfg},
			setup: func(root string) {
				// What --install writes, so the second run finds it current (the ProxyCommand names $ROOT/bin/termag).
				os.MkdirAll(filepath.Join(root, "home/.ssh"), 0o700)
				os.WriteFile(filepath.Join(root, sshCfg), []byte("placeholder\n"), 0o600)
			}},
		{name: "unmatched markers", argv: []string{"ssh-config", "--install"}, files: []string{sshCfg},
			setup: func(root string) {
				os.MkdirAll(filepath.Join(root, "home/.ssh"), 0o700)
				os.WriteFile(filepath.Join(root, sshCfg), []byte("# >>> termag ssh-config >>>\nHost x\n"), 0o600)
			}},
		{name: "symlinked config", argv: []string{"ssh-config", "--install"}, files: []string{"dotfiles/ssh_config", "dotfiles/ssh_config.termag-backup", sshCfg},
			setup: func(root string) {
				sshcWriteRaw(filepath.Join(root, "dotfiles/ssh_config"), "Host old\n")
				os.MkdirAll(filepath.Join(root, "home/.ssh"), 0o700)
				os.Symlink("../../dotfiles/ssh_config", filepath.Join(root, sshCfg))
			}},
		{name: "ssh writes the AWS profile when missing", argv: []string{"ssh", "dev"}, files: []string{awsCfg}},
		{name: "ssh leaves an own profile alone", argv: []string{"ssh", "dev"}, files: []string{awsCfg}, env: []string{"SSHC_AWS_PROFILES=default termag-boxes"},
			setup: func(root string) {
				sshcWriteRaw(filepath.Join(root, awsCfg), "[profile termag-boxes]\nsso_session = mine\nsso_account_id = 1\n")
			}},
		{name: "ssh adds beside another profile", argv: []string{"ssh", "dev"}, files: []string{awsCfg, awsCfg + ".termag-backup"}, env: []string{"SSHC_AWS_PROFILES=other"},
			setup: func(root string) {
				sshcWriteRaw(filepath.Join(root, awsCfg), "[profile other]\nregion = us-east-1\n\n")
			}},
		{name: "ssh with AWS_CONFIG_FILE", argv: []string{"ssh", "dev"}, files: []string{"custom-aws", awsCfg}, env: []string{"AWS_CONFIG_FILE=$ROOT/custom-aws"}},
		{name: "a managed profile is listed: no rewrite", argv: []string{"ssh", "dev"}, files: []string{awsCfg}, env: []string{"SSHC_AWS_PROFILES=termag-boxes"},
			setup: func(root string) {
				sshcWriteRaw(filepath.Join(root, awsCfg), renderAwsBlock("termag-boxes")+"\n")
			}},
		{name: "a shadowed profile", argv: []string{"ssh", "dev"}, files: []string{awsCfg}, env: []string{"SSHC_AWS_PROFILES=termag-boxes"},
			setup: func(root string) {
				sshcWriteRaw(filepath.Join(root, awsCfg), renderAwsBlock("termag-boxes")+"\n[profile termag-boxes]\nregion = x\n")
			}},
		{name: "TERMAG_AWS_PROFILE missing", argv: []string{"ssh", "dev"}, env: []string{"TERMAG_AWS_PROFILE=mine"}},
		{name: "old aws cli", argv: []string{"ssh", "dev"}, env: []string{"SSHC_AWS_VERSION=2.8.0"}},
		{name: "expired sso, no terminal", argv: []string{"ssh", "dev"}, env: []string{"SSHC_STS_FAIL=Error when retrieving token from sso: Token has expired and refresh failed"}},
		{name: "a broken profile", argv: []string{"ssh", "dev"}, env: []string{"SSHC_STS_FAIL=The config profile (termag-boxes) could not be found"}},
		{name: "project and a command line", argv: []string{"ssh", "dev/web", "--", "make test | tail"}},
		{name: "project, no command", argv: []string{"ssh", "dev/web"}},
		{name: "words after --", argv: []string{"ssh", "mine", "--", "claude", "-p", "fix the \"test\""}},
		{name: "-N -L", argv: []string{"ssh", "dev", "-N", "-L", "3000:localhost:3000"}},
		{name: "-t and -o", argv: []string{"ssh", "dev", "-t", "-o", "LogLevel=ERROR", "--", "htop"}},
		{name: "a stray word", argv: []string{"ssh", "dev", "uptime"}},
		{name: "a stopped box", argv: []string{"ssh", "sleepy"}},
		{name: "no such project", argv: []string{"ssh", "dev/nope"}},
		{name: "ssh exits 1", argv: []string{"ssh", "dev"}, env: []string{"SSHC_SSH_EXIT=1"}},
		{name: "ssh exits 255", argv: []string{"ssh", "dev"}, env: []string{"SSHC_SSH_EXIT=255"}},
		{name: "ssh dies of SIGTERM", argv: []string{"ssh", "dev"}, env: []string{"SSHC_SSH_SIGNAL=TERM"}},
		{name: "ssh dies of SIGINT", argv: []string{"ssh", "dev"}, env: []string{"SSHC_SSH_SIGNAL=INT"}},
		{name: "ssh dies of SIGKILL", argv: []string{"ssh", "dev"}, env: []string{"SSHC_SSH_SIGNAL=KILL"}},
		{name: "ssh cannot start", argv: []string{"ssh", "dev"}, exitOnly: true,
			setup: func(root string) {
				sshcWriteRaw(filepath.Join(root, "bin/ssh"), "\x7fELF not really")
				os.Chmod(filepath.Join(root, "bin/ssh"), 0o755)
			}},
		{name: "no ssh at all", argv: []string{"ssh", "dev"}, setup: func(root string) { os.Remove(filepath.Join(root, "bin/ssh")) }},
		{name: "no session-manager-plugin", argv: []string{"ssh", "dev"}, setup: func(root string) { os.Remove(filepath.Join(root, "bin/session-manager-plugin")) }},
		{name: "no aws", argv: []string{"ssh", "dev"}, setup: func(root string) { os.Remove(filepath.Join(root, "bin/aws")) }},
		{name: "attach needs a terminal", argv: []string{"attach", "dev/web"}},
		{name: "attach needs a project", argv: []string{"attach", "dev"}},
		{name: "ssh-proxy", argv: []string{"ssh-proxy", "termag-dev", "22"}, files: []string{awsCfg}},
		{name: "ssh-proxy passes aws's exit", argv: []string{"ssh-proxy", "termag-mine", "22"}, env: []string{"SSHC_SSM_EXIT=3"}},
		{name: "ssh-proxy, expired sso", argv: []string{"ssh-proxy", "termag-dev", "22"}, env: []string{"SSHC_STS_FAIL=Token has expired"}},
		{name: "ssh-proxy, a stopped box", argv: []string{"ssh-proxy", "termag-sleepy", "22"}},
		{name: "ssh-proxy, port 23", argv: []string{"ssh-proxy", "termag-dev", "23"}},
		{name: "ssh-proxy, not an alias", argv: []string{"ssh-proxy", "dev", "22"}},
		// #1704: ssh-config's HostName is the instance id, which %h passes; an older block's lowercased alias still works.
		{name: "ssh-proxy by instance id", argv: []string{"ssh-proxy", "i-0123456789abcdef0", "22"}},
		{name: "ssh-proxy by an uppercased instance id", argv: []string{"ssh-proxy", "I-0123456789ABCDEF0", "22"}},
		{name: "ssh-proxy, an unknown instance id", argv: []string{"ssh-proxy", "i-00000000deadbeef", "22"}},
		{name: "ssh-proxy, a case-lost alias", argv: []string{"ssh-proxy", "termag-MINE", "22"}},
		{name: "ssh by a name in another case", argv: []string{"ssh", "MINE"}},
		{name: "ssh-proxy, --timeout without --wake", argv: []string{"ssh-proxy", "--timeout", "5", "termag-dev", "22"}},
		{name: "ssh-proxy --wake on a running box", argv: []string{"ssh-proxy", "--wake", "--timeout", "0x10", "termag-dev", "22"}},
		{name: "ssh-proxy --wake, bad timeout", argv: []string{"ssh-proxy", "--wake", "--timeout", "soon", "termag-dev", "22"}},
	}
}

func sshcWriteRaw(path, text string) {
	os.MkdirAll(filepath.Dir(path), 0o755)
	os.WriteFile(path, []byte(text), 0o644)
}

func TestSshcConnectCommandsMatchNode(t *testing.T) {
	node, script := memoryNodeCLI(t)
	goBin := goBinary(t)
	orch := sshcFakeOrchestrator(t)
	for _, tc := range sshcCases() {
		tc := tc
		for i, a := range tc.argv {
			tc.argv[i] = strings.ReplaceAll(a, "$ORCH", orch.URL+"/termag")
		}
		if tc.name == "install twice is unchanged" {
			// The first install's output becomes this case's starting file.
			first := tc
			first.setup = nil
			tc.setup = func(root string) {
				r := sshcRunOne(t, []string{goBin}, orch.URL, sshcCase{argv: []string{"ssh-config"}})
				block := strings.ReplaceAll(r.stdout, "$ROOT", root)
				os.MkdirAll(filepath.Join(root, "home/.ssh"), 0o700)
				os.WriteFile(filepath.Join(root, "home/.ssh/config"), []byte(block), 0o600)
				_ = first
			}
		}
		t.Run(tc.name, func(t *testing.T) {
			n := sshcRunOne(t, []string{node, script}, orch.URL, tc)
			g := sshcRunOne(t, []string{goBin}, orch.URL, tc)
			if os.Getenv("SSHC_DEBUG") != "" {
				t.Logf("exit %d\nstdout:\n%s\nstderr:\n%s\nlog:\n%s\nfiles: %v", g.code, g.stdout, g.stderr, g.log, g.files)
			}
			if n.code != g.code {
				t.Errorf("exit: node %d, go %d", n.code, g.code)
			}
			if n.log != g.log {
				t.Errorf("argv log differs:\nnode:\n%s\ngo:\n%s", n.log, g.log)
			}
			if tc.exitOnly {
				return
			}
			if n.stdout != g.stdout {
				t.Errorf("stdout differs:\nnode:\n%s\ngo:\n%s", n.stdout, g.stdout)
			}
			if n.stderr != g.stderr {
				t.Errorf("stderr differs:\nnode:\n%s\ngo:\n%s", n.stderr, g.stderr)
			}
			for _, f := range tc.files {
				if n.files[f] != g.files[f] {
					t.Errorf("%s differs:\nnode:\n%s\ngo:\n%s", f, n.files[f], g.files[f])
				}
			}
		})
	}
}

// Without a `termag` on PATH, Node names `node <script>` in the ProxyCommand and Go its own binary:
// a Go install rewrites a block Node's fallback wrote.
func TestSshcInstallRewritesANodeBlockToTheGoBinary(t *testing.T) {
	goBin := goBinary(t)
	orch := sshcFakeOrchestrator(t)
	tc := sshcCase{argv: []string{"ssh-config", "--install"}, files: []string{"home/.ssh/config"},
		setup: func(root string) {
			os.Remove(filepath.Join(root, "bin/termag"))
			sshcWriteRaw(filepath.Join(root, "home/.ssh/config"), sshcNodeBlock+"\nHost github.com\n  User git\n")
		}}
	r := sshcRunOne(t, []string{goBin}, orch.URL, tc)
	if r.code != 0 {
		t.Fatalf("exit %d: %s", r.code, r.stderr)
	}
	real, _ := filepath.EvalSymlinks(goBin)
	cfg := r.files["home/.ssh/config"]
	if !strings.Contains(cfg, "  ProxyCommand "+real+" --host ") || strings.Contains(cfg, "node") || !strings.HasSuffix(cfg, "# <<< termag ssh-config <<<\n\nHost github.com\n  User git\n") {
		t.Errorf("config:\n%s", cfg)
	}
	if !strings.HasPrefix(r.stdout, "Updated the termag entry in $ROOT/home/.ssh/config. The previous file is $ROOT/home/.ssh/config.termag-backup.\n") {
		t.Errorf("stdout %q", r.stdout)
	}
}
