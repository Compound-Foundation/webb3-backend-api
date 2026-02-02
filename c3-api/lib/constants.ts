import { BigFixnum } from './bigfixnum.js';

const secondsPerDay  = BigFixnum.from({ value: 24 * 60 * 60 });
const secondsPerYear = secondsPerDay.mul(BigFixnum.from({ value: 365 }));
const quorumVotes = BigFixnum.from({ value: 400_000 }).shiftDecimalPoint(18);

export {
  quorumVotes,
  secondsPerDay,
  secondsPerYear,
};
