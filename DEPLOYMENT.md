# Runbook Local (sans Firebase)

## 1) Variables minimales

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET` (valeur libre en local)
- `HUB_API_TOKEN`
- `PORT` (optionnel, defaut `8080`)
- `TELEGRAM_AUTO_ACK=true` (recommande)

## 2) Demarrage local

```bash
npm install
npm run stack:start
```

Le service tourne en local avec un store JSON:

- `.data/telegram-hub-store.json`

## 3) Activation projet

Sur Telegram:

1. envoyer `/bind pilotage-ed`
2. envoyer un message normal

Le bot doit repondre automatiquement:

- `Message recu et transmis...`
- puis `Reflexion en cours...`
- puis la reponse finale Codex

## 4) Verification bridge

Recuperer les messages Telegram:

```bash
npm run bridge -- pull pilotage-ed default
```

Envoyer une reponse vers Telegram:

```bash
npm run bridge -- push pilotage-ed default assistant "Reponse test"
```

Surveillance continue:

```bash
npm run bridge -- watch pilotage-ed default
```

## 5) Relais Codex CLI

Demarrer le relais local qui execute `codex exec` pour chaque message Telegram:

```bash
npm run relay:codex
```

Le relais envoie:

- un message de connexion (`Connecte. Relais Codex CLI local actif.`)
- un statut de progression (`Reflexion en cours...`)
- la reponse finale Codex
- la liste des fichiers modifies en cours et en fin d'execution

## 6) Commandes Telegram

- `/help`
- `/bind <project_key>`
- `/use <project_key>`
- `/thread <thread_id>`
- `/project`
- `/model`
- `/model <nom_modele>`
