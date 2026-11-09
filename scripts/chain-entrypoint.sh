#!/bin/sh
# Elyon Chain container entrypoint.
#
# v7.8-no-ssl: Caddy and the setcap dance are gone. This script now just:
#   1. Makes sure /data is writable by uid 1001 (unp) — needed when a
#      fresh named volume gets created at first boot, or when previous
#      rescue runs left root-owned files behind.
#   2. Drops privileges to the unp user and exec's the Node.js dashboard.
#
# The dashboard listens on :3000 (HTTP) and :8545 (JSON-RPC proxy). TLS
# is the operator's responsibility — front this container with nginx,
# cloud load balancer, etc.
set -eu

if [ -d /data ]; then
  chown -R 1001:1001 /data 2>/dev/null || true
fi

cd /dashboard
exec /usr/sbin/runuser -u unp -- node server.js
