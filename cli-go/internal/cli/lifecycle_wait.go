package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// The part of lifecycle.ts `termag ask` needs to wake the caller's own parked box when an older
// orchestrator refuses an ask with box_offline (ownBox, startAndWait). The seed of the phase-2
// lifecycle port; names carry an lc prefix until then.

const lcDefaultPoll = 3 * time.Second
const lcStartWaitS = 10 * 60

var (
	lcParked   = map[string]bool{"stopping": true, "stopped": true, "hibernating": true, "hibernated": true}
	lcParking  = map[string]bool{"stopping": true, "hibernating": true}
	lcWakeable = map[string]bool{"stopping": true, "stopped": true, "hibernating": true, "hibernated": true, "starting": true}
)

type lcBox struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	State          string  `json:"state"`
	AgentConnected bool    `json:"agentConnected"`
	Error          *string `json:"error"`
}

func lcListBoxes(api *Api) ([]lcBox, error) {
	var res struct {
		Boxes []lcBox `json:"boxes"`
	}
	if err := api.Request(context.Background(), "GET", "/boxes", nil, &res); err != nil {
		return nil, err
	}
	return res.Boxes, nil
}

func lcFindBox(boxes []lcBox, ref string) *lcBox {
	for i := range boxes {
		if boxes[i].Name == ref {
			return &boxes[i]
		}
	}
	for i := range boxes {
		if boxes[i].ID == ref {
			return &boxes[i]
		}
	}
	return nil
}

func lcFormatDuration(d time.Duration) string {
	s := int64(jsRound(float64(d) / float64(time.Second)))
	if s < 60 {
		return fmt.Sprintf("%ds", s)
	}
	return fmt.Sprintf("%dm%02ds", s/60, s%60)
}

func (c *Ctx) lcPoll() time.Duration {
	if c.PollInterval > 0 {
		return c.PollInterval
	}
	return lcDefaultPoll
}

func lcRefresh(api *Api, box lcBox) (lcBox, error) {
	boxes, err := lcListBoxes(api)
	if err != nil {
		return lcBox{}, err
	}
	for _, b := range boxes {
		if b.ID == box.ID {
			return b, nil
		}
	}
	return lcBox{}, newErr("not_found", fmt.Sprintf("Box %s is gone", box.Name))
}

func lcSleepUntil(c *Ctx, deadline time.Time) {
	d := c.lcPoll()
	if left := deadline.Sub(c.now()); left < d {
		d = left
	}
	if d > 0 {
		c.sleep(d)
	}
}

func lcWaitForRunning(c *Ctx, api *Api, box lcBox, timeoutS float64, quiet bool) (lcBox, error) {
	started := c.now()
	deadline := started.Add(time.Duration(timeoutS * float64(time.Second)))
	last := ""
	current := box
	for {
		if current.State == "running" && current.AgentConnected {
			return current, nil
		}
		if current.State == "failed" {
			why := ""
			if truthy(current.Error) {
				why = ": " + *current.Error
			}
			return lcBox{}, newErr("failed", fmt.Sprintf("Box %s failed%s", current.Name, why))
		}
		if lcParked[current.State] {
			return lcBox{}, newErr("failed", fmt.Sprintf("Box %s is %s; start it with `termag box start %s`", current.Name, current.State, current.Name))
		}
		label := current.State
		if label == "running" {
			label = "running, waiting for its agent"
		}
		if !quiet && label != last {
			c.Err(fmt.Sprintf("%s: %s (%s)", current.Name, label, lcFormatDuration(c.now().Sub(started))))
		}
		last = label
		if !c.now().Before(deadline) {
			return lcBox{}, newErr("timeout", fmt.Sprintf("Timed out after %s waiting for %s to be running (it is %s)", lcFormatDuration(time.Duration(timeoutS*float64(time.Second))), current.Name, label))
		}
		lcSleepUntil(c, deadline)
		next, err := lcRefresh(api, box)
		if err != nil {
			return lcBox{}, err
		}
		current = next
	}
}

func lcWaitUntilParked(c *Ctx, api *Api, box lcBox, deadline time.Time, quiet bool) (lcBox, error) {
	current := box
	last := ""
	for lcParking[current.State] {
		if !quiet && current.State != last {
			c.Err(fmt.Sprintf("%s: %s, starting it once that finishes", current.Name, current.State))
		}
		last = current.State
		if !c.now().Before(deadline) {
			return lcBox{}, newErr("timeout", fmt.Sprintf("Timed out waiting for %s to finish %s; run `termag box start %s --wait` again", current.Name, current.State, current.Name))
		}
		lcSleepUntil(c, deadline)
		next, err := lcRefresh(api, box)
		if err != nil {
			return lcBox{}, err
		}
		current = next
	}
	return current, nil
}

func lcSendStart(api *Api, box lcBox) (lcBox, error) {
	if box.State == "running" || box.State == "starting" {
		return box, nil
	}
	raw, err := api.RequestRaw(context.Background(), "POST", "/boxes/"+enc(box.ID)+"/start", nil)
	if err == nil {
		var res struct {
			Box lcBox `json:"box"`
		}
		_ = json.Unmarshal(raw, &res)
		return res.Box, nil
	}
	// Another start got there first: the 409 is that start's, not a failure.
	var ce *CliError
	if !errors.As(err, &ce) || ce.Code != "conflict" {
		return lcBox{}, err
	}
	boxes, lerr := lcListBoxes(api)
	if lerr != nil {
		return lcBox{}, lerr
	}
	for _, b := range boxes {
		if b.ID == box.ID && (b.State == "starting" || b.State == "running") {
			return b, nil
		}
	}
	return lcBox{}, err
}

func lcStartAndWait(c *Ctx, api *Api, box lcBox, timeoutS float64, quiet bool) (lcBox, error) {
	parked, err := lcWaitUntilParked(c, api, box, c.now().Add(time.Duration(timeoutS*float64(time.Second))), quiet)
	if err != nil {
		return lcBox{}, err
	}
	startedBox, err := lcSendStart(api, parked)
	if err != nil {
		return lcBox{}, err
	}
	return lcWaitForRunning(c, api, startedBox, timeoutS, quiet)
}

// wakeBox (ask.ts): start the caller's own parked box, then the ask is sent again.
func wakeBox(c *Ctx, api *Api, target string, a *ParsedArgs) (bool, error) {
	boxes, err := lcListBoxes(api)
	if err != nil {
		return false, nil
	}
	box := lcFindBox(boxes, strings.Split(target, "/")[0])
	if box == nil || !lcWakeable[box.State] {
		return false, nil
	}
	if !a.JSON {
		c.Err(fmt.Sprintf("termag: %s is %s; starting it, then asking", box.Name, box.State))
	}
	limit, has, err := askTimeoutSeconds(a)
	if err != nil {
		return false, err
	}
	if !has {
		limit = lcStartWaitS
	}
	if _, err := lcStartAndWait(c, api, *box, limit, a.JSON); err != nil {
		return false, err
	}
	return true, nil
}
