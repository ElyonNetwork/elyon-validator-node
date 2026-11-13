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
