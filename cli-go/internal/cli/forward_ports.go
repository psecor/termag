package cli

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// forward/ports.ts and forward/refusals.ts.

// fwdPort is one forward: Port on the box, reached at Local on this machine's loopback.
type fwdPort struct {
	Port  int
	Local int
	Name  string
}

const fwdMinLocalPort = 1024

var fwdDigits = regexp.MustCompile(`^\d{1,5}$`)

func fwdPortNumber(text, what, whole string) (int, error) {
	n := -1
	if fwdDigits.MatchString(text) {
		n, _ = strconv.Atoi(text)
	}
	if n < 1 || n > 65535 {
		return 0, usageError(fmt.Sprintf("`%s`: %s must be a number from 1 to 65535", whole, what))
	}
	return n, nil
}

// fwdParsePortSpec: `<port>[:<local>]`, the box's port first, then the local one.
func fwdParsePortSpec(text string) (fwdPort, error) {
	parts := strings.Split(text, ":")
	if len(parts) > 2 || parts[0] == "" || (len(parts) == 2 && parts[1] == "") {
		return fwdPort{}, usageError(fmt.Sprintf("`%s` is not <port>[:<local>], e.g. 3000 or 3000:3001", text))
	}
	port, err := fwdPortNumber(parts[0], "the box port", text)
	if err != nil {
		return fwdPort{}, err
	}
	local := port
	if len(parts) == 2 {
		if local, err = fwdPortNumber(parts[1], "the local port", text); err != nil {
			return fwdPort{}, err
		}
	}
	if local < fwdMinLocalPort {
		suggestion := ""
		if port+8000 <= 65535 {
			suggestion = fmt.Sprintf("; e.g. %d:%d", port, port+8000)
		}
		return fwdPort{}, usageError(fmt.Sprintf("`%s`: local port %d is below %d; pick a local port of %d or more%s", text, local, fwdMinLocalPort, fwdMinLocalPort, suggestion))
	}
	return fwdPort{Port: port, Local: local}, nil
}

func fwdParsePortSpecs(texts []string) ([]fwdPort, error) {
	var ports []fwdPort
	for _, t := range texts {
		p, err := fwdParsePortSpec(t)
		if err != nil {
			return nil, err
		}
		ports = append(ports, p)
	}
	seen := map[int]bool{}
	for _, p := range ports {
		if seen[p.Local] {
			return nil, usageError(fmt.Sprintf("Local port %d is named twice; each forward needs its own local port", p.Local))
		}
		seen[p.Local] = true
	}
	return ports, nil
}

// The WebSocket close codes of the forward contract, section 4.
const (
	fwdCloseNormal          = 1000
	fwdCloseRevoked         = 1008
	fwdCloseError           = 1011
	fwdCloseDraining        = 1012
	fwdCloseTokenLapsed     = 4401
	fwdCloseTokenNotRenewed = 4402
	fwdCloseRenewalRefused  = 4406
	fwdCloseLifetime        = 4408
	fwdCloseParked          = 4409
)

// fwdRetryCodes: worth one more try on a new connection.
var fwdRetryCodes = map[string]bool{"tunnel_failed": true, "draining": true}

func fwdSSHFallback(boxName string, ports []fwdPort) string {
	flags := make([]string, len(ports))
	for i, p := range ports {
		flags[i] = fmt.Sprintf("-L %d:localhost:%d", p.Local, p.Port)
	}
	return fmt.Sprintf("termag ssh %s -N %s", boxName, strings.Join(flags, " "))
}

func fwdSuggestsSSH(code string) bool { return code == "not_found" || code == "box_outdated" }

// fwdDescribeRefusal: one line saying what a refusal means and what to do. port 0: the probe's.
func fwdDescribeRefusal(code, box, host string, port int, errText string) string {
	portText := "that port"
	if port != 0 {
		portText = fmt.Sprintf("port %d", port)
	}
	switch code {
	case "not_found":
		return fmt.Sprintf("termag-native forwarding isn't available for %s yet: the orchestrator at %s doesn't offer it, or it isn't turned on for you", box, host)
	case "forbidden":
		return "forwarding needs this device signed in with `termag login`; a box's own credentials can't forward"
	case "bad_port":
		return fmt.Sprintf("the orchestrator refused %s: ports run from 1 to 65535", portText)
	case "box_parked":
		return fmt.Sprintf("%s is stopped or hibernated, and a forward never starts it; run `termag box start %s` and try again", box, box)
	case "box_not_ready":
		return fmt.Sprintf("%s isn't ready yet (its agent hasn't connected); try again in a minute", box)
	case "box_outdated":
		return fmt.Sprintf("%s's agent predates port forwarding; it needs an update before it can forward", box)
	case "draining":
		return "the orchestrator is restarting (a deploy); try again in a few seconds"
	case "too_many_tunnels":
		if errText != "" {
			return fmt.Sprintf("the orchestrator refused another connection to %s: %s", box, errText)
		}
		return fmt.Sprintf("%s already has as many forwarded connections open as the orchestrator allows; close some", box)
	case "port_refused":
		if errText != "" {
			return fmt.Sprintf("%s refused to forward %s: %s", box, portText, errText)
		}
		return fmt.Sprintf("%s refused to forward %s", box, portText)
	case "port_closed":
		return fmt.Sprintf("nothing listens on %s on %s", portText, box)
	case "cli_outdated":
		return "this termag is too old for the forward: run `termag update`"
	case "tunnel_failed":
		return fmt.Sprintf("the orchestrator couldn't open a tunnel to %s in time", box)
	}
	if errText != "" {
		return errText
	}
	return fmt.Sprintf("the orchestrator refused the forward (%s)", code)
}

// fwdDescribeClose: what a close code on a live connection means.
func fwdDescribeClose(code int, box string) string {
	switch code {
	case fwdCloseError:
		return fmt.Sprintf("the connection to %s was reset", box)
	case fwdCloseDraining:
		return "the orchestrator restarted (a deploy)"
	case fwdCloseParked:
		return fmt.Sprintf("%s was stopped or hibernated", box)
	case fwdCloseRevoked:
		return "this device's sign-in was revoked; run `termag login`"
	case fwdCloseTokenLapsed:
		return "its access token lapsed"
	case fwdCloseTokenNotRenewed:
		return "its access token expired before a renewed one reached the orchestrator"
	case fwdCloseRenewalRefused:
		return "the orchestrator refused its renewed access token (from a different sign-in?)"
	case fwdCloseLifetime:
		return "it reached the orchestrator's 12 h limit"
	case 1006:
		return "the connection to the orchestrator dropped"
	}
	return fmt.Sprintf("the orchestrator closed it (%d)", code)
}
