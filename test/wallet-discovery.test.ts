import assert from "node:assert/strict";
import test from "node:test";
import { createConfig, http } from "wagmi";
import {
  connectPhaseLocked,
  connectionMessage,
  nextConnectPhase,
  selectInstalledWallets,
  walletKind,
  type BrowserWalletCandidate,
  type WalletConnectPhase,
} from "../components/wallet-button.js";
import { monad } from "../src/chain.js";
import {
  browserWalletConnectors,
  installedWalletConnector,
  uniqueEip6963Providers,
  type Eip6963ProviderDetail,
} from "../src/wallet-connectors.js";

function wallet(
  id: string,
  name: string,
  provider: unknown,
  eip6963 = true,
): BrowserWalletCandidate {
  return { uid: `${id}:${name}`, id, name, provider, eip6963 };
}

test("MetaMask EIP-6963 replaces the legacy view of the same provider", () => {
  const provider = {};
  const selected = selectInstalledWallets([
    wallet("injected", "Injected", provider, false),
    wallet("io.metamask", "MetaMask", provider),
  ]);

  assert.deepEqual(selected.map(({ id }) => id), ["io.metamask"]);
});

test("Phantom EIP-6963 is detected without an explicit Phantom connector", () => {
  const selected = selectInstalledWallets([
    wallet("app.phantom", "Phantom", {}),
  ]);

  assert.deepEqual(selected.map(({ id }) => id), ["app.phantom"]);
  assert.equal(walletKind(selected[0].id, selected[0].name), "phantom");
});

test("MetaMask and Phantom are deduplicated and ordered before other installed wallets", () => {
  const metaMask = {};
  const selected = selectInstalledWallets([
    wallet("me.rainbow", "Rainbow", {}),
    wallet("app.phantom", "Phantom", {}),
    wallet("io.metamask", "MetaMask", metaMask),
    wallet("io.metamask", "MetaMask duplicate", metaMask),
    wallet("com.coinbase.wallet", "Coinbase Wallet", {}),
    wallet("injected", "Injected", metaMask, false),
  ]);

  assert.deepEqual(selected.map(({ name }) => name), [
    "MetaMask",
    "Phantom",
    "Coinbase Wallet",
    "Rainbow",
  ]);
});

test("one legacy injected wallet is used only when no EIP-6963 wallet exists", () => {
  const selected = selectInstalledWallets([
    wallet("injected", "Injected", {}, false),
    wallet("injected", "Second legacy", {}, false),
  ]);

  assert.equal(selected.length, 1);
  assert.equal(selected[0].name, "Injected");
});

test("EIP-6963 connector setup keeps every installed wallet once and ignores legacy injection", () => {
  const metaMask = {};
  const providers: Eip6963ProviderDetail[] = [
    { info: { uuid: "1", rdns: "io.metamask", name: "MetaMask", icon: "data:image/svg+xml,<svg/>" }, provider: metaMask },
    { info: { uuid: "2", rdns: "io.metamask", name: "MetaMask duplicate", icon: "data:image/svg+xml,<svg/>" }, provider: metaMask },
    { info: { uuid: "3", rdns: "com.coinbase.wallet", name: "Coinbase Wallet", icon: "data:image/svg+xml,<svg/>" }, provider: {} },
  ];

  assert.equal(uniqueEip6963Providers(providers).length, 2);
  const config = createConfig({
    chains: [monad],
    multiInjectedProviderDiscovery: false,
    connectors: browserWalletConnectors(providers, {}),
    transports: { [monad.id]: http(monad.rpcUrls.default.http[0]) },
  });

  assert.deepEqual(config.connectors.map(({ id, name }) => ({ id, name })), [
    { id: "io.metamask", name: "MetaMask" },
    { id: "com.coinbase.wallet", name: "Coinbase Wallet" },
  ]);
});

test("a resolved request stays locked in syncing until useAccount confirms the account", () => {
  let phase: WalletConnectPhase = "idle";
  phase = nextConnectPhase(phase, "request");
  assert.equal(phase, "requesting");
  assert.equal(connectPhaseLocked(phase), true);

  assert.equal(nextConnectPhase(phase, "request"), "requesting");
  phase = nextConnectPhase(phase, "requestResolved");
  assert.equal(phase, "syncing");
  assert.equal(connectPhaseLocked(phase), true);

  assert.equal(nextConnectPhase(phase, "request"), "syncing");
  assert.equal(nextConnectPhase(phase, "timeout"), "syncing");
  phase = nextConnectPhase(phase, "accountConfirmed");
  assert.equal(phase, "idle");
  assert.equal(connectPhaseLocked(phase), false);
});

test("only a real request failure unlocks immediately into the retryable error phase", () => {
  const requesting = nextConnectPhase("idle", "request");
  const error = nextConnectPhase(requesting, "requestFailed");

  assert.equal(error, "error");
  assert.equal(connectPhaseLocked(error), false);
  assert.equal(nextConnectPhase(error, "retry"), "idle");
});

test("-32002 reports the existing native wallet request", () => {
  assert.equal(
    connectionMessage({ code: -32002, message: "Resource unavailable" }),
    "A wallet request is already open. Complete or close it before trying again.",
  );
});

test("one connect click issues exactly one account authorization request", async () => {
  const methods: string[] = [];
  const account = "0x0000000000000000000000000000000000000001";
  const provider = {
    async request({ method }: { method: string }) {
      methods.push(method);
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      if (method === "eth_chainId") return "0x8f";
      throw new Error(`Unexpected provider method: ${method}`);
    },
    on() {},
    removeListener() {},
  };
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  try {
    const config = createConfig({
      chains: [monad],
      multiInjectedProviderDiscovery: false,
      connectors: [installedWalletConnector({ id: "test", name: "Test wallet", provider: provider as never })],
      transports: { [monad.id]: http(monad.rpcUrls.default.http[0]) },
    });

    await config.connectors[0].connect();
  } finally {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }

  const accountRequests = methods.filter((method) => (
    method === "wallet_requestPermissions" || method === "eth_requestAccounts"
  ));
  assert.deepEqual(accountRequests, ["eth_requestAccounts"]);
});
