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
  const [status, setStatus] = useState("Prêt à déployer depuis le wallet configuré.");
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
    if (!address || !publicClient || !walletClient) throw new Error("Wallet indisponible");
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
    if (!receipt.contractAddress) throw new Error("La transaction de déploiement ne contient aucune adresse");
    return { hash, address: getAddress(receipt.contractAddress) };
  }

  async function deploy() {
    if (!address || !publicClient || !walletClient) return setStatus("Connecte d’abord ton wallet.");
    if (chainId !== monad.id) return setStatus("Passe le wallet sur Monad avant de continuer.");
    setBusy(true);
    try {
      const response = await fetch("/api/dev/deployment-artifacts", { cache: "no-store" });
      const config = await response.json() as DeploymentConfig & { error?: string };
      if (!response.ok) throw new Error(config.error || "Artefacts indisponibles");
      if (getAddress(address) !== getAddress(config.expectedDeployer)) {
        throw new Error(`Mauvais wallet connecté. Adresse attendue : ${config.expectedDeployer}`);
      }

      setStatus("1/4 — Déploiement du vérifieur Reclaim…");
      const implementation = await deployArtifact(config.artifacts.reclaim);
      let next: DeploymentReport = {
        reclaimImplementation: implementation.address,
        reclaimImplementationTx: implementation.hash,
      };
      await persist(next);

      setStatus("2/4 — Déploiement et initialisation atomique du proxy…");
      const initializationData = encodeFunctionData({
        abi: config.artifacts.reclaim.abi,
        functionName: "initialize",
        args: [zeroAddress],
      });
      const proxy = await deployArtifact(config.artifacts.proxy, [implementation.address, initializationData]);
      next = { ...next, reclaim: proxy.address, reclaimProxyTx: proxy.hash };
      await persist(next);

      setStatus("3/4 — Enregistrement du witness Reclaim officiel…");
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

      setStatus("4/4 — Déploiement de l’escrow Lock In…");
      const escrow = await deployArtifact(config.artifacts.escrow, [
        config.stakeToken,
        proxy.address,
        config.evidenceSigner,
        BigInt(config.maxStake),
      ]);
      next = { ...next, escrow: escrow.address, escrowTx: escrow.hash };
      await persist(next);
      setStatus("Déploiement Monad terminé et sauvegardé dans /tmp/lock-in-deployment.json.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Déploiement interrompu");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="legal-page">
      <p className="eyebrow"><span>LOCAL</span> Console de déploiement</p>
      <h1>Ship,<br/><em>sans exposer la clé.</em></h1>
      <section><h2>Principe</h2><p>Cette page n’existe qu’en développement. Le wallet connecté signe quatre transactions Monad : implémentation Reclaim, proxy atomique, epoch witness et escrow Lock In.</p></section>
      <button className="lock-button" onClick={deploy} disabled={busy || !address}>{busy ? "Déploiement en cours…" : "DÉPLOYER SUR MONAD"}</button>
      <p className="form-status">{status}</p>
      {Object.keys(report).length > 0 && <pre className="deployment-report">{JSON.stringify(report, null, 2)}</pre>}
    </main>
  );
}
