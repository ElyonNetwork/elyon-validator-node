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
