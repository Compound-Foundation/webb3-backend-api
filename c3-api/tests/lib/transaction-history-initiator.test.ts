import t from 'tap';

import * as Eth from '../../lib/eth-constants.js';
import { checksumAddress } from '../../lib/model/comet-registry.js';
import type { TransactionHistoryItem } from '../../lib/model/transaction-history/item.js';

import { filterTransactionHistoryItem } from '../../src/transaction-history-handler/transaction-history-items-handler.js';

import '../../shim/node-self.js';

/*
 * initiated_by[] keeps the items the account initiated, `me`, and the items
 * another address initiated, `other`, whatever the casing of the account and
 * of the initiator. The account is the one an account route hands on, and the
 * initiator the sender of the transaction as a node names it, in lowercase,
 * unless every action of the item went through the account's DeFi Saver
 * proxy, named in lowercase, or through a migrator, named checksummed. Before,
 * the two were compared as they were spelled: an account in another casing
 * than its initiator was never `me`, and always `other`.
 */
const ACCOUNT = '0x420f253087044b8bcf028dd89f8fe83ba6275e84';
const FORMS: Array<[ string, string ]> = [
  [ ACCOUNT,                               'in lowercase' ],
  [ checksumAddress(ACCOUNT),              'checksummed' ],
  [ `0x${ACCOUNT.slice(2).toUpperCase()}`, 'in uppercase' ],
];

// the initiators that are not the account: a sender, a DeFi Saver proxy and a migrator, each as the history names it
const OTHERS: Array<[ string, string ]> = [
  [ '0x1111111111111111111111111111111111111111', 'another sender' ],
  [ '0x5a5b2d1c6f3e4a7b8c9d0e1f2a3b4c5d6e7f8091', 'the account\'s DeFi Saver proxy' ],
  [ Eth.wellKnownContractsByNetwork['ethereum-mainnet']['CompoundMigrator']['V2'].address, 'a migrator' ],
];

function itemInitiatedBy(address: string): TransactionHistoryItem {
  return {
    itemType:        'Unit',
    actions:         [],
    initiatedBy:     { address: address as Eth.Address },
    timestamp:       1_800_000_000,
    network:         'ethereum-mainnet',
    transactionHash: `0x${'1'.repeat(64)}`,
    blockNumber:     22_900_000,
  };
}

// whether a filter keeps an item of an initiator, for the account in a form
function keeps(account: string, initiatedBy: string[], initiator: string): boolean {
  return filterTransactionHistoryItem(account as Eth.Address, [], initiatedBy, itemInitiatedBy(initiator));
}

t.test('an item the account initiated is `me`, whatever the casing of either', async t => {
  for (const [ account, accountForm ] of FORMS) {
    for (const [ initiator, initiatorForm ] of FORMS) {
      const what = `the account ${accountForm}, its initiator ${initiatorForm}`;
      t.equal(keeps(account, [ 'me' ], initiator), true, `${what}: me keeps it`);
      t.equal(keeps(account, [ 'other' ], initiator), false, `${what}: other drops it`);
      t.equal(keeps(account, [ 'me', 'other' ], initiator), true, `${what}: both keep it`);
    }
  }
});

t.test('an item another address initiated is `other`, whatever the casing of the account', async t => {
  for (const [ account, accountForm ] of FORMS) {
    for (const [ initiator, initiatorName ] of OTHERS) {
      const what = `the account ${accountForm}, initiated by ${initiatorName}`;
      t.equal(keeps(account, [ 'me' ], initiator), false, `${what}: me drops it`);
      t.equal(keeps(account, [ 'other' ], initiator), true, `${what}: other keeps it`);
      t.equal(keeps(account, [ 'me', 'other' ], initiator), true, `${what}: both keep it`);
    }
  }
});

t.test('without initiated_by[], every item is kept', async t => {
  for (const [ initiator ] of [ ...FORMS, ...OTHERS ]) {
    t.equal(keeps(checksumAddress(ACCOUNT), [], initiator), true, `the item of ${initiator}`);
  }
});
