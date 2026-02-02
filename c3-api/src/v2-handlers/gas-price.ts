import * as Eth from '../../lib/eth-constants.js';
import fetch from '../../lib/request-counting-fetch.js';
import * as Fallible from '../../lib/fallible/fallible.js';

type V2GasPriceData = {
  safe_low: { value: string };
  average: { value: string };
  fast: { value: string };
  fastest: { value: string };
};

// Used to estimate gas for submitting Txns on the V2 Dapp
// We don't use this anymore for the V3 Dapp
async function getGasPrice(blockNativeKey: string): Promise<Response> {
  // Cache the response on the edge for 60 seconds.
  const resp = await fetch(Eth.mainnetGasPriceEndpoint, {
    headers: { 'Authorization': blockNativeKey },
    cf: { cacheTtl: 60, cacheEverything: true }
  });
  const data = await Fallible.must(resp).json<any>();

  let v2GasPriceData: V2GasPriceData;
  if (isExpectedBlockNativeGasPrices(data)) {
    const prices = data.blockPrices[0].estimatedPrices;
    const fastest = prices.find(price => price.confidence === 99);
    const fast = prices.find(price => price.confidence === 95);
    const average = prices.find(price => price.confidence === 90);
    const safeLow = prices.find(price => price.confidence === 80);
    const gweiToWei = 10 ** 9;
    v2GasPriceData = {
      fastest: { value: (fastest!.price * gweiToWei).toString()},
      fast: { value: (fast!.price * gweiToWei).toString()},
      average: { value: (average!.price * gweiToWei).toString()},
      safe_low: { value: (safeLow!.price * gweiToWei).toString()},
    }
  } else {
    v2GasPriceData = {
      fastest: { value: '40000000000' },
      fast: { value: '30000000000' },
      average: { value: '25000000000' },
      safe_low: { value: '20000000000' },
    }
  }
  return new Response(JSON.stringify(v2GasPriceData));
}

type ExpectedBlockNativeGasPriceData = {
  blockPrices: [{
    estimatedPrices: [
      // Order is not guaranteed
      { confidence: 99; price: number }, // fastest
      { confidence: 95; price: number }, // fast
      { confidence: 90; price: number }, // average
      { confidence: 80; price: number } // safe low
    ]
  }]
};

function isExpectedBlockNativeGasPrices(data: any): data is ExpectedBlockNativeGasPriceData {
  const maybePrices = data?.blockPrices?.[0]?.estimatedPrices;
  if (!Array.isArray(maybePrices)) {
    return false;
  }
  return [99, 95, 90, 80].every((confidence) =>
    maybePrices.find(
      (priceData) =>
        priceData?.confidence === confidence &&
        typeof priceData?.price === 'number'
    )
  );
}

export {
  getGasPrice,
};
