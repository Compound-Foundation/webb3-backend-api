import t from 'tap';

/*
 * NOTE: eth-constants MUST be imported before contracts/utils.
 *
 * utils.ts imports eth-constants.js ahead of types.js, and eth-constants
 * evaluates every per-network contracts file, each of which calls ERC20()
 * and friends at module scope. Entering the module graph at utils.js
 * therefore runs those calls before types.js has initialized
 * ContractTypeTag, throwing "Cannot access 'ContractTypeTag' before
 * initialization". Entering at eth-constants.js -- as the worker entrypoint
 * and every other test does -- orders the cycle correctly.
 */
import { wellKnownContractsByNetwork } from '../../../../lib/eth-constants.js';

import { getCometContractsForNetwork } from '../../../../lib/well-known/contracts/utils.js';

import '../../../../shim/node-self.js';

const network = 'ethereum-mainnet' as const;
const iusdcAddress = '0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C';
const iusdgAddress = '0xe58fC3D0ECcB7dE485CD1F477427b680c96436d0';
const cometRewardsAddress = '0x1b0e765f6224c21223aea2af16c1c46e38885a40';

t.test('ciUSDCv3 is aggregated alongside the other ethereum-mainnet markets', async t => {
  const contracts = getCometContractsForNetwork(network);

  t.ok(
    contracts.some(({ address }) => address === iusdcAddress),
    'ciUSDCv3 is returned by getCometContractsForNetwork'
  );
  t.ok(
    contracts.some(({ address }) => address === iusdgAddress),
    'ciUSDGv3 is returned by getCometContractsForNetwork'
  );
  t.ok(
    contracts.some(({ displayName }) => displayName === 'cUSDCv3'),
    'the other markets are still present'
  );
});

/*
 * get-reward-configs-sleuth.ts batches every comet returned for a network into
 * a single Sleuth query issued against cometMarkets[0].rewards.contract -- it
 * assumes one CometRewards per network, and flags that assumption in a comment
 * at line 78. That assumption is only true as long as every declared comet
 * points at the same CometRewards.
 *
 * If this test fails, some market's reward config is being read from the wrong
 * rewards contract and will silently come back zero. The fix is not to reorder
 * contractData -- it is to teach get-reward-configs-sleuth.ts to batch per
 * rewards contract.
 */
t.test('every ethereum-mainnet market shares one CometRewards', async t => {
  const contracts = getCometContractsForNetwork(network);

  t.ok(contracts.length > 1, 'there is more than one market to compare');
  for (const comet of contracts) {
    t.equal(
      comet.rewards.contract.address.toLowerCase(),
      cometRewardsAddress,
      `${comet.displayName ?? comet.address} uses the canonical CometRewards`
    );
  }
});

t.test('registry lookups resolve ciUSDCv3', async t => {
  const wellKnown = wellKnownContractsByNetwork[network];

  t.equal(
    (wellKnown as any)[iusdcAddress].displayName,
    'ciUSDCv3',
    'resolves by address'
  );
  t.equal(
    (wellKnown as any)[iusdcAddress.toLowerCase()].displayName,
    'ciUSDCv3',
    'resolves by lowercased address'
  );
  t.equal(
    (wellKnown as any)['Comet']['ciUSDCv3'].address,
    iusdcAddress,
    'resolves by displayName alias'
  );
  t.equal(
    (wellKnown as any)['Comet']['01-iusdc'].address,
    iusdcAddress,
    'resolves by 01-iusdc alias'
  );
  t.equal(
    (wellKnown as any)['CometRewards']['default'].address,
    cometRewardsAddress,
    'the canonical CometRewards still owns the default alias'
  );
});

t.test('registry lookups resolve ciUSDGv3', async t => {
  const wellKnown = wellKnownContractsByNetwork[network];

  t.equal(
    (wellKnown as any)[iusdgAddress].displayName,
    'ciUSDGv3',
    'resolves by address'
  );
  t.equal(
    (wellKnown as any)[iusdgAddress.toLowerCase()].displayName,
    'ciUSDGv3',
    'resolves by lowercased address'
  );
  t.equal(
    (wellKnown as any)['Comet']['ciUSDGv3'].address,
    iusdgAddress,
    'resolves by displayName alias'
  );
  t.equal(
    (wellKnown as any)['Comet']['01-iusdg'].address,
    iusdgAddress,
    'resolves by 01-iusdg alias'
  );
  t.equal(
    (wellKnown as any)['Comet']['ciUSDGv3'].base.asset.symbol,
    'USDG',
    'the base asset is USDG'
  );
});
