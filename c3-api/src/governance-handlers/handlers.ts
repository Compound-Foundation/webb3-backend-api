import * as evm        from '../../lib/computations/evm.js';
import * as account    from '../../lib/computations/account.js';
import * as governance from '../../lib/computations/governance.js';

import type { Context as RouterContext } from '../router.js';

/*
 * Route context -- runtime dependencies NOT parsed from the request.
 */

type Dependencies = (
  | evm.Evm
  | account.Erc20Balance
  | governance.AllProposals
  | governance.VoteTransfers
  | governance.CrowdProposals
  | governance.DelegateTransfers
  | governance.CompRate
  | governance.CompBorrowSpeeds
  | governance.CompSupplySpeeds
  | governance.CrossChainProposals
);

interface Context
  extends RouterContext
{}

export type {
  Context,
  Dependencies,
};

export { getHistory } from './history.js';
export { getAccounts } from './accounts.js';
export { getCompDistribution } from './comp-distribution.js';
export { getProposalVoteReceipts } from './proposal-vote-receipts.js';
export { getProposals, hydrateProposers } from './proposals.js';
