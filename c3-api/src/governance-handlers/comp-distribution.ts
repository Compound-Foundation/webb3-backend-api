import * as Eth      from '../../lib/eth-constants.js';
import * as Fallible from '../../lib/fallible/fallible.js';
import { BigFixnum } from '../../lib/bigfixnum.js';

import * as Index from '../../lib/symbolic/index.js';

import { ctokenv2s } from '../../lib/well-known/contracts/ethereum-mainnet.js';

import { AllContracts, GovernanceRouteData } from '../router.js';

import type { Context } from './handlers.js';

async function getCompDistribution(
  { apiHost, nodeHost, nodeKey, network, contract }: GovernanceRouteData,
  context: Context,
): Promise<Response> {
  if (contract === AllContracts) {
    return new Response(`Error: Specifier '${AllContracts}' is invalid for this route`, { status: 400 });
  }
  const selectedGovernanceTokenContract = contract;
  if (selectedGovernanceTokenContract.address !== Eth.wellKnownContractsByNetwork[network]['COMP']['default'].address) {
    return new Response(`Error: Governance token distribution data is only available for the COMP token`, { status: 400 });
  }

  const comptroller = Eth.wellKnownContractsByNetwork[network]['Comptroller']['Unitroller'];

  const { evaluate, join, pull1, pipe1, split } = context.evaluator;
  const latestBlock = await evaluate(pull1({
    ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network }
  }));

  const hourlyIndex = Index.HourlyBlockIndex.project({ network, contract: selectedGovernanceTokenContract, block: latestBlock });
  const hourlyCachedBlockNumber = Fallible.must(hourlyIndex).block.number;

  const [compRate, compSupplySpeedByMarket, compBorrowSpeedByMarket] = await evaluate(split(<const>[
    pull1({
      compRate: {
        apiHost,
        nodeHost,
        nodeKey, 
        network,
        contract: comptroller,
        blockNumber: hourlyCachedBlockNumber,
      }
    }),
    join([
      ctokenv2s.map(v2MarketContract => pipe1([{
            compSupplySpeeds: {
              apiHost,
              nodeHost,
              nodeKey, 
              cToken: v2MarketContract,
              network: network,
              contract: comptroller,
              blockNumber: hourlyCachedBlockNumber,
            }
          },
          compSupplySpeed => ({[v2MarketContract.address]: compSupplySpeed}),
        ])),
      (compSupplySpeedsByMarket): { [key: string]: BigFixnum } => Object.assign({}, ...compSupplySpeedsByMarket ),
    ]),
    join([
      ctokenv2s.map(v2MarketContract => pipe1([{
            compBorrowSpeeds: {
              apiHost,
              nodeHost,
              nodeKey, 
              cToken: v2MarketContract,
              network: network,
              contract: comptroller,
              blockNumber: hourlyCachedBlockNumber,
            }
          },
          compBorrowSpeed => ({[v2MarketContract.address]: compBorrowSpeed}),
        ])),
      (compBorrowSpeedsByMarket): { [key: string]: BigFixnum } => Object.assign({}, ...compBorrowSpeedsByMarket ),
    ]),
  ]));

  const marketDistributionData = ctokenv2s.map(market => {
    const dailySupplyComp = estimateDailyCompFromSpeed(compSupplySpeedByMarket[market.address]);
    const dailyBorrowComp = estimateDailyCompFromSpeed(compBorrowSpeedByMarket[market.address]);
    return {
      address: market.address,
      symbol: market.canonicalName,
      underlying_address: market.underlying.address,
      underlying_name: market.underlying.description,
      underlying_symbol: market.underlying.canonicalName,
      supplier_daily_comp: parseFloat(dailySupplyComp.toString()).toFixed(2),
      borrower_daily_comp: parseFloat(dailyBorrowComp.toString()).toFixed(2),
    }
  });

  const responseData: CompDistributionResponseData = {
    comp_rate: compRate.toString(),
    daily_comp: parseFloat(estimateDailyCompFromSpeed(compRate).toString()).toFixed(2),
    markets: marketDistributionData,
  }

  return new Response(JSON.stringify(responseData));
}

const estimateDailyCompFromSpeed = (compPerBlock: BigFixnum) => {
  const compPerSecond = compPerBlock.div(BigFixnum.from({value: 12}));
  const compPerDay = compPerSecond.mul(BigFixnum.from({value: 60 * 60 * 24}));
  return compPerDay;
}

type CompDistributionResponseData = {
  comp_rate: string,
  daily_comp: string,
  markets: {
    address: string;
    symbol: string;
    underlying_address: string;
    underlying_name: string;
    underlying_symbol: string;
    supplier_daily_comp: string;
    borrower_daily_comp: string;
  }[],
}

export {
  getCompDistribution,
  CompDistributionResponseData,
}
