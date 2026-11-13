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
