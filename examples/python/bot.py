#!/usr/bin/env python3
"""Minimal Elyon bot in Python (standard library only).

Start the client first:  elyon serve
Then:                    ELYON_TOKEN=$(elyon api-token show) python3 bot.py
Set ELYON_TRADE=1 to really open and close a tiny position (1 wUSDT margin, 2x).
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

URL = os.environ.get("ELYON_URL", "http://127.0.0.1:7457")
TOKEN = os.environ.get("ELYON_TOKEN", "")


def call(path, body=None, method=None):
    """GET when body is None, otherwise POST JSON. Returns the parsed answer (ok, result, error...)."""
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(URL + path, data=data, method=method or ("GET" if body is None else "POST"))
    req.add_header("Authorization", "Bearer " + TOKEN)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:  # 4xx/5xx still carry the JSON answer
        return json.load(e)


def must(answer):
    if not answer["ok"]:
        err = answer["error"]
        sys.exit("elyon error %s: %s %s" % (err["code"], err["message"], err.get("hint", "")))
    return answer["result"]


if not TOKEN:
    sys.exit("Set ELYON_TOKEN (run: elyon api-token show)")

status = must(call("/v1/status"))
wallet = status.get("wallet") or {}
print("wallet", wallet.get("address"), "| ELN", wallet.get("eln"), "| wUSDT", wallet.get("wusdt"))

price = must(call("/v1/futures/price?" + urllib.parse.urlencode({"market": "BTC"})))
last = price["market"]["last"]
print("BTC last price", last)

totals = must(call("/v1/portfolio"))["totals"]
print("equity estimate", totals["total_equity_estimate_wusdt"], "wUSDT")

if os.environ.get("ELYON_TRADE") == "1":
    order = {"side": "long", "market": "BTC", "margin": "1", "leverage": 2, "stop_loss": str(round(last * 0.9))}
    opened = call("/v1/futures/open", order)
    if not opened["ok"] and opened["error"]["code"] == "QUOTE_EXPIRED":
        opened = call("/v1/futures/open", order)  # the signed price aged: one retry is enough
    pos = must(opened)
    print("opened position", pos["position_id"], "at", pos["entry_price"])
    closed = must(call("/v1/futures/close", {"id": pos["position_id"]}))
    print("closed, paid back", closed["payout"], "wUSDT")

# Several commands in one request:
batch = call("/v1/batch", {"stop_on_error": False, "commands": [
    {"command": "futures price", "params": {"market": "ETH"}},
    {"command": "spot price", "params": {"market": "BTC"}},
    {"command": "futures positions"},
]})
for step in batch["steps"]:
    print("batch step", step["index"], step["command"], "ok" if step["ok"] else step["error"]["code"])
