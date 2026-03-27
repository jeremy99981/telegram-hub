import { setTelegramWebhook } from "./telegram.js";

async function main() {
  await setTelegramWebhook();
  console.log("Webhook configured.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
