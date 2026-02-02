import * as Eth from '../../eth-constants.js';

import * as abiFunction from '../abi-function.js';

type GetAllProxies = abiFunction.Spec<{
  name: 'getAllProxies',
  expects: {
    address: Eth.Address
  },
  returns: Eth.Address[],
}>;

const { implement } = abiFunction.Functor<GetAllProxies>({});
const getAllProxies = implement({
  version: 1,
  signature: `function getAllProxies(address) view returns (address,address[])`,
  parameters: ({ address }) => [ address ],
  parser: ([mcdProxy, additionalProxies]) => {
    if (!Eth.parseAddress(mcdProxy)) {
      throw new Error(`invariant violated: mcdProxy is not an address`);
    }
    const additionalProxiesAddresses: Eth.Address[] = additionalProxies.map((address:string) => {
      if (!Eth.parseAddress(address)) {
        throw new Error(`invariant violated: address is not an address`);
      }
      return address;
    });

    // Return only one with non null address
    return [mcdProxy, ...additionalProxiesAddresses].filter((address) => address !== Eth.NullAddress);
  },
});

export { GetAllProxies, getAllProxies };
