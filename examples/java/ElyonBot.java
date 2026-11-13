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
