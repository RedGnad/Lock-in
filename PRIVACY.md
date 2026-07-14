# Politique de confidentialité — Lock In (prototype hackathon)

Version du 14 juillet 2026.

Cette politique décrit le prototype Lock In limité à des engagements symboliques d’au plus 1 USD. Le contact public du responsable du prototype est **mookipstore@hotmail.com**.

## Données traitées

Pour vérifier un pacte Strava, Lock In traite uniquement :

- l’adresse de portefeuille, l’identifiant du pacte et son challenge aléatoire ;
- l’identifiant de session Reclaim ;
- l’identifiant du compte athlète et de l’activité Strava ;
- le titre, le type de sport, l’heure de départ et la distance en mètres ;
- les booléens Strava `has_latlng`, `trainer` et `flagged` ;
- les temps de mouvement/écoulé et le dénivelé nécessaires aux contrôles de plausibilité ;
- le résultat de validation, un nullifier cryptographique et, après déploiement, la transaction onchain.

Lock In ne demande, ne reçoit et ne stocke ni mot de passe Strava, ni cookie Strava, ni jeton d’accès Strava, ni tracé GPS détaillé. La connexion s’effectue dans le flux isolé de Reclaim.

Pour permettre la vérification onchain, le portefeuille soumet toutefois les preuves Reclaim transformées dans le calldata d’une transaction Monad. Le contexte public de ces preuves contient le marqueur du compte athlète, l’identifiant et le titre de l’activité, le sport, l’heure de départ, la distance, les booléens GPS/trainer/flag, les temps de mouvement et écoulé, le dénivelé, le pacte et les métadonnées de preuve. Ces données deviennent publiques et permanentes. Les réglages de confidentialité Strava ne masquent pas la copie publiée dans le calldata.

## Finalités et base

Ces données servent exclusivement à créer le pacte, vérifier que ses conditions sont satisfaites, empêcher le rejeu d’une preuve, régler l’engagement et traiter un éventuel incident. Le traitement est nécessaire à l’exécution du service demandé par l’utilisateur ; le consentement explicite est demandé avant l’ouverture du flux Strava/Reclaim.

## Conservation et minimisation

- L’API web encode la politique de session dans un token HMAC qui expire après vingt minutes et n’est pas inscrit dans une base utilisateur.
- La preuve brute est vérifiée en mémoire et n’est pas conservée par le backend applicatif.
- Après acceptation, le backend web ne conserve pas l’identifiant de session ni la preuve ; le bitmap et le nullifier onchain empêchent la réutilisation de l’activité.
- Les preuves transformées et leurs champs minimisés sont ensuite publiés par le portefeuille dans le calldata Monad. L’adresse, le pacte, les champs listés ci-dessus, le nullifier et la transaction sont publics et ne peuvent pas être supprimés par Lock In.

Les scripts CLI de développement peuvent créer des fichiers locaux sous `sessions/` et `proofs/`. Ils sont ignorés par Git, automatiquement élagués pour les sessions et doivent être supprimés après les tests.

## Destinataires et sécurité

Les données sont traitées par Lock In et par les services strictement nécessaires : Reclaim pour la preuve zkTLS, Strava comme source déclarative et la blockchain choisie pour le règlement. Les secrets applicatifs restent côté serveur. Les versions de provider sont verrouillées, les sessions sont liées au portefeuille et au pacte, et chaque session/nullifier n’est accepté qu’une fois.

## Droits

Selon la juridiction applicable, l’utilisateur peut demander l’accès, la rectification, l’effacement ou la limitation des données hors chaîne, ainsi que s’opposer au traitement, via l’adresse affichée sur `/privacy` et configurée dans `NEXT_PUBLIC_PRIVACY_EMAIL`. Il peut également saisir son autorité locale de protection des données. Les données déjà inscrites sur une blockchain publique ne peuvent matériellement pas être effacées ; Lock In peut seulement supprimer ses copies hors chaîne.

## Enfants et évolution

Le prototype n’est pas destiné aux mineurs. Toute extension à Duolingo ou à un nouveau fournisseur fera l’objet d’une analyse séparée des données et d’une mise à jour de cette politique avant activation.
