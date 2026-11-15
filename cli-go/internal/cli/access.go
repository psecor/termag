package cli

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// refreshMu: see freshAccess.
var refreshMu sync.Mutex

// refreshMargin: refresh this long before the access token lapses (access.ts REFRESH_MARGIN_MS).
const refreshMargin = 60 * time.Second

func expiresAtFrom(now time.Time, expiresInSeconds float64) string {
	return isoString(now.Add(time.Duration(expiresInSeconds * float64(time.Second))))
}

type refreshResponse struct {
	AccessToken          string  `json:"accessToken"`
	AccessTokenExpiresIn float64 `json:"accessTokenExpiresIn"`
	ExpiresAt            string  `json:"expiresAt"`
	MaxExpiresAt         string  `json:"maxExpiresAt"`
}

// freshAccess is access.ts's: the login's access token, refreshed with its device token (and saved)
// when missing, about to lapse, or rejected.
func freshAccess(ctx context.Context, c *Ctx, host, credsPath string, login *StoredLogin, rejected string, validFor time.Duration) (string, error) {
	exp, okExp := parseJSDate(login.AccessTokenExpiresAt())
	refused := rejected != "" && login.AccessToken() == rejected
	margin := refreshMargin
	if validFor > margin {
		margin = validFor
	}
	if login.AccessToken() != "" && login.AccessTokenExpiresAt() != "" && !refused && okExp && exp.Add(-margin).After(c.now()) {
		return login.AccessToken(), nil
	}
	// One refresh at a time in this process: a burst of bearers (forward connections, the memory
	// listing's goroutines) collapses to one POST /token and one save. A waiter re-reads the file
	// and takes the winner's token if it does.
	refreshMu.Lock()
	defer refreshMu.Unlock()
	saved := LoadLogin(credsPath, host)
	if saved == nil {
		// Signed out (or replaced) while this caller waited: never save the old login back.
		return "", newErr("auth_required", fmt.Sprintf("Not signed in to %s; run `termag login`", host))
	}
	exp, okExp = parseJSDate(saved.AccessTokenExpiresAt())
	refused = rejected != "" && saved.AccessToken() == rejected
	if saved.AccessToken() != "" && !refused && okExp && exp.Add(-margin).After(c.now()) {
		return saved.AccessToken(), nil
	}
	login = saved
	api := &Api{Host: host, Client: c.HTTP}
	var fresh refreshResponse
	body := newObject().Set("grant_type", "refresh_token").Set("refresh_token", login.Token())
	if err := api.Request(ctx, "POST", "/token", body, &fresh); err != nil {
		return "", err
	}
	login.obj.Set("accessToken", fresh.AccessToken)
	login.obj.Set("accessTokenExpiresAt", expiresAtFrom(c.now(), fresh.AccessTokenExpiresIn))
	login.obj.Set("expiresAt", fresh.ExpiresAt)
	login.obj.Set("maxExpiresAt", fresh.MaxExpiresAt)
	if err := SaveLogin(credsPath, host, login); err != nil {
		return "", newErr("failed", "Could not save the refreshed sign-in: "+err.Error())
	}
	return fresh.AccessToken, nil
}
