/**
 * Shared sender factory (V0.7 → Phase 9H).
 *
 * channel.type → DeliverySender, the single mapping used by both the
 * notification UI server actions and the delivery worker. Sender
 * implementations are unchanged — this file only picks an instance and
 * wires the production dependencies.
 *
 * Phase 9H: the Telegram sender receives the real `resolveSecret`
 * (notification_secrets via the 9F repository). `getChannelSecret`
 * decrypts with AES-256-GCM and THROWS on decryption failure — the sender
 * surfaces that as a controlled error instead of masking it or falling
 * back to env.
 */

import type { ChannelType, DeliverySender } from "../types";
import { EmailSender } from "./email";
import { WebhookSender } from "./webhook";
import { TelegramSender } from "./telegram";
// Phase 14C-1: the factory resolves runtime data through the async
// Repository contract (Node SQLite / Cloudflare D1) instead of the sync
// feature repositories. The worker + actions pass the repository through
// createSender below; business code never touches a SQL driver.
import type { Repository } from "@/db/repository";
import { getRepository } from "@/lib/runtime/repository";

/** Instantiate the sender for a channel type. Email/webhook (V0.6+) / telegram (V0.7.x+9H). */
export function createSender(
  type: ChannelType,
  repo?: Repository,
  env?: Record<string, string | undefined>,
): DeliverySender {
  switch (type) {
    case "email":
      return new EmailSender();
    case "webhook":
      return new WebhookSender();
    case "telegram":
      return new TelegramSender({
        // Operator-level endpoint override (prototype/E2E) is honored by
        // the sender via this env map. Not user-configurable (SSRF guard).
        env,
        resolveDomain: async (domainId) =>
          (await (repo ?? (await getRepository())).getDomainById(domainId))?.hostname,
        // Phase 9H priority A: encrypted notification_secrets token; the
        // sender falls back to legacy env (config.secretRef) when null.
        resolveSecret: async (channelId, key) =>
          (repo ?? (await getRepository())).getChannelSecret(channelId, key),
      });
  }
}
