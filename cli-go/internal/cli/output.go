package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// jsLen is a string's length as JavaScript counts it (UTF-16 code units), for padEnd parity.
func jsLen(s string) int { return len(utf16.Encode([]rune(s))) }

func padEnd(s string, width int) string {
	if n := jsLen(s); n < width {
		return s + strings.Repeat(" ", width-n)
	}
	return s
}

// Table is output.ts's table: left-aligned columns two spaces apart, the last not padded.
func Table(headers []string, rows [][]string) string {
	widths := make([]int, len(headers))
	for i, h := range headers {
		widths[i] = jsLen(h)
		for _, r := range rows {
			if i < len(r) {
				if n := jsLen(r[i]); n > widths[i] {
					widths[i] = n
				}
			}
		}
	}
	line := func(cells []string) string {
		parts := make([]string, len(cells))
		for i, c := range cells {
			if i == len(cells)-1 || i >= len(widths) {
				parts[i] = c
			} else {
				parts[i] = padEnd(c, widths[i])
			}
		}
		return strings.TrimRightFunc(strings.Join(parts, "  "), isJSWhitespace)
	}
	out := []string{line(headers)}
	for _, r := range rows {
		out = append(out, line(r))
	}
	return strings.Join(out, "\n")
}

func isJSWhitespace(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\v', '\f', '\r', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// parseJSDate parses the ISO timestamps the orchestrator sends, as Date does.
func parseJSDate(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.000Z", "2006-01-02T15:04Z07:00", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// FormatDate is output.ts's formatDate: 2026-10-02T14:05:00.000Z → 2026-10-02 14:05 UTC.
func FormatDate(iso string) string {
	t, ok := parseJSDate(iso)
	if !ok {
		return "-"
	}
	return t.UTC().Format("2006-01-02 15:04") + " UTC"
}

// isoString is Date#toISOString.
func isoString(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// JSONText is JSON.stringify(v, null, 2). Struct field order is the output's key order; never
// marshal a Go map where the key order is a contract (it sorts), use *Object.
func JSONText(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
	return jsLineSeparators(strings.TrimSuffix(buf.String(), "\n"))
}

// CompactJSON is JSON.stringify(v).
func CompactJSON(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
	return jsLineSeparators(strings.TrimSuffix(buf.String(), "\n"))
}

// jsLineSeparators undoes encoding/json's   and   escapes, which JSON.stringify leaves raw.
func jsLineSeparators(s string) string {
	if !strings.Contains(s, `\u202`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			if s[i+1] == 'u' && i+6 <= len(s) && (s[i+2:i+6] == "2028" || s[i+2:i+6] == "2029") {
				if s[i+2:i+6] == "2028" {
					b.WriteRune(0x2028)
				} else {
					b.WriteRune(0x2029)
				}
				i += 5
				continue
			}
			b.WriteByte(s[i])
			b.WriteByte(s[i+1])
			i++
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// Object is a JSON object that keeps its keys in insertion order, as a JS object does.
type Object struct {
	keys []string
	vals map[string]any
}

func newObject() *Object { return &Object{vals: map[string]any{}} }

// Set adds or replaces a key; a new key goes last.
func (o *Object) Set(k string, v any) *Object {
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
	return o
}

func (o *Object) Get(k string) (any, bool) { v, ok := o.vals[k]; return v, ok }

func (o *Object) Delete(k string) {
	if _, ok := o.vals[k]; !ok {
		return
	}
	delete(o.vals, k)
	for i, kk := range o.keys {
		if kk == k {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

func (o *Object) Keys() []string { return o.keys }

func (o *Object) Len() int { return len(o.keys) }

func (o *Object) MarshalJSON() ([]byte, error) {
	if o == nil {
		return []byte("null"), nil
	}
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		kb, _ := marshalNoEscape(k)
		buf.Write(kb)
		buf.WriteByte(':')
		vb, err := marshalNoEscape(o.vals[k])
		if err != nil {
			return nil, err
		}
		buf.Write(vb)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// UnmarshalJSON keeps the keys' order; values stay json.RawMessage.
func (o *Object) UnmarshalJSON(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	t, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := t.(json.Delim); !ok || d != '{' {
		// A plain error: json.UnmarshalTypeError with no Type panics in Error().
		return fmt.Errorf("expected a JSON object, got %s", jsonKindOf(t))
	}
	o.keys = nil
	o.vals = map[string]any{}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return err
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return err
		}
		o.Set(kt.(string), raw)
	}
	_, err = dec.Token()
	return err
}

func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// jsNumber is String(n) for the numbers termag prints (no exponent forms below 1e21).
func jsNumber(f float64) string {
	if f == float64(int64(f)) && f < 1e21 && f > -1e21 {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// jsonKindOf names the JSON value a token starts, for an error message.
func jsonKindOf(t json.Token) string {
	switch v := t.(type) {
	case nil:
		return "null"
	case bool:
		return "a boolean"
	case json.Number, float64:
		return "a number"
	case string:
		return "a string"
	case json.Delim:
		if v == '[' {
			return "an array"
		}
	}
	return "something else"
}
