# Installer Penida Analytics — sans terminal

Tout se fait dans ton navigateur. **Aucune commande à exécuter sur ton ordinateur, aucun code à écrire sur GitHub, aucun identifiant de base à copier.**

## 1. Choisir le compte Cloudflare

Connecte-toi à Cloudflare avec **penidastudio@gmail.com** et sélectionne le compte destiné à Penida. Active **Workers Paid, à partir de 5 $ US/mois + dépassements**, pour l'import de tes gros historiques. Les quotas gratuits sont trop bas pour les lots de cette version. L'abonnement concerne le compte, pas chaque app. Aucun abonnement n'est souscrit par ce projet.

## 2. Déployer en quelques clics

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/charlesmdp/appanalytics)

1. Clique sur **Deploy to Cloudflare** ci-dessus.
2. Sélectionne ton compte Cloudflare. Si Cloudflare demande de connecter GitHub, utilise `charlesmdp` et autorise l'accès demandé au projet.
3. Accepte les noms proposés pour le projet, les deux bases et la file. Le bouton peut créer automatiquement une **copie du dépôt dans ton GitHub** : il ne faut pas essayer de réutiliser le nom `appanalytics` si Cloudflare indique qu'il existe déjà. Garde alors le nouveau nom proposé.
4. Dans les champs de secrets présentés par Cloudflare, remplis les **trois valeurs** ci-dessous. Ne modifie pas les champs de compilation/déploiement.
5. Clique sur **Deploy** et attends la fin du déploiement. Ouvre l'adresse en `.workers.dev` fournie par Cloudflare.

| Champ | Ce qu'il faut mettre |
|---|---|
| `PARTNER_TOKEN_BIG_DOWNLOAD` | Le jeton **Partner API** du compte Shopify Partners **655806**. |
| `PARTNER_TOKEN_COWLENDAR` | Le jeton **Partner API** du compte Shopify Partners **4386727**. |
| `DASHBOARD_PASSWORD` | Un mot de passe long et unique de **12 caractères minimum**, pour te connecter au dashboard. |

Ce sont les **jetons Partner API**, pas les secrets OAuth des apps. Dans chaque compte Shopify Partners : **Settings → Partner API clients → Manage Partner API clients**, créer un client avec **View financials** et **Manage apps**. Les app IDs et les dates de lancement sont déjà intégrés.

Si l'assistant Cloudflare ne présente pas les secrets : termine le déploiement, puis **Workers & Pages → ton Worker → Settings → Variables and Secrets → Add**. Ajoute les trois noms ci-dessus, chacun avec le type **Secret**, colle la valeur, puis valide **Deploy**. Aucune donnée n'est accessible sans le mot de passe ; le Cron ne démarre pas tant que le mot de passe et les jetons concernés manquent. La clé interne de session est créée automatiquement.

## Utiliser directement le dépôt appanalytics, sans copie

Dans **Cloudflare → Workers & Pages → Create application → Import a repository / Connect GitHub**, choisis **charlesmdp/appanalytics**, branche **main**, dossier racine. Garde les réglages proposés et clique sur **Deploy**. Le fichier de configuration à la racine fournit la compilation et la création des ressources même si Cloudflare utilise sa commande de déploiement par défaut. Ajoute ensuite les trois secrets dans **Settings → Variables and Secrets**, type **Secret**, puis valide **Deploy**.

Les commandes visibles dans Cloudflare sont exécutées **par Cloudflare sur ses serveurs**. Tu n'as rien à ouvrir ni à saisir dans Terminal. Les mises à jour de la branche connectée sont redéployées par Workers Builds. Le workflow GitHub Actions vérifie le code ; aucun secret Cloudflare ou Shopify n'est à mettre dans GitHub Actions.

## 3. Ouvrir le dashboard

Connecte-toi avec `DASHBOARD_PASSWORD`. Va dans **Synchronisation → Synchroniser les deux apps** pour démarrer immédiatement. Sinon, le Cron démarre au prochain passage, toutes les 15 minutes. Tu peux fermer le navigateur pendant l'import.

| App | Compte Partner | App ID | Début de l'historique |
|---|---|---|---|
| Big Download | 655806 | 6922231 | 17 novembre 2022 |
| Cowlendar | 4386727 | 5822535 | 21 janvier 2022 |

Cloudflare crée et relie les deux bases D1 et la file d'import. Le Worker initialise les tables automatiquement au premier accès ; les mises à jour préservent les données déjà importées. Une page de connexion vide de données après le déploiement est normale tant que les secrets ne sont pas renseignés.

## Budget à prévoir

**Estimation de départ : 5 à 10 $ US/mois hors taxes** pour un dashboard privé et les synchronisations des deux apps, si l'usage reste proche des quotas inclus. Ce n'est pas un plafond garanti : le volume réel de l'historique n'est pas encore connu.

- Workers Paid : base de **5 $/mois**, avec 10 millions de requêtes et 30 millions de millisecondes CPU par mois. L'attente des réponses Shopify n'est pas du temps CPU.
- D1 : **50 millions d'écritures**, **25 milliards de lectures** et **5 Go** inclus au niveau du compte. Au-delà : **1 $/million d'écritures**, **0,001 $/million de lectures**, **0,75 $/Go-mois**.
- Queues : **1 million d'opérations/mois** inclus, puis **0,40 $/million**. Un message consomme normalement trois opérations ; un message traite un lot, pas un paiement isolé.

Le premier import est le principal inconnu. Exemple : **75 millions d'écritures D1 facturables dans le mois = 25 $ de dépassement D1**, donc au moins 30 $ avec l'abonnement, avant les autres dépassements éventuels et taxes. Une transaction Shopify peut provoquer plusieurs écritures : index, agrégats et suivi de progression comptent aussi. Les quotas sont partagés avec tes autres projets Cloudflare.

L'IA est désactivée par défaut. Tu peux suivre les consommations réelles dans **Cloudflare → D1 → base → Metrics**, et dans la facturation du compte. La limite CPU par exécution et le bouton Pause ne constituent pas un plafond financier mensuel.

Tarifs vérifiés le 28 septembre 2026 : [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [Queues](https://developers.cloudflare.com/queues/platform/pricing/).

## Analyse IA, facultative

Les observations chiffrées et les scénarios sont déjà disponibles sans IA. Pour activer l'analyse IA, ouvre **Settings → Variables and Secrets**, modifie la variable texte **AI_ENABLED** en **true**, puis valide **Deploy**. La connexion Workers AI est déjà prévue : aucune clé OpenAI à acheter ou à configurer. L'utilisation de Workers AI suit sa tarification propre ; elle n'est pas comprise dans l'estimation ci-dessus.

L'analyse est déclenchée seulement par le bouton du dashboard. Elle transmet uniquement des chiffres agrégés, jamais les jetons, noms ou domaines de boutiques, identifiants de transaction ou détails clients. Les réponses identiques sont mises en cache une heure. Le modèle utilisé est `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Un texte d'IA reste une interprétation à vérifier.

## Lecture des données

- **30 / 90 / 365 derniers jours** : jours calendaires UTC complets, hier inclus.
- **Mois dernier** : mois calendaire complet. **Mois en cours / cette année / tout l’historique** : incluent aujourd’hui, signalé comme partiel.
- **MRR quotidien** : niveau en fin de journée (ou au dernier état synchronisé pour aujourd’hui), abonnements annuels divisés par 12, hors essais, hors usage et hors charges de test identifiées. Les règles d’inférence des abonnements sont celles de PartnerDex ; toutes les alternances gel/dégel sont rejouées.
- **Croissance MRR** : niveau en fin de période moins celui avant le premier jour. Pourcentage non affiché quand le MRR initial est nul.
- **Installations / désinstallations** : événements explicites de pose/retrait de l’app, réinstallations comprises ; fermetures/réouvertures de boutiques sont affichées séparément. C’est un nombre d’événements, pas de visiteurs uniques.
- **Boutiques payantes** : une boutique au plus par app et par devise, même lors d’un changement de forfait. Deux apps = deux relations.
- **Revenus bruts / nets** : montants des transactions Shopify, datés de leur enregistrement dans le flux Partner, avec leurs signes. Ce ne sont pas des dates de débit merchant ni un relevé comptable.
- **Devises** : sélection séparée, jamais de conversion implicite ni d’addition de devises.
- **Projections** : MRR du dernier état synchronisé, indépendant de la période historique sélectionnée. Croissance composée mensuelle, stable 0 %, recul −3 %, croissance +5 %, scénario personnel de −20 % à +20 %. Ce sont des hypothèses illustratives, pas un modèle prédictif appris.

La page Cloudflare est centrée sur les métriques demandées. Les anciens écrans avancés PartnerDex (avis App Store, Slack et funnel BigQuery) restent dans la version Node d’origine et ne sont pas activés dans cette interface D1.

## Gros historiques et progression

Chaque app dispose d’une base D1 indépendante. Une tâche lit au maximum une page Shopify à la fois, en fenêtres mensuelles ; chaque lot enregistre les lignes **et** le curseur dans la même transaction D1. Les clés uniques empêchent les doubles comptages. La file enchaîne les lots, un verrou évite les imports concurrents d’une même app et le Cron peut relancer un travail abandonné.

Le dashboard affiche les pages/lignes réellement reçues, le calendrier traité, les boutiques calculées, les reprises et les erreurs. Il n’affiche aucun pourcentage fictif de paiements : Shopify ne donne pas le total. Après trois fenêtres, une fourchette indicative est calculée sur les douze dernières durées observées, uniquement pour la phase d’import. L’estimation de calcul est séparée. Une hausse récente du volume peut fortement allonger le temps restant.

Les calculs se font par boutique, puis produisent des variations journalières compactes. Les graphiques lisent ces agrégats au lieu de scanner les paiements à chaque affichage. Pendant un recalcul, les valeurs peuvent être partiellement mises à jour : un bandeau les signale et bloque projections/IA jusqu’à la fin.

Après l’import initial, une synchronisation relit les trois jours précédant le dernier point acquis, comme PartnerDex. Le bouton **Relire tout l’historique** permet de récupérer des corrections plus anciennes. Une correction datée de plus de trois jours ne sera pas découverte par la seule mise à jour incrémentale. Les événements supprimés de la source ne sont pas automatiquement effacés localement.

Limites actuelles : D1 Paid est plafonné à **10 Go par base**. Il faut surveiller le stockage dans Cloudflare pour des dizaines de millions de lignes. Une boutique dépassant 10 000 événements ou 900 écritures de dérivation par lot arrête le travail avec une erreur explicite ; ses données restent conservées pour traitement adapté. Aucun test de charge avec le véritable volume des apps n’est possible sans connexion Shopify.

## Origine et licence

Base : https://github.com/AdityaMalani/partnerdex — commit `32dbca5c58a7db67df35b75f71ca1119ad0b452d`.

Le fichier `LICENSE` GPL version 3 est conservé. La déclaration du package a été alignée sur ce fichier ; le dépôt d’origine annonçait MIT dans `package.json`, en contradiction avec `LICENSE`. Cette adaptation conserve l’attribution PartnerDex et ses obligations de licence.

Documentation officielle :
- https://shopify.dev/docs/api/partner/latest
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/queues/
- https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/
