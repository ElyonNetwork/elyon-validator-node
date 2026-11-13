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
