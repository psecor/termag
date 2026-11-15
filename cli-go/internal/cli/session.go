package cli

import (
	"context"
	"fmt"
	"time"
)

// Session is the orchestrator a run talks to and where its login lives (commands.ts).
type Session struct {
	Target    Target
	CredsPath string
}

func newSession(c *Ctx, a *ParsedArgs) (*Session, error) {
	t, err := resolveTarget(a.Host, c.Env, c.Home, c.ReadFile)
	if err != nil {
		return nil, err
	}
	return &Session{Target: t, CredsPath: CredentialsPath(c.Env, c.Home)}, nil
}

func (s *Session) notSignedIn() *CliError {
	return newErr("auth_required", fmt.Sprintf("Not signed in to %s; run `termag login`", s.Target.Host))
}

// bearerFor: a device login's access token (refreshed when about to lapse) wins over the box's own
// credential; the login is re-read per request (a refresh saves, a logout elsewhere removes).
func bearerFor(c *Ctx, s *Session) (BearerSource, error) {
	login := LoadLogin(s.CredsPath, s.Target.Host)
	if login == nil {
		if s.Target.Box == nil || s.Target.Box.Token == "" {
			return nil, s.notSignedIn()
		}
		tok := s.Target.Box.Token
		return func(context.Context, string, time.Duration) (string, error) { return tok, nil }, nil
	}
	return func(ctx context.Context, rejected string, validFor time.Duration) (string, error) {
		current := LoadLogin(s.CredsPath, s.Target.Host)
		if current == nil {
			return "", s.notSignedIn()
		}
		return freshAccess(ctx, c, s.Target.Host, s.CredsPath, current, rejected, validFor)
	}, nil
}

// authedApi: a device login for this orchestrator wins over the box's own credential.
func authedApi(c *Ctx, s *Session, timeout time.Duration) (*Api, error) {
	api := &Api{Host: s.Target.Host, Client: c.HTTP, Timeout: timeout}
	login := LoadLogin(s.CredsPath, s.Target.Host)
	if login == nil && s.Target.Box != nil && s.Target.Box.Token != "" {
		api.Token = s.Target.Box.Token
		return api, nil
	}
	src, err := bearerFor(c, s)
	if err != nil {
		return nil, err
	}
	api.Source = src
	return api, nil
}

// boxApi is the box's own credential even when a device login exists (bug list/show/triage).
func boxApi(c *Ctx, s *Session, timeout time.Duration) *Api {
	if s.Target.Box == nil {
		return nil
	}
	return &Api{Host: s.Target.Host, Client: c.HTTP, Token: s.Target.Box.Token, Timeout: timeout}
}
