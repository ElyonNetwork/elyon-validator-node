#!/usr/bin/env sh
# Reproducible release build: static binaries (CGO disabled, paths trimmed, no build id) for every supported
# platform, plus SHA256SUMS. Usage: scripts/build.sh [version]   (default: the VERSION file)
set -eu
cd "$(dirname "$0")/.."
VERSION="${1:-$(cat VERSION)}"
COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
DATE="$(git log -1 --format=%cI 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
PKG=github.com/elyon-chain/elyon-bot/internal/version
LDFLAGS="-s -w -buildid= -X $PKG.Version=$VERSION -X $PKG.Commit=$COMMIT -X $PKG.Date=$DATE"
rm -rf dist && mkdir -p dist
for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64; do
  os=${target%/*}; arch=${target#*/}
  name="elyon-$VERSION-$os-$arch"
  [ "$os" = windows ] && name="$name.exe"
  echo "building dist/$name"
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "$LDFLAGS" -o "dist/$name" ./cmd/elyon
done
cd dist && sha256sum elyon-* > SHA256SUMS && cat SHA256SUMS
