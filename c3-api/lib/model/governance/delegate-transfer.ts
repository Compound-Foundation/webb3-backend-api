export * as v3 from './delegate_transfers/v3.js';

const DelegateChanged = (
  `event DelegateChanged(
    address indexed delegator,
    address indexed fromDelegate,
    address indexed toDelegate
  )`
) as const;

const events = {
  DelegateChanged,
};

export type {
  DelegateChanged,
};

export type {
  DelegatesMapping,
} from './delegate_transfers/v3.js';

export {
  events,
}
