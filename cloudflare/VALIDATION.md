# Vérification de la version Penida

Vérifications effectuées le 28 septembre 2026 :

- 261 tests PartnerDex passent après extraction du moteur de calcul partagé.
- 15 tests Cloudflare passent : périodes calendaires, devises séparées, MRR initial d’une période, annualisation, plusieurs gels/dégels, changement de forfait sans double comptage des boutiques, essais annulés, remplacement atomique des agrégats, correction/relecture des paiements, scénarios, consolidation de deux bases, projections indépendantes des filtres historiques, pipeline paginé, pause/verrou/reprise et authentification signée.
- Initialisation automatique de bases vierges, concurrence, reprise après échec, conservation d'un import existant et génération persistante de la clé de session vérifiées.
- Les vérifications TypeScript des deux versions passent.
- La compilation du dashboard réussit.
- Les migrations locales D1 et l'initialisation automatique sont vérifiées dans le runtime Wrangler.
- L’assemblage du Worker en `wrangler deploy --dry-run` réussit : aucun déploiement effectué.
- Vérification dans le navigateur du runtime local : connexion, dashboard, changement de période, filtre d’app, écran de synchronisation et réglage d’une projection de +5 % à −5 %.
- L’audit npm après mises à jour compatibles ne signale aucune vulnérabilité connue.

Limites de cette vérification : les réponses Shopify des tests sont simulées. Le déploiement distant reste à finaliser dans le compte Cloudflare après activation du plan et saisie des secrets. Les chiffres de l’aperçu local sont fictifs et signalés comme tels. Aucun jeton Shopify réel n’a été fourni, aucun import de production ni test de charge sur le volume réel n’a été effectué. Workers AI est intégré mais désactivé et n’a pas été appelé. La première connexion devra valider les permissions des deux comptes et rapprocher quelques périodes avec Shopify.

L’aperçu local actuel utilise un fichier `.dev.vars` ignoré par Git, avec `DEMO_MODE=true`. Ce réglage n’est pas dans la configuration déployable ni dans l’archive source. Pour utiliser cet environnement local avec des données réelles, utiliser des bases locales vierges et retirer le mode démo ; ne pas mélanger les fixtures de démonstration avec les données Shopify.
