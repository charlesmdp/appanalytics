# Penida Analytics

Dashboard privé pour **Big Download** et **Cowlendar**, adapté de [PartnerDex](https://github.com/AdityaMalani/partnerdex), hébergé dans ton compte Cloudflare.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/charlesmdp/appanalytics)

**[Installation sans terminal, en quelques clics →](cloudflare/SETUP.md)**

## Ce qu'il reste à faire

1. Utiliser le compte Cloudflare de Penida et activer Workers Paid, à partir de 5 $/mois.
2. Déployer avec le bouton ci-dessus, ou connecter ce dépôt à Workers & Pages pour éviter d'en créer une copie.
3. Renseigner dans Cloudflare seulement les deux jetons Partner API et un mot de passe pour le dashboard.

| Secret Cloudflare | Valeur |
|---|---|
| `PARTNER_TOKEN_BIG_DOWNLOAD` | Jeton Partner API du compte **655806** |
| `PARTNER_TOKEN_COWLENDAR` | Jeton Partner API du compte **4386727** |
| `DASHBOARD_PASSWORD` | Mot de passe unique, **12 caractères minimum** |

Les IDs des apps, dates de lancement, bases de données, file d'import et Cron sont préconfigurés. La création des tables et de la clé de session est automatique. **Aucune commande à lancer, aucun secret à enregistrer sur GitHub.**

## Dashboard

- Portefeuille des deux apps ou vue par app ; devises séparées.
- 30 jours, 90 jours, mois dernier, mois en cours, 365 jours, année, tout l'historique, dates personnalisées.
- MRR quotidien, croissance, installations/désinstallations quotidiennes, encaissements bruts et nets.
- Import reprenable : pages réellement reçues, calendrier traité, boutiques calculées, estimation indicative du temps restant, pause/reprise.
- Scénarios stable, recul, croissance et taux personnalisé ; hypothèses explicites.
- Analyse IA facultative, désactivée par défaut ; export CSV.

Les premiers imports peuvent être longs. Les chiffres restent signalés comme partiels jusqu'à leur fin. Les appels Shopify réels et la facture ne peuvent être validés qu'après connexion des deux comptes. [Détails des calculs et du budget](cloudflare/SETUP.md) · [Vérifications](cloudflare/VALIDATION.md).

## Origine

Basé sur PartnerDex, commit `32dbca5c58a7db67df35b75f71ca1119ad0b452d`. Licence [GPL-3.0](LICENSE) conservée. L'adaptation Cloudflare est dans `cloudflare/`, avec le moteur d'abonnements partagé dans `src/core/`. Les fonctionnalités Node d'origine sont conservées ; leur [documentation est séparée](docs/PARTNERDEX.md).
