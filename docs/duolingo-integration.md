# Intégration Duolingo

## Décision

Duolingo est intégrable comme second connecteur Reclaim, mais pas comme une simple copie du provider Strava. La mission recommandée est « gagner au moins N XP après le début du pacte », calculée à partir de deux états authentifiés du même compte : une baseline lors de l’engagement et un état final lors de la réclamation.

Un streak seul n’est pas une preuve suffisante : il peut être protégé ou réparé. Un total XP final seul ne prouve pas non plus que les XP ont été gagnés pendant le pacte.

## Preuves requises

1. À la création/jonction : identité Duolingo authentifiée, identifiant de compte, total XP et horodatage de la baseline.
2. À la réclamation : même identifiant de compte, nouveau total XP et horodatage.
3. Politique : `finalXp - baselineXp >= targetXp`, fenêtre temporelle du pacte, preuves fraîches et versions de provider verrouillées.
4. Nullifier : hash du provider, du compte, du pacte et de la baseline pour empêcher le rejeu ou le mélange de deux comptes.

La capture doit viser une réponse backend confirmée. L’interface Duolingo peut afficher une prédiction temporaire des XP avant confirmation serveur ; cette valeur client ne doit jamais servir au règlement.

## Architecture

L’escrow Strava déployé reste volontairement immuable et spécifique à quatre preuves Strava. Duolingo utilisera un second contrat/adaptateur avec son propre provider, ses hashes et sa politique. Le frontend sélectionnera l’adaptateur selon le type de mission. Cette séparation évite qu’une mise à jour Duolingo puisse affaiblir ou casser les pactes Strava.

## Limite anti-triche

Reclaim pourra prouver que Duolingo a confirmé les XP sur un compte authentifié. Cela ne prouve pas que la personne a appris sans bot, script, partage de compte ou aide extérieure. Pour le hackathon, la même limite de 1 USD et les contrôles de fréquence/anomalies restent obligatoires.

## Ordre d’exécution

1. Terminer une vraie course GPS E2E Strava et le déploiement Vercel.
2. Capturer via MCP Reclaim les réponses Duolingo authentifiées de baseline et de progression.
3. Publier et verrouiller un provider privé Duolingo après replay authentifié, rejet anonyme et preuve zkTLS.
4. Implémenter l’adaptateur/escrow Duolingo, les tests de delta/rejeu et l’interface de choix de mission.
5. Étendre la politique de confidentialité avant activation publique.
