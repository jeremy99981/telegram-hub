# Check-list d'exploitation

## 1) Securite avant mise en ligne

1. Regenerer le token bot via BotFather (l'ancien token expose ne doit plus etre utilise).
2. Creer des secrets runtime:
   - `TELEGRAM_BOT_TOKEN`
   - `HUB_API_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET`
3. (Optionnel) Fixer `TELEGRAM_OWNER_CHAT_ID` pour verrouiller ton chat prive.

## 2) Deploy hub (projet Firebase/Cloud Run dedie)

1. Construire et deployer l'image:
   - `docker build -t gcr.io/<PROJECT_ID>/telegram-hub:latest .`
   - `docker push gcr.io/<PROJECT_ID>/telegram-hub:latest`
2. Deploy Cloud Run:
   - `gcloud run deploy telegram-hub --image gcr.io/<PROJECT_ID>/telegram-hub:latest --region <REGION> --allow-unauthenticated`
3. Definir les variables et secrets d'environnement du service.

## 3) Configurer le webhook Telegram

1. Exporter `HUB_PUBLIC_URL`.
2. Lancer `npm run set-webhook`.
3. Verifier que Telegram pointe vers:
   - `https://<HUB_PUBLIC_URL>/telegram/webhook/<TELEGRAM_WEBHOOK_SECRET>`

## 4) Activer Pilotage ED

1. Dans Pilotage ED:
   - `TELEGRAM_BRIDGE_ENABLED=true`
   - `TELEGRAM_HUB_URL=https://<HUB_PUBLIC_URL>`
   - `TELEGRAM_PROJECT_KEY=pilotage-ed`
   - `TELEGRAM_HUB_API_TOKEN=<same HUB_API_TOKEN>`
2. Binder le projet:
   - Telegram: `/bind pilotage-ed`
   - ou CLI: `npm run telegram:bridge -- bind pilotage-ed`
3. Verifier reception du message `Connecte`.

## 5) Tests de flux

1. Telegram -> Hub -> Pull:
   - envoyer un message Telegram
   - appeler `/bridge/pull` et verifier le message
2. Push -> Telegram:
   - appeler `/bridge/push` avec `project_key=pilotage-ed`
   - verifier reception sur Telegram
3. Isolation multi-projets:
   - binder un second `project_key`
   - verifier qu'un `pull` sur `pilotage-ed` ne remonte pas les messages de l'autre projet.
