param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9]{20}$')][string]$ProjectRef,
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [Parameter(Mandatory = $true)][string]$ExpectedCurrentBuild,
  [string]$StateFile,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$Arguments = @(
  (Join-Path $PSScriptRoot 'deploy-release.mjs'),
  '--project-ref', $ProjectRef,
  '--env-file', (Resolve-Path -LiteralPath $EnvFile).Path,
  '--expected-current-build', $ExpectedCurrentBuild
)
if ($StateFile) { $Arguments += @('--state-file', $StateFile) }
if ($Apply) { $Arguments += '--apply' }

& node @Arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
