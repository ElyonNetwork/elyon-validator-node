#!/usr/bin/env bash
# Sets up an Elyon Chain node on this machine with Docker.
#
#   sudo bash scripts/setup-node.sh --image <image> [options]
#
# Required:
#   --image NAME            Node image to run, e.g. one built from this repository with
#                           `docker build -f Dockerfile.aposunpchain -t elyon-node:local .`
# Options:
#   --admin-url URL         Network entry point (default https://mainnet.elyon.network)
#   --public-ip IP          This machine's public address, advertised to peers (detected if omitted)
#   --data-dir DIR          Where the chain data lives (default /opt/elyon/data)
#   --name NAME             Container name (default elyon-node)
#   --p2p-port PORT         Published devp2p port (default 30303)
#   --validator-key-file F  File holding the validator's private key (hex). Without it the
#                           node runs as a full node and never signs blocks.
#   --node-key-file F       File holding a 32-byte hex P2P key, to keep a fixed enode
#   --static-peers LIST     Comma-separated enode URLs of other nodes to stay connected to
#   --expose-rpc            Publish JSON-RPC on 8545 to the network. By default the RPC port and
#                           the dashboard are bound to 127.0.0.1 only
set -euo pipefail

ADMIN_URL=https://mainnet.elyon.network
IMAGE=""
PUBLIC_IP=""
DATA_DIR=/opt/elyon/data
NAME=elyon-node
P2P_PORT=30303
KEY_FILE=""
NODE_KEY_FILE=""
STATIC_PEERS=""
EXPOSE_RPC=false

while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE=$2; shift 2 ;;
    --admin-url) ADMIN_URL=$2; shift 2 ;;
    --public-ip) PUBLIC_IP=$2; shift 2 ;;
    --data-dir) DATA_DIR=$2; shift 2 ;;
    --name) NAME=$2; shift 2 ;;
    --p2p-port) P2P_PORT=$2; shift 2 ;;
    --validator-key-file) KEY_FILE=$2; shift 2 ;;
    --node-key-file) NODE_KEY_FILE=$2; shift 2 ;;
    --static-peers) STATIC_PEERS=$2; shift 2 ;;
    --expose-rpc) EXPOSE_RPC=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$IMAGE" ] || { echo "--image is required" >&2; exit 2; }
command -v docker >/dev/null || { echo "Docker is not installed" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
[ -n "$PUBLIC_IP" ] || PUBLIC_IP=$(curl -fsS https://api.ipify.org)
mkdir -p "$DATA_DIR"

echo "Reading network settings from $ADMIN_URL ..."
BOOT=$(mktemp)
curl -fsS "$ADMIN_URL/api/wizard/bootstrap" -o "$BOOT"

# The node only signs blocks when its config names the address that belongs to the key.
VALIDATOR_ADDRESS=""
if [ -n "$KEY_FILE" ]; then
  VALIDATOR_ADDRESS=$(docker run --rm -i --entrypoint node "$IMAGE" -e "
    const { Web3 } = require('/dashboard/node_modules/web3');
    let k = '';
    process.stdin.on('data', d => k += d).on('end', () => {
      k = k.trim();
      console.log(new Web3().eth.accounts.privateKeyToAccount(k.startsWith('0x') ? k : '0x' + k).address);
    });" < "$KEY_FILE")
  case "$VALIDATOR_ADDRESS" in
    0x*) echo "Validator address: $VALIDATOR_ADDRESS" ;;
    *) echo "Could not derive the validator address from the key file" >&2; exit 1 ;;
  esac
fi

ADMIN_URL="$ADMIN_URL" DATA_DIR="$DATA_DIR" KEY_FILE="$KEY_FILE" BOOT="$BOOT" VALIDATOR_ADDRESS="$VALIDATOR_ADDRESS" python3 - <<'PY'
import json, os
boot = json.load(open(os.environ["BOOT"]))
data = os.environ["DATA_DIR"]
spec = boot["chainspec"]
cfg = {
    "mode": "node",
    "role": "operator",
    "nodeLabel": "Elyon Node",
    "chainName": spec.get("name", "Elyon Chain"),
    "chainId": boot["chainId"],
    "blockPeriod": boot.get("blockPeriod", 2),
    "networkType": "mainnet",
    "adminEnode": boot["adminEnode"],
    "adminBootstrapUrl": os.environ["ADMIN_URL"],
    "stakingContract": boot.get("stakingContract"),
    "aposRegistry": boot.get("aposRegistry"),
    "minGasPriceWei": boot.get("minGasPriceWei"),
    "validatorMinStakeWei": boot.get("validatorMinStakeWei"),
}
key_file = os.environ["KEY_FILE"]
if key_file:
    key = open(key_file).read().strip()
    key = key if key.startswith("0x") else "0x" + key
    if len(key) != 66:
        raise SystemExit("The validator key must be 32 bytes of hex")
    cfg["validatorKey"] = key   # the dashboard encrypts this on its first save
    cfg["validatorAddress"] = os.environ["VALIDATOR_ADDRESS"]
with open(os.path.join(data, "chainspec.json"), "w") as f:
    json.dump(spec, f, indent=2)
path = os.path.join(data, "wizard-config.json")
with open(path, "w") as f:
    json.dump(cfg, f, indent=1)
os.chmod(path, 0o600)
print("Network:", cfg["chainName"], "chain id", cfg["chainId"])
print("Bootstrap peer:", cfg["adminEnode"])
PY
rm -f "$BOOT"

if [ -n "$NODE_KEY_FILE" ]; then
  install -m 600 "$NODE_KEY_FILE" "$DATA_DIR/node-p2p.key"
fi

RPC_BIND=127.0.0.1
$EXPOSE_RPC && RPC_BIND=0.0.0.0

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  --log-opt max-size=50m --log-opt max-file=3 \
  -v "$DATA_DIR":/data \
  -p "$P2P_PORT":"$P2P_PORT"/tcp -p "$P2P_PORT":"$P2P_PORT"/udp \
  -p "$RPC_BIND":8545:8545 -p 127.0.0.1:3000:3000 \
  -e NODE_ROLE=operator \
  -e P2P_PORT="$P2P_PORT" \
  -e PUBLIC_HOST="$PUBLIC_IP" \
  -e ADMIN_URL="$ADMIN_URL" \
  -e STATIC_PEERS="$STATIC_PEERS" \
  "$IMAGE"

echo
echo "Node started. Follow it with:"
echo "  docker logs -f $NAME"
echo "Current block (full sync from genesis takes several hours):"
echo "  curl -s -X POST -H 'content-type: application/json' --data '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}' http://127.0.0.1:8545"
