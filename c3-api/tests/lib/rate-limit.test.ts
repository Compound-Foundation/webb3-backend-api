import t from 'tap';

import * as Rate from '../../lib/rate-limit.js';

t.test(`Rate.key keeps IPv4 whole and keys IPv6 on its /64`, async t => {
  const cases: Array<[ string, string ]> = [
    [ '203.0.113.7',                             '203.0.113.7'        ],
    [ '2001:db8:1:2:3:4:5:6',                    '2001:db8:1:2::/64'  ],
    [ '2001:0DB8:0001:0002:0003:0004:0005:0006', '2001:db8:1:2::/64'  ],
    [ '2001:db8:1:2::1',                         '2001:db8:1:2::/64'  ],
    [ '2001:db8::1',                             '2001:db8:0:0::/64'  ],
    [ '2001:db8::',                              '2001:db8:0:0::/64'  ],
    [ '2001:db8:1:2::1.2.3.4',                   '2001:db8:1:2::/64'  ],
    [ '::1',                                     '::1'                ],
    [ '::ffff:203.0.113.7',                      '::ffff:203.0.113.7' ],
    [ '::ffff:c000:207',                         '::ffff:c000:207'    ],
    // input that is not IPv6 is kept whole rather than throwing or sharing a key
    [ '1:2:3:4:5:6:7::8:9',                      '1:2:3:4:5:6:7::8:9' ],
    [ '1:2:3:4:5:6:7:8:9::',                     '1:2:3:4:5:6:7:8:9::' ],
    [ 'a::b::c',                                 'a::b::c'            ],
    [ 'zz::',                                    'zz::'               ],
    [ 'fe80::1%eth0',                            'fe80::1%eth0'       ],
  ];
  for (const [ ip, key ] of cases) {
    t.equal(Rate.key(ip), key, `${ip} -> ${key}`);
  }

  t.end();
});

t.test(`Rate.key gives one /64 one key`, async t => {
  t.equal(
    Rate.key('2001:db8:1:2::1'),
    Rate.key('2001:db8:1:2:ffff:ffff:ffff:ffff'),
  );
  t.not(
    Rate.key('2001:db8:1:2::1'),
    Rate.key('2001:db8:1:3::1'),
  );

  t.end();
});
