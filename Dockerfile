# elyon-bot container: the elyon client and its local API, running as an unprivileged user.
#   docker build -t elyon-bot:local .
#   docker run -it --rm -v elyon-data:/data elyon-bot:local setup          # once: create the wallet
#   docker run -it -d --name elyon -v elyon-data:/data -p 127.0.0.1:7457:7457 elyon-bot:local
#   docker attach elyon   # type the password, then detach with Ctrl+P Ctrl+Q
# See docs/install-docker.md.

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY cmd ./cmd
COPY internal ./internal
# RELEASE exists only in the source archive: it names the release commit and date, so the image gets the same
# binary as the published Linux build (same flags as scripts/build.sh).
COPY VERSION RELEASE* ./
ARG COMMIT=unknown
ARG BUILD_DATE=unknown
RUN if [ -f RELEASE ] && [ "$COMMIT" = unknown ]; then \
      COMMIT="$(sed -n 's/^commit=//p' RELEASE)"; BUILD_DATE="$(sed -n 's/^date=//p' RELEASE)"; fi \
 && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
      -ldflags "-s -w -buildid= -X github.com/elyon-chain/elyon-bot/internal/version.Version=$(cat VERSION) -X github.com/elyon-chain/elyon-bot/internal/version.Commit=${COMMIT} -X github.com/elyon-chain/elyon-bot/internal/version.Date=${BUILD_DATE}" \
      -o /out/elyon ./cmd/elyon

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -H -u 10001 -s /sbin/nologin elyon \
 && mkdir -p /data && chown elyon:elyon /data && chmod 700 /data
COPY --from=build /out/elyon /usr/local/bin/elyon
USER elyon
# Data (wallet, token, audit log) lives in the /data volume. The API listens on all interfaces of the container
# but only accepts private-network clients (Docker bridge) unless ELYON_ALLOW_IP says otherwise; publish the port
# on the host's loopback only (-p 127.0.0.1:7457:7457).
ENV ELYON_HOME=/data \
    ELYON_LISTEN=0.0.0.0:7457 \
    ELYON_ALLOW_IP=127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
VOLUME ["/data"]
EXPOSE 7457
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD wget -qO- http://127.0.0.1:7457/v1/health >/dev/null || exit 1
ENTRYPOINT ["elyon"]
CMD ["serve"]
