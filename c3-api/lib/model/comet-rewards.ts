const RewardsClaimed = (
  `event RewardClaimed(
    address indexed src,
    address indexed recipient,
    address indexed token,
    uint256 amount
  )`
) as const;

const events = {
  RewardsClaimed,
};

export {
  events,
};
