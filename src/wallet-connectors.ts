import { injected, type InjectedParameters } from "wagmi/connectors";

export type Eip6963ProviderDetail = {
  info: {
    uuid: string;
    name: string;
    icon: string;
    rdns: string;
  };
  provider: unknown;
};

/**
 * `shimDisconnect` asks for wallet permissions before requesting accounts.
 * Browser wallets already expose a deliberate connect prompt, so use the
 * single-request path and keep disconnect state inside Wagmi only.
 */
export function installedWalletConnector(target: NonNullable<InjectedParameters["target"]>) {
  return injected({ target, shimDisconnect: false });
}

export function uniqueEip6963Providers(
  providers: readonly Eip6963ProviderDetail[],
): Eip6963ProviderDetail[] {
  const rdns = new Set<string>();
  const providerReferences = new Set<unknown>();
  const unique: Eip6963ProviderDetail[] = [];

  for (const detail of providers) {
    const identity = detail.info.rdns.trim().toLowerCase();
    if (!identity || rdns.has(identity) || providerReferences.has(detail.provider)) continue;
    rdns.add(identity);
    providerReferences.add(detail.provider);
    unique.push(detail);
  }

  return unique;
}

export function browserWalletConnectors(
  providers: readonly Eip6963ProviderDetail[],
  legacyProvider?: unknown,
) {
  const discovered = uniqueEip6963Providers(providers);
  if (discovered.length > 0) {
    return discovered.map(({ info, provider }) => installedWalletConnector({
      id: info.rdns,
      name: info.name,
      icon: info.icon,
      provider: provider as never,
    }));
  }

  if (!legacyProvider) return [];
  return [installedWalletConnector({
    id: "injected",
    name: "Browser wallet",
    provider: legacyProvider as never,
  })];
}
