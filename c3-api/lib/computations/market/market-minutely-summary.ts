import * as Key from "../../symbolic/key.js";
import * as Index from "../../symbolic/index.js";
import * as Compute from "../../symbolic/computation.js";
import * as Fallible from "../../fallible/fallible.js";

import type { MarketLatestSummary } from "./market-latest-summary.js";

type MarketMinutelySummary = Compute.Spec<{
  name: "marketMinutelySummary";
  depends: [MarketLatestSummary];
  expects: MarketLatestSummary["expects"];
  returns: MarketLatestSummary["returns"];
}>;

const { implement, pull1 } = Compute.Functor<MarketMinutelySummary>({});
const marketMinutelySummary = implement({
  // 13: the latest summary, with an empty market's APRs from its Comet's rate model (#23).
  // 12 is taken by values of another shape.
  version: 13,
  index: Index.MinutelyBlockIndex,
  key(name, {block, ...context}) {
    const { block: projected } = Fallible.must(this.index.project({ block, ...context }));
    return Key.toKey(name, { block: projected.number, ...context });
  },
  compute({ apiHost, nodeHost, nodeKey, contract, network, block }) {
    const projected = Fallible.must(this.index.project({ apiHost, nodeHost, nodeKey, contract, network, block }));

    return pull1(
      { marketLatestSummary: projected },
    );
  }
});

export { MarketMinutelySummary, marketMinutelySummary };
