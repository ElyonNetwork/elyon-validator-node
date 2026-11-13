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
