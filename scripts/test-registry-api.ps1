# Smoke test: Laravel Email Registry API + this app's backend registry routes. Read-only.
# Reads EMAIL_REGISTRY_API_URL / EMAIL_REGISTRY_API_TOKEN from server/.env (the token is never printed).
#   pwsh -File scripts/test-registry-api.ps1
#   pwsh -File scripts/test-registry-api.ps1 -Backend http://localhost:4000/api
param([string]$Backend = 'http://localhost:4000/api')

$envFile = Join-Path $PSScriptRoot '..\server\.env'
$vars = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*([A-Z_]+)\s*=\s*(.*)\s*$' } | ForEach-Object { $vars[$Matches[1]] = $Matches[2].Trim('"', "'") }
$Api = "$($vars['EMAIL_REGISTRY_API_URL'])".TrimEnd('/')
$Token = $vars['EMAIL_REGISTRY_API_TOKEN']
if (-not $Api -or -not $Token) { throw 'EMAIL_REGISTRY_API_URL / EMAIL_REGISTRY_API_TOKEN missing in server/.env' }
$Auth = @{ Authorization = "Bearer $Token"; Accept = 'application/json' }
$script:failed = 0

function Call($Method, $Url, $Headers = @{ Accept = 'application/json' }, $Body = $null) {
    $p = @{ Method = $Method; Uri = $Url; Headers = $Headers; SkipHttpErrorCheck = $true }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 6); $p.ContentType = 'application/json' }
    try { $r = Invoke-WebRequest @p } catch { Write-Host "      request error: $_" -ForegroundColor DarkYellow; return [pscustomobject]@{ Status = 0; Body = $null; Raw = '' } }
    $json = $null; try { $json = $r.Content | ConvertFrom-Json } catch {}
    [pscustomobject]@{ Status = [int]$r.StatusCode; Body = $json; Raw = $r.Content + ($r.Headers | Out-String) }
}
function Check($Name, [bool]$Ok, $Detail = '') {
    if ($Ok) { Write-Host "PASS  $Name" -ForegroundColor Green } else { $script:failed++; Write-Host "FAIL  $Name  $Detail" -ForegroundColor Red }
}

Write-Host "Laravel registry: $Api`nBackend:          $Backend`n"

# --- Laravel directly ---
$r = Call GET "$Api/health";                              Check 'Laravel /health (public) -> 200' ($r.Status -eq 200)
$r = Call GET "$Api/email-verifications";                 Check 'no token -> 401' ($r.Status -eq 401)
$r = Call GET "$Api/email-verifications" @{ Authorization = 'Bearer wrong'; Accept = 'application/json' }; Check 'wrong token -> 401' ($r.Status -eq 401)
$r = Call GET "$Api/health/registry" $Auth;              Check 'token from server/.env -> 200 (stats)' ($r.Status -eq 200) $r.Status
if ($r.Status -eq 200) { Write-Host "      registry total: $($r.Body.data.total)" }
$r = Call GET "$Api/email-verifications?limit=5" $Auth;  Check 'list records' ($r.Status -eq 200 -and $null -ne $r.Body.meta)
$r = Call POST "$Api/email-verifications/lookup" $Auth @{ emails = @('nobody@example.com') }
Check 'batch lookup (read-only)' ($r.Status -eq 200 -and $r.Body.data.missing -contains 'nobody@example.com')

# --- Backend (what the browser uses) ---
$responses = @()
$r = Call GET "$Backend/status"; $responses += $r.Raw
Check 'backend /status: registry connected' ($r.Body.centralDb.connected -eq $true) ($r.Body.centralDb | ConvertTo-Json -Compress)
$r = Call GET "$Backend/registry/stats"; $responses += $r.Raw;          Check 'backend /registry/stats' ($r.Status -eq 200)
$r = Call GET "$Backend/registry/records?limit=5&search=example"; $responses += $r.Raw; Check 'backend /registry/records (search)' ($r.Status -eq 200)
$r = Call POST "$Backend/registry/lookup" @{ Accept = 'application/json' } @{ emails = @('nobody@example.com') }; $responses += $r.Raw
Check 'backend /registry/lookup' ($r.Status -eq 200 -and $r.Body.summary.missing -eq 1)
Check 'token never appears in backend responses or headers' (-not ($responses -join "`n").Contains($Token))

Write-Host ''
if ($script:failed) { Write-Host "$script:failed check(s) failed" -ForegroundColor Red; exit 1 } else { Write-Host 'All checks passed' -ForegroundColor Green }
