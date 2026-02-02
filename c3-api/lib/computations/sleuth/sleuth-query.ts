import { BytesLike } from '@ethersproject/bytes';

import * as abiFunction from '../abi-function.js';

import { UntypedContract } from '../../well-known/contracts/types.js';
import * as KnownNetwork from '../../well-known/networks/network.js';

type SleuthQuery = abiFunction.Spec<{
  name: 'sleuthQuery',
  expects: {
    queryBytecode: string,
    codedArgs: string,
  };
  returns: BytesLike,
}>;

const { implement } = abiFunction.Functor<SleuthQuery>({});
const sleuthQuery = implement({
  version: 0,
  signature: `function query(bytes,bytes) view returns (bytes)`,
  parameters: ({ queryBytecode, codedArgs }) => [queryBytecode, codedArgs],
  parser: ([result]) => (result),
});


function getSleuthContract(network: KnownNetwork.Name) {
  const sleuthContract = UntypedContract("Sleuth", <const>{
    network: network,
    address: '0xc6a613fdac3465d250df7ff3cc21bec86eb8a372',
    block: {
      number: 16179324,
      timestamp: 1670977343,
    },
  });

  const sleuthMantleContract = UntypedContract("Sleuth", <const>{
    network: network,
    address: '0x1C31c10691Ba7728A04C2bAa2ac02E663a87466F',
    block: {
      number: 72296616,
      timestamp: 1732723544,
    },
  });

  if (network === 'mantle-mainnet') {
    return sleuthMantleContract;
  } else {
    return sleuthContract;
  }
}

export { SleuthQuery, sleuthQuery, getSleuthContract };
