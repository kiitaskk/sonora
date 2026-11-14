# SONORA pour iPhone (version web installable)

Ta musique, sans pub, sans abonnement, sans Mac, sans compte Apple Developer.
SONORA s'installe depuis Safari sur l'écran d'accueil et fonctionne **hors ligne**, comme une vraie app.

---

## 1. Mettre SONORA en ligne (gratuit, une seule fois)

L'app doit être servie en **HTTPS** pour être installable. Le plus simple : **GitHub Pages**.

1. Crée un dépôt sur github.com (ex. `sonora`), public.
2. Envoie **le contenu** de ce dossier (pas le dossier lui-même) à la racine du dépôt :
   `index.html`, `styles.css`, `manifest.webmanifest`, `sw.js`, `js/`, `icons/`.
   - Sur le site GitHub : *Add file → Upload files*, glisse tous les fichiers et dossiers, puis *Commit*.
3. *Settings → Pages* → *Source : Deploy from a branch* → branche `main`, dossier `/ (root)` → *Save*.
4. Après 1 à 2 minutes, ton app est en ligne sur `https://TON-PSEUDO.github.io/sonora/`.

Autres hébergeurs gratuits qui marchent aussi : Netlify (glisser-déposer le dossier sur app.netlify.com/drop), Cloudflare Pages, Vercel.

> Tes musiques ne sont **jamais** envoyées sur l'hébergeur : il ne sert que l'application. Les fichiers audio restent stockés dans ton iPhone.

## 2. Installer sur l'iPhone

1. Ouvre l'adresse de ton app dans **Safari** (pas Chrome : sur iPhone, l'installation passe par Safari).
2. Touche le bouton **Partager** (carré avec une flèche).
3. Choisis **« Sur l'écran d'accueil »**, puis **Ajouter**.
4. Lance SONORA depuis l'icône : elle s'ouvre en plein écran, sans barre Safari.

Ensuite, plus besoin d'Internet : l'app et tes musiques sont sur le téléphone.

## 3. Importer ta musique

1. Mets tes fichiers dans l'app **Fichiers** de l'iPhone (iCloud Drive, « Sur mon iPhone », AirDrop depuis ton PC, clé USB…).
2. Dans SONORA : **Bibliothèque → +** (ou « Importer des musiques »).
3. Sélectionne plusieurs fichiers d'un coup → ils sont copiés dans SONORA.

Formats : MP3, M4A/AAC, WAV et FLAC fonctionnent sur iPhone. OGG et OPUS dépendent de la version d’iOS (seules les versions récentes de Safari les lisent) : si un fichier OGG ne se lance pas, convertis-le en MP3 ou M4A.
Titre, artiste, album, genre, **pochette** et durée sont lus automatiquement dans les MP3, M4A et FLAC ; sinon ils sont déduits du nom du fichier (« Artiste - Titre.mp3 »).

## 4. Importer une playlist Deezer ou Spotify

**Playlists → Importer une playlist.** SONORA récupère la **liste des titres** et les retrouve dans ta bibliothèque (même avec « feat. », « Radio Edit », « Remastered »…). Aucune musique n'est téléchargée : les titres absents restent **en attente** et s'ajoutent automatiquement à la playlist dès que tu importes leurs fichiers.

- **Deezer** : colle le lien de la playlist (`https://www.deezer.com/fr/playlist/123456`). La playlist doit être **publique**. Les liens courts (`link.deezer.com/…`) : ouvre-les dans Safari et copie l'adresse complète. Les liens d'albums marchent aussi.
- **Spotify** : depuis février 2026, Spotify interdit aux applis indépendantes de lire une playlist par son lien. Passe par **exportify.app** → Export → fichier .csv → dans SONORA, « Fichier CSV ».
- **Autres** (Apple Music, YouTube Music, Tidal…) : exporte en CSV avec un service comme TuneMyMusic, ou colle une liste « Artiste - Titre ».

---

## Fonctionnalités

- **Lecteur** : lecture/pause, précédent/suivant, barre de progression, aléatoire, répéter (file ou morceau), grande pochette animée, fond flouté.
- **Écran verrouillé, Centre de contrôle, AirPods, Bluetooth** : titre, pochette, pause, suivant, précédent, avance.
- **File d'attente** : lire ensuite, ajouter à la file, réordonner, retirer, vider.
- **Playlists** illimitées : image personnalisée, renommer, réordonner, retirer, lecture complète ou aléatoire. Playlist « Titres likés » automatique.
- **Bibliothèque** : vues Morceaux / Artistes / Albums, tri (date, titre, artiste, album, durée, croissant/décroissant), sélection multiple (supprimer, ajouter à une playlist, lire ensuite).
- **Recherche instantanée**, sans tenir compte des accents, par titre / artiste / album / genre, et parcours par genre.
- **Accueil** : reprendre la dernière écoute, écoutés récemment, favoris, recommandations locales, plus écoutés.
- **Minuteur de sommeil**, **historique** par jour, **statistiques** (temps d'écoute, top titres/artistes/genres, 7 derniers jours).
- **Modifier** titre, artiste, album, genre et pochette ; appliquer une pochette à tout un album.
- **Réglages** : thème sombre / clair / auto, 5 couleurs d'accent, espace utilisé, sauvegarde et restauration des playlists, tout supprimer.

## Limites propres à l'iPhone (honnêtement)

- **Volume** : Safari ne laisse pas une page web régler le volume ; on utilise les boutons de l'iPhone (l'app l'indique).
- **Arrière-plan** : la lecture continue écran verrouillé et l'enchaînement fonctionne, mais iOS peut parfois mettre en pause une app web restée longtemps en arrière-plan. Il suffit alors d'appuyer sur lecture.
- **Égaliseur** : pas inclus (même raison que la version native).
- **Stockage** : l'espace est celui de ton iPhone. L'app demande à iOS de garder les données ; si tu supprimes l'icône de l'écran d'accueil, iOS efface aussi les musiques importées. Pense à **exporter tes playlists** (Réglages) de temps en temps.

## Mettre à jour l'app plus tard

Après avoir modifié des fichiers, change la ligne `VERSION` en haut de `sw.js` (ex. `sonora-v1.0.1`), puis renvoie les fichiers. L'iPhone récupère la nouvelle version au lancement suivant (ferme et rouvre l'app deux fois).

## Fichiers

```
index.html             Page de l'app (balises iPhone : plein écran, icône)
manifest.webmanifest   Nom, icônes, mode « app »
sw.js                  Service worker : fonctionnement hors ligne
styles.css             Identité visuelle SONORA (sombre/clair, accents)
js/app.js              Pages, navigation, interactions
js/player.js           Lecteur, file d'attente, écran verrouillé (Media Session)
js/store.js            Bibliothèque, playlists, favoris, stats
js/importer.js         Import de playlists (Deezer, CSV Spotify, liste)
js/db.js               Stockage local (IndexedDB)
js/tags.js             Lecture des tags MP3 / M4A / FLAC
js/ui.js               Pochettes, dialogues, formatage
js/icons.js            Icônes
icons/                 Icônes de l'app
```

## Testé

37 tests automatisés dans un navigateur au format iPhone, avec de vrais fichiers MP3, M4A, FLAC, WAV et OGG. Ils couvrent :
- l'import et le refus des fichiers non audio ;
- les tags, les pochettes et les durées, ainsi que les doublons ;
- la lecture, l'enchaînement automatique, l'écran verrouillé, l'aléatoire, la répétition et l'avance ;
- la file d'attente, le minuteur, les playlists et leur réorganisation ;
- la recherche sans accents, les favoris et l'édition ;
- le thème, la conservation des données après fermeture, la reprise et le **fonctionnement hors ligne** ;
- la suppression.

Aucune erreur JavaScript.
