package cli

// Exit codes are part of the CLI's contract with scripts and agents (cli/src/errors.ts).
const (
	ExitOK       = 0
	ExitFailed   = 1
	ExitUsage    = 2
	ExitNotFound = 3
	ExitAuth     = 4
	ExitTimeout  = 5
	ExitChanged  = 6 // a conditional write lost
)

var exitFor = map[string]int{
	"failed":          ExitFailed,
	"usage":           ExitUsage,
	"not_found":       ExitNotFound,
	"auth_required":   ExitAuth,
	"timeout":         ExitTimeout,
	"unreachable":     ExitFailed,
	"not_cli_enabled": ExitFailed,
	"edge_auth":       ExitFailed,
	"conflict":        ExitFailed,
	"forbidden":       ExitFailed,
	"precondition":    ExitFailed,
	"changed":         ExitChanged,
}

// CliError is a failure with a one-line, user-facing reason. Never put a token in Message.
type CliError struct {
	Code    string
	Message string
	// Status is the HTTP status when the orchestrator (or its edge) answered; Body its decoded JSON error.
	Status int
	Body   map[string]any
	// RawBody is the error body as sent, for callers that decode more of it.
	RawBody []byte
}

func (e *CliError) Error() string { return e.Message }

// ExitCode is the process exit code the error maps to.
func (e *CliError) ExitCode() int {
	if c, ok := exitFor[e.Code]; ok {
		return c
	}
	return ExitFailed
}

func newErr(code, message string) *CliError { return &CliError{Code: code, Message: message} }

func usageError(message string) *CliError { return newErr("usage", message) }

// BodyString is a string field of the error body, or "".
func (e *CliError) BodyString(key string) string {
	if e.Body == nil {
		return ""
	}
	s, _ := e.Body[key].(string)
	return s
}
