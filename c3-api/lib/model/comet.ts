const Supply = (
  `event Supply(
    address indexed from,
    address indexed dst,
    uint amount
  )`
) as const;

const Transfer = (
  `event Transfer(
    address indexed from,
    address indexed to,
    uint amount
  )`
) as const;

const Withdraw = (
  `event Withdraw(
    address indexed src,
    address indexed to,
    uint amount
  )`
) as const;

const SupplyCollateral = (
  `event SupplyCollateral(
    address indexed from,
    address indexed dst,
    address indexed asset,
    uint amount
  )`
) as const;

const TransferCollateral = (
  `event TransferCollateral(
    address indexed from,
    address indexed to,
    address indexed asset,
    uint amount
  )`
) as const;

const WithdrawCollateral = (
  `event WithdrawCollateral(
    address indexed src,
    address indexed to,
    address indexed asset,
    uint amount
  )`
) as const;

const AbsorbDebt = (
  `event AbsorbDebt(
    address indexed absorber,
    address indexed borrower,
    uint basePaidOut,
    uint usdValue
  )`
) as const;

const AbsorbCollateral = (
  `event AbsorbCollateral(
    address indexed absorber,
    address indexed borrower,
    address indexed asset,
    uint collateralAbsorbed,
    uint usdValue
  )`
) as const;

const BuyCollateral = (
  `event BuyCollateral(
    address indexed buyer,
    address indexed asset,
    uint baseAmount,
    uint collateralAmount
  )`
) as const;

const PauseAction = (
  `event PauseAction(
    bool supplyPaused,
    bool transferPaused,
    bool withdrawPaused,
    bool absorbPaused,
    bool buyPaused
  )`
) as const;

const WithdrawReserves= (
  `event WithdrawReserves(
    address indexed to,
    uint amount
  )`
) as const;

const Approval = (
  `event Approval(
    address indexed owner,
    address indexed spender,
    uint amount
  )`
) as const;

const events = {
  Supply,
  Transfer,
  Withdraw,
  Approval,
  AbsorbDebt,
  PauseAction,
  BuyCollateral,
  AbsorbCollateral,
  SupplyCollateral,
  WithdrawReserves,
  TransferCollateral,
  WithdrawCollateral,
};

export {
  events,
};
