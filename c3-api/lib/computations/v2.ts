import { CTokenUnderlyingPrice } from './v2/ctoken-underlying-price.js';
import { CTokenMetadata } from './v2/ctoken-metadata.js';

export type V2 = (
  | CTokenMetadata
  | CTokenUnderlyingPrice
);

export {
  CTokenMetadata,
  cTokenMetadata,
} from './v2/ctoken-metadata.js';

export {
  CTokenUnderlyingPrice,
  cTokenUnderlyingPrice,
} from './v2/ctoken-underlying-price.js';
