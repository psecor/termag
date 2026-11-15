# The Go build of termag's CLI. See README.md.
PKG       := github.com/example-org/termag/cli-go/internal/cli
VERSION   ?= $(shell ./version.sh)
LDFLAGS   := -s -w -X $(PKG).Version=$(VERSION)
PLATFORMS := darwin-arm64 darwin-amd64 linux-arm64 linux-amd64

.PHONY: build dist test vet generate check-generated

# dist/termag for this machine: static, stamped with version.sh's version.
build:
	CGO_ENABLED=0 go build -trimpath -ldflags '$(LDFLAGS)' -o dist/termag ./cmd/termag

# dist/termag-<os>-<arch> for every platform termag supports (no Windows).
dist: $(addprefix dist/termag-,$(PLATFORMS))

dist/termag-%: FORCE
	CGO_ENABLED=0 GOOS=$(word 1,$(subst -, ,$*)) GOARCH=$(word 2,$(subst -, ,$*)) \
	  go build -trimpath -ldflags '$(LDFLAGS)' -o $@ ./cmd/termag

FORCE:

test:
	go test ./...

vet:
	go vet ./...

# Regenerates internal/cli/spec_gen.go and the golden fixtures from the Node CLI (needs npm ci in cli/).
generate:
	node tools/genspec.mjs
	node tools/genconnect.mjs

# The generated table and fixtures are the Node CLI's current ones. The check is a Go test
# (internal/cli/generated_test.go), so plain `go test ./...` runs it too; here it may not skip.
check-generated:
	TERMAG_REQUIRE_GENSPEC=1 go test -count=1 -run '^TestGeneratedFilesMatchTheNodeCLI$$' ./internal/cli
