import * as abiFunction from '../abi-function.js';

import type { GetPrice, PriceRead } from './get-price.js';

type BasePrice = abiFunction.Spec<{
  name: 'basePrice',
  depends: [ GetPrice ],
  returns: PriceRead,
}>;

const { implement, pull1 } = abiFunction.Functor<BasePrice>({});
const basePrice = implement({
  // 1: a feed that reverts is answered, not thrown
  version: 1,
  signature: `function baseTokenPriceFeed() view returns (address)`,
  parser: ([ priceFeed ], { apiHost, nodeHost, nodeKey, blockNumber, contract, network }) => {
    return pull1({
      getPrice: {
        apiHost,
        nodeHost,
        nodeKey,
        priceFeed: {
          address: priceFeed,
          decimals: 8, // FIXME: should not assume 8, probably...?
        },
        blockNumber,
        contract,
        network,
      }
    });
  },
});

export { BasePrice, basePrice };
