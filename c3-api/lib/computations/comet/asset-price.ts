import { BigFixnum } from '../../bigfixnum.js';
import * as Compute  from '../../symbolic/computation.js';

import type { AssetInfo } from './asset-info.js';
import type { GetPrice  } from './get-price.js';

type AssetPrice = Compute.Spec<{
  name: 'assetPrice',
  depends: [ AssetInfo, GetPrice ],
  expects: AssetInfo['expects'],
  returns: BigFixnum,
}>;

const { implement, pipe1, pull1 } = Compute.Functor<AssetPrice>({});
const assetPrice = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  compute: ({ apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network }) => pipe1([
    { assetInfo: { apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network } },
    ({ priceFeed }) => {
      // Work around for deprecated wUSDM price feed.
      if (network === 'ethereum-mainnet' && priceFeed === '0xe3a409eD15CD53aFdEFdd191ad945cEC528A2496') {
        return BigFixnum.from({ decimals: 8, value: 0 });
      // Work around for deprecated pumpBTC / BTC exchange rate feed (cWBTCv3 collateral).
      // Last published answer (2026-09-03, retired aggregator 0x918c6cde1cdd940934820b8fa3a2c8b26a60736c).
      } else if (network === 'ethereum-mainnet' && priceFeed === '0x351a133Fd850ea81ed8a782016e308aCBADDec91') {
        return BigFixnum.from({ decimals: 8, value: 102447384 });
      } else if (network === 'arbitrum-mainnet' && priceFeed === '0x13cDFB7db5e2F58e122B2e789b59dE13645349C4') {
        return BigFixnum.from({ decimals: 8, value: 0 });
      } else if (network === 'optimism-mainnet' 
        && (priceFeed === '0x66228d797eb83ecf3465297751f6b1D4d42b7627')
          || priceFeed === '0x7E86318Cc4bc539043F204B39Ce0ebeD9F0050Dc'
        ) {
        return BigFixnum.from({ decimals: 8, value: 0 });
      }

      return pull1({
        getPrice: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          contract,
          blockNumber,
          priceFeed: {
            address: priceFeed,
            decimals: 8, // FIXME: this is an assumption that could break
          },
        },
      });
    },
  ]),
});

export { AssetPrice, assetPrice };
