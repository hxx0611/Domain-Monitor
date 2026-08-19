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
import { getChannelSecret } from "../secrets";
// Phase 11D: import from the repository module directly, NOT the
// `@/lib/domains` barrel. The barrel re-exports `./actions`, which pulls
// in `next/cache`; under `--conditions=react-server` (worker CLI) and
// NODE_ENV=production that resolves next's react-server *source* files,
// which tsx's CJS transform breaks on (`React.createContext is not a
// function`). The worker only needs the repository lookup, so bypass the
// barrel entirely.
import { getDomainById } from "@/lib/domains/repository";

/** Instantiate the sender for a channel type. Email/webhook (V0.6+) / telegram (V0.7.x+9H). */
export function createSender(type: ChannelType): DeliverySender {
  switch (type) {
    case "email":
      return new EmailSender();
    case "webhook":
      return new WebhookSender();
    case "telegram":
      return new TelegramSender({
        resolveDomain: (domainId) => getDomainById(domainId)?.hostname,
        // Phase 9H priority A: encrypted notification_secrets token; the
        // sender falls back to legacy env (config.secretRef) when null.
        resolveSecret: (channelId, key) => Promise.resolve(getChannelSecret(channelId, key)),
      });
  }
}
