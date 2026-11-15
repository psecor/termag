package cli

import "testing"

// JSON that is not an object (null, an array, a string) is a plain error, never a panic: the
// orchestrator answering `null` to an ask is an "Unexpected answer", as any malformed one is.
func TestObjectUnmarshalRefusesNonObjectsWithoutPanicking(t *testing.T) {
	for _, in := range []string{`null`, `[1]`, `"x"`, `3`, `true`} {
		o := newObject()
		err := o.UnmarshalJSON([]byte(in))
		if err == nil {
			t.Errorf("%s: no error", in)
			continue
		}
		_ = err.Error() // panicked before for every one of these
	}
	if _, err := parseAskMessage([]byte(`null`)); err == nil || err.Error() != "Unexpected answer from the orchestrator: expected a JSON object, got null" {
		t.Errorf("ask null: %v", err)
	}
}
