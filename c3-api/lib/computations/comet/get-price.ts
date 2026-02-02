import { BigFixnum }    from '../../bigfixnum.js';
import * as Eth         from '../../eth-constants.js';
import * as Key         from '../../symbolic/key.js';
import * as abiFunction from '../abi-function.js';

type GetPrice = abiFunction.Spec<{
  name: 'getPrice',
  expects: {
    priceFeed: {
      address: Eth.Address,
      decimals: number,
    },
  },
  returns: BigFixnum,
}>;

const { implement } = abiFunction.Functor<GetPrice>({});
const getPrice = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function getPrice(address) view returns (uint256)`,
  key(name, { priceFeed, ...context }) {
    return Key.toKey(name, { priceFeed: priceFeed.address, ...context });
  },
  parameters: ({ priceFeed }) => [ priceFeed.address ],
  parser: ([ u256 ], { priceFeed: { decimals } }) => (
    BigFixnum.from({ decimals, value: u256 })
  ),
});

export { GetPrice, getPrice };
