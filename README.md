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
- `projects/{project_key}`
- `bindings/{project_key_chatId}`
- `inbox/{project_key_thread_messageId}`
- `outbox/{project_key_thread_messageId}`

## Variables d'environnement

Copier `.env.example` puis renseigner:

- `TELEGRAM_BOT_TOKEN` (token regenere)
- `TELEGRAM_WEBHOOK_SECRET`
- `HUB_API_TOKEN` (token API interne bridge)
- `HUB_PUBLIC_URL` (URL publique du service)
- `TELEGRAM_OWNER_CHAT_ID` (optionnel: verrouille un chat proprietaire)

## Commandes

```bash
npm install
npm run dev
npm run set-webhook
```

## Flux principal

1. Sur Telegram, l'owner envoie `/bind pilotage-ed`
2. Le bot repond `Connecte`
3. Les projets poussent leurs messages via `/bridge/push`
4. Les messages utilisateur Telegram sont recuperes via `/bridge/pull`
