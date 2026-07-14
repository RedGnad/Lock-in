# Modèle de preuve Strava v2

## Ce que l’acceptation prouve

Une acceptation v2 signifie que quatre réponses Strava authentifiées ont été attestées par Reclaim et validées contre le provider privé exact `f3ec8292-d8f3-487c-a79d-f53f482f88e2@1.0.1`. Ensemble, elles établissent que :

1. la session correspond au compte Strava actuellement connecté ;
2. ce compte expose un `Run` dont le titre contient le challenge imprévisible du pacte ;
3. l’heure de départ est dans la fenêtre du pacte ;
4. `distance_raw` atteint la distance minimale en mètres ;
5. Strava renvoie `has_latlng=true` et `trainer=false` ;
6. la preuve est liée au portefeuille, au pacte et à la session initiée par Lock In ;
7. la configuration du provider, le TEE, la fraîcheur et l’usage unique sont validés par le SDK ; une attestation EIP-712 de cinq minutes engage ce résultat, et le contrat exige en plus les signatures Reclaim, les quatre hashes du provider et le nullifier.

L’activité manuelle de test créée pendant le spike renvoie `has_latlng=false` : elle est donc volontairement une fixture négative et la politique la rejette avec `NO_GPS`.

## Limite incompressible

Strava et zkTLS attestent des données numériques, pas le déplacement biologique d’une personne. Un utilisateur déterminé peut encore fabriquer ou importer un fichier GPS vraisemblable, partager son compte ou faire transporter un appareil. Aucun provider Strava ne peut rendre ces attaques mathématiquement impossibles, car Strava lui-même accepte des données importées.

Pour le hackathon à mise maximale de 1 USD, la v2 réduit fortement la fraude opportuniste : challenge créé après engagement, compte authentifié, GPS obligatoire, trainer interdit, date et distance exactes, preuve fraîche et non rejouable. Une version à enjeu supérieur devrait exiger en plus une attestation signée par un wearable/OS de confiance, analyser le tracé et la cinématique, introduire un délai de contestation et plafonner le risque cumulé. Même cet ensemble ne constitue pas une preuve physique absolue.

## Règles de règlement

- Aucun règlement ne dépend du seul contenu client, de la seule signature applicative ou de la seule signature Reclaim : les trois doivent concorder.
- La validation SDK Reclaim et `validateStravaEvidence` s’exécutent avant soumission ; `LockInEscrow` refait les contrôles déterminants onchain et vérifie l’attestation SDK EIP-712.
- La version du provider est exactement `1.0.1`, sans fallback vers `latest`.
- Le token HMAC lie la session attendue pendant vingt minutes ; onchain, le bitmap journalier et `usedActivityNullifiers` rendent tout rejeu inexécutable même si l’API stateless revoit la preuve.
- La clé EIP-712 est dédiée, hors du navigateur et distincte des clés de déploiement ; le propriétaire du contrat peut la faire tourner si elle est compromise.
- Le constructeur du contrat fixe un plafond immuable en unités du token stable sélectionné ; un token volatil ne doit pas être présenté comme un plafond USD sans oracle.
- En cas d’indisponibilité de Reclaim ou Strava, le pacte doit être remboursable, jamais automatiquement perdu.
- Avant chaque signature, l’API relit `evidenceSigner` onchain et refuse une clé serveur qui ne correspond pas au contrat.
- Les routes API bornent la taille JSON et refusent les appels navigateur cross-origin ; les en-têtes de sécurité empêchent notamment l’embarquement de l’app dans une frame.
- Les transactions estiment leur gas puis ajoutent seulement 5 % : sur Monad, une limite volontairement surévaluée serait directement facturée à l’utilisateur.
- Les paquets Solidity/Foundry restent des dépendances de développement ; le graphe réellement embarqué dans Vercel passe `pnpm audit --prod` sans vulnérabilité connue au 14 juillet 2026.
- `.vercelignore` exclut explicitement tout `.env`, fixture de preuve, session et artefact de build des uploads CLI ; les secrets de production doivent venir uniquement du coffre de variables Vercel.
