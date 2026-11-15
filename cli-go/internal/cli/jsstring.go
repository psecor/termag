package cli

import (
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Helpers that make Go strings behave as the JS strings the Node CLI computes with.

// nodeUTF8 decodes bytes as Node's readFileSync(…, 'utf8') does (the WHATWG decoder): each
// maximal invalid subpart becomes one U+FFFD, where Go would give one per byte.
func nodeUTF8(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var out strings.Builder
	for i := 0; i < len(b); {
		r, n := utf8.DecodeRune(b[i:])
		if r != utf8.RuneError || n > 1 {
			out.WriteRune(r)
			i += n
			continue
		}
		// The longest prefix of a valid sequence starting at i counts as one error.
		c := b[i]
		need, lo, hi := 0, byte(0x80), byte(0xBF)
		switch {
		case c >= 0xC2 && c <= 0xDF:
			need = 1
		case c == 0xE0:
			need, lo = 2, 0xA0
		case c >= 0xE1 && c <= 0xEC, c == 0xEE, c == 0xEF:
			need = 2
		case c == 0xED:
			need, hi = 2, 0x9F
		case c == 0xF0:
			need, lo = 3, 0x90
		case c >= 0xF1 && c <= 0xF3:
			need = 3
		case c == 0xF4:
			need, hi = 3, 0x8F
		}
		j := i + 1
		for k := 0; k < need && j < len(b); k++ {
			if b[j] < lo || b[j] > hi {
				break
			}
			lo, hi = 0x80, 0xBF
			j++
		}
		out.WriteRune(utf8.RuneError)
		i = j
	}
	return out.String()
}

// jsSpaceClass is JS's \s.
const jsSpaceClass = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var jsSpaceRun = regexp.MustCompile(jsSpaceClass + `+`)

// jsTrim is String#trim.
func jsTrim(s string) string { return strings.TrimFunc(s, isJSWhitespace) }

// jsSliceUnits is s.slice(0, n) in UTF-16 units (a split pair becomes U+FFFD on output, as in Node).
func jsSliceUnits(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if n >= len(u) {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

// jsSlicePrefix is s.slice(0, n) for ASCII-led strings such as ISO timestamps.
func jsSlicePrefix(s string, n int) string { return jsSliceUnits(s, n) }
