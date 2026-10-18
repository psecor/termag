#!/usr/bin/env bash
# The spaces bucket and KMS alias in the e2e stack's Floci, named the way the
# backend derives them (backend/src/services/spaces/spaceConfig.ts) and the
# terraform creates them (projects/termag/root-modules/orchestrator/spaces.tf):
# bucket termag-spaces-<account>-<region>-an, versioned, with the browser CORS
# rule; KMS alias alias/termag-spaces. The presigner role needs no seed: Floci
# answers AssumeRole for any role ARN.
#
#   spaces.sh seed <origin>...   create both, CORS open to each browser origin;
#                                print the bucket name
#
# Env: E2E_AWS_URL, E2E_AWS_REGION.
set -euo pipefail

if [ "${1:-}" != seed ] || [ -z "${2:-}" ]; then echo "usage: spaces.sh seed <origin>..." >&2; exit 2; fi
shift
origins=''
for o in "$@"; do origins="$origins<AllowedOrigin>$o</AllowedOrigin>"; done
url=${E2E_AWS_URL:?}
region=${E2E_AWS_REGION:?}

account=$(curl -fsS -X POST "$url/" -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'Action=GetCallerIdentity&Version=2011-06-15' | sed -n 's:.*<Account>\([0-9]*\)</Account>.*:\1:p')
[ -n "$account" ] || { echo "spaces: STS GetCallerIdentity gave no account" >&2; exit 1; }
bucket="termag-spaces-$account-$region-an"

status=$(curl -sS -X PUT "$url/$bucket" -o /dev/null -w '%{http_code}')
case $status in 200|409) ;; *) echo "spaces: creating $bucket answered HTTP $status" >&2; exit 1 ;; esac
curl -fsS -X PUT "$url/$bucket?versioning" -H 'Content-Type: application/xml' -o /dev/null \
  -d '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>'
curl -fsS -X PUT "$url/$bucket?cors" -H 'Content-Type: application/xml' -o /dev/null -d "<CORSConfiguration>
  <CORSRule>
    $origins
    <AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>3000</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>"

kms() {
  curl -fsS -X POST "$url/" -H "X-Amz-Target: TrentService.$1" -H 'Content-Type: application/x-amz-json-1.1' -d "$2"
}
if ! kms ListAliases '{}' | grep -q '"alias/termag-spaces"'; then
  key=$(kms CreateKey '{"Description":"termag spaces (e2e)"}' | sed -n 's/.*"KeyId" *: *"\([^"]*\)".*/\1/p')
  [ -n "$key" ] || { echo "spaces: KMS CreateKey gave no key id" >&2; exit 1; }
  kms CreateAlias "{\"AliasName\":\"alias/termag-spaces\",\"TargetKeyId\":\"$key\"}" >/dev/null
fi
printf '%s\n' "$bucket"
