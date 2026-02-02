import { BigFixnum }    from '../../bigfixnum.js';
import * as abiFunction from '../abi-function.js';

import type { GetPrice  } from './get-price.js';

type BasePrice = abiFunction.Spec<{
  name: 'basePrice',
  depends: [ GetPrice ],
  returns: BigFixnum,
}>;

const { implement, pull1 } = abiFunction.Functor<BasePrice>({});
const basePrice = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
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
