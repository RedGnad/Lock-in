# Lock In

Lock in. Prove it. Or the finishers take your stake.

Lock In est une app d’engagement à mise symbolique : un utilisateur verrouille au plus 1 USD, réalise une mission réelle puis présente une preuve zkTLS. Strava est le premier connecteur ; Duolingo viendra après la boucle Strava complète.

## État réel du développement

La preuve Strava v2 est publiée et son moteur de décision est implémenté :

- provider Reclaim privé `f3ec8292-d8f3-487c-a79d-f53f482f88e2`, version verrouillée `1.0.2` ;
- preuve du compte Strava connecté, de l’activité recherchée par challenge, de `has_latlng`, `trainer`, `flagged` et des métriques de mouvement ;
- contrôles du titre/challenge, sport `Run`, fenêtre temporelle, distance entière en mètres, GPS présent, trainer absent, activité non signalée et cinématique plausible ;
- liaison au portefeuille, pacte et session Reclaim initiée par Lock In ;
- vérification de la configuration Reclaim exacte, TEE obligatoire par défaut, fraîcheur de dix minutes ;
- validation SDK exacte + TEE attestée au contrat par un signataire dédié, en complément des signatures Reclaim onchain ;
- nullifier d’activité côté serveur et onchain contre le rejeu ;
- tests TypeScript et Solidity couvrant activité manuelle, trainer, signalement Strava, cinématique impossible, mauvais sport/challenge, date/distance, autre wallet, mauvais provider, attestation absente, rejeu et Sybil.

La fixture Strava créée pendant le spike est manuelle et renvoie `has_latlng=false`. Elle sert désormais de cas négatif : la v2 la rejette. Elle n’est pas présentée comme une course réelle.

Le contrat quotidien, l’API et l’interface responsive sont maintenant implémentés. `LockInEscrow.sol` couvre 1 à 5 jours, USDC natif Monad, plafond immuable de 1 USDC, partage du pool, quatre preuves Reclaim vérifiées onchain, attestation SDK/TEE, hashes exacts du provider, GPS/date/distance, nullifier global et remboursement d’urgence. Le runtime Vercel n’a aucune vulnérabilité connue selon `pnpm audit --prod`, les dépendances sont épinglées et les transactions utilisent une estimation de gas assortie d’une marge Monad limitée à 5 %. Il reste avant l’ouverture publique : déployer/configurer les contrats, renseigner le contact privacy et exécuter une vraie course GPS E2E. `LockInReclaimSpike.sol` reste uniquement l’ancien spike minimal et n’est pas déployé par défaut.

## Flux v2

1. Lock In crée un pacte de 1 à 5 jours, sa distance et un challenge aléatoire `LI-…`.
2. Pour chaque jour, le backend crée une session Reclaim exactement sur le provider `1.0.2`, liée à `pactId:dayIndex`.
3. L’utilisateur enregistre un run GPS et place le challenge dans son titre Strava.
4. Reclaim lit quatre réponses authentifiées sans transmettre les identifiants Strava à Lock In.
5. Le backend prévalide la version publiée, le TEE, le contexte et les règles métier, puis signe une attestation de cinq minutes sans conserver la preuve brute.
6. Le portefeuille soumet les quatre preuves et cette attestation ; le contrat exige les deux et revérifie signatures Reclaim, hashes provider, contexte, date, distance, GPS et nullifier.

Le détail exact des garanties et des attaques résiduelles est dans [SECURITY.md](SECURITY.md). La politique de minimisation est dans [PRIVACY.md](PRIVACY.md).

## Configuration locale

Copier `.env.example` vers `.env`, puis renseigner les identifiants Reclaim et l’adresse de test. `SECRET`, les clés privées, `sessions/` et `proofs/` sont ignorés par Git et ne doivent jamais être exposés au navigateur.

```bash
pnpm install
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

Créer ensuite une session. Sans `STRAVA_CHALLENGE`, le script génère un challenge cryptographiquement aléatoire :

```bash
pnpm proof:request
```

Le résultat indique le challenge à placer dans le titre de la nouvelle course GPS. Après le flux Reclaim, placer la réponse JSON sous `proofs/` puis vérifier :

```bash
pnpm proof:inspect -- proofs/strava-v2.json
```

Le deuxième passage du même fichier est rejeté comme rejeu. `REQUIRE_TEE_ATTESTATION=false` existe uniquement pour examiner d’anciennes fixtures MCP ; il ne doit jamais être utilisé pour un règlement.

Le prototype verrouille l’USDC natif Circle sur Monad (`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`), contrôlé onchain comme `USDC` à six décimales. Renseigner le vérifieur Reclaim déployé, le signataire dédié et le plafond, puis déployer l’escrow :

```bash
pnpm build:contracts
pnpm deploy:reclaim
# Reporter l’adresse `reclaim` dans RECLAIM_CONTRACT_ADDRESS.
pnpm deploy:escrow
# Reporter l’adresse `escrow` dans NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS.
pnpm provider:check
pnpm production:check
```

`MAX_STAKE_ATOMIC_UNITS=1000000` impose exactement 1 USDC. Source primaire : [registre officiel Circle des adresses USDC](https://developers.circle.com/stablecoins/usdc-contract-addresses).

## Provider et vie privée

La recette relue depuis Reclaim est conservée dans `providers/strava-date-distance.json`. Lock In ne stocke ni mot de passe/cookie Strava, ni token Strava, ni tracé GPS détaillé. L’API web est stateless : sa politique tient dans un token HMAC de vingt minutes et la preuve brute disparaît après la réponse. Le CLI local garde seulement ses fixtures ignorées par Git.

Le prototype ne doit pas être publié tant que l’identité et le contact du responsable de traitement ne sont pas renseignés dans `PRIVACY.md`.

## Interface et API

`pnpm dev` lance la home, la page publique `/pact/[id]`, les trois routes stateless `/api/reclaim/*` et `/api/health`. Il faut configurer `NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS`, les secrets Reclaim, `SESSION_SIGNING_SECRET`, `EVIDENCE_SIGNER_PRIVATE_KEY`, `NEXT_PUBLIC_PRIVACY_EMAIL` et l’URL publique du dépôt. Aucun secret ne doit utiliser le préfixe `NEXT_PUBLIC_`.

Le polling Reclaim est exécuté dans le navigateur par requêtes courtes. Les routes Node Vercel créent la session, lisent son état et vérifient la preuve ; aucune base ni processus long n’est nécessaire. Un backend Render séparé n’est donc pas requis pour la v2.

## Mise en production

1. Utiliser une clé de déploiement Monad distincte et approvisionnée uniquement du MON nécessaire.
2. Générer une clé EIP-712 dédiée au validator et un secret HMAC d’au moins 32 caractères.
3. Déployer le vérifieur Reclaim puis `LockInEscrow`, vérifier le bytecode sur les explorateurs et exécuter `pnpm production:check`.
4. Publier le dépôt, relier le projet Vercel et configurer les variables pour Production et Preview.
5. Déployer avec `vercel deploy --prod`, contrôler `/api/health`, puis réaliser le parcours complet avec une nouvelle activité Strava GPS.

Les routes limitent les corps JSON, refusent les requêtes navigateur cross-origin et vérifient que la clé validator Vercel correspond au signer du contrat avant de signer. La page pacte demande le consentement explicite avant d’ouvrir Reclaim.
