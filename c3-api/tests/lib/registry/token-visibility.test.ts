import t from 'tap';

import { BigFixnum } from '../../../lib/bigfixnum.js';

import type { VisibilityV1 } from '../../../lib/model/comet-registry.js';

import {
  visibilityHere,
  visibilityOf,
} from '../../../src/registry/token-visibility.js';
import type { Exclusion } from '../../../src/registry/token-visibility.js';

/*
 * The visibility rule without a node: how a collateral's value in its market
 * decides whether discovery shows the token there. What holds of a token
 * across its chain is summary-tokens.test.ts's.
 */

// a collateral worth `usd` in its market, every digit of it, or one whose value could not be read
const worth = (usd: string | null): BigFixnum | null => (
  usd === null ? null : BigFixnum.from({ value: usd.replace('.', ''), decimals: usd.split('.')[1]?.length ?? 0 })
);

t.test('the rule: what keeps a token out of discovery, then strategic, then unknown, then the threshold', async t => {
  const cases: Array<[ string, Exclusion, boolean, BigFixnum | null, boolean, string ]> = [
    [ 'hidden here',                               'hidden',     false, worth('1'),                            false, 'hidden' ],
    [ 'hidden and worth the threshold',            'hidden',     false, worth('300000'),                       false, 'hidden' ],
    [ 'hidden and unreadable',                     'hidden',     false, worth(null),                           false, 'hidden' ],
    [ 'hidden and strategic',                      'hidden',     true,  worth('300000'),                       false, 'hidden' ],
    [ 'deprecated here',                           'deprecated', false, worth('1'),                            false, 'deprecated' ],
    [ 'deprecated and worth the threshold',        'deprecated', false, worth('300000'),                       false, 'deprecated' ],
    [ 'deprecated and unreadable',                 'deprecated', false, worth(null),                           false, 'deprecated' ],
    [ 'deprecated and strategic',                  'deprecated', true,  worth('300000'),                       false, 'deprecated' ],
    [ 'strategic below the threshold',             'none',       true,  worth('1'),                            true,  'strategic' ],
    [ 'strategic and unreadable',                  'none',       true,  worth(null),                           true,  'strategic' ],
    [ 'strategic and held nowhere here',           'none',       true,  worth('0'),                            true,  'strategic' ],
    [ 'unreadable',                                'none',       false, worth(null),                           true,  'data_unavailable' ],
    [ 'exactly the threshold',                     'none',       false, worth('250000'),                       true,  'collateral_threshold' ],
    [ 'a hair below it',                           'none',       false, worth('249999.9999'),                  false, 'below_threshold' ],
    [ 'past it by less than a float can tell',     'none',       false, worth('250000.000000000000000000001'), true,  'collateral_threshold' ],
    [ 'short of it by less than a float can tell', 'none',       false, worth('249999.999999999999999999999'), false, 'below_threshold' ],
    [ 'held nowhere here',                         'none',       false, worth('0'),                            false, 'below_threshold' ],
  ];
  for (const [ name, exclusion, isStrategic, value, isVisible, reason ] of cases) {
    t.same(visibilityOf(exclusion, isStrategic, value), { isVisible, visibilityReason: reason }, name);
  }
});

/*
 * /summary answers each collateral with what discovery says of its token in
 * the collateral's market, from that market's Comet's decisions, where a kind
 * of decision may not have been read. It says why the token is shown or not
 * where the decisions read decide it whichever way the others went: the
 * hiding decides alone, the deprecating once the hiding is read, and the
 * strategic mark and the value once every kind is. It says whether the token
 * is shown wherever the decisions read decide that much, even without why: it
 * is not shown where this Comet has it deprecated, whatever its hiding, or
 * where it is not strategic and is worth less than the threshold, whatever its
 * hiding and its deprecating; and shown where this Comet neither hides nor
 * deprecates it and its value reaches the threshold or cannot be read,
 * whatever its strategic mark. Every combination is asked: each kind read
 * true, read false, or not read, and a value at the threshold, short of it, or
 * unknown.
 */
t.test('in one market, discovery is said to show a token or not only where the decisions read decide it', async t => {
  const kinds = [ true, false, null ] as const;
  const values: Array<[ string, BigFixnum | null ]> = [
    [ 'exactly the threshold', worth('250000') ],
    [ 'a hair below it',       worth('249999.9999') ],
    [ 'unreadable',            worth(null) ],
  ];
  const named = (decision: boolean | null, yes: string, no: string, unread: string) => decision === null ? unread : decision ? yes : no;
  // what the summary says of a collateral, stated apart from the rule's code
  const said = (isHidden: boolean | null, isDeprecated: boolean | null, isStrategic: boolean | null, value: string): Partial<VisibilityV1> => {
    // a token no hiding or deprecating could show
    const unwanted = isStrategic === false && value === 'a hair below it';
    return (
        isHidden === true                  ? { isVisible: false, visibilityReason: 'hidden' }
      : isHidden === null                  ? (isDeprecated === true || unwanted ? { isVisible: false } : {})
      : isDeprecated === true              ? { isVisible: false, visibilityReason: 'deprecated' }
      : isDeprecated === null              ? (unwanted ? { isVisible: false } : {})
      : isStrategic === null               ? (value === 'a hair below it' ? {} : { isVisible: true })
      : isStrategic                        ? { isVisible: true, visibilityReason: 'strategic' }
      : value === 'unreadable'             ? { isVisible: true, visibilityReason: 'data_unavailable' }
      : value === 'exactly the threshold'  ? { isVisible: true, visibilityReason: 'collateral_threshold' }
      : { isVisible: false, visibilityReason: 'below_threshold' }
    );
  };
  for (const isHidden of kinds) {
    for (const isDeprecated of kinds) {
      for (const isStrategic of kinds) {
        for (const [ value, held ] of values) {
          const name = [
            named(isHidden, 'hidden here', 'not hidden here', 'its hiding unread'),
            named(isDeprecated, 'deprecated here', 'not deprecated here', 'its deprecating unread'),
            named(isStrategic, 'strategic', 'not strategic', 'its strategic mark unread'),
            value,
          ].join(', ');
          t.same(visibilityHere({ isHidden, isDeprecated, isStrategic }, held), said(isHidden, isDeprecated, isStrategic, value), name);
        }
      }
    }
  }
});

/*
 * Whether discovery shows a token follows from its reason, and its type says
 * so: each pairing below is a type error the build expects.
 */
t.test('a visibility whose isVisible and visibilityReason disagree does not compile', async () => {
  (visibility: VisibilityV1) => [
    // @ts-expect-error discovery does not show a token for being hidden, deprecated or short of the threshold
    { ...visibility, isVisible: true,  visibilityReason: 'hidden' } satisfies VisibilityV1,
    // @ts-expect-error
    { ...visibility, isVisible: true,  visibilityReason: 'deprecated' } satisfies VisibilityV1,
    // @ts-expect-error
    { ...visibility, isVisible: true,  visibilityReason: 'below_threshold' } satisfies VisibilityV1,
    // @ts-expect-error and shows one for being strategic, worth the threshold, or of a value that could not be read
    { ...visibility, isVisible: false, visibilityReason: 'strategic' } satisfies VisibilityV1,
    // @ts-expect-error
    { ...visibility, isVisible: false, visibilityReason: 'collateral_threshold' } satisfies VisibilityV1,
    // @ts-expect-error
    { ...visibility, isVisible: false, visibilityReason: 'data_unavailable' } satisfies VisibilityV1,
  ];
});
