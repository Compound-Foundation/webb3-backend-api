#!/bin/sh
#
# Runs every compiled test that needs neither a node provider nor the R2 test
# dumps: the registry suites, which run the worker in workerd with local D1,
# KV and rate-limit bindings, and the unit tests of everything else. This is
# what CI runs.
#
# A test runs here unless it is excluded below by its own file name, so a new
# test is covered by default, in whichever directory it lives. One that reads
# a live service or a dump is added to the list. The list, in its order:
#
# - tests that replay R2 dumps: the governance routes, the legacy cTokens
#   route, the all-networks historical market summary, the transaction
#   history, the account transaction history items, the governance
#   computations, and the historical market day summaries;
# - tests that read a live chain through a node provider: the all-networks
#   and mainnet market summaries, account rewards, and the market day,
#   minutely, rewards and rewards summary computations;
# - the legacy gas price, which reads blocknative;
# - timestamp-estimate, which reads a dump and a live chain.
#
# Arguments are passed on to tap.
set -eu

exec npx tap --disable-coverage --timeout=600 \
  --include='dist/tests/**/*.test.js' \
  --exclude='dist/tests/e2e/governance/mainnet/all/proposal-vote-receipts.test.js' \
  --exclude='dist/tests/e2e/governance/mainnet/all/proposals.test.js' \
  --exclude='dist/tests/e2e/governance/mainnet/comp/accounts.test.js' \
  --exclude='dist/tests/e2e/governance/mainnet/comp/distribution.test.js' \
  --exclude='dist/tests/e2e/governance/mainnet/comp/history.test.js' \
  --exclude='dist/tests/e2e/legacy/mainnet/ctokens.test.js' \
  --exclude='dist/tests/e2e/market/all-networks/all-contracts/historical-summary.test.js' \
  --exclude='dist/tests/e2e/transaction-history/transaction-history.test.js' \
  --exclude='dist/tests/lib/computations/account/enrich-transaction-history-items.test.js' \
  --exclude='dist/tests/lib/computations/account/raw-transaction-history-items.test.js' \
  --exclude='dist/tests/lib/computations/governance/all-proposals.test.js' \
  --exclude='dist/tests/lib/computations/governance/crowd-proposals.test.js' \
  --exclude='dist/tests/lib/computations/market/historical-market-day-summaries.test.js' \
  --exclude='dist/tests/e2e/market/all-networks/all-contracts/summary.test.js' \
  --exclude='dist/tests/e2e/market/mainnet/01-iusdc/summary.test.js' \
  --exclude='dist/tests/e2e/market/mainnet/01-usdc/summary.test.js' \
  --exclude='dist/tests/lib/computations/account/account-rewards.test.js' \
  --exclude='dist/tests/lib/computations/market/market-day-summary.test.js' \
  --exclude='dist/tests/lib/computations/market/market-minutely-summary.test.js' \
  --exclude='dist/tests/lib/computations/market/market-rewards.test.js' \
  --exclude='dist/tests/lib/computations/market/rewards-summary.test.js' \
  --exclude='dist/tests/e2e/legacy/gas-price.test.js' \
  --exclude='dist/tests/lib/timestamp-estimate.test.js' \
  "$@"
