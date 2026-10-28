import * as Eth     from '../../eth-constants.js';
import * as Compute from '../../symbolic/computation.js';

import { BigFixnum } from '../../bigfixnum.js';

import type { RegistryComet } from '../../model/comet-registry.js';

import type {
  AssetInfo,
  AssetPrice,
  AssetTotalCollateral,
  NumAssets,
  PriceRead,
  Symbol,
} from '../comet.js';

/*
 * Every collateral asset of a market, in the order the Comet numbers them:
 * what it is, how much of it the market holds, and its price or why that
 * could not be read. The summary's collateral value and its report of which
 * collateral could not be priced both come from this one pass, so each read
 * is made once — an evaluator that does not remember what it computed would
 * otherwise make every one of them twice.
 */
type Collateral = {
  asset:           Eth.Address,
  symbol:          string,
  totalCollateral: BigFixnum,
  price:           PriceRead,
};

type Collaterals = Compute.Spec<{
  name: 'collaterals',
  depends: [ NumAssets, AssetInfo, AssetTotalCollateral, AssetPrice, Symbol ],
  // a Comet the registry materialized, whose version states how its collateral is priced
  expects: Omit<NumAssets['expects'], 'contract'> & { contract: RegistryComet },
  returns: Collateral[],
}>;

const { implement, join, pipe, pipe1 } = Compute.Functor<Collaterals>({});
const collaterals = implement({
  version: 1,
  compute({ apiHost, nodeHost, nodeKey, blockNumber, contract, network }) {
    return pipe1([
      { numAssets: { apiHost, nodeHost, nodeKey, blockNumber, contract, network } },
      numAssets => join([
        Array.from({ length: numAssets }, (_, assetNumber) => pipe1([
          { assetInfo: { apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network } },
          ({ asset }) => pipe([
            {
              assetTotalCollateral: { apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network },
              assetPrice:           { apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network },
              // @ts-expect-error Only address is required
              symbol: { contract: { address: asset }, blockNumber, network, apiHost, nodeHost, nodeKey },
            },
            ({ assetTotalCollateral, assetPrice, symbol }): Collateral => ({
              asset,
              symbol,
              totalCollateral: assetTotalCollateral,
              price:           assetPrice,
            }),
          ]),
        ])),
        results => results as Collateral[],
      ]),
    ]);
  },
});

function collateralValue(collaterals: Collateral[]): BigFixnum {
  return collaterals.reduce(
    (sum, { totalCollateral, price }) => price.status === 'success'
      ? sum.add(totalCollateral.mul(price.price))
      : sum,
    BigFixnum.from({ value: 0 }),
  );
}

export { Collateral, Collaterals, collateralValue, collaterals };
