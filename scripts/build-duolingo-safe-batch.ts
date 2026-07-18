import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { getAddress, isAddress } from "viem";

/*
 * Builds the Safe Transaction Builder batch that OPENS the Duolingo escrow pauses, for the owner to import
 * and sign. It does NOT submit anything. The address comes from the pinned NEXT_PUBLIC_DUOLINGO_ESCROW_ADDRESS
 * (or DUOLINGO_ESCROW_ADDRESS) so a placeholder can never be signed by accident; it refuses the Strava escrow.
 *
 * Order matters: completion first, joining second, creation LAST, so admission opens last. Only import and
 * sign these AFTER `pnpm gate:duolingo` is fully green.
 *
 * Usage: pnpm safe:duolingo
 */

const STRAVA_ESCROW = "0xD37121112F240fE03a18D754B2fdB9dC750034d4".toLowerCase();
const raw = (process.env.NEXT_PUBLIC_DUOLINGO_ESCROW_ADDRESS || process.env.DUOLINGO_ESCROW_ADDRESS || "").trim();
if (!isAddress(raw)) throw new Error("Set NEXT_PUBLIC_DUOLINGO_ESCROW_ADDRESS to the deployed escrow B first");
const escrow = getAddress(raw);
if (escrow.toLowerCase() === STRAVA_ESCROW) throw new Error("Refusing: that is the Strava escrow, not the Duolingo escrow");

const steps = [
  { order: 1, fn: "setCompletionPaused", note: "Open completion first." },
  { order: 2, fn: "setJoiningPaused", note: "Open joining." },
  { order: 3, fn: "setCreationPaused", note: "Open creation LAST. Admission is still gated by DUOLINGO_ESCROW_ALLOWED_WALLETS." },
] as const;

const setterInput = [{ name: "paused", type: "bool", internalType: "bool" }];
const tx = (fn: string) => ({
  to: escrow,
  value: "0",
  data: null,
  contractMethod: { inputs: setterInput, name: fn, payable: false },
  contractInputsValues: { paused: "false" },
});

mkdirSync("safe-batches/duolingo", { recursive: true });

// Combined batch: all three pause-opens in ONE atomic multisig transaction, in order.
const combined = {
  version: "1.0",
  chainId: "143",
  createdAt: Date.now(),
  meta: {
    name: "Open Duolingo escrow pauses (completion, joining, creation)",
    description: `Atomic: setCompletionPaused(false), setJoiningPaused(false), setCreationPaused(false) on ${escrow}. Sign only after 'pnpm gate:duolingo' is green.`,
    txBuilderVersion: "1.17.1",
  },
  transactions: [tx("setCompletionPaused"), tx("setJoiningPaused"), tx("setCreationPaused")],
};
writeFileSync("safe-batches/duolingo/0-open-all-pauses.json", `${JSON.stringify(combined, null, 2)}\n`);
console.log("wrote safe-batches/duolingo/0-open-all-pauses.json (combined, recommended)");

for (const step of steps) {
  const batch = {
    version: "1.0",
    chainId: "143",
    createdAt: Date.now(),
    meta: {
      name: `${step.order}. ${step.fn}(false) — Duolingo escrow`,
      description: `${step.note} Only sign after 'pnpm gate:duolingo' is green. Target ${escrow}.`,
      txBuilderVersion: "1.17.1",
    },
    transactions: [
      {
        to: escrow,
        value: "0",
        data: null,
        contractMethod: {
          inputs: [{ name: "paused", type: "bool", internalType: "bool" }],
          name: step.fn,
          payable: false,
        },
        contractInputsValues: { paused: "false" },
      },
    ],
  };
  const path = `safe-batches/duolingo/${step.order}-${step.fn}-false.json`;
  writeFileSync(path, `${JSON.stringify(batch, null, 2)}\n`);
  console.log("wrote", path);
}
console.log("\nImport these into the Safe Transaction Builder IN ORDER, and sign ONLY after the gate is green.");
