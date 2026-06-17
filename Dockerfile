# =============================================================================
# Elyon Chain — VALIDATOR NODE image (validator-only distribution)
#
# This image runs ONLY a validator (operator) node. It contains nothing about
# the admin node:
#   * NO /admin (or /setup) route, NO admin wizard page.
#   * NO admin API endpoints (approve/reject validators, set tiers, create or
#     convert a chain, deploy/manage the registry, withdraw admin fees, faucet).
#     They are hard-disabled at the router (return 404) AND the UI is removed.
#   * NO faucet service.
#   * The validator panel (/manager) has no admin tabs.
#
# It DOES include everything a validator needs: join an existing Elyon chain,
# apply/stake as a validator, publish delegator packages, manage the pool,
# claim fee earnings, run PoS staking, send ELN, and the block explorer.
#
# The chain engine (patched Nethermind + APOS consensus) and the Node runtime
# come from the published base image; only the dashboard is replaced with the
# validator-only build shipped in this folder.
#
# Build:
#   docker build -t elyonchain/validatornode:latest .
#
# Run (join an existing chain whose admin node is at http://<ADMIN_IP>:3000):
#   docker run -d --name elyon-validator --restart unless-stopped \
#     -p 3000:3000 -p 8545:8545 -p 30303:30303 \
#     -v elyon-validator-data:/data \
#     -e ADMIN_URL=http://<ADMIN_IP>:3000 \
#     elyonchain/validatornode:latest
#   open http://localhost:3000   # lands on /manager (the validator panel)
# =============================================================================
FROM elyonchain/node:latest

# Replace the bundled dashboard with the validator-only build. node_modules from
# the base image is preserved (same package.json — no new dependencies added),
# so no reinstall is needed and the admin dashboard files are physically gone.
RUN find /dashboard -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
COPY dashboard/ /dashboard/

# This image can NEVER be an admin node.
ENV NODE_ROLE=operator \
    NODE_LABEL="Elyon Validator Node"

LABEL org.opencontainers.image.title="Elyon Validator Node" \
      org.opencontainers.image.description="Validator-only Elyon Chain node (no admin)."

EXPOSE 3000 8545 30303 30303/udp
