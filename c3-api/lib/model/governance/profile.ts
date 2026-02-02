import * as Eth from '../../eth-constants.js';

type Profile = {
  address:      Eth.Address,
  image_url:    null | string,
  display_name: null | string,
};

const defaultProfile = (proposer: Eth.Address) => ({
  address:      proposer,
  image_url:    null,
  display_name: null,
});

export type { Profile };
export { defaultProfile };
