#!/usr/bin/env bash
#
# Deploy a worker with wrangler, then upload its source maps to Sentry so
# production stack traces point at the TypeScript source.
#
# Run from a worker directory, for example:
#   ../scripts/deploy-with-sentry.sh webb3-c3-api-server --env production
#
# The first argument is the Sentry project; the rest go to `wrangler deploy`.
#
# Uploading needs a Sentry organization auth token. The script uses
# SENTRY_AUTH_TOKEN when it is set (for example in CI). Otherwise it reads the
# token from 1Password with the `op` CLI, from SENTRY_AUTH_TOKEN_OP_REF or the
# default reference below. Never commit the token.
set -euo pipefail

DEFAULT_TOKEN_REF="op://Engineering/sentry-deployments-auth-token/credential"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <sentry-project> [wrangler deploy args...]" >&2
  exit 64
fi
sentry_project="$1"
shift

# Read the token before deploying, so a missing token stops the deploy.
if [[ -z "${SENTRY_AUTH_TOKEN:-}" ]]; then
  token_ref="${SENTRY_AUTH_TOKEN_OP_REF:-$DEFAULT_TOKEN_REF}"
  if ! command -v op >/dev/null 2>&1; then
    echo "SENTRY_AUTH_TOKEN is not set and the 1Password CLI (op) is not installed." >&2
    echo "Install it (https://developer.1password.com/docs/cli/get-started/) or set SENTRY_AUTH_TOKEN." >&2
    exit 1
  fi
  if ! SENTRY_AUTH_TOKEN="$(op read --no-newline "$token_ref")" || [[ -z "$SENTRY_AUTH_TOKEN" ]]; then
    echo "Could not read the Sentry auth token from 1Password ($token_ref)." >&2
    echo "Sign in with 'op signin' (or unlock the 1Password app), or set SENTRY_AUTH_TOKEN." >&2
    exit 1
  fi
  export SENTRY_AUTH_TOKEN
fi

export SENTRY_ORG="compound-foundation"
export SENTRY_PROJECT="$sentry_project"

# The git commit names the release. The SDK reads it from SENTRY_RELEASE.
release="$(npx sentry-cli releases propose-version)"
out_dir=".wrangler/sentry-deploy"
rm -rf "$out_dir"

npx wrangler deploy "$@" \
  --outdir "$out_dir" \
  --upload-source-maps \
  --var "SENTRY_RELEASE:$release"

# The SDK renames the bundle's frames to app:///<bundle>.js (lib/sentry.ts,
# src/sentry.ts), so the source map is uploaded under the same prefix.
npx sentry-cli releases new "$release"
npx sentry-cli sourcemaps upload \
  --release "$release" \
  --url-prefix "app:///" \
  --ext js --ext map \
  "$out_dir"
npx sentry-cli releases finalize "$release"
