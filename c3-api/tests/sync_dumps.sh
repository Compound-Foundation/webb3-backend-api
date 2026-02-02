#!/bin/sh
git_root=$(git rev-parse --show-toplevel)
dump_path="${git_root}/cloudflare/workers/c3-api/tests/dumps"
export RCLONE_CONFIG_DUMPSR2_TYPE=s3
export RCLONE_CONFIG_DUMPSR2_ACCESS_KEY_ID="${CLOUDFLARE_R2_ACCESS_KEY_ID}"
export RCLONE_CONFIG_DUMPSR2_SECRET_ACCESS_KEY="${CLOUDFLARE_R2_SECRET_ACCESS_KEY}"
export RCLONE_CONFIG_DUMPSR2_ENDPOINT="${CLOUDFLARE_R2_ENDPOINT}"
export RCLONE_CONFIG_DUMPSR2_PROVIDER=Cloudflare

#
# sync into ${dump_path} from the dumpsr2:compound-v3-api-test-dumps/dumps.
# rclone sync {source} {destination}
# 
# This script leverage ENV to set the rclone config
# DUMPSR2 is the name of the bucket in this case which is dumpsr2
# 
# In order to run this script, you need to have the following ENV set
# CLOUDFLARE_R2_ACCESS_KEY_ID
# CLOUDFLARE_R2_SECRET_ACCESS_KEY
# CLOUDFLARE_R2_ENDPOINT
# Which will be loaded into RCLONE_CONFIG ENV
if [ "$1" = "upload" ]
then
  rclone sync "${dump_path}" dumpsr2:compound-v3-api-test-dumps/dumps
else
  rclone sync dumpsr2:compound-v3-api-test-dumps/dumps "${dump_path}" 
fi
