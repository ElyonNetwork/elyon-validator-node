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
