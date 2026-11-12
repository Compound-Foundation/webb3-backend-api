import * as abiFunction from '../abi-function.js';

import type * as Compute from '../../symbolic/computation.js';

import type { RegistryComet } from '../../model/comet-registry.js';

import { decimalsOf } from './asset-price.js';
import type { GetPrice, PriceRead } from './get-price.js';

/*
 * The base asset's price through the feed its Comet names for it at the
 * block, baseTokenPriceFeed(): what basePrice reads where the feed the version
 * names does not answer (base-price.ts).
 *
 * The feed is read at the address the call answers, checksummed as the
 * version's feeds are, and never lowercased: the read is made under the same
 * key as basePrice's own, so an evaluator that keeps what it computed (the
 * working set, on the routes that read many markets) does not make it again.
 * The history's recursive evaluator keeps nothing a getPrice computes, and
 * reads it again. It is read at the scale the version states for it, and a
 * feed the version does not describe at eight decimals (decimalsOf). Its
 * revert is not reported here: basePrice reports the version's feed where
 * neither answers.
 *
 * A Comet always answers baseTokenPriceFeed(). Where one reverts it, the
 * revert is answered as a price that could not be read, so basePrice answers
 * what the version's feed did rather than failing the request.
 */
type CometBasePrice = abiFunction.Spec<{
  name: 'cometBasePrice',
  depends: [ GetPrice ],
  // a Comet the registry materialized, whose version states the scale of the feeds it describes
  expects: { contract: RegistryComet },
  returns: PriceRead,
}>;

const { implement, pull1 } = abiFunction.Functor<CometBasePrice>({});
const cometBasePrice = implement<Compute.Returns<CometBasePrice>>({
  // 1: the base price through the feed the Comet names at the block
  version: 1,
  signature: `function baseTokenPriceFeed() view returns (address)`,
  parser: ([ feed ], { apiHost, nodeHost, nodeKey, network, contract, blockNumber }) => pull1({
    getPrice: {
      apiHost,
      nodeHost,
      nodeKey,
      network,
      contract,
      blockNumber,
      priceFeed:  { address: feed, decimals: decimalsOf(contract.registry, feed) },
      unreported: true,
    },
  }),
  reverted: ({ message }) => ({ status: 'error', message }),
});

export { CometBasePrice, cometBasePrice };
