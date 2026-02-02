import { defaultAbiCoder, Result } from '@ethersproject/abi';
import { BigFixnum } from '../../bigfixnum.js';
import { BigNumber } from '../../bignumber.js';

import * as governance from '../../model/governance.js';

import * as Eth      from '../../eth-constants.js';
import * as Fallible from '../../fallible/fallible.js';

import { setConfigurationFunctionArgTypes } from '../signatures.js';

import * as KnownNetwork from '../networks/network.js';

import type * as Type from '../../type-utilities.js';

// TODO(jordan): refactor 'types' into actual modules
import {
  Contract,
  //
  Comet,
  ERC20,
  CTokenv2,
  PriceFeed,
  TokenLike,
  PseudoToken,
  UntypedContract,
  //
  ContractLocation,
  StandaloneContract,
  //
  hasCreationTimestamp,
} from './types.js';
import { wellKnownENSHashes } from '../ens-hashes.js';

export {
  Contract,
  //
  Comet,
  ERC20,
  CTokenv2,
  PriceFeed,
  TokenLike,
  PseudoToken,
  //
  UntypedContract,
  ContractLocation,
  StandaloneContract,
  //
  hasCreationTimestamp,
};

/*
 * Contract_For filters a union of Contracts to those within a network,
 * and optionally also filters on name, address, and alias.
 */
type Contracts_For<
  Contracts extends StandaloneContract,
  Network   extends KnownNetwork.Name,
  Name      extends string = any,
  Address   extends string = any,
  Alias     extends string = any,
> = (
  Contracts_FilterByAlias<
    Extract<Contracts, {
      network: Network
      address: Address,
      canonicalName: Name,
    }>,
    Alias
  >
);

/*
 * Contracts_FilterByAlias filters a union of Contracts to only those
 * whose possible selectedAlias union contains the given alias(es).
 */
type Contracts_FilterByAlias<
  Contracts extends StandaloneContract,
  Alias     extends string,
> = (
  // if no alias is specified, or if it is `any`, do not filter.
  unknown extends Alias ? Contracts
  // otherwise...
  : { [Address in Contracts['address']]: (
        Alias extends Extract<Contracts, { address: Address }>['selectedAlias']
          ? Type.Merge<(Extract<Contracts, { address: Address }> & { selectedAlias?: Alias })>
          : never
      )
    }[Contracts['address']]
);

/*
 * StaticWellKnownContracts is a constant mapping containing all
 * well-known contracts, addressable by any of:
 *    [network][address]
 *    [network][canonicalName][alias]     case-insensitive
 *    [network][canonicalName][address]   case-insensitive
 */
type StaticWellKnownContracts<
  Contracts extends readonly StandaloneContract[]
> = Type.Merge<{
  [Network in Contracts[number]['network']]: Type.Merge<(
    & { [Address in Addresses_For<Contracts[number], Network> as Address | Lowercase<Address>]:
          Contracts_For<Contracts[number], Network, any, Address>
      }
    & { [Name in Contracts_For<Contracts[number], Network>['canonicalName']]: Type.Merge<(
          & { [Address in Addresses_For<Contracts[number], Network, Name> as Address | Lowercase<Address>]:
                Contracts_For<Contracts[number], Network, Name, Address>;
            }
          & { [Alias in Aliases_For<Contracts[number], Network, Name> as Alias | Lowercase<Alias>]:
                Contracts_For<Contracts[number], Network, Name, any, Alias>;
            }
        )>
      }
  )>;
}>;

type Addresses_For<
  Contracts extends StandaloneContract,
  Network   extends KnownNetwork.Name,
  Name      extends string = any,
> = (
  | Contracts_For<Contracts, Network, Name>['address']
);

type Aliases_For<
  Contracts extends StandaloneContract,
  Network   extends KnownNetwork.Name,
  Name      extends string = any,
> = (
  | Contracts_For<Contracts, Network, Name>['aliases'][number]
);

/*
 *
 */
function StaticWellKnownContracts<
    Contracts extends readonly Contract[]
  >
  (contracts: Contracts)
  : StaticWellKnownContracts<Contracts>
{
  const wellKnownContracts: (
    // TODO?(jordan): extract into more useful type?
    { [N in KnownNetwork.Name]?: (
      & { [address in string]?: Contract }
      & { [name in string]?: (
          & { [address in string]?: Contract }
          & { [alias   in string]?: Contract }
        )}
    )}
  ) = {};
  for (const contract of contracts) {
    /*
     * build contract lookup leaf mappings: address | alias -> contract.
     * NOTE: case-insensitive.
     */
    const byAddress: { [address: string]: Contract } = {
      [contract.address]: contract,
      [contract.address.toLowerCase()]: contract,
    };
    const byAlias: { [alias: string]: Contract } = {};
    for (const alias of contract.aliases) {
      byAlias[alias] = byAlias[alias.toLowerCase()] = contract;
    }
    /*
     * add the contract lookup map to the overall static contract map
     */
    if (!(contract.network in wellKnownContracts)) {
      wellKnownContracts[contract.network] = {};
    }
    /*
     * FIXME(jordan): wow that's a lot of `as any` and non-null assert...
     */
    if (!(contract.canonicalName in wellKnownContracts[contract.network]!)) {
      wellKnownContracts[contract.network]![contract.canonicalName] = {} as any;
    }
    Object.assign(wellKnownContracts[contract.network]!, byAddress);
    Object.assign(
      wellKnownContracts[contract.network]![contract.canonicalName] as any,
      {
        ...byAlias,
        ...byAddress,
      },
    );
  }
  return wellKnownContracts as StaticWellKnownContracts<Contracts>;
}

/*
 *
 */
type WellKnownContractsByNetworkAddress = {
  [Network in KnownNetwork.Name]: (
    & { [address in Eth.Address]: Contract }
    & { [key: string]: any }
  )
};

/*
 * Contract.forLocation({ network, address }, wellKnownContracts) either
 * selects the well-known contract at the given location, or assumes that
 * the address corresponds to a contract, and materializes an empty
 * UntypedContract for the location.
 */
type LookupLocation = Type.Optional<ContractLocation, 'creation'>;
function contractForLocation(
  { network, address }: LookupLocation,
  wellKnownContracts: WellKnownContractsByNetworkAddress,
): Contract {
  const addressLowercased = address.toLowerCase();
  if (addressLowercased in wellKnownContracts[network]) {
    return wellKnownContracts[network][addressLowercased];
  }
  return UntypedContract(address, { network, address, block: { number: 0 } });
}

/*
 * Contract.lookup({ network, address }, wellKnownContracts) attempts to
 * look up a well-known contract at the given location. It returns the
 * well-known contract if found, or a Failure if not.
 */
function lookupInWellKnown(
  { network, address }: LookupLocation,
  wellKnownContracts: WellKnownContractsByNetworkAddress,
): Contract | Fallible.Outcome.Of.Failure<string> {
  return wellKnownContracts?.[network]?.[address.toLowerCase()]
      ?? Fallible.Outcome.Of.Failure('contract not found');
}

type HumanizedContractCall = {
  title: string;
  subtitles?: string[];
}

// Parse a readable action message based on a particular contract to show on each governance proposals page.
function describeContractCallForHumans(
  callee:    StandaloneContract,
  signature: string,
  calldata:  string,
  value:     BigFixnum,
  wellKnownContracts: WellKnownContractsByNetworkAddress,
): HumanizedContractCall {
  /*
   * callee-relative lookup helpers
   */
  const lookupContract = (address: Eth.Address) => (
    lookupInWellKnown({ network: callee.network, address }, wellKnownContracts)
  );
  const formatContractAddress = (address: Eth.Address) => (
    formatContractAddressWithMap(callee.network, address, wellKnownContracts)
  );

  const linkToTargetContract = formatContractAddress(callee.address);
  const decodedFunctionData = decodeFunctionDataFromSignature(signature, calldata);
  if (decodedFunctionData === null) {
    if (!value.eq(BigFixnum.from({value: 0}))) {
      return { title: `${value.toString()} ETH to [${nameForDisplay(callee)}](${getEtherscanLink(callee.network, callee.address)})`};
    }
    // When the signature could not be extracted from the calldata, show the
    // full calldata in the UI.
    if (signature === '') {
      return { title: calldata };
    }
    return { title: 'This action could not be decoded' };
  }

  const { functionName, functionValues } = decodedFunctionData;

  try {
    if (functionName == '_acceptAdmin') {
      return { title: `Accept admin for ${linkToTargetContract}`};
    }
    if (functionName == '_acceptImplementation') {
      return { title: `Accept new Comptroller implementation`};
    }
    if (functionName == '_reduceReserves') {
      if (BigNumber.isBigNumber(functionValues[0]) && CTokenv2.is(callee)) {
        const underlyingTokenDecimals = callee.underlying.decimals;
        const reduceAmount = round2(toTokenBase(functionValues[0], underlyingTokenDecimals));
        return { title: `Reduce reserves of ${nameForDisplay(callee)} by ${reduceAmount} ${callee.underlying.canonicalName}` };
      }
      return { title: `Reduce reserves of ${nameForDisplay(callee)}` }
    }
    if (functionName == '_setCloseFactor' && BigNumber.isBigNumber(functionValues[0])) {
      const factor = percent(toWei(functionValues[0]));
      return { title: `Set close factor ${factor}` };
    }
    if (functionName == '_setCollateralFactor' && Eth.parseAddress(functionValues[0]) && BigNumber.isBigNumber(functionValues[1])) {
      const [contractAddress, collateralFactor] = functionValues;
      const formattedContractAddress = formatContractAddress(contractAddress);
      const formattedCollateralFactor = percent(toWei(collateralFactor));
      return { title: `Set ${formattedContractAddress} collateral factor to ${formattedCollateralFactor}` };
    }
    if (functionName == '_setImplementation') {
      return { title: `Set implementation for ${linkToTargetContract}` };
    }
    if (CTokenv2.is(callee) && functionName == '_setInterestRateModel' && Eth.parseAddress(functionValues[0])) {
      return { title: `Set [interest rate model](${getEtherscanLink(
        callee.network,
        functionValues[0],
      )}) for ${linkToTargetContract}` };
    }
    if (functionName == '_setPendingImplementation' && Eth.parseAddress(functionValues[0])) {
      const formattedAddress = formatContractAddress(functionValues[0]);
      return { title: `Comptroller Set Pending Implementation: ${formattedAddress}` };
    }
    if (functionName == '_setPriceOracle' && Eth.parseAddress(functionValues[0])) {
      const formattedAddress = formatContractAddress(functionValues[0]);
      return { title: `Set new price oracle to  ${formattedAddress}` };
    }
    if (functionName == '_setReserveFactor' && BigNumber.isBigNumber(functionValues[0])) {
      const reserveFactor = percent(toWei(functionValues[0]));
      return { title: `Set reserve factor for ${linkToTargetContract} to ${reserveFactor}` };
    }
    if (functionName == '_supportMarket') {
      if (Eth.parseAddress(functionValues[0])) {
        const formattedAssetContract = formatContractAddress(functionValues[0]);
        return { title: `Support ${formattedAssetContract} on Compound` };
      }
      return { title: `Support a new asset on Compound` };
    }
    if (functionName == '_dropCompMarket' && Eth.parseAddress(functionValues[0])) {
      const formattedAssetContract = formatContractAddress(functionValues[0]);
      return { title: `Disable COMP Distribution (${formattedAssetContract})` };
    }
    if (functionName == '_addCompMarkets' && functionValues[0]?.length && functionValues[0].every(Eth.parseAddress)) {
      const assets = functionValues[0] as Eth.Address[];
      const formattedAssets = assets.length == 1 ? formatContractAddress(assets[0]) : `[${assets.map(formatContractAddress).join(', ')}]`;
      return { title: `Enable COMP Distribution (${formattedAssets})` };
    }
    if (functionName == '_setCompRate' && BigNumber.isBigNumber(functionValues[0])) {
      const compRate = functionValues[0];
      const formattedCompRate = round(toWei(compRate), 3);
      return { title: `Comptroller: Set compSpeed to ${formattedCompRate} COMP/block` };
    }
    if (functionName == '_setCompSpeeds' && Array.isArray(functionValues[0]) && functionValues[0].length > 0 && functionValues[0].every(Eth.parseAddress)) {
      const marketAddresses = functionValues[0];
      const marketChanges: string[] = [];
      for (let i = 0; i < functionValues[0].length; ++i) {
        const market = formatContractAddress(marketAddresses[i]);
        const compSupplySpeed = round(toWei(functionValues[1][i]), 3);
        const compBorrowSpeed = round(toWei(functionValues[2][i]), 3);
        marketChanges.push(`Set compSpeed of ${market} to ${compSupplySpeed} COMP/block (supply) and ${compBorrowSpeed} COMP/block (borrow)`);
      }
      return { title: marketChanges.join('. ') };
    }
    if (functionName == '_grantComp' && Eth.parseAddress(functionValues[0]) && BigNumber.isBigNumber(functionValues[1])) {
      const receipient = formatContractAddress(functionValues[0]);
      const compAmount = round(toWei(functionValues[1]), 3);
      return { title: `Grant ${compAmount} COMP to ${receipient}` };
    }
    if (functionName == 'setConfiguration') {
      const newMarketAddress = formatContractAddress(functionValues['cometProxy']);
      const baseTokenContract = lookupContract(functionValues['newConfiguration']['baseToken']);
      if (TokenLike.is(baseTokenContract)) {
        const baseTokenDecimals = baseTokenContract.decimals;

        // Scale up the decimals when dividing to keep precision.
        // Since we're scaling up the numerator and denominator by the same # of decimals, it doesn't
        // affect the result value.
        const trackingIndexScaleDiv = BigFixnum.from({ value: functionValues['newConfiguration']['trackingIndexScale'] });
        const baseTrackingSupplySpeed = BigFixnum.from({ value: functionValues['newConfiguration']['baseTrackingSupplySpeed'] }).div(trackingIndexScaleDiv);
        const baseTrackingBorrowSpeed = BigFixnum.from({ value: functionValues['newConfiguration']['baseTrackingBorrowSpeed'] }).div(trackingIndexScaleDiv);

        const assetConfigs = functionValues['newConfiguration']['assetConfigs'].map((asset: Result) => `{
          **asset**: ${formatContractAddress(asset['asset'])},
          **priceFeed**: ${formatContractAddress(asset['priceFeed'])},
          **decimals**: ${asset['decimals']},
          **borrowCollateralFactor**: ${round2(toWei(asset['borrowCollateralFactor']))},
          **liquidateCollateralFactor**: ${round2(toWei(asset['liquidateCollateralFactor']))},
          **liquidationFactor**: ${round2(toWei(asset['liquidationFactor']))},
          **supplyCap**: ${round2(toTokenBase(asset['supplyCap'], asset['decimals']))}
        }`);
        const marketConfig =  (`{
          **governor**: ${formatContractAddress(functionValues['newConfiguration']['governor'])},
          **pauseGuardian**: ${formatContractAddress(functionValues['newConfiguration']['pauseGuardian'])},
          **baseToken**: ${formatContractAddress(functionValues['newConfiguration']['baseToken'])},
          **baseTokenPriceFeed**: ${formatContractAddress(functionValues['newConfiguration']['baseTokenPriceFeed'])},
          **extensionDelegate**: ${formatContractAddress(functionValues['newConfiguration']['extensionDelegate'])},
          **supplyKink**: ${round2(toWei(functionValues['newConfiguration']['supplyKink']))},
          **supplyPerYearInterestRateSlopeLow**: ${round4(toWei(functionValues['newConfiguration']['supplyPerYearInterestRateSlopeLow']))},
          **supplyPerYearInterestRateSlopeHigh**: ${round4(toWei(functionValues['newConfiguration']['supplyPerYearInterestRateSlopeHigh']))},
          **supplyPerYearInterestRateBase**: ${round4(toWei(functionValues['newConfiguration']['supplyPerYearInterestRateBase']))},
          **borrowKink**: ${round2(toWei(functionValues['newConfiguration']['borrowKink']))},
          **borrowPerYearInterestRateSlopeLow**: ${round4(toWei(functionValues['newConfiguration']['borrowPerYearInterestRateSlopeLow']))},
          **borrowPerYearInterestRateSlopeHigh**: ${round4(toWei(functionValues['newConfiguration']['borrowPerYearInterestRateSlopeHigh']))},
          **borrowPerYearInterestRateBase**: ${round4(toWei(functionValues['newConfiguration']['borrowPerYearInterestRateBase']))},
          **storeFrontPriceFactor**: ${round2(toWei(functionValues['newConfiguration']['storeFrontPriceFactor']))},
          **trackingIndexScale**: ${round2(BigFixnum.from({ value: functionValues['newConfiguration']['trackingIndexScale'], decimals: 0 }).toString())},
          **baseTrackingSupplySpeed**: ${baseTrackingSupplySpeed.toString()},
          **baseTrackingBorrowSpeed**: ${baseTrackingBorrowSpeed.toString()},
          **baseMinForRewards**: ${toTokenBase(functionValues['newConfiguration']['baseMinForRewards'], baseTokenDecimals)},
          **baseBorrowMin**: ${toTokenBase(functionValues['newConfiguration']['baseBorrowMin'], baseTokenDecimals)},
          **targetReserves**: ${toTokenBase(functionValues['newConfiguration']['targetReserves'], baseTokenDecimals)},
          **assetConfigs**: [
            ${assetConfigs.join(`, \n    `)}
          ]
        }`);
        return { title: `Set configuration for ${newMarketAddress} to: ${marketConfig}` };
      }
    }
    if (functionName == 'setSubnodeRecord' && Eth.parseAddress(functionValues[2]) && Eth.parseAddress(functionValues[3])) {
      const [nameHash, labelHash, owner, resolver, _ttl] = functionValues;
      const formattedNameHash = formatENSHash(nameHash);
      const formattedLabelHash = formatENSHash(labelHash);
      const formattedOwnerAddress = formatContractAddress(owner);
      const formattedResolverAddress = formatContractAddress(resolver);
      return { title: `Create new **${formattedLabelHash}** ENS subdomain for **${formattedNameHash}** with ${formattedOwnerAddress} as owner and ${formattedResolverAddress} as resolver` };
    }
    if (functionName == 'setText' && callee.address === wellKnownContracts[callee.network]['ENSResolver']['ens-resolver'].address) {
      const [nameHash, textRecordKey, textRecordValue] = functionValues;
      const formattedNameHash = formatENSHash(nameHash);
      return { title: `Set ENS text record for **${formattedNameHash}** with key: **${textRecordKey}** and value: **${textRecordValue}**` };
    }
    if (functionName == 'setRewardConfig' && Eth.parseAddress(functionValues[0]) && Eth.parseAddress(functionValues[1])) {
      const marketAddress = formatContractAddress(functionValues[0]);
      const rewardTokenAddress = formatContractAddress(functionValues[1]);
      return { title: `Set reward token for market ${marketAddress} as ${rewardTokenAddress}` };
    }
    if (functionName == 'deposit' && callee.address === wellKnownContracts[callee.network]['WETH']['weth-default'].address) {
      return { title: `Wrap ${value.toString()} ETH for ${linkToTargetContract}` }
    }
    if (functionName == 'addAsset' && Eth.parseAddress(functionValues[0])) {
      const marketAddress = formatContractAddress(functionValues[0]);
      const asset = functionValues[1];
      const assetAddress = asset[0];
      const assetContract = lookupContract(assetAddress);
      const assetDecimals = TokenLike.is(assetContract) && assetContract.decimals || 18;
      const assetConfig = `{
        **asset**: ${formatContractAddress(assetAddress)},
        **priceFeed**: ${formatContractAddress(asset[1])},
        **decimals**: ${asset[2]},
        **borrowCollateralFactor**: ${round2(toWei(asset[3]))},
        **liquidateCollateralFactor**: ${round2(toWei(asset[4]))},
        **liquidationFactor**: ${round2(toWei(asset[5]))},
        **supplyCap**: ${round2(toTokenBase(asset[6], assetDecimals))}
      }`;
      return { title: `Add new asset to market ${marketAddress} with asset configuration: ${assetConfig}` };
    }

    // Polygon handlers
    if (
      functionName == 'sendMessageToChild'
      && (callee.network === 'ethereum-mainnet')
      && callee.address === wellKnownContracts[callee.network]['FxRoot']['default'].address
    ) {
      const mappedPolygonNetwork = callee.network === 'ethereum-mainnet' ? 'polygon-mainnet' : 'polygon-mumbai';
      const polygonBridgeReceiverAddress = functionValues[0];
      const isValidPolygonReceiver = polygonBridgeReceiverAddress === wellKnownContracts[mappedPolygonNetwork]['BridgeReceiver']['default'].address;
      const unwrappedActions = defaultAbiCoder.decode(['address[] targets', 'uint256[] values_', 'string[] sigs', 'bytes[] calldatas'], functionValues[1]);
      const formattedActions: string[] = [];
      for (let i = 0; i < unwrappedActions.targets.length; ++i) {
        const targetContract = contractForLocation(
          { network: mappedPolygonNetwork, address: unwrappedActions.targets[i] },
          Eth.wellKnownContractsByNetwork,
        )
        const { signature, data } = governance.proposal.parseSignatureAndCalldata(
          unwrappedActions.sigs[i],
          unwrappedActions.calldatas[i],
        );
        const formattedAction = describeContractCallForHumans(
          targetContract,
          signature,
          data,
          BigFixnum.from({ value: unwrappedActions.values_[i], decimals: 18 }),
          wellKnownContracts,
        );
        formattedActions.push(formattedAction.title);
      }

      if (!isValidPolygonReceiver) {
        return { title: `Bridge wrapped actions to Polygon with UNKNOWN receiver (${polygonBridgeReceiverAddress})`, subtitles: formattedActions };
      }
      const formattedPolygonReceiverAddress = formatContractAddressWithMap(mappedPolygonNetwork, polygonBridgeReceiverAddress, wellKnownContracts);
      return { title: `Bridge wrapped actions to Polygon with ${formattedPolygonReceiverAddress}`, subtitles: formattedActions };
    }
    if (
      functionName == 'approve' && (callee.network === 'ethereum-mainnet')
      && TokenLike.is(callee)
      && functionValues.length === 2 && Eth.parseAddress(functionValues[0])
      && functionValues[0] === wellKnownContracts[callee.network]['PolygonErc20Predicate']['default'].address
    ) {
      const assetDecimals = callee.decimals;
      const assetAmount = toTokenBase(functionValues[1], assetDecimals);

      return { title: `Approve ${assetAmount} ${formatContractAddress(callee.address)} tokens to bridge to Polygon` };
    }
    if (
      functionName === 'depositFor' && (callee.network === 'ethereum-mainnet')
      && functionValues.length === 3
      && callee.address === wellKnownContracts[callee.network]['PolygonBridge']['default'].address
    ) {
      const assetContract = lookupContract(functionValues[1]);
      const assetDecimals = TokenLike.is(assetContract) && assetContract.decimals || 18;
      const assetAmount = toTokenBase(functionValues[2], assetDecimals);
      const mappedPolygonNetwork = callee.network === 'ethereum-mainnet' ? 'polygon-mainnet' : 'polygon-mumbai';
      const formattedPolygonAddress = formatContractAddressWithMap(mappedPolygonNetwork, functionValues[0], wellKnownContracts);
      return { title: `Bridge ${assetAmount} ${formatContractAddress(functionValues[1])} tokens over Polygon to ${formattedPolygonAddress}` };
    }
    // Arbitrum handlers
    if (
      functionName == 'createRetryableTicket'
      && (callee.network === 'ethereum-mainnet')
      && callee.address === wellKnownContracts[callee.network]['ArbitrumInbox']['default'].address
    ) {
      const mappedArbitrumNetwork = callee.network === 'ethereum-mainnet' ? 'arbitrum-mainnet' : 'arbitrum-goerli';
      const arbitrumBridgeReceiverAddress = functionValues[0];
      const isValidArbitrumReceiver = arbitrumBridgeReceiverAddress === wellKnownContracts[mappedArbitrumNetwork]['BridgeReceiver']['default'].address;
      const unwrappedActions = defaultAbiCoder.decode(['address[] targets', 'uint256[] values_', 'string[] sigs', 'bytes[] calldatas'], functionValues[7]);
      const formattedActions: string[] = [];
      for (let i = 0; i < unwrappedActions.targets.length; ++i) {
        const targetContract = contractForLocation(
          { network: mappedArbitrumNetwork, address: unwrappedActions.targets[i] },
          Eth.wellKnownContractsByNetwork,
        )
        const { signature, data } = governance.proposal.parseSignatureAndCalldata(
          unwrappedActions.sigs[i],
          unwrappedActions.calldatas[i],
        );
        const formattedAction = describeContractCallForHumans(
          targetContract,
          signature,
          data,
          BigFixnum.from({ value: unwrappedActions.values_[i], decimals: 18 }),
          wellKnownContracts,
        );
        formattedActions.push(formattedAction.title);
      }

      if (!isValidArbitrumReceiver) {
        return { title: `Bridge wrapped actions to Arbitrum with UNKNOWN receiver (${arbitrumBridgeReceiverAddress})`, subtitles: formattedActions };
      }
      const formattedArbitrumReceiverAddress = formatContractAddressWithMap(mappedArbitrumNetwork, arbitrumBridgeReceiverAddress, wellKnownContracts);
      return { title: `Bridge wrapped actions to Arbitrum with ${formattedArbitrumReceiverAddress}`, subtitles: formattedActions };
    }
    if (
      functionName == 'approve' && (callee.network === 'ethereum-mainnet')
      && TokenLike.is(callee)
      && functionValues.length === 2 && Eth.parseAddress(functionValues[0])
      && (functionValues[0] === wellKnownContracts[callee.network]['ArbitrumERC20Gateway']['default'].address
      || functionValues[0] === wellKnownContracts[callee.network]['ArbitrumCustomUSDCGateway']?.['default'].address)
    ) {
      const assetDecimals = callee.decimals;
      const assetAmount = toTokenBase(functionValues[1], assetDecimals);

      return { title: `Approve ${assetAmount} ${formatContractAddress(callee.address)} tokens to bridge to Arbitrum` };
    }
    if (
      functionName === 'outboundTransferCustomRefund' && (callee.network === 'ethereum-mainnet')
      && functionValues.length === 7
      && callee.address === wellKnownContracts[callee.network]['ArbitrumGatewayRouter']['default'].address
    ) {
      const assetContract = lookupContract(functionValues[0]);
      const assetDecimals = TokenLike.is(assetContract) && assetContract.decimals || 18;
      const assetAmount = toTokenBase(functionValues[3], assetDecimals);
      const mappedArbitrumNetwork = callee.network === 'ethereum-mainnet' ? 'arbitrum-mainnet' : 'arbitrum-goerli';
      const formattedArbitrumAddress = formatContractAddressWithMap(mappedArbitrumNetwork, functionValues[2], wellKnownContracts);
      return { title: `Bridge ${assetAmount} ${formatContractAddress(functionValues[0])} tokens over Arbitrum to ${formattedArbitrumAddress}` };
    }
    // Optimism handlers
    if (
      functionName == 'sendMessage'
      && callee.network === 'ethereum-mainnet'
      && callee.address === wellKnownContracts[callee.network]['OptimismL1CrossDomainMessenger']['default'].address
    ) {
      const mappedOptimismNetwork = 'optimism-mainnet';
      const optimismBridgeReceiverAddress = functionValues[0];
      const isValidOptimismReceiver = optimismBridgeReceiverAddress === wellKnownContracts[mappedOptimismNetwork]['BridgeReceiver']['default'].address;
      const unwrappedActions = defaultAbiCoder.decode(['address[] targets', 'uint256[] values_', 'string[] sigs', 'bytes[] calldatas'], functionValues[1]);
      const formattedActions: string[] = [];
      for (let i = 0; i < unwrappedActions.targets.length; ++i) {
        const targetContract = contractForLocation(
          { network: mappedOptimismNetwork, address: unwrappedActions.targets[i] },
          Eth.wellKnownContractsByNetwork,
        )
        const formattedAction = describeContractCallForHumans(
          targetContract,
          unwrappedActions.sigs[i],
          unwrappedActions.calldatas[i],
          BigFixnum.from({ value: unwrappedActions.values_[i], decimals: 18 }),
          wellKnownContracts,
        );
        formattedActions.push(formattedAction.title);
      }

      if (!isValidOptimismReceiver) {
        return { title: `Bridge wrapped actions to Optimism with UNKNOWN receiver (${optimismBridgeReceiverAddress})`, subtitles: formattedActions };
      }
      const formattedOptimismReceiverAddress = formatContractAddressWithMap(mappedOptimismNetwork, optimismBridgeReceiverAddress, wellKnownContracts);
      return { title: `Bridge wrapped actions to Optimism with ${formattedOptimismReceiverAddress}`, subtitles: formattedActions };
    }

    if (
      functionName == 'approve'
      && callee.network === 'ethereum-mainnet'
      && TokenLike.is(callee)
      && functionValues.length === 2 && Eth.parseAddress(functionValues[0])
      && functionValues[0] === wellKnownContracts[callee.network]['OptimismL1StandardBridge']['default'].address
    ) {
      const assetDecimals = callee.decimals;
      const assetAmount = toTokenBase(functionValues[1], assetDecimals);

      return { title: `Approve ${assetAmount} ${formatContractAddress(callee.address)} tokens to bridge to Optimism` };
    }

    if (
      functionName == 'depositERC20To'
      && callee.network === 'ethereum-mainnet'
      && callee.address === wellKnownContracts[callee.network]['OptimismL1StandardBridge']['default'].address
      && functionValues.length === 6
    ) {
      // function depositERC20To(address _l1Token, address _l2Token, address _to, uint256 _amount, uint32 _l2Gas,bytes calldata _data)
      const assetContract = lookupContract(functionValues[0]);
      const assetDecimals = TokenLike.is(assetContract) && assetContract.decimals || 18;
      const assetAmount = toTokenBase(functionValues[3], assetDecimals);
      const mappedOptimismNetwork = 'optimism-mainnet';
      const formattedOptimismAddress = formatContractAddressWithMap(mappedOptimismNetwork, functionValues[2], wellKnownContracts);
      return { title: `Bridge ${assetAmount} ${formatContractAddress(functionValues[0])} tokens over Optimism to ${formattedOptimismAddress}` };
    }

    // Base handlers
    if(
      functionName == 'sendMessage'
      && (callee.network === 'ethereum-mainnet')
      && callee.address === wellKnownContracts[callee.network]['BaseL1CrossDomainMessenger']['default'].address
    ){
      const mappedBaseNetwork = callee.network === 'ethereum-mainnet' ? 'base-mainnet' : 'base-goerli';
      const baseBridgeReceiverAddress = functionValues[0];
      const isValidBaseReceiver = baseBridgeReceiverAddress === wellKnownContracts[mappedBaseNetwork]['BridgeReceiver']['default'].address;
      const unwrappedActions = defaultAbiCoder.decode(['address[] targets', 'uint256[] values_', 'string[] sigs', 'bytes[] calldatas'], functionValues[1]);
      const formattedActions: string[] = [];
      for (let i = 0; i < unwrappedActions.targets.length; ++i) {
        const targetContract = contractForLocation(
          { network: mappedBaseNetwork, address: unwrappedActions.targets[i] },
          Eth.wellKnownContractsByNetwork,
        )
        const formattedAction = describeContractCallForHumans(
          targetContract,
          unwrappedActions.sigs[i],
          unwrappedActions.calldatas[i],
          BigFixnum.from({ value: unwrappedActions.values_[i], decimals: 18 }),
          wellKnownContracts,
        );
        formattedActions.push(formattedAction.title);
      }

      if (!isValidBaseReceiver) {
        return { title: `Bridge wrapped actions to Base with UNKNOWN receiver (${baseBridgeReceiverAddress})`, subtitles: formattedActions };
      }
      const formattedBaseReceiverAddress = formatContractAddressWithMap(mappedBaseNetwork, baseBridgeReceiverAddress, wellKnownContracts);
      return { title: `Bridge wrapped actions to Base with ${formattedBaseReceiverAddress}`, subtitles: formattedActions };
    }

    if (
      functionName == 'approve'
      && (callee.network === 'ethereum-mainnet')
      && TokenLike.is(callee)
      && functionValues.length === 2 && Eth.parseAddress(functionValues[0])
      && functionValues[0] === wellKnownContracts[callee.network]['BaseL1StandardBridge']['default'].address
    ){
      const assetDecimals = callee.decimals;
      const assetAmount = toTokenBase(functionValues[1], assetDecimals);

      return { title: `Approve ${assetAmount} ${formatContractAddress(callee.address)} tokens to bridge to Base` };
    }

    if (
      functionName == 'depositERC20To'
      && (callee.network === 'ethereum-mainnet')
      && callee.address === wellKnownContracts[callee.network]['BaseL1StandardBridge']['default'].address
      && functionValues.length === 6
    ){
      // function depositERC20To(address _l1Token, address _l2Token, address _to, uint256 _amount, uint32 _l2Gas,bytes calldata _data)
      const assetContract = lookupContract(functionValues[0]);
      const assetDecimals = TokenLike.is(assetContract) && assetContract.decimals || 18;
      const assetAmount = toTokenBase(functionValues[3], assetDecimals);
      const mappedBaseNetwork = callee.network === 'ethereum-mainnet' ? 'base-mainnet' : 'base-goerli';
      const formattedBaseAddress = formatContractAddressWithMap(mappedBaseNetwork, functionValues[2], wellKnownContracts);
      return { title: `Bridge ${assetAmount} ${formatContractAddress(functionValues[0])} tokens over Base to ${formattedBaseAddress}` };
    }

    if (
      functionName == 'depositETHTo'
      && (callee.network === 'ethereum-mainnet')
      && callee.address === wellKnownContracts[callee.network]['BaseL1StandardBridge']['default'].address
      && functionValues.length === 3
    ) {
      // function depositETHTo(address _to, uint32 _l2Gas, bytes calldata _data)
      const mappedBaseNetwork = callee.network === 'ethereum-mainnet' ? 'base-mainnet' : 'base-goerli';
      const formattedBaseAddress = formatContractAddressWithMap(mappedBaseNetwork, functionValues[0], wellKnownContracts);
      return { title: `Bridge ${value} ETH over Base to ${formattedBaseAddress}` };
    }

    // Other handlers
    if (
      functionName == 'transfer' && TokenLike.is(callee) &&
      Eth.parseAddress(functionValues[0]) && BigNumber.isBigNumber(functionValues[1])
    ) {
      const [address, amount] = functionValues;
      const smallestTokenUnit = callee.decimals;
      const formattedAmount = round2(toTokenBase(amount, smallestTokenUnit));

      const formattedDestinationAddress = formatContractAddress(address);
      return { title: `Transfer ${formattedAmount} ${linkToTargetContract} to ${formattedDestinationAddress}` };
    }
    if (functionName == 'updateAssetSupplyCap' && Eth.parseAddress(functionValues[0]) && Eth.parseAddress(functionValues[1]) && BigNumber.isBigNumber(functionValues[2])) {
      const [cometAddress, assetAddress, supplyCap] = functionValues;
      const assetContract = lookupContract(assetAddress);
      const assetDecimals = TokenLike.is(assetContract) && assetContract.decimals || 18;
      const formattedSupplyCap = round2(toTokenBase(supplyCap, assetDecimals));
      const formattedCometAddress = formatContractAddress(cometAddress);
      const formattedAssetAddress = formatContractAddress(assetAddress);
      return { title: `Set supply cap for ${formattedAssetAddress} on ${formattedCometAddress} via ${linkToTargetContract} to ${formattedSupplyCap}` };
    }
    if (functionName == 'updateAssetLiquidationFactor' && Eth.parseAddress(functionValues[0]) && Eth.parseAddress(functionValues[1]) && BigNumber.isBigNumber(functionValues[2])) {
      const [cometAddress, assetAddress, liqudationFactor] = functionValues;
      const formattedLiquidationFactor = percent(toWei(liqudationFactor));
      const formattedCometAddress = formatContractAddress(cometAddress);
      const formattedAssetAddress = formatContractAddress(assetAddress);
      return { title: `Set liquidation factor for ${formattedAssetAddress} on ${formattedCometAddress} via ${linkToTargetContract} to ${formattedLiquidationFactor}` };
    }
    if (functionName == 'deployAndUpgradeTo' && Eth.parseAddress(functionValues[0]) && Eth.parseAddress(functionValues[1])) {
      const [configuratorAddress, cometAddress] = functionValues;
      const formattedConfiguratorAddress = formatContractAddress(configuratorAddress);
      const formattedCometAddress = formatContractAddress(cometAddress);
      return { title: `Deploy and upgrade new implementation for ${formattedCometAddress} via ${formattedConfiguratorAddress}` };
    }

    // In the case it is a valid function signature, but does not match any of the expected cases,
    // still format the function being called with its arguments, e.g. '<target>.<functioncall>(<arg1>, <arg2>, ...)''.
    return defaultFormatFunctionCall({
      formatContractAddress,
      name: functionName,
      args: functionValues as unknown[], // cast from ReadonlyArray<any> to unknown[] is safe
      formattedTarget: linkToTargetContract,
    });
  } catch (e) {
    return defaultFormatFunctionCall({
      formatContractAddress,
      name: functionName,
      args: functionValues as unknown[], // cast from ReadonlyArray<any> to unknown[] is safe
      formattedTarget: linkToTargetContract,
    });
  }
};

function defaultFormatFunctionCall({
  name,
  args,
  formattedTarget,
  formatContractAddress,
}: {
  formatContractAddress: (_: Eth.Address) => string,
  formattedTarget: string,
  name: string,
  args: unknown[],
}) {
  let formattedArgs = args.map(defaultFormatFunctionArg(formatContractAddress));
  // if formatted args is too long, truncate
  if (formattedArgs.length > 50) {
    formattedArgs = formattedArgs.slice(0, 50).concat('...');
  }
  return { title: `${formattedTarget}.${name}(${formattedArgs.join(', ')})` };
}

const defaultFormatFunctionArg = (formatContractAddress: (_: Eth.Address) => string) => (arg: unknown): string => {
  if (true
    && typeof(arg) === 'string'
    && Eth.parseAddress(arg)
  ) {
    return '"' + formatContractAddress(arg) + '"';
  }
  if (typeof(arg) === 'object') {
    if (Array.isArray(arg)) {
      return '[' + truncateList(arg.map(defaultFormatFunctionArg(formatContractAddress)), 50).join(', ') + ']';
    } else if (BigNumber.isBigNumber(arg)) {
      return toTokenBase(arg, 0); // FIXME: this seems wrong -- always 0 decimals, formatted as a fixed-width decimal?
    }
  }
  return `${arg}`; // FIXME: um, does this really do what we want?
}

// Helper functions to format the action titles.
const nameForDisplay = (contract: StandaloneContract) => (contract.displayName ?? contract.canonicalName);
const percent = (val: string) => `${(parseFloat(val) * 100).toFixed(1)}%`;
const round2 = (val: string) => round(val, 2);
const round4 = (val: string) => round(val, 4);
const round = (val: string, decimalPlaces: number) => `${parseFloat(val).toFixed(decimalPlaces)}`;
const toTokenBase = (val: BigNumber, baseTokenUnit: number) => {
  return BigFixnum.from({ value: val, decimals: baseTokenUnit }).toString()
};
const toWei = (val: BigNumber) => {
  return BigFixnum.from({ value: val, decimals: 18 }).toString()
};
const truncateList = (val: unknown[], count: number) => {
  return val.length > 50 ? val.slice(0, count).concat('...') : val;
};

// ENS hashes are chain-agnostic
function formatENSHash(hash: string): string {
  return wellKnownENSHashes[hash] || hash;
};

// Using the contract lookup map, attempt to look up a particular address and format it with
// its etherscan link.
function formatContractAddressWithMap(
  network: KnownNetwork.Name,
  address: Eth.Address,
  wellKnownContracts: WellKnownContractsByNetworkAddress,
) {
  const contract = lookupInWellKnown({ network, address }, wellKnownContracts);
  if (Fallible.isFailure(contract)) {
    return address;
  }
  return `[${nameForDisplay(contract)}](${getEtherscanLink(contract.network, contract.address)})`;
}

function getEtherscanLink(network: KnownNetwork.Name, address: Eth.Address) {
  const etherscanHostMapping: { [name in KnownNetwork.Name]: string } = <const>({
    'polygon-mumbai':   'mumbai.polygonscan.com',
    'polygon-mainnet':  'polygonscan.com',
    'ethereum-sepolia': 'sepolia.etherscan.io',
    'ethereum-mainnet': 'etherscan.io',
    'arbitrum-mainnet': 'arbiscan.io',
    'arbitrum-goerli':  'goerli.arbiscan.io',
    'optimism-mainnet': 'optimistic.etherscan.io',
    'optimism-goerli':  'goerli-optimism.etherscan.io',
    'base-goerli':      'goerli.basescan.org',
    'base-mainnet':     'basescan.org',
    'linea-goerli':     'goerli.lineascan.build',
    'scroll-mainnet':   'scrollscan.com',
    'base-sepolia':     'sepolia.basescan.org',
    'mantle-mainnet':   'mantlescan.xyz',
    'linea-mainnet':    'lineascan.build',
    'unichain-mainnet': 'uniscan.xyz',
    'ronin-mainnet':    'app.roninchain.com',
  });
  const etherscanHost = etherscanHostMapping[network];
  return `https://${etherscanHost}/address/${address}`;
}

// Take the raw function signature and hex encoded calldata, and decode it to obtain
// the function name, and parsed function arguments.
function decodeFunctionDataFromSignature(functionSignature: string, calldata: string) {
  // Check that the function name is made up of alphanumeric characters or '_'.
  // Check that there are no parenthesis '(' ')' within the function parameters.
  const signatureMatch = functionSignature.match(
    new RegExp('^([a-zA-Z0-9_]+)\\((.*)\\)$')
  );

  // NOTE setConfiguration is a particularly difficult function to decode compared to
  // other function signatures. So rather than increasing the complexity of how we decode
  // the function signature by a lot, just handle the setConfiguration function outlier for
  // now individually.
  if (functionSignature.startsWith('setConfiguration(')) {
    const formattedCalldata = calldata.startsWith('0x') ? calldata : `0x${calldata}`;
    const functionValues = defaultAbiCoder.decode(setConfigurationFunctionArgTypes, formattedCalldata);
    return {functionName: 'setConfiguration', functionValues};
  }

  if (!signatureMatch) {
    return null;
  }

  const [functionName, rawFunctionArgs] = signatureMatch.splice(1);

  const functionArgTypes = splitStringWithParens(rawFunctionArgs);
  const formattedCalldata = calldata.startsWith('0x') ? calldata : `0x${calldata}`;
  const functionValues = defaultAbiCoder.decode(functionArgTypes, formattedCalldata);

  return {
    functionName,
    functionValues,
  };
}

// Take the function args from a signature, and split it into a list of args, e.g:
// address,uint64 -> [address, uint64]
// address,(address,address,uint64),address -> [address, (address,address,uint64), address]
function splitStringWithParens(value: string) {
  const result = [];
  let current = '';
  let parenthesesCounter = 0;

  for (const char of value) {
    if (char === '(') {
      parenthesesCounter++;
    } else if (char === ')') {
      parenthesesCounter--;
    } else if (char === ',' && parenthesesCounter === 0) {
      result.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  result.push(current);
  return result;
};

function getNetworkIfCrossChain({ network, target, signature }: {
  network: Extract<KnownNetwork.Name, `ethereum-${'mainnet'}`>,
  target: Eth.Address,
  signature: string
}): (
  | null
  | Exclude<KnownNetwork.Name, `ethereum-${string}`>
) {
  // The source chain bridge needs to be added to crossChainTargets in order to monitor
  // the cross chain proposal states.
  const crossChainTargets: string[] = [
    Eth.wellKnownContractsByNetwork[network]['FxRoot']['default'].address,
    Eth.wellKnownContractsByNetwork[network]['ArbitrumInbox']['default'].address,
    Eth.wellKnownContractsByNetwork[network]['BaseL1CrossDomainMessenger']['default'].address,
  ];
  if (!crossChainTargets.includes(target)) {
    return null;
  }

  const signatureMatch = signature.match(
    new RegExp('^([a-zA-Z0-9_]+)\\((.*)\\)$')
  );

  if (!signatureMatch) {
    return null;
  }

  const functionName = signatureMatch.splice(1)[0];
  const mappedPolygonNetwork = <const>{
    'ethereum-mainnet': 'polygon-mainnet',
    'ethereum-goerli': 'polygon-mumbai',
  };
  const mappedArbitrumNetwork = <const>{
    'ethereum-mainnet': 'arbitrum-mainnet',
    'ethereum-goerli': 'arbitrum-goerli',
  };
  const mappedBaseNetwork = <const>{
    'ethereum-mainnet': 'base-mainnet',
    'ethereum-goerli': 'base-goerli',
  };

  // TODO: Scroll and Optimism are `sendMessage`, add scroll support to cross-chain
  // const mappedScrollNetwork = <const>{
  //   'ethereum-mainnet': 'scroll-mainnet',
  // };
  // const mappedOptimismNetwork = <const>{
  //   'ethereum-mainnet': 'optimism-mainnet',
  // };

  switch (functionName) {
    case 'sendMessageToChild':
      return mappedPolygonNetwork[network];
    case 'createRetryableTicket':
      return mappedArbitrumNetwork[network];
    case 'sendMessage':
      return mappedBaseNetwork[network];
    default:
      return null;
  }
}

/**
 * Helper function to convert a token amount to a string
 *
 * @param network Network
 * @param address Address of the token, if its comet's cUSDCv3 or cWETHv3, we use the base token
 * @param amount Amount of the token
 * @returns Stringified amount
 */
function stringifyTokenAmount(network: KnownNetwork.Name, address: Eth.Address, amount: BigNumber): string {
  return toTokenBase(amount, getTokenDecimals(network, address));
}

function getTokenSymbol(network: KnownNetwork.Name, address: Eth.Address): string {
  const tokenContract = lookupInWellKnown({ network, address }, Eth.wellKnownContractsByNetwork);
  if (Comet.is(tokenContract))     return tokenContract.base.asset.canonicalName;
  if (TokenLike.is(tokenContract)) return tokenContract.canonicalName;
  else                             return '';
}

function getBaseTokenAddress(network: KnownNetwork.Name, address: Eth.Address): Eth.Address {
  const contract = lookupInWellKnown({ network, address }, Eth.wellKnownContractsByNetwork);
  if (Comet.is(contract)) return contract.base.asset.address;
  else                    return '0x0';
}

function getTokenDecimals(network: KnownNetwork.Name, address: Eth.Address): number {
  const contract = lookupInWellKnown({ network, address }, Eth.wellKnownContractsByNetwork);
  if (Comet.is(contract))     return contract.base.asset.decimals;
  if (TokenLike.is(contract)) return contract.decimals;
  else                        return 18;
}

function getCometContractsForNetwork (networkName: KnownNetwork.Name): Eth.Contract<StandaloneContract<Comet>>[] {
  const wellKnownContracts = Eth.wellKnownContractsByNetwork[networkName];
  if (!('Comet' in wellKnownContracts)) {
    return [];
  }
  const marketContracts: Eth.Contract<StandaloneContract<Comet>>[] =
    Object.values(wellKnownContracts['Comet']);

  const uniqueMarketContracts = marketContracts.filter(
    (contract, index) =>
      index ===
      marketContracts.findIndex(
        (otherContract) => contract.address === otherContract.address
      )
  );

  return uniqueMarketContracts;
};

export {
  StaticWellKnownContracts,
  lookupInWellKnown,
  contractForLocation,
  describeContractCallForHumans,
  decodeFunctionDataFromSignature,
  getNetworkIfCrossChain,
  stringifyTokenAmount,
  getTokenSymbol,
  getBaseTokenAddress,
  getTokenDecimals,
  getCometContractsForNetwork,
};
