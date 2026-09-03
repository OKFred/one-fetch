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
  pnpm run predeploy
  if ($LASTEXITCODE -ne 0) { throw 'deployment preflight failed' }
  $BuildId = (& node scripts/build-id.mjs --project-ref $ProjectRef --env-file $ResolvedEnv).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $BuildId) { throw 'build ID generation failed' }
  pnpm exec supabase link --project-ref $ProjectRef
  if ($LASTEXITCODE -ne 0) { throw 'supabase link failed' }
  pnpm exec supabase db push --include-all
  if ($LASTEXITCODE -ne 0) { throw 'supabase db push failed' }
  pnpm exec supabase secrets set --project-ref $ProjectRef --env-file $ResolvedEnv
  if ($LASTEXITCODE -ne 0) { throw 'supabase secrets set failed' }
  pnpm exec supabase functions deploy one-fetch-control --project-ref $ProjectRef --no-verify-jwt
  if ($LASTEXITCODE -ne 0) { throw 'control deployment failed' }
  pnpm exec supabase functions deploy one-fetch-gateway --project-ref $ProjectRef --no-verify-jwt
  if ($LASTEXITCODE -ne 0) { throw 'gateway deployment failed' }
  pnpm exec supabase secrets set --project-ref $ProjectRef "ONE_FETCH_BUILD_VERSION=$BuildId"
  if ($LASTEXITCODE -ne 0) { throw 'build ID injection failed' }
  node scripts/verify-deployment.mjs --project-ref $ProjectRef --env-file $ResolvedEnv --build-id $BuildId
  if ($LASTEXITCODE -ne 0) { throw 'post-deployment verification failed' }
} finally {
  Pop-Location
}
