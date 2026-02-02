import * as v2  from '../../lib/computations/v2.js';
import * as evm from '../../lib/computations/evm.js';

import { Context as RouterContext } from '../router.js';

type Dependencies = (
  | evm.EthGetBlock
  | v2.CTokenMetadata
  | v2.CTokenUnderlyingPrice
);

interface Context
  extends RouterContext
{}

export type {
  Context,
  Dependencies,
};

export { getCTokens } from './ctokens.js';
export { getGasPrice } from './gas-price.js';
