import { idempotencyKeys, logger, task } from "@trigger.dev/sdk";
import { fetchSupportEmails, gmailSettings, supportInboxAddress } from "./gmail.js";
import { handleTicket } from "./handle-ticket.js";

// Caps Claude spend if the inbox suddenly fills up; the rest are picked up on the next check.
const MAX_EMAILS_PER_RUN = 25;

/**
 * Reads new emails sent to the support address and handles them one by one, oldest first, so a
 * follow-up is always handled after the email it follows up on. Triggered by hand for now (no schedule).
 */
export const checkSupportInbox = task({
  id: "check-support-inbox",
  // One check at a time, so two checks never pick up the same email.
  queue: { concurrencyLimit: 1 },
  run: async (payload: { dryRun?: boolean; limit?: number } = {}) => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    if (!process.env.SUPPORT_SHEET_ID) throw new Error("SUPPORT_SHEET_ID is not set");
    const gmail = gmailSettings();
    const dryRun = payload.dryRun === true;

    const emails = await fetchSupportEmails(gmail, Math.min(payload.limit ?? MAX_EMAILS_PER_RUN, MAX_EMAILS_PER_RUN));
    logger.info("Inbox checked", { inbox: supportInboxAddress(gmail), found: emails.length, dryRun });

    const results = [];
    // Sequential on purpose (never Promise.all): each ticket may read what the previous one wrote.
    for (const email of emails) {
      const result = await handleTicket.triggerAndWait(
        { email, dryRun },
        {
          // A dry run must never block the live run of the same email.
          idempotencyKey: await idempotencyKeys.create(`ticket-${dryRun ? "dry-" : ""}${email.messageId}`, { scope: "global" }),
          idempotencyKeyTTL: "1h",
        },
      );
      if (result.ok) results.push({ subject: email.subject, ...result.output });
      else results.push({ subject: email.subject, failed: String(result.error) });
    }
    return { found: emails.length, dryRun, results };
  },
});
