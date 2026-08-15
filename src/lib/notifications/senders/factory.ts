/**
 * Shared sender factory (V0.7).
 *
 * channel.type → DeliverySender, the single mapping used by both the
 * notification UI server actions and the delivery worker. Sender
 * implementations are unchanged — this file only picks an instance.
 */

import type { ChannelType, DeliverySender } from "../types";
import { EmailSender } from "./email";
import { WebhookSender } from "./webhook";

/** Instantiate the sender for a channel type. Email/webhook only (V0.6+). */
export function createSender(type: ChannelType): DeliverySender {
  switch (type) {
    case "email":
      return new EmailSender();
    case "webhook":
      return new WebhookSender();
  }
}
