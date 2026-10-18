#!/usr/bin/env bash
# What terraform creates for the per-user credential store (E2E_CREDENTIAL_STORE):
# the KMS key behind alias/termag-user-credentials, in Floci at E2E_AWS_URL.
# Prints the backend env line terraform gives the orchestrator, the key's ARN,
# which Floci only assigns at CreateKey time.
#
#   credential-store.sh seed-aws
set -euo pipefail
[ "${1:-}" = seed-aws ] && [ $# -eq 1 ] || { echo "usage: credential-store.sh seed-aws" >&2; exit 2; }
aws=(bash "$(dirname "${BASH_SOURCE[0]}")/aws.sh" call)
alias=alias/termag-user-credentials
# An E2E_AWS_SEED may already have made the alias; a second CreateAlias would
# silently retarget it to a new key.
if ! arn=$("${aws[@]}" TrentService.DescribeKey "{\"KeyId\":\"$alias\"}" 2>/dev/null | jq -er .KeyMetadata.Arn); then
  key=$("${aws[@]}" TrentService.CreateKey '{}' | jq -r .KeyMetadata.KeyId)
  "${aws[@]}" TrentService.CreateAlias "{\"AliasName\":\"$alias\",\"TargetKeyId\":\"$key\"}" >/dev/null
  arn=$("${aws[@]}" TrentService.DescribeKey "{\"KeyId\":\"$alias\"}" | jq -er .KeyMetadata.Arn)
fi
echo "CREDENTIAL_STORE_KMS_KEY_ID=$arn"
