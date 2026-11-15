package cli

// The command table itself is spec_gen.go, generated from cli/src/args.ts by
// tools/genspec.mjs, so the help text and the options are the Node CLI's own.

// OptionSpec is one option of node:util parseArgs' config.
type OptionSpec struct {
	Name     string
	String   bool // type 'string'; otherwise 'boolean'
	Short    string
	Multiple bool
}

// CommandSpec is one entry of COMMANDS (args.ts).
type CommandSpec struct {
	Name        string
	Summary     string
	Usage       string
	Options     []OptionSpec
	MaxArgs     int
	Details     string
	Passthrough bool
}

const maxArgsUnlimited = int(^uint(0) >> 1)

var (
	// A package-level initializer, not init(): command files register() in their own init(),
	// which may run before this file's (init order follows file names).
	specByName  = indexSpecs()
	unionByName map[string]OptionSpec
	unionShort  map[string]string // short letter -> long name
	groupSet    map[string]bool
)

func indexSpecs() map[string]*CommandSpec {
	m := make(map[string]*CommandSpec, len(commandSpecs))
	for i := range commandSpecs {
		m[commandSpecs[i].Name] = &commandSpecs[i]
	}
	return m
}

func init() {
	// allOptions(): the global options, then every command's, a later one
	// replacing an earlier one of the same name, and multiple if any is.
	unionByName = map[string]OptionSpec{}
	unionShort = map[string]string{}
	add := func(o OptionSpec) {
		prev, had := unionByName[o.Name]
		if (o.Multiple || (had && prev.Multiple)) && o.String {
			o.Multiple = true
		}
		unionByName[o.Name] = o
	}
	for _, o := range globalOptions {
		add(o)
	}
	for _, s := range commandSpecs {
		for _, o := range s.Options {
			add(o)
		}
	}
	for name, o := range unionByName {
		if o.Short != "" {
			unionShort[o.Short] = name
		}
	}
	groupSet = map[string]bool{}
	for _, g := range commandGroups {
		groupSet[g] = true
	}
}

func (s *CommandSpec) option(name string) (OptionSpec, bool) {
	for _, o := range s.Options {
		if o.Name == name {
			return o, true
		}
	}
	return OptionSpec{}, false
}
