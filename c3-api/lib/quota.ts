type ResourceAmounts = { [resource: string]: number };

class Quota<Amounts extends ResourceAmounts> {
  private constructor(
    public resources: Amounts,
    public allocated: Partial<Amounts>,
  ) {}

  static initialize<Amounts extends ResourceAmounts>(resources: Amounts) {
    return new Quota(resources, { ...resources });
  }

  has(amounts: Partial<Amounts>) {
    return has(amounts, this.resources)
        && has(amounts, this.allocated);
  }

  consume(amounts: Partial<Amounts>) {
    if (!this.has(amounts)) {
      throw new Error(`Quota::consume(..): not enough remains to consume ${JSON.stringify(amounts)}`);
    }
    consume(amounts, this.resources);
    consume(amounts, this.allocated);
    return this;
  }

  allocate(amounts: Partial<Amounts>) {
    if (!this.has(amounts)) {
      throw new Error(`Quota::allocate(..): not enough remains to allocate ${JSON.stringify(amounts)}`);
    }
    return new Quota(this.resources, amounts);
  }
}

function has
  <Amounts extends ResourceAmounts>
  (required: Partial<Amounts>, resources: Partial<Amounts>)
  : boolean
{
  return Object.entries(required).every(([ resource, amount ]) => {
    return resource in resources && (resources[resource] ?? 0) >= amount;
  });
}

function consume(
  consumed: Partial<ResourceAmounts>,
  target: Partial<ResourceAmounts>,
) {
  for (const [ resource, amount ] of Object.entries(consumed)) {
    if (!(resource in target)) continue;
    target[resource]! -= amount ?? 0;
  }
}

interface InsufficientQuota<
  Amounts extends ResourceAmounts = ResourceAmounts
> {
  type: `${string}.InsufficientQuota`;
  error?: Error;
  details: {
    quota: {
      requested: Partial<Amounts>;
      resources: Amounts;
      allocated: Partial<Amounts>;
    }
  }
}

export default Quota;
export type {
  ResourceAmounts,
  InsufficientQuota,
};
