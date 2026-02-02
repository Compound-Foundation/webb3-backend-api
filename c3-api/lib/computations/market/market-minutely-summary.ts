import * as Key from "../../symbolic/key.js";
import * as Index from "../../symbolic/index.js";
import * as Compute from "../../symbolic/computation.js";
import * as Fallible from "../../fallible/fallible.js";

import type { MarketSummary } from "./market-summary.js";

type MarketMinutelySummary = Compute.Spec<{
  name: "marketMinutelySummary";
  depends: [MarketSummary];
  expects: MarketSummary["expects"];
  returns: MarketSummary["returns"];
}>;

const { implement, pull1 } = Compute.Functor<MarketMinutelySummary>({});
const marketMinutelySummary = implement({
  version: 1,
  index: Index.MinutelyBlockIndex,
  key(name, {block, ...context}) {
    const { block: projected } = Fallible.must(this.index.project({ block, ...context }));
    return Key.toKey(name, { block: projected.number, ...context });
  },
  compute({ apiHost, nodeHost, nodeKey, contract, network, block }) {
    const projected = Fallible.must(this.index.project({ apiHost, nodeHost, nodeKey, contract, network, block }));

    return pull1(
      { marketSummary: projected },
    );
  }
});

export { MarketMinutelySummary, marketMinutelySummary };
