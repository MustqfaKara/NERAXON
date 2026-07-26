export interface SpotUniverseAsset {
  name: string;
  index: number;
  tokens: [number, number];
}

export interface SpotTokenMetadata {
  index: number;
  name: string;
  szDecimals: number;
}

export interface SpotAssetContext {
  coin?: string;
}

export function mapSpotUniverseContexts<TContext extends SpotAssetContext>(
  universe: SpotUniverseAsset[],
  tokens: SpotTokenMetadata[],
  contexts: TContext[],
) {
  const contextByCoin = new Map(contexts.filter((context) => context.coin).map((context) => [context.coin!, context]));
  return universe.map((asset) => ({
    asset,
    baseToken: tokens.find((token) => token.index === asset.tokens[0]),
    context: contextByCoin.get(asset.name),
  }));
}
