#!/usr/bin/env bash
# Render the termag Claude gateway's Envoy config for the e2e stack
# (E2E_CLAUDE_GATEWAY) from a checkout of the gateway's terraform: the same
# envoy-config module and claude-models.json the deployment uses, with
# the stack's ports and a plain-HTTP fake Bedrock. Also writes the backend env
# terraform would give the orchestrator (models, default and fast tiers).
#
#   claude-gateway.sh render <terraform checkout> <out dir> <envoy port> <orchestrator port> <bedrock port> <github port> <sts port> <ca file>
#                                  Envoy's ports: Claude on <envoy port>, admin on +1,
#                                  the GitHub broker on +2, the checks' caller-proof
#                                  and STS signer loopback listeners on +3 and +4.
#                                  Every check goes over HTTPS to <orchestrator port>
#                                  (the checks ALB's stand-in), verified with <ca file>
#                                  as Envoy verifies the real ALB with the system CAs.
#
# render needs terraform on PATH (or E2E_TERRAFORM).
set -euo pipefail
usage="usage: claude-gateway.sh render <terraform checkout> <out dir> <envoy port> <orchestrator port> <bedrock port> <github port> <sts port> <ca file>"
[ "${1:-}" = render ] && [ $# -eq 9 ] || { echo "$usage" >&2; exit 2; }
tf_repo=$(cd "$2" && pwd); out=$3; envoy_port=$4; orchestrator_port=$5; bedrock_port=$6; github_port=$7; sts_port=$8; ca_file=$9
root="$tf_repo/projects/termag/root-modules/orchestrator"
[ -f "$root/claude-models.json" ] || { echo "no $root/claude-models.json" >&2; exit 1; }
terraform=${E2E_TERRAFORM:-terraform}
command -v "$terraform" >/dev/null || { echo "terraform not found (set E2E_TERRAFORM)" >&2; exit 1; }
mkdir -p "$out"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cat >"$work/main.tf" <<TF
locals { claude = jsondecode(file("$root/claude-models.json")) }
module "cfg" {
  source         = "$root/modules/claude-gateway/envoy-config"
  listen_port    = $envoy_port
  admin_port     = $((envoy_port + 1))
  orchestrator_host = "localhost"
  orchestrator_port = $orchestrator_port
  system_ca_file    = "$ca_file"
  bedrock_region    = "us-east-2"
  bedrock_host      = "127.0.0.1"
  bedrock_port      = $bedrock_port
  bedrock_tls       = false
  models            = local.claude.models
  # The GitHub broker, against the api.github.com / github.com stub; the
  # caller proof is signed for the STS stub.
  github_listen_port = $((envoy_port + 2))
  caller_proof_port  = $((envoy_port + 3))
  sts_signer_port    = $((envoy_port + 4))
  github             = { git_host = "127.0.0.1", api_host = "127.0.0.1", port = $github_port, tls = false, git_path_prefix = "/_github.com" }
  sts                = { host = "127.0.0.1:$sts_port", port = $sts_port, tls = false }
}
locals {
  env = join("\n", [
    "CLAUDE_BEDROCK_REGION=us-east-2",
    "CLAUDE_BEDROCK_MODELS=\${join(",", [for t, m in local.claude.models : "\${t}=\${m.profile}"])}",
    "CLAUDE_DEFAULT_MODEL=\${local.claude.default}",
    "CLAUDE_FAST_MODEL=\${local.claude.fast}",
  ])
}
TF
( cd "$work" && "$terraform" init -input=false >/dev/null \
  && echo 'module.cfg.yaml' | "$terraform" console | sed '1d;$d' >"$out/envoy.yaml" \
  && echo 'local.env' | "$terraform" console | sed '1d;$d' >"$out/backend.env" )
[ -s "$out/envoy.yaml" ] && [ -s "$out/backend.env" ] || { echo "rendering failed" >&2; exit 1; }
