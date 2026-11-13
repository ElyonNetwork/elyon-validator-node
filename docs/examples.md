# Code examples: connect your bot in any language

Your bot does not need any Elyon library. It talks to `elyon` on its own computer, and elyon does the signing, the
contract calls and the waiting. This page shows the complete code of a small, working bot in many languages, and
exactly how to run it on Windows, macOS, Linux and Docker.

**Jump to:** [Python on Windows, step by step](#step-by-step-a-python-bot-on-windows) ·
[Python](#python) · [JavaScript and Node.js](#javascript-and-nodejs) · [Go](#go) · [C# and .NET](#c-and-net) ·
[Java](#java) · [PHP](#php) · [Rust](#rust) · [Ruby](#ruby) · [PowerShell](#powershell) ·
[Windows Command Prompt](#windows-command-prompt-cmd) · [Bash, curl and jq](#bash-curl-and-jq) ·
[Command line from any language](#the-command-line-from-any-language) ·
[Aggregate commands](#aggregate-commands-batch-files) · [Docker](#run-any-example-in-docker)

## How a bot talks to elyon

| Way | Best for | How |
|---|---|---|
| **Local HTTP API** | bots that run all the time, in any language | Start `elyon serve` once. The bot sends JSON to `http://127.0.0.1:7457` with a secret token. |
| **Command line with `--json`** | scripts, scheduled jobs, any language that can start a program | The bot runs `elyon --json <command>` and reads the JSON it prints. |
| **Batch files** (aggregate commands) | several commands in one go, for example an emergency exit | `elyon run file.json`, or `POST /v1/batch` with the same JSON. |

All three run the same commands and give the same kind of answer:

```json
{"ok": true, "result": {"...": "..."}}
{"ok": false, "error": {"code": "QUOTE_EXPIRED", "message": "...", "hint": "..."}}
```

Your bot checks `ok`. When it is `false`, `error.code` says what happened in a stable code your bot can react to
(see [Patterns worth copying](#patterns-worth-copying) and the [error codes](http-api.md#error-codes)).

## Before you start: run elyon and get the token

Install elyon and create your wallet first ([Windows](install-windows.md), [macOS](install-macos.md),
[Linux](install-linux.md), [Docker](install-docker.md)). Then every example needs two things: the local API running,
and the API token in the environment variable `ELYON_TOKEN`.

### Windows (PowerShell)

```powershell
# Window 1: start the local API, type the wallet password once, and leave this window open
elyon serve

# Window 2: give the token to programs started from this window, then start your bot here
$env:ELYON_TOKEN = (elyon api-token show)
```

In the Command Prompt (cmd.exe) the second step is:
`for /f "delims=" %t in ('elyon api-token show') do set ELYON_TOKEN=%t`

### macOS and Linux

```sh
# Terminal 1: start the local API, type the wallet password once, and leave it open
elyon serve

# Terminal 2: give the token to programs started from this terminal, then start your bot here
export ELYON_TOKEN=$(elyon api-token show)
```

### Docker

```sh
export ELYON_TOKEN=$(docker exec elyon elyon api-token show 2>/dev/null)
```

A bot on the same machine uses the published port `http://127.0.0.1:7457`. A bot in its own container uses the
container name instead, see [Run any example in Docker](#run-any-example-in-docker).

The examples read `ELYON_URL` too (default `http://127.0.0.1:7457`). Set it only if you changed the address.

> **Keep the token secret.** It lets programs on this computer trade with your wallet. Sending funds out of the
> wallet also needs your password or an address you approved beforehand. Do not write the token into code you share
> or upload. Read it from `ELYON_TOKEN` or from
> elyon's token file (below). Replace it whenever you like with `elyon api-token rotate`.

### Or let the bot read the token file

elyon keeps the token in the file `api-token` in its data folder. It is readable only by your user, so a bot that
runs as you can read it directly. This is handy for scheduled tasks and services, where setting `ELYON_TOKEN` is
awkward:

| System | Token file |
|---|---|
| Windows | `%APPDATA%\Elyon\api-token` |
| macOS | `~/Library/Application Support/Elyon/api-token` |
| Linux | `~/.config/elyon/api-token` |
| Docker | `/data/api-token` inside the elyon container |

In Python:

```python
import os, pathlib, sys

def token_file():
    if sys.platform == "win32":
        return pathlib.Path(os.environ["APPDATA"]) / "Elyon" / "api-token"
    if sys.platform == "darwin":
        return pathlib.Path.home() / "Library" / "Application Support" / "Elyon" / "api-token"
    return pathlib.Path(os.environ.get("XDG_CONFIG_HOME") or pathlib.Path.home() / ".config") / "elyon" / "api-token"

TOKEN = os.environ.get("ELYON_TOKEN") or token_file().read_text().strip()
```

## What every example does

All examples do the same thing, so you can compare them line by line:

1. `GET /v1/status`: print the wallet address and its ELN and wUSDT balances.
2. `GET /v1/futures/price?market=BTC`: print the last BTC price.
3. `GET /v1/portfolio`: print the equity estimate.
4. Only when `ELYON_TRADE=1` is set: open a long BTC position (1 wUSDT margin, 2×, stop loss 10 % below), retry
   once on `QUOTE_EXPIRED`, then close it again. This is a real trade that costs a few cents in fees.
5. `POST /v1/batch`: several read-only commands in one request.

Without `ELYON_TRADE=1` they only read. When a call fails they stop and print elyon's error code and message.
Every example was run against a live elyon on ElyonChain mainnet (2026-11-13). The Command Prompt file uses the same
requests as the curl example.

## Step by step: a Python bot on Windows

The whole path for a bot written in Python on Windows. Other languages and systems work the same way. Only the
install and run commands differ, and the sections below list them.

#### 1. Install elyon and create the wallet

Follow [Install on Windows](install-windows.md) up to "Fund it". At the end, `elyon version` works in PowerShell and
your wallet holds wUSDT and a little ELN for fees ([Fund your bot wallet](funding.md)).

#### 2. Install Python

In PowerShell:

```powershell
winget install Python.Python.3.13
```

Or download it from python.org and tick **Add python.exe to PATH** in the installer. Close PowerShell, open it again
and check with `python --version` (3.8 or newer).

#### 3. Save the bot

Create the folder `C:\bots\elyon`. Open Notepad, paste the [Python code](#python) from this page, and save it as
`C:\bots\elyon\bot.py`. Choose **Save as type: All files**, otherwise Notepad saves `bot.py.txt`.

#### 4. Start elyon

In a first PowerShell window, start the local API, type your wallet password once, and leave the window open:

```powershell
elyon serve
```

To have it start by itself after a restart, see
[Start the API automatically](install-windows.md#start-the-api-automatically-optional).

#### 5. Run the bot

In a second PowerShell window:

```powershell
cd C:\bots\elyon
$env:ELYON_TOKEN = (elyon api-token show)
python bot.py
```

The output looks like this (this run used an empty test wallet, hence the zero balances):

```text
wallet 0xe60Cb95FbB1647AfB982C4f2c5D19F475fd7ebD7 | ELN 0.000000000000147 | wUSDT 0
BTC last price 68457.1
equity estimate 0.00 wUSDT
batch step 0 futures.price ok
batch step 1 spot.price ok
batch step 2 futures.positions ok
```

#### 6. Make it trade

The example only reads unless you allow it to trade. This opens a long BTC position with 1 wUSDT margin at 2× and
closes it again right away:

```powershell
$env:ELYON_TRADE = "1"; python bot.py
Remove-Item Env:ELYON_TRADE
```

#### 7. Write your own strategy

Keep the `call` and `must` functions and replace the middle part with your logic. `call("/v1/...")` reads,
`call("/v1/...", {...})` sends a command. Every command, its path and its fields are in the
[Local HTTP API](http-api.md) reference and in `elyon commands`. For example:

```python
must(call("/v1/spot/buy", {"market": "ETH", "spend": "25"}))

eth = must(call("/v1/futures/price?market=ETH"))["market"]["last"]
must(call("/v1/futures/open", {"side": "short", "market": "ETH", "margin": "10", "leverage": 5,
                               "take_profit": str(round(eth * 0.95)), "stop_loss": str(round(eth * 1.03))}))

for p in must(call("/v1/futures/positions"))["positions"]:
    print(p["id"], p["market"], p["side"], p["unrealized_pnl"])
```

#### 8. Run it on a schedule

Use the Windows **Task Scheduler**: create a task, action **Start a program**, program: the path that
`(Get-Command python).Source` prints, arguments: `bot.py`, start in: `C:\bots\elyon`. Let the bot
[read the token file](#or-let-the-bot-read-the-token-file) so the task does not need `ELYON_TOKEN`. `elyon serve`
must be running.

## Python

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install Python.Python.3.13` | `brew install python` | `sudo apt install python3` |
| Run | `python bot.py` | `python3 bot.py` | `python3 bot.py` |

Python 3.8 or newer, standard library only (no `pip install`).

`examples/python/bot.py`

```python
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
```

## JavaScript and Node.js

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install OpenJS.NodeJS.LTS` | `brew install node` | from nodejs.org (distribution packages are often too old) |
| Run | `node bot.mjs` | `node bot.mjs` | `node bot.mjs` |

Node.js 18 or newer (built-in `fetch`, no `npm install`).

`examples/node/bot.mjs`

```javascript
// Minimal Elyon bot in Node.js 18+ (built-in fetch, no packages).
// Start the client first:  elyon serve
// Then:                    ELYON_TOKEN=$(elyon api-token show) node bot.mjs
// Set ELYON_TRADE=1 to really open and close a tiny position (1 wUSDT margin, 2x).
const URL = process.env.ELYON_URL ?? "http://127.0.0.1:7457";
const TOKEN = process.env.ELYON_TOKEN ?? "";
if (!TOKEN) { console.error("Set ELYON_TOKEN (run: elyon api-token show)"); process.exit(1); }

async function call(path, body) {
  const res = await fetch(URL + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json(); // errors also answer with JSON: { ok: false, error: { code, message, hint } }
}
function must(answer) {
  if (!answer.ok) throw new Error(`elyon error ${answer.error.code}: ${answer.error.message} ${answer.error.hint ?? ""}`);
  return answer.result;
}

const status = must(await call("/v1/status"));
console.log("wallet", status.wallet?.address, "| ELN", status.wallet?.eln, "| wUSDT", status.wallet?.wusdt);
const price = must(await call("/v1/futures/price?market=BTC"));
const last = price.market.last;
console.log("BTC last price", last);
console.log("equity estimate", must(await call("/v1/portfolio")).totals.total_equity_estimate_wusdt, "wUSDT");

if (process.env.ELYON_TRADE === "1") {
  const order = { side: "long", market: "BTC", margin: "1", leverage: 2, stop_loss: String(Math.round(last * 0.9)) };
  let opened = await call("/v1/futures/open", order);
  if (!opened.ok && opened.error.code === "QUOTE_EXPIRED") opened = await call("/v1/futures/open", order);
  const pos = must(opened);
  console.log("opened position", pos.position_id, "at", pos.entry_price);
  const closed = must(await call("/v1/futures/close", { id: pos.position_id }));
  console.log("closed, paid back", closed.payout, "wUSDT");
}

const batch = await call("/v1/batch", { stop_on_error: false, commands: [
  { command: "futures price", params: { market: "ETH" } },
  { command: "spot price", params: { market: "BTC" } },
  { command: "futures positions" },
] });
for (const s of batch.steps) console.log("batch step", s.index, s.command, s.ok ? "ok" : s.error.code);
```

## Go

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install GoLang.Go` | `brew install go` | from go.dev/dl (distribution packages are often too old) |
| Run | `go run .` | `go run .` | `go run .` |

Go 1.22 or newer, standard library only. Put both files in one folder and run `go run .` there.

`examples/go/go.mod`

```text
module example.com/elyonbot

go 1.22
```

`examples/go/main.go`

```go
// Minimal Elyon bot in Go (standard library only).
// Start the client first:  elyon serve
// Then:                    ELYON_TOKEN=$(elyon api-token show) go run .
// Set ELYON_TRADE=1 to really open and close a tiny position (1 wUSDT margin, 2x).
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"
)

type answer struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code, Message, Hint string
	} `json:"error"`
}

var (
	base   = env("ELYON_URL", "http://127.0.0.1:7457")
	token  = os.Getenv("ELYON_TOKEN")
	client = &http.Client{Timeout: 10 * time.Minute}
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// call sends GET (body == nil) or POST JSON and decodes the answer's result into out.
func call(path string, body any, out any) (*answer, error) {
	method, rd := http.MethodGet, (*bytes.Reader)(nil)
	if body != nil {
		b, _ := json.Marshal(body)
		method, rd = http.MethodPost, bytes.NewReader(b)
	}
	var req *http.Request
	if rd != nil {
		req, _ = http.NewRequest(method, base+path, rd)
		req.Header.Set("Content-Type", "application/json")
	} else {
		req, _ = http.NewRequest(method, base+path, nil)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var a answer
	if err := json.NewDecoder(res.Body).Decode(&a); err != nil {
		return nil, err
	}
	if !a.OK {
		return &a, fmt.Errorf("elyon error %s: %s %s", a.Error.Code, a.Error.Message, a.Error.Hint)
	}
	if out != nil {
		return &a, json.Unmarshal(a.Result, out)
	}
	return &a, nil
}

func main() {
	if token == "" {
		log.Fatal("Set ELYON_TOKEN (run: elyon api-token show)")
	}
	var status struct {
		Wallet struct{ Address, ELN, WUSDT string } `json:"wallet"`
	}
	if _, err := call("/v1/status", nil, &status); err != nil {
		log.Fatal(err)
	}
	fmt.Println("wallet", status.Wallet.Address, "| ELN", status.Wallet.ELN, "| wUSDT", status.Wallet.WUSDT)

	var price struct {
		Market struct{ Last float64 } `json:"market"`
	}
	if _, err := call("/v1/futures/price?market=BTC", nil, &price); err != nil {
		log.Fatal(err)
	}
	fmt.Println("BTC last price", price.Market.Last)

	if os.Getenv("ELYON_TRADE") == "1" {
		order := map[string]any{"side": "long", "market": "BTC", "margin": "1", "leverage": 2, "stop_loss": fmt.Sprintf("%.0f", price.Market.Last*0.9)}
		var pos struct {
			PositionID uint64 `json:"position_id"`
			EntryPrice string `json:"entry_price"`
		}
		a, err := call("/v1/futures/open", order, &pos)
		if err != nil && a != nil && a.Error.Code == "QUOTE_EXPIRED" {
			_, err = call("/v1/futures/open", order, &pos)
		}
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println("opened position", pos.PositionID, "at", pos.EntryPrice)
		var closed struct{ Payout string }
		if _, err := call("/v1/futures/close", map[string]any{"id": pos.PositionID}, &closed); err != nil {
			log.Fatal(err)
		}
		fmt.Println("closed, paid back", closed.Payout, "wUSDT")
	}

	// Several commands in one request.
	req := map[string]any{"stop_on_error": false, "commands": []map[string]any{
		{"command": "futures price", "params": map[string]any{"market": "ETH"}},
		{"command": "futures positions"},
	}}
	b, _ := json.Marshal(req)
	hr, _ := http.NewRequest(http.MethodPost, base+"/v1/batch", bytes.NewReader(b))
	hr.Header.Set("Authorization", "Bearer "+token)
	hr.Header.Set("Content-Type", "application/json")
	res, err := client.Do(hr)
	if err != nil {
		log.Fatal(err)
	}
	defer res.Body.Close()
	var batch struct {
		OK    bool `json:"ok"`
		Steps []struct {
			Index   int
			Command string
			OK      bool
		} `json:"steps"`
	}
	_ = json.NewDecoder(res.Body).Decode(&batch)
	for _, s := range batch.Steps {
		fmt.Println("batch step", s.Index, s.Command, s.OK)
	}
}
```

## C# and .NET

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install Microsoft.DotNet.SDK.8` | `brew install --cask dotnet-sdk` | `sudo apt install dotnet-sdk-8.0` |
| Run | `dotnet run` | `dotnet run` | `dotnet run` |

.NET 8 or newer, no packages. Put both files in one folder and run `dotnet run` there.

`examples/csharp/ElyonBot.csproj`

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RollForward>Major</RollForward>
  </PropertyGroup>
</Project>
```

`examples/csharp/Program.cs`

```csharp
// Minimal Elyon bot in C# (.NET 8+, no packages).
// Start the client first:  elyon serve
// Then:                    ELYON_TOKEN=<token from `elyon api-token show`> dotnet run
// Set ELYON_TRADE=1 to really open and close a tiny position (1 wUSDT margin, 2x).
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

var url = Environment.GetEnvironmentVariable("ELYON_URL") ?? "http://127.0.0.1:7457";
var token = Environment.GetEnvironmentVariable("ELYON_TOKEN") ?? "";
if (token == "") { Console.Error.WriteLine("Set ELYON_TOKEN (run: elyon api-token show)"); return 1; }

var http = new HttpClient { BaseAddress = new Uri(url), Timeout = TimeSpan.FromMinutes(10) };
http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

async Task<JsonNode> Call(string path, object? body = null)
{
    HttpResponseMessage res = body is null
        ? await http.GetAsync(path)
        : await http.PostAsync(path, new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"));
    return JsonNode.Parse(await res.Content.ReadAsStringAsync())!; // errors are JSON too
}
JsonNode Must(JsonNode answer)
{
    if (answer["ok"]!.GetValue<bool>()) return answer["result"]!;
    var e = answer["error"]!;
    throw new Exception($"elyon error {e["code"]}: {e["message"]} {e["hint"]}");
}

var status = Must(await Call("/v1/status"));
Console.WriteLine($"wallet {status["wallet"]?["address"]} | ELN {status["wallet"]?["eln"]} | wUSDT {status["wallet"]?["wusdt"]}");
var last = Must(await Call("/v1/futures/price?market=BTC"))["market"]!["last"]!.GetValue<double>();
Console.WriteLine($"BTC last price {last}");
Console.WriteLine($"equity estimate {Must(await Call("/v1/portfolio"))["totals"]!["total_equity_estimate_wusdt"]} wUSDT");

if (Environment.GetEnvironmentVariable("ELYON_TRADE") == "1")
{
    var order = new Dictionary<string, object> { ["side"] = "long", ["market"] = "BTC", ["margin"] = "1", ["leverage"] = 2, ["stop_loss"] = Math.Round(last * 0.9).ToString() };
    var opened = await Call("/v1/futures/open", order);
    if (!opened["ok"]!.GetValue<bool>() && opened["error"]!["code"]!.ToString() == "QUOTE_EXPIRED") opened = await Call("/v1/futures/open", order);
    var pos = Must(opened);
    Console.WriteLine($"opened position {pos["position_id"]} at {pos["entry_price"]}");
    var closed = Must(await Call("/v1/futures/close", new { id = pos["position_id"]!.ToString() }));
    Console.WriteLine($"closed, paid back {closed["payout"]} wUSDT");
}

var batch = await Call("/v1/batch", new { stop_on_error = false, commands = new object[] {
    new { command = "futures price", @params = new { market = "ETH" } },
    new { command = "futures positions" },
} });
foreach (var s in batch["steps"]!.AsArray())
    Console.WriteLine($"batch step {s!["index"]} {s["command"]} {(s["ok"]!.GetValue<bool>() ? "ok" : s["error"]!["code"]!.ToString())}");
return 0;
```

## Java

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install EclipseAdoptium.Temurin.21.JDK` | Temurin 21 from adoptium.net | `sudo apt install openjdk-21-jdk-headless` |
| Run | `java ElyonBot.java` | `java ElyonBot.java` | `java ElyonBot.java` |

Java 11 or newer runs the single file directly, without a build step. A real bot would read the JSON with a library
such as Jackson or Gson; this example uses small helpers so it runs with a bare JDK.

`examples/java/ElyonBot.java`

```java
// Minimal Elyon bot in Java 11+ (java.net.http, no libraries).
// Start the client first:  elyon serve
// Then:                    ELYON_TOKEN=<token from `elyon api-token show`> java ElyonBot.java
// Set ELYON_TRADE=1 to really open and close a tiny position (1 wUSDT margin, 2x).
// The answers are JSON; a real bot would use a JSON library (Jackson, Gson). This example uses small regex
// helpers so it runs with a bare JDK.
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class ElyonBot {
    static final String URL = System.getenv().getOrDefault("ELYON_URL", "http://127.0.0.1:7457");
    static final String TOKEN = System.getenv().getOrDefault("ELYON_TOKEN", "");
    static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    static String call(String path, String jsonBody) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(URL + path)).timeout(Duration.ofMinutes(10))
                .header("Authorization", "Bearer " + TOKEN);
        if (jsonBody == null) b.GET();
        else b.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(jsonBody));
        return HTTP.send(b.build(), HttpResponse.BodyHandlers.ofString()).body();
    }

    static String field(String json, String name) {
        Matcher m = Pattern.compile("\"" + name + "\"\\s*:\\s*(\"[^\"]*\"|[-0-9.eE]+|true|false|null)").matcher(json);
        return m.find() ? m.group(1).replace("\"", "") : null;
    }

    static String must(String answer) {
        if (!answer.matches("(?s)\\{\\s*\"ok\":\\s*true.*")) {
            throw new RuntimeException("elyon error " + field(answer, "code") + ": " + field(answer, "message"));
        }
        return answer;
    }

    public static void main(String[] args) throws Exception {
        if (TOKEN.isEmpty()) { System.err.println("Set ELYON_TOKEN (run: elyon api-token show)"); System.exit(1); }
        String status = must(call("/v1/status", null));
        System.out.println("wallet " + field(status, "address") + " | ELN " + field(status, "eln") + " | wUSDT " + field(status, "wusdt"));
        String price = must(call("/v1/futures/price?market=BTC", null));
        double last = Double.parseDouble(field(price, "last"));
        System.out.println("BTC last price " + last);
        System.out.println("equity estimate " + field(must(call("/v1/portfolio", null)), "total_equity_estimate_wusdt") + " wUSDT");

        if ("1".equals(System.getenv("ELYON_TRADE"))) {
            String order = "{\"side\":\"long\",\"market\":\"BTC\",\"margin\":\"1\",\"leverage\":2,\"stop_loss\":\"" + Math.round(last * 0.9) + "\"}";
            String opened = call("/v1/futures/open", order);
            if ("QUOTE_EXPIRED".equals(field(opened, "code"))) opened = call("/v1/futures/open", order);
            String id = field(must(opened), "position_id");
            System.out.println("opened position " + id + " at " + field(opened, "entry_price"));
            String closed = must(call("/v1/futures/close", "{\"id\":\"" + id + "\"}"));
            System.out.println("closed, paid back " + field(closed, "payout") + " wUSDT");
        }

        String batch = call("/v1/batch", "{\"stop_on_error\":false,\"commands\":[{\"command\":\"futures price\",\"params\":{\"market\":\"ETH\"}},{\"command\":\"futures positions\"}]}");
        System.out.println("batch ok: " + field(batch, "ok"));
    }
}
```

## PHP

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install PHP.PHP.8.4` | `brew install php` | `sudo apt install php-cli php-curl` |
| Run | `php bot.php` | `php bot.php` | `php bot.php` |

PHP 8 with the curl extension. On Windows, turn it on once: `php --ini` shows PHP's folder. Copy
`php.ini-production` there to `php.ini`, and in `php.ini` remove the `;` in front of `extension_dir = "ext"` and
`extension=curl`.

`examples/php/bot.php`

```php
<?php
// Minimal Elyon bot in PHP 8 (curl extension, no packages).
// Start the client first:  elyon serve
// Then:                    ELYON_TOKEN=<token from `elyon api-token show`> php bot.php
// Set ELYON_TRADE=1 to really open and close a tiny position (1 wUSDT margin, 2x).
$url = getenv('ELYON_URL') ?: 'http://127.0.0.1:7457';
$token = getenv('ELYON_TOKEN') ?: '';
if ($token === '') { fwrite(STDERR, "Set ELYON_TOKEN (run: elyon api-token show)\n"); exit(1); }

function call(string $path, ?array $body = null): array {
    global $url, $token;
    $ch = curl_init($url . $path);
    $headers = ["Authorization: Bearer $token"];
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }
    curl_setopt_array($ch, [CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 600]);
    $raw = curl_exec($ch);
    if ($raw === false) { throw new RuntimeException('elyon daemon unreachable: ' . curl_error($ch)); }
    return json_decode($raw, true); // errors are JSON too: ['ok' => false, 'error' => [...]]
}
function must(array $answer): array {
    if (!$answer['ok']) {
        $e = $answer['error'];
        throw new RuntimeException("elyon error {$e['code']}: {$e['message']} " . ($e['hint'] ?? ''));
    }
    return $answer['result'];
}

$status = must(call('/v1/status'));
printf("wallet %s | ELN %s | wUSDT %s\n", $status['wallet']['address'] ?? '-', $status['wallet']['eln'] ?? '-', $status['wallet']['wusdt'] ?? '-');
$last = must(call('/v1/futures/price?market=BTC'))['market']['last'];
printf("BTC last price %s\n", $last);
printf("equity estimate %s wUSDT\n", must(call('/v1/portfolio'))['totals']['total_equity_estimate_wusdt']);

if (getenv('ELYON_TRADE') === '1') {
    $order = ['side' => 'long', 'market' => 'BTC', 'margin' => '1', 'leverage' => 2, 'stop_loss' => (string) round($last * 0.9)];
    $opened = call('/v1/futures/open', $order);
    if (!$opened['ok'] && $opened['error']['code'] === 'QUOTE_EXPIRED') { $opened = call('/v1/futures/open', $order); }
    $pos = must($opened);
    printf("opened position %s at %s\n", $pos['position_id'], $pos['entry_price']);
    $closed = must(call('/v1/futures/close', ['id' => (string) $pos['position_id']]));
    printf("closed, paid back %s wUSDT\n", $closed['payout']);
}

$batch = call('/v1/batch', ['stop_on_error' => false, 'commands' => [
    ['command' => 'futures price', 'params' => ['market' => 'ETH']],
    ['command' => 'futures positions'],
]]);
foreach ($batch['steps'] as $s) {
    printf("batch step %d %s %s\n", $s['index'], $s['command'], $s['ok'] ? 'ok' : $s['error']['code']);
}
```

## Rust

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install Rustlang.Rustup` | rustup.rs | rustup.rs |
| Run | `cargo run` | `cargo run` | `cargo run` |

Uses the crates `ureq` and `serde_json` (cargo downloads them on the first run). Put `Cargo.toml` in a folder and
`main.rs` in its `src` subfolder.

`examples/rust/Cargo.toml`

```toml
[package]
name = "elyon-bot-example"
version = "0.1.0"
edition = "2021"

[dependencies]
ureq = { version = "2", features = ["json"] }
serde_json = "1"
```

`examples/rust/src/main.rs`

```rust
//! Minimal Elyon bot in Rust (ureq + serde_json).
//! Start the client first:  elyon serve
//! Then:                    ELYON_TOKEN=<token from `elyon api-token show`> cargo run
//! Set ELYON_TRADE=1 to really open and close a tiny position (1 wUSDT margin, 2x).
use serde_json::{json, Value};
use std::env;

fn call(url: &str, token: &str, path: &str, body: Option<Value>) -> Value {
    let auth = format!("Bearer {token}");
    let res = match body {
        None => ureq::get(&format!("{url}{path}")).set("Authorization", &auth).call(),
        Some(b) => ureq::post(&format!("{url}{path}")).set("Authorization", &auth).send_json(b),
    };
    match res {
        Ok(r) => r.into_json().expect("JSON answer"),
        Err(ureq::Error::Status(_, r)) => r.into_json().expect("JSON error answer"), // errors are JSON too
        Err(e) => panic!("elyon daemon unreachable: {e}"),
    }
}

/// A JSON value as plain text (strings without quotes).
fn txt(v: &Value) -> String {
    v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())
}

fn must(answer: Value) -> Value {
    if answer["ok"].as_bool() != Some(true) {
        panic!("elyon error {}: {}", answer["error"]["code"], answer["error"]["message"]);
    }
    answer["result"].clone()
}

fn main() {
    let url = env::var("ELYON_URL").unwrap_or_else(|_| "http://127.0.0.1:7457".into());
    let token = env::var("ELYON_TOKEN").expect("Set ELYON_TOKEN (run: elyon api-token show)");

    let status = must(call(&url, &token, "/v1/status", None));
    println!("wallet {} | ELN {} | wUSDT {}", txt(&status["wallet"]["address"]), txt(&status["wallet"]["eln"]), txt(&status["wallet"]["wusdt"]));
    let last = must(call(&url, &token, "/v1/futures/price?market=BTC", None))["market"]["last"].as_f64().unwrap();
    println!("BTC last price {last}");
    let p = must(call(&url, &token, "/v1/portfolio", None));
    println!("equity estimate {} wUSDT", txt(&p["totals"]["total_equity_estimate_wusdt"]));

    if env::var("ELYON_TRADE").as_deref() == Ok("1") {
        let order = json!({"side": "long", "market": "BTC", "margin": "1", "leverage": 2, "stop_loss": format!("{}", (last * 0.9).round())});
        let mut opened = call(&url, &token, "/v1/futures/open", Some(order.clone()));
        if opened["error"]["code"] == "QUOTE_EXPIRED" {
            opened = call(&url, &token, "/v1/futures/open", Some(order));
        }
        let pos = must(opened);
        println!("opened position {} at {}", txt(&pos["position_id"]), txt(&pos["entry_price"]));
        let closed = must(call(&url, &token, "/v1/futures/close", Some(json!({"id": txt(&pos["position_id"])}))));
        println!("closed, paid back {} wUSDT", txt(&closed["payout"]));
    }

    let batch = call(&url, &token, "/v1/batch", Some(json!({"stop_on_error": false, "commands": [
        {"command": "futures price", "params": {"market": "ETH"}},
        {"command": "futures positions"}
    ]})));
    for s in batch["steps"].as_array().unwrap() {
        println!("batch step {} {} {}", s["index"], txt(&s["command"]), if s["ok"] == true { "ok".to_string() } else { txt(&s["error"]["code"]) });
    }
}
```

## Ruby

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install RubyInstallerTeam.Ruby.3.3` | `brew install ruby` | `sudo apt install ruby` |
| Run | `ruby bot.rb` | `ruby bot.rb` | `ruby bot.rb` |

Ruby 3, standard library only.

`examples/ruby/bot.rb`

```ruby
#!/usr/bin/env ruby
# Minimal Elyon bot in Ruby 3 (standard library only).
# Start the client first:  elyon serve
# Then:                    ELYON_TOKEN=$(elyon api-token show) ruby bot.rb
# Set ELYON_TRADE=1 to really open and close a tiny position (1 wUSDT margin, 2x).
require "json"
require "net/http"
require "uri"

URL = ENV.fetch("ELYON_URL", "http://127.0.0.1:7457")
TOKEN = ENV.fetch("ELYON_TOKEN", "")
abort "Set ELYON_TOKEN (run: elyon api-token show)" if TOKEN.empty?

# GET when body is nil, otherwise POST JSON. Errors are JSON too: {"ok": false, "error": {code, message, hint}}.
def call(path, body = nil)
  uri = URI(URL + path)
  req = body.nil? ? Net::HTTP::Get.new(uri) : Net::HTTP::Post.new(uri, "Content-Type" => "application/json")
  req["Authorization"] = "Bearer #{TOKEN}"
  req.body = JSON.generate(body) unless body.nil?
  res = Net::HTTP.start(uri.host, uri.port, read_timeout: 600) { |http| http.request(req) }
  JSON.parse(res.body)
end

def must(answer)
  return answer["result"] if answer["ok"]
  e = answer["error"]
  abort "elyon error #{e["code"]}: #{e["message"]} #{e["hint"]}"
end

status = must(call("/v1/status"))
wallet = status["wallet"] || {}
puts "wallet #{wallet["address"]} | ELN #{wallet["eln"]} | wUSDT #{wallet["wusdt"]}"
last = must(call("/v1/futures/price?market=BTC"))["market"]["last"]
puts "BTC last price #{last}"
puts "equity estimate #{must(call("/v1/portfolio"))["totals"]["total_equity_estimate_wusdt"]} wUSDT"

if ENV["ELYON_TRADE"] == "1"
  order = { side: "long", market: "BTC", margin: "1", leverage: 2, stop_loss: (last * 0.9).round.to_s }
  opened = call("/v1/futures/open", order)
  opened = call("/v1/futures/open", order) if !opened["ok"] && opened["error"]["code"] == "QUOTE_EXPIRED" # one retry is enough
  pos = must(opened)
  puts "opened position #{pos["position_id"]} at #{pos["entry_price"]}"
  closed = must(call("/v1/futures/close", { id: pos["position_id"].to_s }))
  puts "closed, paid back #{closed["payout"]} wUSDT"
end

# Several commands in one request:
batch = call("/v1/batch", { stop_on_error: false, commands: [
  { command: "futures price", params: { market: "ETH" } },
  { command: "spot price", params: { market: "BTC" } },
  { command: "futures positions" },
] })
batch["steps"].each { |s| puts "batch step #{s["index"]} #{s["command"]} #{s["ok"] ? "ok" : s["error"]["code"]}" }
```

## PowerShell

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | `winget install Microsoft.PowerShell` | `brew install --cask powershell` | see Microsoft's "Install PowerShell on Linux" |
| Run | `pwsh .\bot.ps1` | `pwsh ./bot.ps1` | `pwsh ./bot.ps1` |

Needs PowerShell 7 or newer (`pwsh`). The older Windows PowerShell 5.1 does not have `-SkipHttpErrorCheck`. If
Windows refuses to run a downloaded script, run `Unblock-File .\bot.ps1` once.

`examples/powershell/bot.ps1`

```powershell
# Minimal Elyon bot in PowerShell 7+ (Windows, macOS, Linux).
# Start the client first:  elyon serve
# Then:                    $env:ELYON_TOKEN = (elyon api-token show); ./bot.ps1
# Set $env:ELYON_TRADE = "1" to really open and close a tiny position (1 wUSDT margin, 2x).
$ErrorActionPreference = "Stop"
$Url = if ($env:ELYON_URL) { $env:ELYON_URL } else { "http://127.0.0.1:7457" }
if (-not $env:ELYON_TOKEN) { throw "Set ELYON_TOKEN (run: elyon api-token show)" }
$Headers = @{ Authorization = "Bearer $($env:ELYON_TOKEN)" }

function Invoke-Elyon([string]$Path, $Body = $null) {
    $params = @{ Uri = "$Url$Path"; Headers = $Headers; SkipHttpErrorCheck = $true; TimeoutSec = 600 }
    if ($null -ne $Body) {
        $params.Method = "Post"; $params.ContentType = "application/json"; $params.Body = ($Body | ConvertTo-Json -Depth 5)
    }
    return Invoke-RestMethod @params   # errors are JSON too: ok = $false, error = { code, message, hint }
}
function Must($Answer) {
    if (-not $Answer.ok) { throw "elyon error $($Answer.error.code): $($Answer.error.message) $($Answer.error.hint)" }
    return $Answer.result
}

$status = Must (Invoke-Elyon "/v1/status")
Write-Host "wallet $($status.wallet.address) | ELN $($status.wallet.eln) | wUSDT $($status.wallet.wusdt)"
$last = (Must (Invoke-Elyon "/v1/futures/price?market=BTC")).market.last
Write-Host "BTC last price $last"
Write-Host "equity estimate $((Must (Invoke-Elyon '/v1/portfolio')).totals.total_equity_estimate_wusdt) wUSDT"

if ($env:ELYON_TRADE -eq "1") {
    $order = @{ side = "long"; market = "BTC"; margin = "1"; leverage = 2; stop_loss = [string][math]::Round($last * 0.9) }
    $opened = Invoke-Elyon "/v1/futures/open" $order
    if (-not $opened.ok -and $opened.error.code -eq "QUOTE_EXPIRED") { $opened = Invoke-Elyon "/v1/futures/open" $order }
    $pos = Must $opened
    Write-Host "opened position $($pos.position_id) at $($pos.entry_price)"
    $closed = Must (Invoke-Elyon "/v1/futures/close" @{ id = [string]$pos.position_id })
    Write-Host "closed, paid back $($closed.payout) wUSDT"
}

$batch = Invoke-Elyon "/v1/batch" @{ stop_on_error = $false; commands = @(
    @{ command = "futures price"; params = @{ market = "ETH" } },
    @{ command = "futures positions" }
) }
foreach ($s in $batch.steps) { Write-Host "batch step $($s.index) $($s.command) $(if ($s.ok) { 'ok' } else { $s.error.code })" }
```

## Windows Command Prompt (cmd)

Nothing to install: `curl.exe` is part of Windows 10 and 11. Put the three files in one folder and run `bot.cmd`.
Reading values out of the JSON answers is clumsy in cmd, so this example only reads. For a bot that makes decisions,
use PowerShell or one of the languages above.

`examples/windows-cmd/bot.cmd`

```bat
@echo off
rem Minimal Elyon bot for the Windows Command Prompt (curl.exe is built into Windows 10 and 11). Read-only.
rem Start the client first, in another window:  elyon serve
rem Then run this file:                          bot.cmd
setlocal
if not defined ELYON_URL set "ELYON_URL=http://127.0.0.1:7457"
if not defined ELYON_TOKEN for /f "delims=" %%t in ('elyon api-token show 2^>nul') do set "ELYON_TOKEN=%%t"
if not defined ELYON_TOKEN (echo Could not read the API token. Is elyon installed and the wallet created?& exit /b 1)

echo --- status
curl.exe -s "%ELYON_URL%/v1/status" -H "Authorization: Bearer %ELYON_TOKEN%"
echo.
echo --- BTC futures price
curl.exe -s "%ELYON_URL%/v1/futures/price?market=BTC" -H "Authorization: Bearer %ELYON_TOKEN%"
echo.
echo --- several read-only commands in one request (the JSON body comes from a file: no quoting problems)
curl.exe -s -X POST "%ELYON_URL%/v1/batch" -H "Authorization: Bearer %ELYON_TOKEN%" -H "Content-Type: application/json" --data-binary "@%~dp0read-only.json"
echo.
echo --- the same kind of answer without HTTP: the elyon command line with --json
elyon --json futures positions

rem To trade, keep each order in a small JSON file and POST it the same way, for example order.json:
rem   curl.exe -s -X POST "%ELYON_URL%/v1/futures/open" -H "Authorization: Bearer %ELYON_TOKEN%" -H "Content-Type: application/json" --data-binary "@%~dp0order.json"
rem or use the command line:   elyon futures open long BTC --margin 1 --leverage 2 --stop-loss 60000
rem and close that position with the id from the answer:   elyon futures close <id>
endlocal
```

`examples/windows-cmd/read-only.json`

```json
{
  "stop_on_error": false,
  "commands": [
    {"command": "futures price", "params": {"market": "ETH"}},
    {"command": "spot price", "params": {"market": "BTC"}},
    {"command": "futures positions"},
    {"command": "wallet balance"}
  ]
}
```

`examples/windows-cmd/order.json`

```json
{"side": "long", "market": "BTC", "margin": "1", "leverage": 2, "stop_loss": "60000"}
```

## Bash, curl and jq

| | Windows | macOS | Linux |
|---|---|---|---|
| Install | use Git Bash or WSL (or the PowerShell example) | `brew install jq` | `sudo apt install curl jq` |
| Run | `bash bot.sh` | `bash bot.sh` | `bash bot.sh` |

`examples/curl/bot.sh`

```bash
#!/usr/bin/env bash
# Minimal Elyon bot with curl (+ jq for reading the JSON answers).
# Start the client first:  elyon serve
# Then:                    ELYON_TOKEN=$(elyon api-token show) ./bot.sh
# Set ELYON_TRADE=1 to really open and close a tiny position (1 wUSDT margin, 2x).
set -euo pipefail
URL="${ELYON_URL:-http://127.0.0.1:7457}"
: "${ELYON_TOKEN:?Set ELYON_TOKEN (run: elyon api-token show)}"

get()  { curl -sS "$URL$1" -H "Authorization: Bearer $ELYON_TOKEN"; }
post() { curl -sS -X POST "$URL$1" -H "Authorization: Bearer $ELYON_TOKEN" -H "Content-Type: application/json" -d "$2"; }
must() { # prints .result, or the error and exits
  local a; a=$(cat)
  if [ "$(jq -r .ok <<<"$a")" != "true" ]; then jq -r '"elyon error \(.error.code): \(.error.message) \(.error.hint // "")"' <<<"$a" >&2; exit 1; fi
  jq .result <<<"$a"
}

get /v1/status | must | jq -r '"wallet \(.wallet.address) | ELN \(.wallet.eln) | wUSDT \(.wallet.wusdt)"'
LAST=$(get "/v1/futures/price?market=BTC" | must | jq -r .market.last)
echo "BTC last price $LAST"
get /v1/portfolio | must | jq -r '"equity estimate \(.totals.total_equity_estimate_wusdt) wUSDT"'

if [ "${ELYON_TRADE:-}" = "1" ]; then
  SL=$(awk -v p="$LAST" 'BEGIN { printf "%d", p * 0.9 }')
  POS=$(post /v1/futures/open "{\"side\":\"long\",\"market\":\"BTC\",\"margin\":\"1\",\"leverage\":2,\"stop_loss\":\"$SL\"}" | must)
  ID=$(jq -r .position_id <<<"$POS")
  echo "opened position $ID at $(jq -r .entry_price <<<"$POS")"
  post /v1/futures/close "{\"id\":\"$ID\"}" | must | jq -r '"closed, paid back \(.payout) wUSDT"'
fi

# Several commands in one request:
post /v1/batch '{"stop_on_error":false,"commands":[{"command":"futures price","params":{"market":"ETH"}},{"command":"futures positions"}]}' \
  | jq -r '.steps[] | "batch step \(.index) \(.command) \(if .ok then "ok" else .error.code end)"'
```

## The command line from any language

Any language that can start a program can use elyon without HTTP: run `elyon --json <command>`, read standard
output, and check the exit code (0 means ok). While `elyon serve` runs, commands that sign are carried out by it, so
no password prompt appears. Without `elyon serve`, signing commands ask for the password in the terminal, which a bot
cannot answer.

Python:

```python
import json, subprocess

def elyon(*args):
    out = subprocess.run(["elyon", "--json", *args], capture_output=True, text=True)
    return json.loads(out.stdout)

answer = elyon("futures", "price", "BTC")
print(answer["result"]["market"]["last"] if answer["ok"] else answer["error"]["code"])
```

Node.js:

```javascript
import { spawnSync } from "node:child_process";

const elyon = (...args) => JSON.parse(spawnSync("elyon", ["--json", ...args], { encoding: "utf8" }).stdout);

const answer = elyon("futures", "price", "BTC");
console.log(answer.ok ? answer.result.market.last : answer.error.code);
```

PowerShell:

```powershell
$answer = elyon --json futures positions | ConvertFrom-Json
if ($answer.ok) { $answer.result.positions } else { $answer.error.code }
```

The command line takes the same commands as the API, written as words: `elyon --json futures open long BTC
--margin 10 --leverage 5 --stop-loss 60000`. The [command reference](commands.md) lists all of them.

## Aggregate commands (batch files)

A batch runs several commands in order and returns one result per step. elyon carries out the steps itself, on your
computer. Your bot sends one request, or you run one command. With `"stop_on_error": true` (the default) it stops at
the first failed step and skips the rest. With `false` it tries every step.

Run a batch file from the command line, or send the same JSON to the API:

```sh
elyon run open-and-protect.json
elyon run - < open-and-protect.json          # from standard input
curl -s -X POST http://127.0.0.1:7457/v1/batch -H "Authorization: Bearer $ELYON_TOKEN" \
  -H "Content-Type: application/json" --data-binary @open-and-protect.json
```

Emergency exit: cancel every limit order, close every position, then show what is left.

`examples/batch/emergency-exit.json`

```json
{
  "stop_on_error": false,
  "commands": [
    {"command": "futures cancel-all"},
    {"command": "futures close-all"},
    {"command": "portfolio"}
  ]
}
```

Open a protected position: check the price, open with take profit and stop loss, list the positions.

`examples/batch/open-and-protect.json`

```json
{
  "stop_on_error": true,
  "commands": [
    {"command": "futures price", "params": {"market": "BTC"}},
    {"command": "futures open", "params": {"side": "long", "market": "BTC", "margin": "10", "leverage": 5, "take_profit": "80000", "stop_loss": "62000"}},
    {"command": "futures positions"}
  ]
}
```

Rebalance spot: sell all ETH, buy BTC for 50 wUSDT, show the balances.

`examples/batch/rebalance-spot.json`

```json
{
  "stop_on_error": true,
  "commands": [
    {"command": "spot sell", "params": {"amount": "all", "market": "ETH"}},
    {"command": "spot buy", "params": {"market": "BTC", "spend": "50", "slippage": "0.5"}},
    {"command": "wallet balance"}
  ]
}
```

Every command can be a step, with the same fields as its API request in `params`. The
[Local HTTP API](http-api.md) reference has the full batch format and the combined commands `portfolio`,
`futures close-all` and `futures cancel-all`.

## Run any example in Docker

When elyon runs in a container ([Install with Docker](install-docker.md)), a bot in another container reaches it
by the container name over a shared Docker network. Requests from private networks are allowed, and the token is
still required:

```sh
docker network create elyon-net                 # once
docker network connect elyon-net elyon          # the elyon container joins it
export ELYON_TOKEN=$(docker exec elyon elyon api-token show 2>/dev/null)

# run the Python example from the current folder in its own container
docker run --rm --network elyon-net -e ELYON_URL=http://elyon:7457 -e ELYON_TOKEN \
  -v "$PWD":/bot -w /bot python:3-slim python bot.py
```

`-e ELYON_TOKEN` without a value passes the variable on without writing the token into the command. The same
works for every language with its official image:

| Language | Image | Command |
|---|---|---|
| Python | `python:3-slim` | `python bot.py` |
| Node.js | `node:lts-slim` | `node bot.mjs` |
| Go | `golang:1` | `go run .` |
| C# | `mcr.microsoft.com/dotnet/sdk:8.0` | `dotnet run` |
| Java | `eclipse-temurin:21-jdk` | `java ElyonBot.java` |
| PHP | `php:8-cli` | `php bot.php` |
| Rust | `rust:1` | `cargo run` |
| Ruby | `ruby:3-slim` | `ruby bot.rb` |
| PowerShell | `mcr.microsoft.com/powershell` | `pwsh ./bot.ps1` |

In Docker Compose, put the bot next to elyon and set `ELYON_URL: http://elyon:7457`. The
[Docker guide](install-docker.md) has a complete `docker-compose.yml`.

## Patterns worth copying

**Retry only what is safe to retry.** `QUOTE_EXPIRED`, `PRICE_FEED_UNAVAILABLE`, `POOL_NOT_READY`, `PRICE_MOVED`,
`RPC_UNAVAILABLE`, `DEX_API_UNAVAILABLE` and `RATE_LIMITED` mean nothing was executed: retry after a short pause.
On `TRANSACTION_PENDING`, check the hash with `GET /v1/tx?hash=...` before sending again.

**Send amounts as strings.** Send `"margin": "10.5"` rather than `10.5`. elyon reads decimals exactly.

**Protect every position.** Open with `stop_loss` (and `take_profit`) in the same call, or use
`"risk": "5", "stop_loss": "..."` to let elyon size the position so a stop-out loses about 5 wUSDT.

**Keep one emergency exit ready.** The `emergency-exit.json` batch above cancels all orders and closes all positions
in one call.

**One wallet, one elyon.** Several bots can share one running elyon. Do not run two elyon instances with the same
wallet at the same time (`NONCE_CONFLICT`).

**Test small.** A bot does exactly what it is told. Start with the minimum margin of 1 wUSDT.

## Other languages

Any language that can send an HTTP request or start a program works the same way: Kotlin, Swift, Dart, Lua, R,
Perl, Excel VBA and others. Three rules:

1. Send `Authorization: Bearer <token>` with every request to `http://127.0.0.1:7457`.
2. Read with `GET` and query parameters, and act with `POST` and a JSON body (`Content-Type: application/json`).
3. Check `ok` in the answer. When it is `false`, use `error.code`.

The [Local HTTP API](http-api.md) reference lists every path and field, and `elyon commands --json` prints the same
list for programs.
