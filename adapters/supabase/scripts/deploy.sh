#!/usr/bin/env bash
set -euo pipefail

project_ref=""
env_file=""
apply="false"
while (($#)); do
  case "$1" in
    --project-ref) project_ref="${2:-}"; shift 2 ;;
    --env-file) env_file="${2:-}"; shift 2 ;;
    --apply) apply="true"; shift ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ "$project_ref" =~ ^[a-z0-9]{20}$ ]] || { printf 'A 20-character --project-ref is required.\n' >&2; exit 2; }
[[ -f "$env_file" ]] || { printf 'A readable --env-file is required.\n' >&2; exit 2; }
if [[ "$apply" != "true" ]]; then
  printf 'Dry run only. Re-run with --apply to link, migrate, set secrets, and deploy both functions.\n'
  exit 0
fi

adapter_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$adapter_root"
pnpm run predeploy
build_id="$(node scripts/build-id.mjs --project-ref "$project_ref" --env-file "$env_file")"
pnpm exec supabase link --project-ref "$project_ref"
pnpm exec supabase db push --include-all
pnpm exec supabase secrets set --project-ref "$project_ref" --env-file "$env_file"
pnpm exec supabase functions deploy one-fetch-control --project-ref "$project_ref" --no-verify-jwt
pnpm exec supabase functions deploy one-fetch-gateway --project-ref "$project_ref" --no-verify-jwt
pnpm exec supabase secrets set --project-ref "$project_ref" "ONE_FETCH_BUILD_VERSION=$build_id"
node scripts/verify-deployment.mjs --project-ref "$project_ref" --env-file "$env_file" --build-id "$build_id"
