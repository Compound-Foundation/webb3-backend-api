/*
 * flags configuration
 */

interface FullFlags {
  // general env
  environment: Environment;
  // toggled flags
  batchingEnabled:         boolean;
  evaluatorAlgorithm:      EvaluatorAlgorithm;
  ethComputationIndexBias: EthComputationIndexBias;
  // test flags
  testRegenerateDump:         boolean;
  testRegenerateCacheSeed:    boolean;
  testShouldLoadCacheSeed:    boolean;
  testRegenerateTallyDumps:   boolean;
  testAllowFetchPassthrough:  boolean;
  testEstimateBlocksIntoPast: boolean;
}

type SomeFlags = Partial<FullFlags>;

const defaults: ((_: SomeFlags) => FullFlags) = ({
  // general env
  environment = 'local',
  // toggled flags
  ethComputationIndexBias,
  batchingEnabled    = false,
  evaluatorAlgorithm = 'recursive',
  // test flags
  testRegenerateDump         = false,
  testRegenerateCacheSeed    = false,
  testShouldLoadCacheSeed    = true,
  testRegenerateTallyDumps   = false,
  testAllowFetchPassthrough  = false,
  testEstimateBlocksIntoPast = false,
}) => ({
  // general env
  environment,
  // toggled flags
  batchingEnabled,
  evaluatorAlgorithm,
  ethComputationIndexBias: (ethComputationIndexBias ?? (
    [ 'test', 'local' ].includes(environment) // TODO(jordan): make test work separately from local
      ? 'Everything' // index everything in test / locally
      : 'default'    // ...but otherwise case-by-case
  )),
  // test flags
  testRegenerateDump,
  testRegenerateCacheSeed,
  testShouldLoadCacheSeed,
  testRegenerateTallyDumps,
  testAllowFetchPassthrough,
  testEstimateBlocksIntoPast,
});

/*
 * environment variable flag parsers
 */

type Env = {
  // general env
  ENVIRONMENT: string;
  // runtime behavior flags
  FLAGS_BATCHING_ENABLED?:           string;
  FLAGS_EVALUATOR_ALGORITHM?:        string;
  FLAGS_ETH_COMPUTATION_INDEX_BIAS?: string;
  // test flags
  TEST_FLAGS_REGENERATE_DUMP?:           string;
  TEST_FLAGS_DISABLE_CACHE_SEED?:        string;
  TEST_FLAGS_REGENERATE_CACHE_SEED?:     string;
  TEST_FLAGS_SHOULD_LOAD_CACHE_SEED?:    string;
  TEST_FLAGS_REGENERATE_TALLY_DUMPS?:    string;
  TEST_FLAGS_ALLOW_FETCH_PASSTHROUGH?:   string;
  TEST_FLAGS_ESTIMATE_BLOCKS_INTO_PAST?: string;
};

type EnvParsers = {
  [name in keyof Required<Env>]: (value: string) => SomeFlags;
};

/*
 * envFlagParsers parse flags from environment variables.
 *
 * NOTE that parsers are ordered; that is, a parser specified later will
 * run last, and if two parsers both write a flag, the last one wins.
 * Order is given by ES2015 standard property order: for string keys,
 * that's insertion order, hence the above statement that "last wins."
 */
const envFlagParsers: EnvParsers = {
  // general expected env
  ENVIRONMENT(value) {
    return isEnvironment(value) ? { environment: value } : {};
  },
  // "feature" flags
  FLAGS_ETH_COMPUTATION_INDEX_BIAS(value) {
    return isEthComputationIndexBias(value)
      ? { ethComputationIndexBias: value }
      : {};
  },
  FLAGS_BATCHING_ENABLED(value) {
    return { batchingEnabled: parseBooleanEnv(value) };
  },
  FLAGS_EVALUATOR_ALGORITHM(value) {
    return isEvaluatorAlgorithm(value) ? { evaluatorAlgorithm: value } : {};
  },
  // test flags
  TEST_FLAGS_ALLOW_FETCH_PASSTHROUGH(value) {
    return { testAllowFetchPassthrough: parseBooleanEnv(value) };
  },
  TEST_FLAGS_DISABLE_CACHE_SEED(value) {
    return { testShouldLoadCacheSeed: !parseBooleanEnv(value) };
  },
  TEST_FLAGS_SHOULD_LOAD_CACHE_SEED(value) {
    return { testShouldLoadCacheSeed: parseBooleanEnv(value) };
  },
  TEST_FLAGS_REGENERATE_TALLY_DUMPS(value) {
    return {
      testRegenerateTallyDumps: parseBooleanEnv(value),
      testAllowFetchPassthrough: true,
    };
  },
  TEST_FLAGS_REGENERATE_DUMP(value) {
    return { testRegenerateDump: parseBooleanEnv(value) };
  },
  TEST_FLAGS_ESTIMATE_BLOCKS_INTO_PAST(value) {
    return { testEstimateBlocksIntoPast: parseBooleanEnv(value) };
  },
  TEST_FLAGS_REGENERATE_CACHE_SEED(value) {
    return {
      testRegenerateCacheSeed:   parseBooleanEnv(value),
      testShouldLoadCacheSeed:   false,
      testAllowFetchPassthrough: true,
    };
  },
};

function parse(env: any): SomeFlags {
  const result: SomeFlags = {};
  for (const [ name, parser ] of Object.entries(envFlagParsers)) {
    if (!!env[name]) {
      // NOTE(jordan): safe non-null assert; we just checked `env[name]`
      Object.assign(result, parser(env[name]!));
    }
  }
  return result;
}

function parseWithDefaults(env: any): FullFlags {
  return defaults(parse(env));
}

/*
 * helpers
 */

function parseBooleanEnv(value: string): boolean {
  return value !== '0' && Boolean(value);
}

const evaluatorAlgorithms = <const>([ 'recursive', 'workingset' ]);
type EvaluatorAlgorithm   = (typeof evaluatorAlgorithms)[number];

function isEvaluatorAlgorithm(value: string): value is EvaluatorAlgorithm {
  return evaluatorAlgorithms.includes(value as any);
}

// cf. wrangler.toml
const environments = <const>([ 'test', 'local', 'stage', 'production', 'jordan-stage' ]);
type Environment   = (typeof environments)[number];

function isEnvironment(value: string): value is Environment {
  return environments.includes(value as any);
}

const ethComputationIndexBias = <const>([ 'Everything', 'Nothing', 'default' ]);
type EthComputationIndexBias  = (typeof ethComputationIndexBias)[number];

function isEthComputationIndexBias(value: string): value is EthComputationIndexBias {
  return ethComputationIndexBias.includes(value as any);
}

export type {
  Env,
  FullFlags,
  SomeFlags,
  EthComputationIndexBias,
};

export {
  parse,
  defaults,
  parseWithDefaults,
};
