type RequestProvider = {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
};

type WalletRequestTrace = {
  timestamp: string;
  method: string;
  connectorId: string;
  connectorUid: string;
  stack: string;
};

declare global {
  interface Window {
    __LOCK_IN_WALLET_REQUESTS__?: WalletRequestTrace[];
  }
}

const instrumented = new WeakSet<object>();

/** Development-only method tracing. Request parameters are deliberately never recorded. */
export function instrumentWalletProvider(
  provider: unknown,
  connector: { id: string; uid: string },
) {
  if (process.env.NODE_ENV === "production") return;
  if ((typeof provider !== "object" && typeof provider !== "function") || provider === null) return;
  if (instrumented.has(provider)) return;
  const candidate = provider as Partial<RequestProvider>;
  if (typeof candidate.request !== "function") return;

  const originalRequest = candidate.request.bind(provider);
  try {
    candidate.request = async (args) => {
      const trace: WalletRequestTrace = {
        timestamp: new Date().toISOString(),
        method: args.method,
        connectorId: connector.id,
        connectorUid: connector.uid,
        stack: new Error().stack?.split("\n").slice(1, 9).join("\n") ?? "",
      };
      const traces = window.__LOCK_IN_WALLET_REQUESTS__ ?? [];
      window.__LOCK_IN_WALLET_REQUESTS__ = [...traces.slice(-99), trace];
      console.info("[Lock In wallet request]", trace);
      return originalRequest(args);
    };
    instrumented.add(provider);
  } catch {
    // Some extensions expose a frozen provider. The connector remains untouched in that case.
  }
}
