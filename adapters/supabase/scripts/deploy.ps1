param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9]{20}$')][string]$ProjectRef,
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$AdapterRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ResolvedEnv = (Resolve-Path -LiteralPath $EnvFile).Path
if (-not $Apply) {
  Write-Host 'Dry run only. Re-run with -Apply to link, migrate, set secrets, and deploy both functions.'
  Write-Host "Project: $ProjectRef"
  Write-Host "Secrets file: $ResolvedEnv"
  exit 0
}

Push-Location $AdapterRoot
try {
  pnpm exec supabase link --project-ref $ProjectRef
  if ($LASTEXITCODE -ne 0) { throw 'supabase link failed' }
  pnpm exec supabase db push --include-all
  if ($LASTEXITCODE -ne 0) { throw 'supabase db push failed' }
  pnpm exec supabase secrets set --env-file $ResolvedEnv
  if ($LASTEXITCODE -ne 0) { throw 'supabase secrets set failed' }
  pnpm exec supabase functions deploy one-fetch-control --no-verify-jwt
  if ($LASTEXITCODE -ne 0) { throw 'control deployment failed' }
  pnpm exec supabase functions deploy one-fetch-gateway --no-verify-jwt
  if ($LASTEXITCODE -ne 0) { throw 'gateway deployment failed' }
} finally {
  Pop-Location
}
