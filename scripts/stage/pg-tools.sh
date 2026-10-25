#!/usr/bin/env bash
# Unpack PostgreSQL <major> binaries from the PGDG apt repository into <dest>,
# without installing anything: no apt, no maintainer scripts, nothing outside
# <dest>. Used by prod-snapshot.sh on the orchestrator (pg_dump must be at
# least the server's version, and the image ships an older one) and by
# `stage.sh refresh` here (the staging cluster should run the dump's version).
# Debian/Ubuntu only.
#
#   pg-tools.sh <major> <dest> [server]   prints the bin directory
#   pg-tools.sh env <dest>                prints LD_LIBRARY_PATH=... for those binaries
#
# The packages are checked the way apt checks them: the repository's signed
# InRelease must verify against PGDG's signing key, pinned here by
# fingerprint; InRelease gives the SHA256 of the package index; the index gives
# each package's SHA256. Package paths must stay under the repository's pool/,
# and every fetch is HTTPS-only, redirects included.
set -euo pipefail

# PGDG's archive signing key ("PostgreSQL Debian Repository"). The same key
# ships in Ubuntu's postgresql-common, /usr/share/postgresql-common/pgdg/.
PGDG_FPR=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
PGDG_KEY_URL=https://www.postgresql.org/media/keys/ACCC4CF8.asc
base=https://apt.postgresql.org/pub/repos/apt

die() { printf 'pg-tools: %s\n' "$*" >&2; exit 1; }
fetch() { curl -fsSL --proto '=https' --proto-redir '=https' -o "$2" "$1"; }

if [ "${1:-}" = env ]; then
  dest=${2:?usage: pg-tools.sh env <dest>}
  printf 'LD_LIBRARY_PATH=%s\n' "$(find "$dest/root/usr/lib" -maxdepth 1 -name '*-linux-gnu*' -type d | head -n1)"
  exit 0
fi

major=${1:?usage: pg-tools.sh <major> <dest> [server]}; dest=${2:?usage: pg-tools.sh <major> <dest> [server]}
want_server=${3:-}
case $major in ''|*[!0-9]*) die "major must be a number, got '$major'" ;; esac
for c in curl gpg gpgv gunzip sha256sum dpkg-deb; do command -v "$c" >/dev/null 2>&1 || die "missing '$c'"; done
. /etc/os-release
arch=$(dpkg --print-architecture)
suite=$VERSION_CODENAME-pgdg
bin="$dest/root/usr/lib/postgresql/$major/bin"
need=pg_dump; [ -n "$want_server" ] && need=postgres
if [ -x "$bin/$need" ]; then printf '%s\n' "$bin"; exit 0; fi

work="$dest/work"
rm -rf "$work"; mkdir -p "$work"
trap 'rm -rf "$work"' EXIT
# gpg would otherwise create a keyring in the caller's home (root's, on the
# orchestrator); keep everything in the work directory.
export GNUPGHOME="$work/gnupg"
mkdir -m 700 "$GNUPGHOME"

# 1. The signing key, pinned by fingerprint.
fetch "$PGDG_KEY_URL" "$work/key.asc"
got_fpr=$(gpg --show-keys --with-colons "$work/key.asc" 2>/dev/null | awk -F: '/^fpr/ {print $10; exit}')
[ "$got_fpr" = "$PGDG_FPR" ] || die "PGDG key fingerprint is '$got_fpr', want $PGDG_FPR"
gpg --dearmor <"$work/key.asc" >"$work/key.gpg"

# 2. The signed release file, and the index hash it vouches for.
fetch "$base/dists/$suite/InRelease" "$work/InRelease"
gpgv --keyring "$work/key.gpg" --output "$work/Release" "$work/InRelease" 2>"$work/gpgv.log" \
  || { cat "$work/gpgv.log" >&2; die "InRelease for $suite does not verify against the PGDG key"; }
idx="main/binary-$arch/Packages.gz"
idx_sha=$(awk -v f="$idx" '/^SHA256:/ {s = 1; next} /^[^ ]/ {s = 0} s && $3 == f {print $1; exit}' "$work/Release")
[ -n "$idx_sha" ] || die "the signed release has no SHA256 for $idx"
fetch "$base/dists/$suite/$idx" "$work/Packages.gz"
echo "$idx_sha  $work/Packages.gz" | sha256sum -c --quiet - || die "Packages.gz does not match the signed release"
gunzip -c "$work/Packages.gz" >"$work/Packages"

# 3. Each package, by the index's SHA256, from the pool only.
pick() {
  awk -v p="$1" '
    /^Package: / { pkg = $2 }
    /^Version: / { ver = $2 }
    /^Filename: / { file = $2 }
    /^SHA256: / { sha = $2 }
    /^$/ { if (pkg == p) print ver, file, sha; pkg = "" }
    END { if (pkg == p) print ver, file, sha }' "$work/Packages" | sort -V | tail -n1
}
pkgs=(libpq5 "postgresql-client-$major")
[ -n "$want_server" ] && pkgs+=("postgresql-$major")
for p in "${pkgs[@]}"; do
  ver='' file='' sha=''
  read -r ver file sha < <(pick "$p") || true
  [ -n "$file" ] || die "$p is not in the PGDG index for $suite/$arch"
  case $file in pool/*) ;; *) die "$p: unexpected path '$file'" ;; esac
  case $file in *..*) die "$p: unexpected path '$file'" ;; esac
  deb="$work/$(basename "$file")"
  fetch "$base/$file" "$deb"
  echo "$sha  $deb" | sha256sum -c --quiet - || die "checksum mismatch for $p $ver"
  dpkg-deb -x "$deb" "$dest/root"
done
[ -x "$bin/$need" ] || die "$bin/$need missing after unpacking"
printf '%s\n' "$bin"
