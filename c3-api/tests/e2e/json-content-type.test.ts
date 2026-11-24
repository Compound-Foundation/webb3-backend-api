import t, { Test } from 'tap';

import { Interface, defaultAbiCoder } from '@ethersproject/abi';
import { BigNumber } from '@ethersproject/bignumber';

import C3Api, { Env } from '../../entrypoint.js';

import * as Eth from '../../lib/eth-constants.js';
import * as v2 from '../../lib/model/v2.js';
import type { RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';
import { ctokenv2s } from '../../lib/well-known/contracts/ethereum-mainnet.js';

import { fakeNode, serve } from '../util/fake-node.js';
import { activeRegistryDatabase } from '../util/registry-database.js';
import { loadRegistrySnapshotFixture } from '../util/registry-fixture.js';
import { makeTestEnv } from '../util/test-env.js';

import '../../shim/node-self.js';

/*
 * The market, account, governance and transaction history routes and the
 * legacy cTokens route label an answer in JSON as JSON, as the registry and
 * the error envelope already do. They used to send it without a content
 * type, which the runtime labels as text, so a client or a gateway that goes
 * by the type read it as text. Only the label changes: each answer keeps its
 * status and its body, which is compared here with what the route answered
 * before. A 400 in a line of plain text stays text.
 *
 * One request of each kind of route, through the worker's own entry point
 * and without a network: a market route, an account route, a governance
 * route, the legacy cTokens route and the transaction history. A market and
 * an account are read from a fake node over the fixture cut down to
 * mainnet's USDC market, so an answer that lists every market lists one.
 */
const JSON_TYPE = 'application/json; charset=utf-8';

const LATEST  = { number: 30_000_000, timestamp: 1_790_000_000 };
const USDC    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const ACCOUNT = '0x420f253087044b8bcf028dd89f8fe83ba6275e84';

function usdcOnly(): RegistrySnapshotV1 {
  const fixture = loadRegistrySnapshotFixture();
  return {
    ...fixture,
    networks: fixture.networks.filter(network => network.chainId === 1).map(network => ({
      ...network,
      markets: network.markets.filter(market => market.contracts.comet === USDC),
    })),
  };
}

/*
 * The worker over a database whose active version is `snapshot`, with a
 * memory cache of the test's own.
 */
async function workerOf(t: Test, snapshot: RegistrySnapshotV1) {
  const registry = await activeRegistryDatabase({ snapshot });
  t.teardown(() => registry.dispose());
  const env: Env = makeTestEnv({ APP_DB: registry.db, MEMORY_CACHE_SEED: `json-content-type: ${t.fullname}` });
  return (path: string) => C3Api.fetch(new Request(`https://api.test.local${path}`), env);
}

// an answer labelled as JSON, with the status and the body the route answered before
async function answeredAsJson(t: Test, response: Response, status: number, body: unknown): Promise<void> {
  t.equal(response.status, status, `answered with ${status}`);
  t.equal(response.headers.get('content-type'), JSON_TYPE, 'labelled as JSON');
  t.strictSame(await response.json(), body, 'with the body it had before');
}

type Call = { id: number, method: string, params: any[] };

// a node that answers each call of a JSON-RPC request, or of a batch of them, as `answer` says
function nodeAnswering(answer: (call: Call) => object) {
  return async (input: string | Request, init?: RequestInit): Promise<Response> => {
    const body    = await new Request(input, init).json() as Call | Call[];
    const calls   = body instanceof Array ? body : [ body ];
    const answers = calls.map(call => ({ jsonrpc: '2.0', id: call.id, ...answer(call) }));
    return new Response(JSON.stringify(body instanceof Array ? answers : answers[0]));
  };
}

// a block, twelve seconds older than the latest for each block below it
function blockAt(reference: string) {
  const number = reference === 'latest' ? LATEST.number : parseInt(reference, 16);
  return {
    number:       Eth.Hex.fromNumber(number),
    timestamp:    Eth.Hex.fromNumber(LATEST.timestamp - (LATEST.number - number) * 12),
    transactions: [],
  };
}

t.test('a market route labels its answers in JSON as JSON, a 400 among them', async t => {
  const snapshot = usdcOnly();
  const get      = await workerOf(t, snapshot);
  serve(t, fakeNode(snapshot, LATEST));

  await answeredAsJson(t, await get(`/market/ethereum-mainnet/${USDC}/rewards/summary`), 200, {
    status:                         'success',
    supply_rewards_apr:             '315360.0',
    borrow_rewards_apr:             '315360.0',
    supply_rewards_rate_per_second: '1.0',
    borrow_rewards_rate_per_second: '1.0',
  });
  // a malformed parameter this route answers in JSON rather than in a line of plain text
  await answeredAsJson(t, await get('/market/all-networks/all-contracts/rewards/summary'), 400, {
    error: 'Invalid network name for route',
  });
});

t.test('an account route labels its answer as JSON', async t => {
  const snapshot = usdcOnly();
  const get      = await workerOf(t, snapshot);
  serve(t, fakeNode(snapshot, LATEST));

  await answeredAsJson(t, await get(`/account/${ACCOUNT}/rewards`), 200, [ {
    status:        'success',
    chain_id:      1,
    comet:         { address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3' },
    comet_rewards: { address: '0x1B0e765F6224C21223AeA2af16c1C46E38885a40' },
    base_asset:    {
      address:     '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      decimals:    6,
      description: 'USD Coin',
      symbol:      'USDC',
      minBorrow:   '100.0',
      priceFeed:   '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
    },
    reward_asset:  {
      address:     '0xc00e94Cb662C3520282E6f5717214004A7f26888',
      decimals:    18,
      description: 'Compound',
      price:       '1.0',
      symbol:      'COMP',
    },
    earn_rewards_apr:   '315360.0',
    borrow_rewards_apr: '315360.0',
    amount_owed:        '0.0000000001',
    wallet_balance:     '0.0000000001',
    supply_balance:     '100.0',
    borrow_balance:     '100.0',
  } ]);
});

t.test('a governance route labels its answer as JSON', async t => {
  const get = await workerOf(t, usdcOnly());
  // Tally's profile of the account, which is what the route asks for
  t.capture(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: { accounts: [ {
    id:             `eip155:1:${ACCOUNT}`,
    name:           'An account',
    address:        ACCOUNT,
    picture:        null,
    participations: [ { stats: {
      voteCount:       3,
      tokenBalance:    '1500000000000000000',
      delegationCount: 2,
      votingPower:     { net: '2500000000000000000' },
    } } ],
  } ] } })));

  await answeredAsJson(t, await get(`/governance/ethereum-mainnet/comp/accounts?addresses=${ACCOUNT}`), 200, { accounts: [ {
    votes:           '2.5',
    balance:         '1.5',
    vote_weight:     '2.5',
    address:         ACCOUNT,
    image_url:       null,
    display_name:    'An account',
    proposals_voted: 3,
    total_delegates: 2,
  } ] });
});

/*
 * The lens answers every cToken alike in units of its own decimals — one
 * unit borrowed, one in cash, one cToken, at a price of one, and no rates —
 * so each is answered with the same values.
 */
const LENS = new Interface([
  `function cTokenMetadata(address) returns (${v2.ctokens.CTokenMetadataStruct})`,
  `function cTokenUnderlyingPrice(address) returns (${v2.ctokens.CTokenUnderlyingPriceStruct})`,
]);

function lensAnswer({ method, params }: Call): object {
  if (method === 'eth_getBlockByNumber') {
    return { result: blockAt(params[0]) };
  }
  const [ { data } ] = params;
  const fragment     = LENS.getFunction(data.slice(0, 10));
  const [ address ]  = LENS.decodeFunctionData(fragment, data);
  const ctoken       = ctokenv2s.find(candidate => candidate.address.toLowerCase() === String(address).toLowerCase())!;
  const units        = (decimals: number) => BigNumber.from(10).pow(decimals);
  const underlying   = ctoken.underlying.decimals;
  if (fragment.name === 'cTokenUnderlyingPrice') {
    return { result: LENS.encodeFunctionResult(fragment, [ [ ctoken.address, units(36 - underlying) ] ]) };
  }
  return { result: LENS.encodeFunctionResult(fragment, [ [
    ctoken.address,
    units(18 + underlying - ctoken.decimals), // exchangeRateCurrent
    0,                                        // supplyRatePerBlock
    0,                                        // borrowRatePerBlock
    units(17),                                // reserveFactorMantissa
    units(underlying),                        // totalBorrows
    0,                                        // totalReserves
    units(ctoken.decimals),                   // totalSupply
    units(underlying),                        // totalCash
    true,                                     // isListed
    units(17).mul(5),                         // collateralFactorMantissa
    ctoken.underlying.address,
    ctoken.decimals,
    underlying,
    0,                                        // compSupplySpeed
    0,                                        // compBorrowSpeed
    0,                                        // borrowCap
  ] ]) };
}

t.test('the legacy cTokens route labels its answer as JSON', async t => {
  const get = await workerOf(t, usdcOnly());
  t.capture(globalThis, 'fetch', nodeAnswering(lensAnswer));

  await answeredAsJson(t, await get('/legacy/mainnet/ctokens'), 200, { cToken: ctokenv2s.map(ctoken => ({
    name:               ctoken.description,
    underlying_name:    ctoken.underlying.description,
    symbol:             ctoken.canonicalName,
    underlying_symbol:  ctoken.underlying.canonicalName,
    token_address:      ctoken.address,
    underlying_address: ctoken.underlying.address,
    borrow_rate:        '0',
    supply_rate:        '0',
    borrow_cap:         '0.0',
    collateral_factor:  '0.5',
    comp_borrow_apy:    '0',
    comp_supply_apy:    '0',
    exchange_rate:      '1.0',
    reserve_factor:     '0.1',
    reserves:           '0.0',
    total_borrows:      '1.0',
    total_supply:       '1.0',
    underlying_price:   '1.0',
    total_supply_value: '2.0',
    total_borrow_value: '1.0',
  })) });
});

// an account without a log in any market, and without a DeFi Saver proxy
function historyAnswer({ method, params }: Call): object {
  switch (method) {
    case 'eth_getBlockByNumber': return { result: blockAt(params[0]) };
    case 'eth_getLogs':          return { result: [] };
    default:                     return { result: defaultAbiCoder.encode([ 'address', 'address[]' ], [ Eth.NullAddress, [] ]) };
  }
}

/*
 * Both pages are labelled: the first, and the one a cursor resumes. The
 * cursor is the digest of what the page read, so only its form is compared.
 */
t.test('the transaction history labels its pages as JSON', async t => {
  const get = await workerOf(t, usdcOnly());
  t.capture(globalThis, 'fetch', nodeAnswering(historyAnswer));

  const first = await get(`/account/${ACCOUNT}/transaction_history`);
  const { cursor } = await first.clone().json() as { cursor: string };
  t.match(cursor, /^[0-9a-f]{64}$/, 'with a cursor');
  await answeredAsJson(t, first, 200, { done: true, cursor, item_count: 0, item_limit: 15, items: [] });

  const next = await get(`/account/${ACCOUNT}/transaction_history?cursor=${cursor}`);
  await answeredAsJson(t, next, 200, { done: true, cursor, item_count: 0, item_limit: 15, items: [] });
});

t.test('a 400 in a line of plain text stays text', async t => {
  const get      = await workerOf(t, usdcOnly());
  const response = await get('/account/not-an-address/rewards');
  t.equal(response.status, 400);
  t.equal(response.headers.get('content-type'), 'text/plain;charset=UTF-8', 'labelled as text');
  t.equal(await response.text(), 'Error: Bad account address: not-an-address');
});
