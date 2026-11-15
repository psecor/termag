package cli

import (
	"encoding/json"
	"fmt"
	"strings"
)

// OptValue is one parsed option: a string, or a boolean flag.
type OptValue struct {
	Str   string
	IsStr bool
}

// ParsedArgs mirrors args.ts's ParsedArgs.
type ParsedArgs struct {
	Command string // "" for none
	Args    []string
	JSON    bool
	Yes     bool
	Host    *string
	Help    bool
	Version bool
	Options map[string]OptValue
	// Every value of an option its command takes more than once, in order; Options holds the last.
	Lists          map[string][]string
	Passthrough    []string
	HasPassthrough bool
}

// Str is a string option's value.
func (a *ParsedArgs) Str(name string) (string, bool) {
	v, ok := a.Options[name]
	if !ok || !v.IsStr {
		return "", false
	}
	return v.Str, true
}

// Bool is whether a boolean option was given.
func (a *ParsedArgs) Bool(name string) bool {
	v, ok := a.Options[name]
	return ok && !v.IsStr
}

// Has is whether the option was given at all.
func (a *ParsedArgs) Has(name string) bool { _, ok := a.Options[name]; return ok }

// MarshalJSON gives ParsedArgs the shape of the Node parser's result, for the golden tests.
func (a ParsedArgs) MarshalJSON() ([]byte, error) {
	o := newObject()
	if a.Command == "" {
		o.Set("command", nil)
	} else {
		o.Set("command", a.Command)
	}
	if a.Args == nil {
		a.Args = []string{}
	}
	o.Set("args", a.Args)
	o.Set("json", a.JSON)
	o.Set("yes", a.Yes)
	if a.Host != nil {
		o.Set("host", *a.Host)
	}
	o.Set("help", a.Help)
	o.Set("version", a.Version)
	opts := newObject()
	for _, k := range sortedKeys(a.Options) {
		v := a.Options[k]
		if v.IsStr {
			opts.Set(k, v.Str)
		} else {
			opts.Set(k, true)
		}
	}
	o.Set("options", opts)
	lists := newObject()
	for _, k := range sortedKeys(a.Lists) {
		lists.Set(k, a.Lists[k])
	}
	o.Set("lists", lists)
	if a.HasPassthrough {
		if a.Passthrough == nil {
			a.Passthrough = []string{}
		}
		o.Set("passthrough", a.Passthrough)
	}
	return json.Marshal(o)
}

type token struct {
	option      bool
	name        string
	rawName     string
	value       *string
	inlineValue bool
	positional  string
}

func isOptionLikeValue(v string) bool { return len(v) > 1 && v[0] == '-' }

func longForShort(short string) string {
	if long, ok := unionShort[short]; ok {
		return long
	}
	return short
}

func optType(name string) (string, bool) {
	o, ok := unionByName[name]
	if !ok {
		return "", false
	}
	if o.String {
		return "string", true
	}
	return "boolean", true
}

// tokenize is node:util parseArgs' argsToTokens.
func tokenize(argv []string) []token {
	var out []token
	rest := append([]string(nil), argv...)
	for len(rest) > 0 {
		arg := rest[0]
		rest = rest[1:]
		if arg == "--" {
			for _, p := range rest {
				out = append(out, token{positional: p})
			}
			break
		}
		switch {
		case len(arg) == 2 && arg[0] == '-' && arg[1] != '-': // -f
			long := longForShort(arg[1:])
			t := token{option: true, name: long, rawName: arg}
			if typ, _ := optType(long); typ == "string" && len(rest) > 0 {
				v := rest[0]
				rest = rest[1:]
				t.value = &v
			}
			out = append(out, t)
		case len(arg) > 2 && arg[0] == '-' && arg[1] != '-':
			first := longForShort(arg[1:2])
			if typ, _ := optType(first); typ != "string" { // -abc
				var expanded []string
				for i := 1; i < len(arg); i++ {
					long := longForShort(arg[i : i+1])
					if typ, _ := optType(long); typ != "string" || i == len(arg)-1 {
						expanded = append(expanded, "-"+arg[i:i+1])
					} else {
						expanded = append(expanded, "-"+arg[i:])
						break
					}
				}
				rest = append(expanded, rest...)
			} else { // -fVALUE
				v := arg[2:]
				out = append(out, token{option: true, name: first, rawName: arg[:2], value: &v, inlineValue: true})
			}
		case len(arg) > 2 && strings.HasPrefix(arg, "--") && !strings.Contains(arg, "="):
			long := arg[2:]
			t := token{option: true, name: long, rawName: arg}
			if typ, _ := optType(long); typ == "string" && len(rest) > 0 {
				v := rest[0]
				rest = rest[1:]
				t.value = &v
			}
			out = append(out, t)
		case len(arg) > 2 && strings.HasPrefix(arg, "--"):
			eq := strings.Index(arg, "=")
			v := arg[eq+1:]
			out = append(out, token{option: true, name: arg[2:eq], rawName: arg[:eq], value: &v, inlineValue: true})
		default:
			out = append(out, token{positional: arg})
		}
	}
	return out
}

type parsedValue struct {
	isStr bool
	str   string
	list  []string
	multi bool
}

// nodeParseArgs is parseArgs({strict: true, allowPositionals: true}) over the union of every command's options.
func nodeParseArgs(argv []string) (order []string, values map[string]*parsedValue, positionals []string, err error) {
	values = map[string]*parsedValue{}
	for _, t := range tokenize(argv) {
		if !t.option {
			positionals = append(positionals, t.positional)
			continue
		}
		o, ok := unionByName[t.name]
		if !ok {
			return nil, nil, nil, fmt.Errorf("Unknown option '%s'", t.rawName)
		}
		shortAndLong := "--" + t.name
		if o.Short != "" {
			shortAndLong = "-" + o.Short + ", " + shortAndLong
		}
		if o.String && t.value == nil {
			return nil, nil, nil, fmt.Errorf("Option '%s <value>' argument missing", shortAndLong)
		}
		if !o.String && t.value != nil {
			return nil, nil, nil, fmt.Errorf("Option '%s' does not take an argument", shortAndLong)
		}
		if !t.inlineValue && t.value != nil && isOptionLikeValue(*t.value) {
			example := "'" + t.rawName + "=-XYZ'"
			if !strings.HasPrefix(t.rawName, "--") {
				example = "'--" + t.name + "=-XYZ' or '" + t.rawName + "-XYZ'"
			}
			return nil, nil, nil, fmt.Errorf("Option '%s' argument is ambiguous.\nDid you forget to specify the option argument for '%s'?\nTo specify an option argument starting with a dash use %s.", t.rawName, t.rawName, example)
		}
		pv, seen := values[t.name]
		if !seen {
			pv = &parsedValue{}
			values[t.name] = pv
			order = append(order, t.name)
		}
		if o.String {
			pv.isStr = true
			if o.Multiple {
				pv.multi = true
				pv.list = append(pv.list, *t.value)
			}
			pv.str = *t.value
		}
	}
	return order, values, positionals, nil
}

// splitPassthrough splits argv just after a passthrough command's first argument (ssh's options).
func splitPassthrough(argv []string) (head, tail []string, has bool) {
	takesValue := func(tok string) bool {
		if strings.HasPrefix(tok, "--") {
			o, ok := unionByName[tok[2:]]
			return ok && o.String
		}
		last := tok[len(tok)-1:]
		for _, o := range unionByName {
			if o.Short == last && o.String {
				return true
			}
		}
		return false
	}
	var positionals []string
	for i := 0; i < len(argv); i++ {
		tok := argv[i]
		if tok == "--" {
			break
		}
		if strings.HasPrefix(tok, "-") && tok != "-" {
			if !strings.Contains(tok, "=") && takesValue(tok) {
				i++
			}
			continue
		}
		positionals = append(positionals, tok)
		if len(positionals) == 2 {
			if s := specByName[positionals[0]]; s != nil && s.Passthrough {
				return argv[:i+1], argv[i+1:], true
			}
		}
	}
	return argv, nil, false
}

// ParseCommandLine is args.ts's parseCommandLine.
func ParseCommandLine(argv []string) (*ParsedArgs, error) {
	head, tail, hasTail := splitPassthrough(argv)
	order, v, positionals, err := nodeParseArgs(head)
	if err != nil {
		return nil, usageError(err.Error())
	}
	base := ParsedArgs{Options: map[string]OptValue{}, Lists: map[string][]string{}, Args: []string{}}
	_, base.JSON = v["json"]
	_, base.Yes = v["yes"]
	if h, ok := v["host"]; ok {
		s := h.str
		base.Host = &s
	}
	_, base.Help = v["help"]
	_, base.Version = v["version"]

	if len(positionals) > 0 && positionals[0] == "help" {
		target, err := resolveHelpTarget(positionals[1:])
		if err != nil {
			return nil, err
		}
		base.Help = true
		base.Command = target
		return &base, nil
	}
	command := ""
	rest := positionals
	if len(positionals) > 0 {
		first := positionals[0]
		if groupSet[first] {
			if len(positionals) < 2 || positionals[1] == "" {
				if base.Help {
					return &base, nil
				}
				g := first
				if g == "env" {
					g = "environment"
				}
				return nil, usageError(fmt.Sprintf("`termag %s` needs a subcommand: %s", first, strings.Join(subcommandsOf(g), ", ")))
			}
			command = first + " " + positionals[1]
			if a, ok := commandAliases[command]; ok {
				command = a
			}
			rest = positionals[2:]
		} else {
			command = first
			rest = positionals[1:]
		}
		if specByName[command] == nil {
			n := 1
			if groupSet[first] {
				n = 2
			}
			return nil, usageError(fmt.Sprintf("Unknown command `%s`. Run `termag --help`.", strings.Join(positionals[:n], " ")))
		}
	}
	var spec *CommandSpec
	if command != "" {
		spec = specByName[command]
	}
	for _, name := range order {
		if isGlobalOption(name) {
			continue
		}
		var o OptionSpec
		ok := false
		if spec != nil {
			o, ok = spec.option(name)
		}
		if !ok {
			cmd := ""
			if command != "" {
				cmd = " " + command
			}
			return nil, usageError(fmt.Sprintf("`--%s` is not an option of `termag%s`", name, cmd))
		}
		pv := v[name]
		if pv.multi {
			if o.Multiple {
				base.Lists[name] = pv.list
			} else if len(pv.list) > 1 {
				return nil, usageError(fmt.Sprintf("`--%s` is given more than once; `termag %s` takes one", name, command))
			}
		}
		if pv.isStr {
			base.Options[name] = OptValue{Str: pv.str, IsStr: true}
		} else {
			base.Options[name] = OptValue{}
		}
	}
	if spec != nil && len(rest) > spec.MaxArgs && !base.Help {
		return nil, usageError("Too many arguments. Usage: " + spec.Usage)
	}
	base.Command = command
	if rest == nil {
		rest = []string{}
	}
	base.Args = rest
	if hasTail {
		base.Passthrough = tail
		base.HasPassthrough = true
	}
	return &base, nil
}

func isGlobalOption(name string) bool {
	for _, o := range globalOptions {
		if o.Name == name {
			return true
		}
	}
	return false
}

func resolveHelpTarget(words []string) (string, error) {
	if len(words) == 0 {
		return "", nil
	}
	n := len(words)
	if n > 2 {
		n = 2
	}
	joined := strings.Join(words[:n], " ")
	if a, ok := commandAliases[joined]; ok {
		return a, nil
	}
	if specByName[joined] != nil {
		return joined, nil
	}
	if specByName[words[0]] != nil {
		return words[0], nil
	}
	return "", usageError(fmt.Sprintf("No help for `%s`. Run `termag --help`.", strings.Join(words, " ")))
}

func subcommandsOf(group string) []string {
	var out []string
	for _, s := range commandSpecs {
		if strings.HasPrefix(s.Name, group+" ") {
			out = append(out, s.Name[len(group)+1:])
		}
	}
	return out
}

// HelpText is args.ts's helpText.
func HelpText(command string) string {
	if command != "" {
		spec := specByName[command]
		details := ""
		if spec.Details != "" {
			details = spec.Details + "\n\n"
		}
		return spec.Summary + ".\n\nUsage: " + spec.Usage + "\n\n" + details + globalHelp
	}
	width := 0
	for _, s := range commandSpecs {
		if n := jsLen(s.Name); n > width {
			width = n
		}
	}
	var b strings.Builder
	b.WriteString("termag: manage termag boxes and projects from the command line.\n\nCommands:\n")
	for i, s := range commandSpecs {
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString("  " + padEnd(s.Name, width) + "  " + s.Summary)
	}
	b.WriteString("\n\n" + globalHelp)
	return b.String()
}
