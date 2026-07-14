# Politique de confidentialité — Lock In (prototype hackathon)

Version du 14 juillet 2026.

Cette politique décrit le prototype Lock In limité à des engagements symboliques d’au plus 1 USD. L’identité du responsable et la valeur publique `NEXT_PUBLIC_PRIVACY_EMAIL` doivent être renseignées avant toute mise en ligne publique : **[responsable à renseigner]**.

## Données traitées

Pour vérifier un pacte Strava, Lock In traite uniquement :

- l’adresse de portefeuille, l’identifiant du pacte et son challenge aléatoire ;
- l’identifiant de session Reclaim ;
- l’identifiant du compte athlète et de l’activité Strava ;
- le titre, le type de sport, l’heure de départ et la distance en mètres ;
- les booléens Strava `has_latlng` et `trainer` ;
- le résultat de validation, un nullifier cryptographique et, après déploiement, la transaction onchain.

Lock In ne demande, ne reçoit et ne stocke ni mot de passe Strava, ni cookie Strava, ni jeton d’accès Strava, ni tracé GPS détaillé. La connexion s’effectue dans le flux isolé de Reclaim. Le titre de l’activité reste soumis aux réglages de confidentialité choisis par l’utilisateur sur Strava.

## Finalités et base

Ces données servent exclusivement à créer le pacte, vérifier que ses conditions sont satisfaites, empêcher le rejeu d’une preuve, régler l’engagement et traiter un éventuel incident. Le traitement est nécessaire à l’exécution du service demandé par l’utilisateur ; le consentement explicite est demandé avant l’ouverture du flux Strava/Reclaim.

## Conservation et minimisation

- L’API web encode la politique de session dans un token HMAC qui expire après vingt minutes et n’est pas inscrit dans une base utilisateur.
- La preuve brute est vérifiée en mémoire et n’est pas conservée par le backend applicatif.
- Après acceptation, le backend web ne conserve pas l’identifiant de session ni la preuve ; le bitmap et le nullifier onchain empêchent la réutilisation de l’activité.
- Les données inscrites sur une blockchain publique — adresse, identifiant/hash de pacte, nullifier et transaction — sont publiques et ne peuvent pas être supprimées par Lock In.

Les scripts CLI de développement peuvent créer des fichiers locaux sous `sessions/` et `proofs/`. Ils sont ignorés par Git, automatiquement élagués pour les sessions et doivent être supprimés après les tests.

## Destinataires et sécurité

Les données sont traitées par Lock In et par les services strictement nécessaires : Reclaim pour la preuve zkTLS, Strava comme source déclarative et la blockchain choisie pour le règlement. Les secrets applicatifs restent côté serveur. Les versions de provider sont verrouillées, les sessions sont liées au portefeuille et au pacte, et chaque session/nullifier n’est accepté qu’une fois.

## Droits

Selon la juridiction applicable, l’utilisateur peut demander l’accès, la rectification, l’effacement ou la limitation des données hors chaîne, ainsi que s’opposer au traitement, via l’adresse affichée sur `/privacy` et configurée dans `NEXT_PUBLIC_PRIVACY_EMAIL`. Il peut également saisir son autorité locale de protection des données. Les données déjà inscrites sur une blockchain publique ne peuvent matériellement pas être effacées ; Lock In peut seulement supprimer ses copies hors chaîne.

## Enfants et évolution

Le prototype n’est pas destiné aux mineurs. Toute extension à Duolingo ou à un nouveau fournisseur fera l’objet d’une analyse séparée des données et d’une mise à jour de cette politique avant activation.
