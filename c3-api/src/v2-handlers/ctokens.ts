import * as Eth from '../../lib/eth-constants.js';
import * as Fallible from '../../lib/fallible/fallible.js';
import * as Index from '../../lib/symbolic/index.js';
import * as v2 from '../../lib/model/v2.js';
import * as Constants from '../../lib/constants.js';
import * as Type from '../../lib/type-utilities.js';
import { BigFixnum } from '../../lib/bigfixnum.js';
import { V2RouteData } from '../router.js';
import { Context } from './handlers.js';
import { ctokenv2s } from '../../lib/well-known/contracts/ethereum-mainnet.js';
import { BigNumber } from '../../lib/bignumber.js';


async function getCTokens(
  { apiHost, nodeHost, nodeKey, network }: V2RouteData,
  context: Context,
): Promise<Response> {
  const { evaluate, join, pull1 } = context.evaluator;

  // Use the lens contract to get the ctoken metadata and their underlying token prices
  const contract = Eth.wellKnownContractsByNetwork[network]['CompoundLens']['default'];

  const latestBlock = await evaluate(pull1({
    ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network }
  }));

  const hourlyBlock = Fallible.must(Index.HourlyBlockIndex.project({ network, contract, block: latestBlock })).block;
  const cTokenData = await Promise.all(ctokenv2s.map(async cTokenContract => (
    await evaluate(join([
      <const>[
        pull1({
          cTokenMetadata: {
            apiHost,
            nodeHost,
            nodeKey, 
            network,
            contract,
            blockNumber: hourlyBlock.number,
            cTokenContract,
            },
        }),
        pull1({
          cTokenUnderlyingPrice: {
            apiHost,
            nodeHost,
            nodeKey,
            network,
            contract,
            blockNumber: hourlyBlock.number,
            cTokenContract,
            },
        }),
      ],
      ([metadata, underlyingPrice]) => ({
        ...metadata,
        underlyingPrice,
        // Hydrate additional data from our ctoken contract config
        // used for later calculations.
        name: cTokenContract.description,
        address: cTokenContract.address,
        symbol: cTokenContract.canonicalName,
        priceDecimals: cTokenContract.decimals,
        underlyingName: cTokenContract.underlying.description,
        underlyingAddress: cTokenContract.underlying.address,
        underlyingSymbol: cTokenContract.underlying.canonicalName,
        underlyingDecimals: cTokenContract.underlying.decimals,
      })
    ]))
  )));

  // Helper for below calculations
  const getApy = (ratePerBlock: BigFixnum) => {
    const estimatedBlocksPerSecond = 1 / Eth.estimateSecondsTakenForBlock(network, latestBlock);
    const estimatedBlocksPerYear = estimatedBlocksPerSecond * parseInt(Constants.secondsPerYear.toString());
    const apr = estimatedBlocksPerYear * parseFloat(ratePerBlock.toString());
    return ((1 + (apr/365)) ** 365) - 1;
  };

  // Get COMP data ahead of time, to later compute V2 rewards data
  const compData = cTokenData.find(ctoken => ctoken.underlyingSymbol === 'COMP');
  if (compData === undefined) {
    throw new Error(`Could not load CToken rewards data`);
  }
  const compDecimals = Eth.wellKnownContractsByNetwork[network]['COMP']['default'].decimals;
  // The price oracle sends prices in the format: ${raw price} * 1e36 / underlying decimals
  const compPrice = BigFixnum.from({value: compData.underlyingPrice, decimals: 36 - compDecimals});

  type CTokenData = (typeof cTokenData)[number];
  const cTokenDataBigFixnumConfiguration: [ keyof CTokenData, (ctoken: CTokenData) => number ][] = [
    [ 'underlyingPrice', ({ underlyingDecimals }) => 36 - underlyingDecimals ],
    [ 'borrowRatePerBlock', Type.fnWrap(18) ],
    [ 'supplyRatePerBlock', Type.fnWrap(18) ],
    [ 'collateralFactorMantissa', Type.fnWrap(18) ],
    [ 'reserveFactorMantissa', Type.fnWrap(18) ],
    [ 'borrowCap', ({ underlyingDecimals }) => underlyingDecimals ],
    [ 'exchangeRateCurrent', ({ underlyingDecimals, priceDecimals }) => 18 + underlyingDecimals - priceDecimals ],
    // Amount of underlying tokens being borrowed
    [ 'totalBorrows', ({ underlyingDecimals }) => underlyingDecimals ],
    // Amount of underlying tokens held by the ctoken contract
    [ 'totalCash', ({ underlyingDecimals }) => underlyingDecimals ],
    // Amount of underlying tokens *owned* by the ctoken contract
    [ 'totalReserves', ({ underlyingDecimals }) => underlyingDecimals ],
    // Total supply is the number of CTokens in existence.
    [ 'totalSupply', ({ priceDecimals }) => priceDecimals ],
    [ 'compBorrowSpeed', Type.fnWrap(compDecimals) ],
    [ 'compSupplySpeed', Type.fnWrap(compDecimals) ],
  ];

  const cTokenFormattedData: v2.CTokenFormattedData[] = cTokenData.map(ctoken => {
    const [
      underlyingPrice,
      borrowRatePerBlock,
      supplyRatePerBlock,
      collateralFactorScaled,
      reserveFactorScaled,
      borrowCap,
      exchangeRateScaled,
      totalBorrows,
      totalCash,
      totalReserves,
      totalSupply,
      compBorrowSpeed,
      compSupplySpeed,
    ] = cTokenDataBigFixnumConfiguration.map(([ cTokenDataKey, decimals ]) => {
      return BigFixnum.from({ value: BigNumber.from(ctoken[cTokenDataKey]), decimals: decimals(ctoken) });
    });
    const totalBorrowValue = totalBorrows.mul(underlyingPrice);
    // Total supply underlying is calculated as: total cash + total borrows - total reserves.
    const totalSupplyUnderlying = totalCash.add(totalBorrows).sub(totalReserves);
    const totalSupplyUnderlyingValue = totalSupplyUnderlying.mul(underlyingPrice);

    const compRewardRatePerBlockBorrow = compBorrowSpeed.mul(compPrice).div(totalBorrowValue);
    const compRewardRatePerBlockSupply = compSupplySpeed.mul(compPrice).div(totalSupplyUnderlyingValue);

    return {
      name: ctoken.name,
      underlying_name: ctoken.underlyingName,
      symbol: ctoken.symbol,
      underlying_symbol: ctoken.underlyingSymbol,
      token_address: ctoken.address,
      underlying_address: ctoken.underlyingAddress,
      borrow_rate: getApy(borrowRatePerBlock).toString(),
      supply_rate: getApy(supplyRatePerBlock).toString(),
      borrow_cap: borrowCap.toString(),
      collateral_factor: collateralFactorScaled.toString(),
      // The client expects reward APY to be scaled up as a percentage
      comp_borrow_apy: (getApy(compRewardRatePerBlockBorrow) * 100).toString(),
      comp_supply_apy: (getApy(compRewardRatePerBlockSupply) * 100).toString(),
      exchange_rate: exchangeRateScaled.toString(),
      reserve_factor: reserveFactorScaled.toString(),
      reserves: totalReserves.toString(),
      total_borrows: totalBorrows.toString(),
      total_supply: totalSupply.toString(),
      underlying_price: underlyingPrice.toString(),
      total_supply_value: totalSupplyUnderlyingValue.toString(),
      total_borrow_value: totalBorrowValue.toString(),
    };
  });

  const responseData: ResponseData = {
    cToken: cTokenFormattedData,
  }
  return new Response(JSON.stringify(responseData));
}

type ResponseData = {
  cToken: v2.CTokenFormattedData[];
}

export {
  getCTokens,
  ResponseData,
}
