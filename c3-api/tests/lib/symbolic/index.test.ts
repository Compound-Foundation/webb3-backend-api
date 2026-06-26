import t, { Test } from 'tap';

import * as Index    from '../../../lib/symbolic/index.js';
import * as Fallible from '../../../lib/fallible/fallible.js';

type ContractAtBlockNumber = {
  blockNumber: number,
  contract: { creationBlock: number },
};

const blockNumberRangeIndex = Index.BlockNumberRange<ContractAtBlockNumber>({
  stride: 100_000,
  start: ({ contract: { creationBlock } }) => creationBlock,
});

type TestMethods = (
  | 'seek'
  | 'covers'
  | 'project'
  | 'includes'
  | 'enumerate'
  | 'preceding'
  | 'succeeding'
  | 'countFromStartTo'
);

/*
 * I guess this is what we have to do in order to make node-tap a usable
 * testing framework: wrap it in an actually not terrible API?
 */
const testMethod =
  <MethodName extends TestMethods>(t: Test, method: MethodName) =>
  <Args extends Parameters<(typeof blockNumberRangeIndex)[MethodName]>>(...args: Args) =>
  (expect: (
    | ReturnType<(typeof blockNumberRangeIndex)[MethodName]>
    | ((t: Test, result: ReturnType<(typeof blockNumberRangeIndex)[MethodName]>) => void)
  )) =>
{
  return t.test(`${method}(${args.map(a => JSON.stringify(a)).join(', ')})`, t => {
    // FIXME(jordan): smfh apparently the compiler cannot figure this out
    // const result = blockNumberRangeIndex[method](...args);
    const result = (blockNumberRangeIndex[method] as any)(...args);
    if (typeof(expect) === 'function') {
      expect(t, result as any);
    } else {
      t.strictSame(result, expect);
    }
    t.end(); // you know what, I don't like node-tap.
  });
}

const atContract =
  (contract:    ContractAtBlockNumber['contract']) =>
  (blockNumber: ContractAtBlockNumber['blockNumber']): ContractAtBlockNumber =>
{
  return { contract, blockNumber };
}

t.test(`BlockNumberRangeIndex({ stride: 100_000, start: creationBlock })`, async t => {
  const block = atContract({ creationBlock: 50_000 });

  t.strictSame(blockNumberRangeIndex.   end(block(0)), undefined);
  t.strictSame(blockNumberRangeIndex. start(block(0)),    50_000);
  t.strictSame(blockNumberRangeIndex.stride(block(0)),   100_000);
  t.strictSame(
    blockNumberRangeIndex.start({
      blockNumber: 0,
      contract: { creationBlock: 147_018 },
    }),
    147_018,
    `start bound is context.contract.creationBlock, whatever is passed in`
  );

  const covers = testMethod(t, 'covers');
  covers(block(20_000))(false);
  covers(block(50_000))( true);
  covers(block(75_000))( true);

  const includes = testMethod(t, 'includes');
  includes(block(20_000))(false);
  includes(block(50_000))( true);
  includes(block(75_000))(false);

  const project = testMethod(t, 'project');
  project(block( 20_000))((t, outcome) => t.ok(Fallible.isFailure(outcome)));
  project(block( 50_000))(block(50_000));
  project(block( 75_000))(block(50_000));
  project(block(175_000))(block(150_000));

  const preceding = testMethod(t, 'preceding');
  preceding(block( 50_000))((t, outcome) => t.ok(Fallible.isFailure(outcome)));
  preceding(block( 75_000))(block( 50_000));
  preceding(block(175_000))(block(150_000));

  const succeeding = testMethod(t, 'succeeding');
  succeeding(block( 50_000))(block(150_000));
  succeeding(block( 75_000))(block(150_000));
  succeeding(block(175_000))(block(250_000));

  const seek = testMethod(t, 'seek');
  seek(block( 20_000), 12)((t, outcome) => t.ok(Fallible.isFailure(outcome))); // out of bounds origin
  seek(block( 50_000), -1)((t, outcome) => t.ok(Fallible.isFailure(outcome))); // out of bounds result
  seek(block( 50_000),  0)(block( 50_000));
  seek(block( 75_000),  0)(block( 50_000));
  seek(block( 75_000), -1)(block( 50_000));
  seek(block(175_000), -2)(block( 50_000));
  seek(block( 75_000), -2)((t, outcome) => t.ok(Fallible.isFailure(outcome))); // out of bounds result
  seek(block( 75_000),  1)(block(150_000));
  seek(block( 75_000),  5)(block(550_000));
  seek(block(550_000), -5)(block( 50_000));
  seek(block(550_000), -6)((t, outcome) => t.ok(Fallible.isFailure(outcome))); // out of bounds result

  const enumerate = testMethod(t, 'enumerate');
  enumerate(block( 20_000), 12)((t, outcome) => t.ok(Fallible.isFailure(outcome))); // unindexed origin
  enumerate(block( 50_000), -2)((t, outcome) => t.ok(Fallible.isFailure(outcome))); // out of bounds result
  enumerate(block( 50_000),  0)([]); // ask for 0 from indexed, get nothing
  enumerate(block( 75_000),  0)([]); // ask for 0 from covered, get nothing
  // asking for +1 and -1 is the same from an indexed value...
  enumerate(block( 50_000),  1)([ block( 50_000) ]);
  enumerate(block( 50_000), -1)([ block( 50_000) ]);
  // ... but different from a covered but not indexed value
  enumerate(block( 75_000), -1)([ block( 50_000) ]);
  enumerate(block( 75_000),  1)([ block(150_000) ]);
  //
  enumerate(block(150_000), -1)([ block(150_000) ]);
  enumerate(block(150_000), -2)([ block(150_000), block( 50_000) ]);
  enumerate(block(175_000), -2)([ block(150_000), block( 50_000) ]);
  enumerate(block(175_000), -3)((t, outcome) => t.ok(Fallible.isFailure(outcome))); // out of bounds result
  enumerate(block( 75_000),  5)([
    block(150_000),
    block(250_000),
    block(350_000),
    block(450_000),
    block(550_000),
  ]);
  // enumerate is endpoints-inclusive
  enumerate(block(150_000),  5)([
    block(150_000),
    block(250_000),
    block(350_000),
    block(450_000),
    block(550_000),
  ]);
  enumerate(block(550_000), -6)([
    block(550_000),
    block(450_000),
    block(350_000),
    block(250_000),
    block(150_000),
    block( 50_000),
  ]);
  enumerate(block(550_000), -7)((t, outcome) => t.ok(Fallible.isFailure(outcome))); // out of bounds result

  const countFromStartTo = testMethod(t, 'countFromStartTo');
  countFromStartTo(block( 20_000))((t, outcome) => t.ok(Fallible.isFailure(outcome))); // out of bounds target
  countFromStartTo(block( 50_000))(1);
  countFromStartTo(block( 75_000))(1);
  countFromStartTo(block(150_000))(2);
  countFromStartTo(block(175_000))(2);
  countFromStartTo(block(200_000))(2);
  countFromStartTo(block(249_999))(2);
  countFromStartTo(block(250_000))(3);
  countFromStartTo(block(250_001))(3);
  countFromStartTo(block(550_000))(6);
  // TODO: if there's an endpoint, target > end is Failure out of bounds
});
