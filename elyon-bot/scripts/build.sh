#!/usr/bin/env sh
# Release build: static binaries (CGO disabled, paths trimmed, no build id) for every supported platform, plus
# SHA256SUMS. Usage: scripts/build.sh [version]   (default: the VERSION file)
# Uses your local Go. For byte-identical copies of the published binaries use scripts/release-build.sh, which runs
# this script in the official Go container (same toolchain and same paths on every machine).
set -eu
cd "$(dirname "$0")/.."
VERSION="${1:-$(cat VERSION)}"
# Release metadata goes into the binary (`elyon version`): from ELYON_COMMIT/ELYON_DATE (set by
# scripts/release-build.sh), from the RELEASE file of a source archive (which has no .git), or from git.
if [ -n "${ELYON_COMMIT:-}" ]; then
  COMMIT="$ELYON_COMMIT"
  DATE="${ELYON_DATE:-unknown}"
elif [ -f RELEASE ]; then
  COMMIT="$(sed -n 's/^commit=//p' RELEASE)"
  DATE="$(sed -n 's/^date=//p' RELEASE)"
else
  COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
  DATE="$(git log -1 --format=%cI 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
PKG=github.com/elyon-chain/elyon-bot/internal/version
LDFLAGS="-s -w -buildid= -X $PKG.Version=$VERSION -X $PKG.Commit=$COMMIT -X $PKG.Date=$DATE"
rm -rf dist && mkdir -p dist
for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64; do
  os=${target%/*}; arch=${target#*/}
  name="elyon-$VERSION-$os-$arch"
  [ "$os" = windows ] && name="$name.exe"
  echo "building dist/$name"
  # -buildvcs=false: the git state is not embedded (only COMMIT/DATE above), so a git checkout and the source
  # archive build the same bytes, wherever they are unpacked.
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -buildvcs=false -ldflags "$LDFLAGS" -o "dist/$name" ./cmd/elyon
done
cd dist && sha256sum elyon-* > SHA256SUMS && cat SHA256SUMS
