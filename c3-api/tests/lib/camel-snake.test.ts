import t from 'tap';

import { BigNumber } from '../../lib/bignumber.js';
import { BigFixnum } from '../../lib/bigfixnum.js';

import { snakeifyCamelObject, snakeifyCamelObjectDeep } from '../../lib/camel-snake.js';

/*
 * The routes answer what a computation reports in camelCase with its keys in
 * snake_case. Most rename only the fields of an entry, and answer what it
 * nests as they always have; the market summary renames every key it nests.
 */
const COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const COMP  = '0xc00e94Cb662C3520282E6f5717214004A7f26888';

// an entry as a computation reports it, made anew for each use, so that one changed in place shows
const entry = () => ({
  chainId:                1,
  comet:                  { address: COMET },
  status:                 'success',
  collateralAssetSymbols: [ 'COMP', 'WETH' ],
  rateModel:              { borrow: { kink: '900000000000000000', slopeLow: '880834601' } },
  collaterals:            [ { address: COMP, priceUsd: '42.17', totalSupply: '3000000000000000000' } ],
});

t.test('the shallow form renames the fields of an entry, and answers what it nests as it is', async t => {
  const target = entry();
  const snaked = snakeifyCamelObject(target);
  t.strictSame(snaked, {
    chain_id:                 1,
    comet:                    { address: COMET },
    status:                   'success',
    collateral_asset_symbols: [ 'COMP', 'WETH' ],
    rate_model:               { borrow: { kink: '900000000000000000', slopeLow: '880834601' } },
    collaterals:              [ { address: COMP, priceUsd: '42.17', totalSupply: '3000000000000000000' } ],
  });
  t.equal(snaked.rate_model, target.rateModel, 'the very objects it nests');
  t.equal(snaked.collaterals, target.collaterals);
  t.strictSame(target, entry(), 'and the entry is left as it was');
});

t.test('the deep form renames every key it nests, in objects and in arrays, where it was', async t => {
  const target   = entry();
  const snaked   = snakeifyCamelObjectDeep(target);
  const expected = {
    chain_id:                 1,
    comet:                    { address: COMET },
    status:                   'success',
    collateral_asset_symbols: [ 'COMP', 'WETH' ],
    rate_model:               { borrow: { kink: '900000000000000000', slope_low: '880834601' } },
    collaterals:              [ { address: COMP, price_usd: '42.17', total_supply: '3000000000000000000' } ],
  };
  t.strictSame(snaked, expected);
  t.equal(JSON.stringify(snaked), JSON.stringify(expected), 'each key in its place');
  t.strictSame(target, entry(), 'and the entry is left as it was');
});

/*
 * Only a plain object is renamed. Any other value is kept as it is, and an
 * instance of a class is not a plain object: renamed field by field it would
 * lose what JSON writes it as.
 */
t.test('the deep form keeps every other value as it is', async t => {
  const value  = BigFixnum.from({ decimals: 2, value: 4217 });
  const supply = BigNumber.from(10).pow(18);
  const snaked = snakeifyCamelObjectDeep({
    totalValue:       value,
    nestedLists:      [ [ { totalSupply: supply } ] ],
    message:          null,
    isPaused:         false,
    withoutPrototype: Object.assign(Object.create(null), { slopeHigh: '114155251141' }),
  });
  t.equal(snaked.total_value, value, 'an instance of a class');
  t.equal(snaked.nested_lists[0][0].total_supply, supply, 'however deep it is nested');
  t.equal(JSON.stringify(snaked.total_value), JSON.stringify(value), 'which JSON writes as its own toJSON has it');
  t.strictSame([ snaked.message, snaked.is_paused ], [ null, false ], 'and null and false as they are');
  t.strictSame(snaked.without_prototype, { slope_high: '114155251141' }, 'while an object without a prototype is plain, and renamed');
});
