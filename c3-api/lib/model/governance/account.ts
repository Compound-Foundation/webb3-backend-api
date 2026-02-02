import { Profile } from './profile.js';

type Account = Profile & {
  rank?:           number,
  votes:           string,
  balance:         string,
  vote_weight:     string,
  proposals_voted: number,
  total_delegates: number,
};

export type {
  Account,
};
