#!/usr/bin/env -S zsh -euo pipefail

git_root=$(git rev-parse --show-toplevel)
dump_path="${git_root}/cloudflare/workers/c3-api/tests/dumps"
git_branch=$(git rev-parse --abbrev-ref HEAD)

# take R2_REMOTE name or configuration string from env, or default
# R2_REMOTE would be the same as {your.r2.domain} if you setup rclone
r2_remote=${R2_REMOTE}

# root path to the compound-v3-api-test-dumps bucket on the r2_remote
r2_root="${r2_remote}:compound-v3-api-test-dumps"

flags=(
  # --workdir  sets the working directory for locks and temporary files
  "--workdir .bisync-workdir"
  # --exclude  excludes this pattern from synchronization
  "--exclude sync.sh"
  # --verbose  verbosity level 1, INFO
  "--verbose"
)

if [[ ! -d .bisync-workdir ]]; then
  flags+=("--resync")
fi

# pass any additional flags by forwarding ${@}
flags+=(${@})

#
# rclone bisync
# cf. https://rclone.org/bisync/
#
# sync ${dump_path} with compound-v3-api-test-dumps bucket, where changed
# files replace unchanged files on either side.
#
rclone bisync ${(@z)flags} "${r2_root}/dumps" "${dump_path}"
