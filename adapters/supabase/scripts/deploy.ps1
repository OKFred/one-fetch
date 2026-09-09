param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9]{20}$')][string]$ProjectRef,
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [Parameter(Mandatory = $true)][string]$ExpectedCurrentBuild,
  [string]$StateFile,
  [string]$ServiceRoleKeyFile,
  [string]$DatabasePasswordFile,
  [string]$AdminTokenFile,
  [switch]$Apply,
  [switch]$Resume
)

$ErrorActionPreference = 'Stop'
$Arguments = @(
  (Join-Path $PSScriptRoot 'deploy-release.mjs'),
  '--project-ref', $ProjectRef,
  '--env-file', (Resolve-Path -LiteralPath $EnvFile).Path,
  '--expected-current-build', $ExpectedCurrentBuild
)
if ($StateFile) { $Arguments += @('--state-file', $StateFile) }
if ($ServiceRoleKeyFile) { $Arguments += @('--service-role-key-file', (Resolve-Path -LiteralPath $ServiceRoleKeyFile).Path) }
if ($DatabasePasswordFile) { $Arguments += @('--db-password-file', (Resolve-Path -LiteralPath $DatabasePasswordFile).Path) }
if ($AdminTokenFile) { $Arguments += @('--admin-token-file', (Resolve-Path -LiteralPath $AdminTokenFile).Path) }
if ($Apply) { $Arguments += '--apply' }
if ($Resume) { $Arguments += '--resume' }

& node @Arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
