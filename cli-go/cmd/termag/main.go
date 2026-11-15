// Command termag is the Go build of termag's CLI (cli-go/README.md).
package main

import (
	"os"

	"github.com/example-org/termag/cli-go/internal/cli"
)

func main() { os.Exit(cli.Main()) }
