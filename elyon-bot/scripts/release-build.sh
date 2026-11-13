#!/usr/bin/env sh
# Reproducible release build: runs scripts/build.sh in the official Go container, so the toolchain and every path
# are the same on every machine (Linux, macOS or Windows with Docker) and dist/SHA256SUMS matches the published one
# byte for byte. Works in a git checkout of a release tag and in the unpacked source archive.
# Usage: scripts/release-build.sh
set -eu
cd "$(dirname "$0")/.."
IMAGE=golang:1.27.4-alpine
if [ -f RELEASE ]; then
  COMMIT="$(sed -n 's/^commit=//p' RELEASE)"; DATE="$(sed -n 's/^date=//p' RELEASE)"
else
  COMMIT="$(git rev-parse --short=12 HEAD)"; DATE="$(git log -1 --format=%cI)"
fi
echo "release build of commit $COMMIT ($DATE) in $IMAGE"
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e GOCACHE=/tmp/go-build \
  -e ELYON_COMMIT="$COMMIT" -e ELYON_DATE="$DATE" -v "$PWD:/src" -w /src "$IMAGE" sh scripts/build.sh
