import t from 'tap';

import { defaultAbiCoder } from '@ethersproject/abi';
import { id }              from '@ethersproject/hash';

import * as Eth      from '../../../../lib/eth-constants.js';
import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as evm   from '../../../../lib/computations/evm.js';
import * as comet from '../../../../lib/computations/comet.js';

import type * as jsonRpc from '../../../../lib/json-rpc.js';

import * as mock from '../../../util/mock/mock.js';
import { fixtureComet } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * What a Comet says about one of its assets: the token, its feed and scale,
 * and the risk parameters the market summary reports as the Comet stores
 * them, each from its own field of the struct.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const network  = 'ethereum-mainnet' as const;
const nodeHost = 'node.test';
const nodeKey  = 'key';
const contract = fixtureComet(network, '0xc3d688b66703497daa19211eedff47f25384cdc3');
const block    = 21_000_000;

const ASSET_INFO = 'tuple(uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap)';

// COMP, the first asset of the USDC market, as its Comet describes it
const COMP = {
  asset:                     '0xc00e94Cb662C3520282E6f5717214004A7f26888',
  priceFeed:                 '0xdbd020CAeF83eFd542f4De03e3cF0C28A4428bd5',
  scale:                     '1000000000000000000',
  borrowCollateralFactor:    '500000000000000000',
  liquidateCollateralFactor: '700000000000000000',
  liquidationFactor:         '750000000000000000',
  supplyCap:                 '100000000000000000000000',
};

// getAssetInfo(assetNumber)
function assetInfoCall(assetNumber: number): string {
  return `${id('getAssetInfo(uint8)').slice(0, 10)}${assetNumber.toString(16).padStart(64, '0')}`;
}

declare var fetch: mock.Fetch;
t.before(() => {
  global.fetch = mock.fetch({ passthrough: false });
});

function answerWith(assetNumber: number, info: typeof COMP) {
  const request: jsonRpc.Request = {
    jsonrpc: '2.0',
    id:      0,
    method:  'eth_call',
    params:  [ { to: contract.address, data: assetInfoCall(assetNumber) }, `0x${block.toString(16)}` ],
  };
  mock.rpc.expectPost(fetch, Eth.nodeEndpoint(nodeHost, nodeKey, network), [
    request,
    { jsonrpc: '2.0', id: 0, result: defaultAbiCoder.encode([ ASSET_INFO ], [ { offset: assetNumber, ...info } ]) },
  ]);
}

function assetInfoOf(assetNumber: number) {
  const cache = new MemoryCache({}, [ BigNumber.JsonReviver, BigFixnum.JsonReviver ]);
  const { pull1, evaluate } = Evaluator.instantiate<comet.AssetInfo>({ ...evm, ...comet }, { cache, debug, flags });
  return evaluate(pull1({
    assetInfo: { apiHost: '', nodeHost, nodeKey, network, contract, blockNumber: block, assetNumber },
  }));
}

t.test('an asset is read with its risk parameters', async t => {
  answerWith(0, COMP);
  const info = await assetInfoOf(0);

  // each number written out; one that is not a BigNumber is left as it is, and matches nothing
  const written = Object.fromEntries(Object.entries(info).map(([ name, value ]) => [
    name,
    BigNumber.isBigNumber(value) ? value.toString() : value,
  ]));
  t.strictSame(written, COMP, 'the factors at 1e18 and the cap in the asset\'s units, each from its own field');
  fetch.satisfy(t);
});
