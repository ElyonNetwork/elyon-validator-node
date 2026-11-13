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
