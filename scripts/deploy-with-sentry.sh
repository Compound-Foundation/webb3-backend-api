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
# Requires SENTRY_AUTH_TOKEN: a Sentry organization auth token, created under
# Settings > Developer Settings > Organization Tokens. Never commit it.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <sentry-project> [wrangler deploy args...]" >&2
  exit 64
fi
sentry_project="$1"
shift

if [[ -z "${SENTRY_AUTH_TOKEN:-}" ]]; then
  echo "SENTRY_AUTH_TOKEN is not set. It is needed to upload source maps to Sentry." >&2
  exit 1
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
