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
npm run dev
```

Le service tourne en local avec un store JSON:

- `.data/telegram-hub-store.json`

## 3) Activation projet

Sur Telegram:

1. envoyer `/bind pilotage-ed`
2. envoyer un message normal

Le bot doit repondre automatiquement:

- `Message recu et transmis...`

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
