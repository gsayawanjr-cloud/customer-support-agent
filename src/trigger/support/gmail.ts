// Adapted from Lead qualifications and follow-up/src/trigger/lead-qualify/gmail.ts.
import { logger } from "@trigger.dev/sdk";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";

export type GmailSettings = { user: string; appPassword: string };

export function gmailSettings(): GmailSettings {
  const user = process.env.SUPPORT_GMAIL_USER;
  if (!user) throw new Error("SUPPORT_GMAIL_USER is not set");
  const appPassword = process.env.SUPPORT_GMAIL_APP_PASSWORD;
  if (!appPassword) throw new Error("SUPPORT_GMAIL_APP_PASSWORD is not set");
  return { user: user.trim().toLowerCase(), appPassword: appPassword.replace(/\s/g, "") };
}

/** Gmail label put on an email once it's handled, so the next check skips it. */
export const PROCESSED_LABEL = "support-processed";
export const SKIPPED_LABEL = "support-skipped";

/** Header that marks a mock customer email sent by send-test-emails from our own Gmail. */
export const TEST_HEADER = "x-support-test";

/** The address customers email. Default: the Gmail's +support alias. */
export function supportInboxAddress(settings: GmailSettings): string {
  const configured = process.env.SUPPORT_INBOX_ADDRESS?.trim();
  if (configured) return configured.toLowerCase();
  const [local, domain] = settings.user.split("@");
  return `${local}+support@${domain}`;
}

export type InboxEmail = {
  messageId: string;
  receivedAt: string;
  fromName: string;
  fromAddress: string;
  replyToAddress: string;
  subject: string;
  text: string;
  /** In-Reply-To + References: the earlier emails in this thread. */
  thread: string[];
  /** Sent by send-test-emails (our own Gmail, with the test header). */
  isTest: boolean;
};

async function connect(settings: GmailSettings): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: settings.user, pass: settings.appPassword },
    logger: false,
  });
  try {
    await client.connect();
  } catch (error) {
    // imapflow's message is just "Command failed"; Gmail's reason is in responseText.
    const e = error as Error & { responseText?: string; serverResponseCode?: string };
    const reason =
      e.serverResponseCode === "AUTHENTICATIONFAILED"
        ? "Gmail rejected the login: check SUPPORT_GMAIL_USER and SUPPORT_GMAIL_APP_PASSWORD"
        : (e.responseText ?? e.message);
    throw new Error(reason);
  }
  return client;
}

function bareId(messageId: string): string {
  return messageId.trim().replace(/^<|>$/g, "");
}

/**
 * Support emails not handled yet: in the inbox, sent to the support address, without either label.
 * Only the support address is read, so alerts and drafts are never mistaken for customer mail.
 */
export async function fetchSupportEmails(settings: GmailSettings, limit: number): Promise<InboxEmail[]> {
  const query = `in:inbox to:${supportInboxAddress(settings)} -label:${PROCESSED_LABEL} -label:${SKIPPED_LABEL} newer_than:14d`;
  const client = await connect(settings);
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Oldest first, so a backlog (and a follow-up after its first email) is worked through in arrival order.
      const uids = ((await client.search({ gmraw: query }, { uid: true })) || []).sort((a, b) => a - b).slice(0, limit);
      if (uids.length === 0) return [];
      const emails: InboxEmail[] = [];
      for (const message of await client.fetchAll(uids, { source: true, internalDate: true }, { uid: true })) {
        if (!message.source) continue;
        const mail = await simpleParser(message.source);
        if (!mail.messageId) continue;
        const from = mail.from?.value[0];
        const received = message.internalDate ? new Date(message.internalDate) : (mail.date ?? new Date());
        const references = Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [];
        const thread = [...new Set([...(mail.inReplyTo ? [mail.inReplyTo] : []), ...references].map(bareId).filter(Boolean))];
        emails.push({
          messageId: bareId(mail.messageId),
          receivedAt: received.toISOString(),
          fromName: from?.name ?? "",
          fromAddress: (from?.address ?? "").toLowerCase(),
          replyToAddress: (mail.replyTo?.value[0]?.address ?? "").toLowerCase(),
          subject: mail.subject ?? "",
          text: (mail.text ?? "").trim(),
          thread,
          isTest: mail.headers.has(TEST_HEADER),
        });
      }
      return emails.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

/** Puts a Gmail label on an inbox email (found by its Message-ID). */
export async function labelEmail(settings: GmailSettings, messageId: string, label: string): Promise<void> {
  const client = await connect(settings);
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = (await client.search({ gmraw: `rfc822msgid:${bareId(messageId)}` }, { uid: true })) || [];
      if (uids.length === 0) throw new Error(`Email ${messageId} not found in the inbox`);
      await client.messageFlagsAdd(uids, [label], { uid: true, useLabels: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

/**
 * Saves a reply as a Gmail draft in the customer's thread (never sends it). The draft has a fixed
 * Message-ID per ticket, so handling the same email again replaces the unsent draft instead of adding
 * a second one. Reply-To is the support address, so the customer's answer comes back to this inbox.
 */
export async function saveReplyDraft(
  settings: GmailSettings,
  draft: { to: string; subject: string; text: string; messageId: string; inReplyTo: string; references: string[] },
): Promise<{ replaced: boolean }> {
  const client = await connect(settings);
  try {
    const mailboxes = await client.list();
    const draftsPath = mailboxes.find((m) => m.specialUse === "\\Drafts")?.path ?? "[Gmail]/Drafts";

    let replaced = false;
    const lock = await client.getMailboxLock(draftsPath);
    try {
      // rfc822msgid finds drafts; a `header: {message-id}` search does not (lead project lesson).
      const existing = (await client.search({ gmraw: `rfc822msgid:${bareId(draft.messageId)}` }, { uid: true })) || [];
      if (existing.length > 0) {
        await client.messageDelete(existing, { uid: true });
        replaced = true;
      }
    } finally {
      lock.release();
    }

    const raw = await new MailComposer({
      from: { name: process.env.STORE_NAME?.trim() || "Larkspur Home Goods", address: settings.user },
      replyTo: supportInboxAddress(settings),
      to: draft.to,
      subject: draft.subject,
      text: draft.text,
      messageId: draft.messageId,
      // Threads the draft under the customer's email (Gmail also needs the "Re:" subject to match).
      inReplyTo: `<${bareId(draft.inReplyTo)}>`,
      references: [...draft.references, draft.inReplyTo].map((id) => `<${bareId(id)}>`).join(" "),
    })
      .compile()
      .build();
    await client.append(draftsPath, raw, ["\\Draft", "\\Seen"]);
    return { replaced };
  } finally {
    await client.logout();
  }
}

/** Emails ALERT_EMAIL_TO. Never throws: an alert problem must not fail the ticket. */
export async function sendAlert(subject: string, body: string): Promise<boolean> {
  const to = process.env.ALERT_EMAIL_TO;
  if (!to) {
    logger.warn("Alert not sent: ALERT_EMAIL_TO is not set", { subject });
    return false;
  }
  try {
    await sendInternalEmail(gmailSettings(), to, `[Support handoff] ${subject}`, body);
    return true;
  } catch (error) {
    logger.error("Could not send alert", { subject, message: (error as Error).message });
    return false;
  }
}

/** Sends an internal email (handoff alerts, test messages). Never used for customers. */
export async function sendInternalEmail(
  settings: GmailSettings,
  to: string,
  subject: string,
  text: string,
  options: { fromName?: string; replyTo?: string; messageId?: string; inReplyTo?: string; headers?: Record<string, string> } = {},
): Promise<void> {
  await nodemailer.createTransport({ service: "gmail", auth: { user: settings.user, pass: settings.appPassword } }).sendMail({
    from: options.fromName ? { name: options.fromName, address: settings.user } : settings.user,
    replyTo: options.replyTo,
    to,
    subject,
    text,
    messageId: options.messageId,
    ...(options.inReplyTo ? { inReplyTo: options.inReplyTo, references: options.inReplyTo } : {}),
    headers: options.headers,
  });
}
