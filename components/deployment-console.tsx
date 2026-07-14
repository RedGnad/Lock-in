"use client";

import { useState } from "react";
import {
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { monad } from "@/src/chain";
import { addMonadGasBuffer } from "@/src/monad-gas";

type Artifact = { abi: Abi; bytecode: Hex };
type DeploymentConfig = {
  expectedDeployer: Address;
  evidenceSigner: Address;
  stakeToken: Address;
  maxStake: string;
  witness: Address;
  witnessHost: string;
  artifacts: { reclaim: Artifact; proxy: Artifact; escrow: Artifact };
};
type DeploymentReport = Record<string, string>;

export function DeploymentConsole() {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Ready to deploy from the configured wallet.");
  const [report, setReport] = useState<DeploymentReport>({});

  async function persist(next: DeploymentReport) {
    setReport(next);
    await fetch("/api/dev/deployment-result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
  }

  async function deployArtifact(artifact: Artifact, args: readonly unknown[] = []) {
    if (!address || !publicClient || !walletClient) throw new Error("Wallet unavailable");
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args } as never);
    const estimate = await publicClient.estimateGas({ account: address, data });
    const hash = await walletClient.deployContract({
      account: address,
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args,
      gas: addMonadGasBuffer(estimate),
    } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("The deployment transaction returned no contract address");
    return { hash, address: getAddress(receipt.contractAddress) };
  }

  async function deploy() {
    if (!address || !publicClient || !walletClient) return setStatus("Connect your wallet first.");
    if (chainId !== monad.id) return setStatus("Switch your wallet to Monad before continuing.");
    setBusy(true);
    try {
      const response = await fetch("/api/dev/deployment-artifacts", { cache: "no-store" });
      const config = await response.json() as DeploymentConfig & { error?: string };
      if (!response.ok) throw new Error(config.error || "Artifacts unavailable");
      if (getAddress(address) !== getAddress(config.expectedDeployer)) {
        throw new Error(`Wrong wallet connected. Expected address: ${config.expectedDeployer}`);
      }

      setStatus("1/4 — Deploying the Reclaim verifier…");
      const implementation = await deployArtifact(config.artifacts.reclaim);
      let next: DeploymentReport = {
        reclaimImplementation: implementation.address,
        reclaimImplementationTx: implementation.hash,
      };
      await persist(next);

      setStatus("2/4 — Deploying and atomically initializing the proxy…");
      const initializationData = encodeFunctionData({
        abi: config.artifacts.reclaim.abi,
        functionName: "initialize",
        args: [zeroAddress],
      });
      const proxy = await deployArtifact(config.artifacts.proxy, [implementation.address, initializationData]);
      next = { ...next, reclaim: proxy.address, reclaimProxyTx: proxy.hash };
      await persist(next);

      setStatus("3/4 — Registering the official Reclaim witness…");
      const epochRequest = {
        account: address,
        address: proxy.address,
        abi: config.artifacts.reclaim.abi,
        functionName: "addNewEpoch",
        args: [[{ addr: config.witness, host: config.witnessHost }], 1],
      } as const;
      const epochEstimate = await publicClient.estimateContractGas(epochRequest);
      const epochHash = await walletClient.writeContract({
        ...epochRequest,
        gas: addMonadGasBuffer(epochEstimate),
      } as never);
      await publicClient.waitForTransactionReceipt({ hash: epochHash });
      next = { ...next, reclaimEpochTx: epochHash };
      await persist(next);

      setStatus("4/4 — Deploying the Lock In escrow…");
      const escrow = await deployArtifact(config.artifacts.escrow, [
        config.stakeToken,
        proxy.address,
        config.evidenceSigner,
        BigInt(config.maxStake),
      ]);
      next = { ...next, escrow: escrow.address, escrowTx: escrow.hash };
      await persist(next);
      setStatus("Monad deployment completed and saved to /tmp/lock-in-deployment.json.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Deployment interrupted");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="legal-page">
      <p className="eyebrow"><span>LOCAL</span> Deployment console</p>
      <h1>Ship,<br/><em>without exposing the key.</em></h1>
      <section><h2>How it works</h2><p>This page only exists in development. The connected wallet signs four Monad transactions: Reclaim implementation, atomic proxy, witness epoch, and Lock In escrow.</p></section>
      <button className="lock-button" onClick={deploy} disabled={busy || !address}>{busy ? "Deploying…" : "DEPLOY TO MONAD"}</button>
      <p className="form-status">{status}</p>
      {Object.keys(report).length > 0 && <pre className="deployment-report">{JSON.stringify(report, null, 2)}</pre>}
    </main>
  );
}
