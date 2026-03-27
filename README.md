# Telegram Hub (independant multi-projets)

Service Telegram dedie pour relier plusieurs projets sans interference.

## Endpoints

- `POST /telegram/webhook/:secret`
- `POST /projects/bind`
- `POST /bridge/push`
- `POST /bridge/pull`
- `GET /health`

## Isolation

- Namespace par `project_key`
- `projects`, `bindings`, `inbox`, `outbox` dans le store JSON local

## Variables d'environnement

Copier `.env.example` puis renseigner:

- `TELEGRAM_BOT_TOKEN` (token regenere)
- `TELEGRAM_WEBHOOK_SECRET`
- `HUB_API_TOKEN` (token API interne bridge)
- `HUB_PUBLIC_URL` (optionnel si webhook public)
- `TELEGRAM_OWNER_CHAT_ID` (optionnel: verrouille un chat proprietaire)

## Commandes

```bash
npm install
npm run dev
npm run dev:local
npm run set-webhook
npm run send:connected
npm run bridge -- pull pilotage-ed default
npm run relay:codex
npm run stack:start
npm run stack:stop
```

## Mode local (sans Firebase)

Le hub est desormais 100% local (aucune dependance Firebase):

- fichier store par defaut: `.data/telegram-hub-store.json`
- polling Telegram automatique via `getUpdates`
- meme API bridge: `/projects/bind`, `/bridge/push`, `/bridge/pull`
- auto-ack Telegram configurable (`TELEGRAM_AUTO_ACK=true` par defaut)

Variables minimales:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET` (valeur libre en local)
- `HUB_API_TOKEN`
- `PORT` (optionnel)

Test rapide:

1. Ouvrir le bot Telegram et envoyer `/bind pilotage-ed`
2. Lancer `npm run send:connected` pour envoyer un ping `Connecte` sur le chat owner
3. Depuis Telegram, envoyer un message normal
4. Verifier la remontee via `npm run bridge -- pull pilotage-ed default`
5. Repondre via `npm run bridge -- push pilotage-ed default assistant "Reponse de test"`

## Relais Codex CLI (Telegram -> Codex -> Telegram)

Le script `relay:codex` permet un agent local autonome:

- il lit les messages Telegram via `/bridge/pull`
- il envoie un statut `Reflexion en cours...` (sans afficher le projet)
- il execute `codex exec` dans le workspace du projet
- il renvoie la reponse sur Telegram
- il publie les fichiers modifies pendant et apres execution (`git status --short`)

Variables utiles:

- `CODEX_DEFAULT_WORKSPACE`
- `CODEX_PROJECT_WORKSPACES` (format `projet=chemin;projet2=chemin2`)
- `TELEGRAM_PROJECT_KEY`
- `TELEGRAM_THREAD_ID`

Lancer le relais:

```bash
npm run relay:codex
```

Lancer/arreter la stack complete (hub + relais) en local:

```bash
npm run stack:start
npm run stack:stop
```

Commandes Telegram disponibles:

- `/help`
- `/bind <project_key>`
- `/use <project_key>`
- `/thread <thread_id>`
- `/project` (affiche projet/thread/modele actifs)
- `/model` (affiche le modele actif)
- `/model <nom_modele>` (change le modele)

## Flux principal

1. Sur Telegram, l'owner envoie `/bind pilotage-ed`
2. Le bot repond `Connecte`
3. Les projets poussent leurs messages via `/bridge/push`
4. Les messages utilisateur Telegram sont recuperes via `/bridge/pull`
