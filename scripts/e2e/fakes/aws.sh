#!/usr/bin/env bash
# Minimal client for the e2e stack's Floci, for E2E_AWS_SEED scripts and
# checks; needs no AWS CLI or SDK. Floci accepts unsigned requests and files
# them under its default region, which up.sh sets to the stack's AWS_REGION.
#
#   aws.sh mb <bucket>                       create an S3 bucket
#   aws.sh call <X-Amz-Target> '<json>'      any JSON-protocol API, e.g.
#       aws.sh call TrentService.CreateKey '{}'
#       aws.sh call AmazonSSM.PutParameter '{"Name":"/x","Value":"v","Type":"SecureString"}'
#       aws.sh call secretsmanager.CreateSecret '{"Name":"x","SecretString":"v"}'
#
# Env: E2E_AWS_URL (set by up.sh for seed scripts; else read from the stack).
set -euo pipefail
if [ -z "${E2E_AWS_URL:-}" ]; then
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  # shellcheck source-path=SCRIPTDIR/..
  . "$here/lib.sh"
  root=$(e2e_root) || die "no e2e stack is up"
  E2E_AWS_URL=$(sed -n 's/^AWS_URL=//p' "$root/stack.env")
  [ -n "$E2E_AWS_URL" ] || die "the stack was started without E2E_FAKE_AWS=1"
fi
case ${1:-} in
  mb)   curl -fsS -X PUT "$E2E_AWS_URL/$2" -o /dev/null ;;
  call) curl -fsS -X POST "$E2E_AWS_URL/" -H "X-Amz-Target: $2" \
          -H 'Content-Type: application/x-amz-json-1.1' -d "$3"; echo ;;
  *)    echo "usage: aws.sh mb <bucket> | call <X-Amz-Target> '<json>'" >&2; exit 2 ;;
esac
