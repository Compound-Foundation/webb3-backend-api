import * as Eth from '../../../eth-constants.js';

type DelegatesMapping = {
  [address: Eth.Address]: Eth.Address,
};

function getDelegatorCount(delegatesMapping: DelegatesMapping, delegateAddress: Eth.Address): number {
  return Object.values(delegatesMapping)
    .filter(delegate => delegate.toLowerCase() === delegateAddress.toLowerCase())
    .length;
}

export type {
  DelegatesMapping
};

export {
  getDelegatorCount
};
