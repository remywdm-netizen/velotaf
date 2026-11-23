# Peloton Vélotaf

Site web pour organiser un groupe qui va au travail à vélo, chaque jour ouvré.

- **Le prochain trajet** : qui fait l'aller, qui fait le retour, qui mène le groupe.
- **La semaine** : planning du lundi au vendredi, chacun coche ses cases (A+R, A seul, R seul).
- **Annonces** : « 5 min de retard », « Crevaison », « Je ne viens pas »… ou un message libre.
- **Ce mois-ci** : nombre de trajets, kilomètres roulés et CO₂ évité.
- **Réglages** : point de rendez-vous, heures de départ, distance, arrivée, itinéraire.

Pas de compte à créer : chaque groupe a un **lien secret** (`https://…/#k7Q2mX9pRtAb`) et chaque cycliste choisit
son prénom, retenu sur son téléphone. Le site fonctionne sur mobile et peut être ajouté à l'écran d'accueil.

Les données sont stockées dans **Firebase Firestore** (gratuit pour cet usage) et le site est hébergé sur
**GitHub Pages** (gratuit). Aucun serveur à gérer.

---

## Mise en route (≈ 10 minutes)

### 1. Créer la base de données Firebase

1. Allez sur <https://console.firebase.google.com> et connectez-vous avec un compte Google.
2. **Créer un projet** (ex. `peloton-velotaf`). Google Analytics n'est pas nécessaire.
3. Dans le menu **Créer → Firestore Database** : **Créer une base de données**, choisissez un emplacement
   européen (ex. `europe-west9` Paris), puis démarrez en **mode production**.
4. Onglet **Règles** de Firestore : remplacez tout le contenu par celui du fichier [`firestore.rules`](firestore.rules),
   puis **Publier**.
5. Revenez à la **vue d'ensemble du projet**, cliquez sur l'icône **Web `</>`** pour ajouter une application web
   (nom libre, pas besoin de Firebase Hosting). Firebase affiche un bloc `firebaseConfig = { … }`.
6. Copiez ces valeurs dans [`firebase-config.js`](firebase-config.js) et faites un commit.

Ces valeurs ne sont pas secrètes : elles identifient le projet. La protection vient des règles Firestore.

### 2. Publier le site avec GitHub Pages

1. Sur GitHub, dans le dépôt : **Settings → Pages**.
2. **Source** : *Deploy from a branch*, branche `main`, dossier `/ (root)`, **Save**.
3. Après une minute, le site est en ligne à `https://<votre-compte>.github.io/<nom-du-depot>/`.

### 3. Créer le groupe

1. Ouvrez le site, **Créer un groupe** avec son nom et votre prénom.
2. Remplissez les réglages (rendez-vous, horaires, distance).
3. **Copiez le lien du groupe** et envoyez-le aux collègues (messagerie, e-mail…).

---

## Essayer sans rien configurer

Tant que `firebase-config.js` est vide, le site tourne en **mode démo** : tout reste dans votre navigateur.
Pour le lancer sur votre ordinateur :

```bash
python3 -m http.server 8000
# puis ouvrez http://localhost:8000
```

(Un simple double-clic sur `index.html` ne suffit pas : les modules JavaScript exigent un serveur.)

---

## Sécurité et vie privée

- Le code du groupe (12 caractères aléatoires) est la clé : **toute personne qui a le lien peut lire et modifier
  le planning du groupe**. Ne le publiez pas sur un réseau social.
- Il est impossible de lister les groupes existants sans connaître leur code (règle `allow list: if false`).
- Seuls les prénoms, les jours cochés et les annonces des 7 derniers jours sont stockés. Les jours de plus de 2 mois
  sont effacés automatiquement à la prochaine modification de chaque cycliste.
- Les règles vérifient la forme et la taille des données envoyées.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html` | Structure de la page |
| `style.css` | Mise en forme (clair et sombre) |
| `app.js` | Logique : planning, annonces, statistiques, réglages |
| `store.js` | Accès aux données (Firestore, ou navigateur en mode démo) |
| `firebase-config.js` | Configuration Firebase à remplir |
| `firestore.rules` | Règles de sécurité à coller dans la console Firebase |
| `manifest.webmanifest`, `icon.svg` | Ajout à l'écran d'accueil du téléphone |

## Limites connues

- Les réglages du groupe sont modifiables par tous les membres (groupe de confiance).
- Si quelqu'un change de téléphone, il lui suffit de rouvrir le lien et de choisir son prénom dans la liste.
