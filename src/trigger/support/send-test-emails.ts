import { logger, task } from "@trigger.dev/sdk";
import samples from "../../../samples/emails.json";
import { gmailSettings, sendInternalEmail, supportInboxAddress, TEST_HEADER } from "./gmail.js";

export type Sample = (typeof samples)[number] & { replyTo?: string };

/** Message-ID of a sample sent in batch `batch`, so follow-ups can thread under their parent. */
export function sampleMessageId(id: string, batch: string): string {
  return `<${id}.${batch}@larkspur-test.local>`;
}

/**
 * Dev helper: emails the mock customer messages in samples/emails.json to the support address from
 * our own Gmail. Each carries the test header and the customer's address as Reply-To; handle-ticket
 * treats that as the sender only while SUPPORT_ALLOW_SELF_TEST=true (dev only). Then run
 * check-support-inbox, then check-test-results. `only` picks samples by id.
 */
export const sendTestEmails = task({
  id: "send-test-emails",
  run: async (payload: { only?: string[] } = {}) => {
    const gmail = gmailSettings();
    const to = supportInboxAddress(gmail);
    const batch = Date.now().toString(36);
    const picked = (samples as Sample[]).filter((s) => !payload.only || payload.only.some((id) => s.id.includes(id)));
    const sent = [];
    for (const sample of picked) {
      await sendInternalEmail(gmail, to, sample.subject, sample.body, {
        fromName: sample.fromName,
        replyTo: sample.customerEmail,
        messageId: sampleMessageId(sample.id, batch),
        inReplyTo: sample.replyTo ? sampleMessageId(sample.replyTo, batch) : undefined,
        headers: { [TEST_HEADER]: sample.id },
      });
      sent.push({ id: sample.id, expect: sample.expect });
      // Spaced out so Gmail's arrival order (and so processing order) matches the file.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    logger.info("Test emails sent", { count: sent.length, batch });
    return { to, batch, sent };
  },
});
