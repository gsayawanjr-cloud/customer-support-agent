import { logger, task } from "@trigger.dev/sdk";
import { todayInStore } from "./dates.js";
import { decide, type Decision } from "./decide.js";
import { gmailSettings, labelEmail, PROCESSED_LABEL, saveReplyDraft, sendAlert, SKIPPED_LABEL, supportInboxAddress, type InboxEmail } from "./gmail.js";
import { buildHandoff, handoffEmail, type HandoffKind } from "./handoff.js";
import { readMessage, type Reading } from "./read-message.js";
import { draftReply, holdingReply, needAddressReply } from "./reply.js";
import { REQUEST_LABELS } from "./rules.js";
import {
  addressChangedBy,
  appendAddressChange,
  appendHandoff,
  appendTicket,
  markReopened,
  normalizeOrderNo,
  readOrders,
  readTickets,
  HANDOFFS_TABLE,
  sheetAccess,
  TABS,
  ticketIdFor,
  TICKETS_TABLE,
  updateShipTo,
  type Order,
  type Outcome,
  type Ticket,
  type TicketRow,
} from "./store.js";
import { SheetClient, type TableSpec } from "./table.js";

const REOPEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type HandleTicketPayload = { email: InboxEmail; dryRun?: boolean };

/**
 * One customer email → one ticket. Code decides; Claude only reads the email and words safe replies.
 * Replies are Gmail drafts (never sent). With dryRun, nothing is written anywhere: the result shows
 * what would have happened.
 */
export const handleTicket = task({
  id: "handle-ticket",
  // One ticket at a time: the reopen check and address changes read then write the same sheet.
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 3 },
  run: async ({ email, dryRun = false }: HandleTicketPayload) => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    const gmail = gmailSettings();
    const access = sheetAccess();
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${access.sheetId}`;

    // Who the customer is. Mail from our own Gmail is only a customer when it is a marked test email
    // and self-tests are allowed (never in production: trigger.config.ts strips that setting).
    let customerEmail = email.fromAddress;
    const ownMail = email.fromAddress === gmail.user || email.fromAddress === supportInboxAddress(gmail);
    if (ownMail) {
      if (email.isTest && process.env.SUPPORT_ALLOW_SELF_TEST === "true" && email.replyToAddress) {
        customerEmail = email.replyToAddress;
      } else {
        if (!dryRun) await labelEmail(gmail, email.messageId, SKIPPED_LABEL);
        logger.info("Skipped: sent from our own Gmail", { subject: email.subject });
        return { skipped: "own email" };
      }
    }

    const ticketId = ticketIdFor(email.messageId, email.receivedAt);
    const today = todayInStore(new Date(email.receivedAt));

    // The sheet is both the order source and the log. If it can't be reached, the customer gets an
    // honest holding reply and the handoff goes out by email only.
    let sheet: SheetClient | undefined;
    let tickets: TicketRow[] = [];
    let orders: Order[] | Error;
    try {
      sheet = await SheetClient.connect(access);
      tickets = await readTickets(sheet);
      orders = await readOrders(sheet).catch((e: Error) => e);
    } catch (error) {
      orders = error as Error;
    }

    const already = tickets.find((t) => t.messageId === email.messageId);
    if (already) {
      if (!dryRun) await labelEmail(gmail, email.messageId, PROCESSED_LABEL);
      return { ticketId: already.ticketId, alreadyHandled: true, outcome: already.outcome };
    }

    // Step 3: Claude reads the email.
    const read = await readMessage(email);
    let costUsd = read.costUsd;
    let model = read.model;

    // An earlier ticket in this thread (the customer replied to us) supplies a missing order number.
    const threadTicket = [...tickets].reverse().find((t) => email.thread.includes(t.messageId));
    const writtenOrderNo = read.ok ? normalizeOrderNo(read.reading.orderNumber) : "";
    const orderNo = writtenOrderNo || threadTicket?.orderNo || "";

    let decision: Decision;
    let reading: Reading | undefined;
    if (!read.ok) {
      decision = { outcome: "Escalated", kind: "error", holding: "error", reason: read.problem, sources: [], actions: [`Could not read the email: ${read.problem}`, "No changes made to the order"] };
    } else {
      reading = read.reading;
      decision = decide({
        reading,
        emailText: `${email.subject}\n${email.text}`,
        customerEmail,
        firstName: firstNameOf(reading.customerName || email.fromName),
        orderNo,
        orders,
        today,
      });
      decision.actions.unshift(`Read the email with Claude (${read.model})`);
      if (!writtenOrderNo && threadTicket?.orderNo) decision.sources.push(`Order number from earlier ticket ${threadTicket.ticketId} in this thread`);
    }
    if (orders instanceof Error) logger.error("Sheet problem", { message: orders.message });

    const customerName = reading?.customerName || email.fromName || "";
    const firstName = firstNameOf(customerName);

    // Reopen check: the same customer came back about the same order within 7 days of an auto-resolved ticket.
    const reopens = tickets.filter(
      (t) =>
        t.outcome === "Auto-resolved" &&
        !t.reopened &&
        Date.parse(email.receivedAt) - Date.parse(`${t.receivedAt}:00Z`) <= REOPEN_WINDOW_MS &&
        ((orderNo !== "" && t.orderNo === orderNo && t.customerEmail === customerEmail) || email.thread.includes(t.messageId)),
    );

    // Step 7 action: the address change, applied before the reply so the reply can say it's done.
    if (decision.outcome === "Auto-resolved" && decision.addressChange && sheet && !dryRun) {
      const { order, newAddress } = decision.addressChange;
      if (!(await addressChangedBy(sheet, ticketId))) {
        await appendAddressChange(sheet, ticketId, order.orderNo, order.shipTo, newAddress);
        await updateShipTo(sheet, order, newAddress, `${new Date().toISOString().slice(0, 16).replace("T", " ")} by ${ticketId}`);
      }
    }

    // Step 8: the reply. Only auto-resolved tickets get a Claude-written reply; the rest use fixed text.
    let replyText: string;
    let outcome: Outcome = decision.outcome;
    let reason = decision.reason;
    let handoffKind: HandoffKind | undefined = decision.outcome === "Escalated" ? decision.kind : undefined;
    if (decision.outcome === "Auto-resolved") {
      const draft = await draftReply(decision.facts, email);
      costUsd += draft.costUsd;
      model = draft.model;
      replyText = draft.text;
      decision.actions.push(
        draft.source === "claude" ? "Reply drafted by Claude from the order facts (passed the fact check)" : `Reply built from the fixed template (${draft.problem})`,
      );
      // The reply answers what the facts cover and tells the customer a teammate will do the rest,
      // so a teammate must actually get it: the ticket is not resolved without a person.
      if (draft.openQuestion) {
        outcome = "Escalated";
        reason = `${decision.reason}; partly answered, needs a person: ${draft.openQuestion}`;
        handoffKind = "open_question";
      }
    } else if (decision.outcome === "Needs info") {
      replyText = decision.reply.kind === "need_address" ? needAddressReply(firstName, orderNo, decision.reply.missing) : holdingReply("need_order_no", firstName, "");
    } else {
      // A suspicious sender is not greeted by name and never sees the order number confirmed back.
      const suspicious = decision.holding === "suspicious";
      replyText = holdingReply(decision.holding, suspicious ? "" : firstName, suspicious ? "" : orderNo);
    }

    const subject = /^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject || "Your message"}`;
    const reasonWithReopen = reopens.length > 0 ? `${reason} (follow-up to ${reopens.map((t) => t.ticketId).join(", ")})` : reason;
    const ticket: Ticket = {
      ticketId,
      receivedAt: email.receivedAt,
      customer: customerName,
      customerEmail,
      orderNo,
      request: reading ? REQUEST_LABELS[reading.requestType] : "Unknown",
      outcome,
      reason: reasonWithReopen,
      actions: [...decision.actions, "Saved the reply as a Gmail draft in the customer's thread (not sent)"],
      sources: decision.sources,
      replyDraft: replyText,
      messageId: email.messageId,
      thread: email.thread,
    };

    const handoff =
      handoffKind !== undefined
        ? buildHandoff({
            kind: handoffKind,
            ticketId,
            createdAt: new Date().toISOString(),
            customerEmail,
            orderNo,
            reason: reasonWithReopen,
            summary: reading?.summary || `(Claude could not summarize this email.) First lines: ${email.text.slice(0, 300)}`,
            sources: decision.sources,
            actions: [...ticket.actions, "Sent this handoff to the Handoffs tab and by email"],
          })
        : undefined;

    if (dryRun) {
      logger.info("Dry run: nothing written", { ticketId, outcome: ticket.outcome });
      return { dryRun: true, ticket, handoff, reopens: reopens.map((t) => t.ticketId), addressChange: decision.outcome === "Auto-resolved" ? decision.addressChange?.newAddress : undefined };
    }

    // Step 9: save the draft, the ticket row and the label.
    await saveReplyDraft(gmail, {
      to: customerEmail,
      subject,
      text: replyText,
      messageId: `<${ticketId.toLowerCase()}.reply@support.local>`,
      inReplyTo: email.messageId,
      references: email.thread,
    });

    let logged = false;
    if (sheet) {
      try {
        await appendTicket(sheet, ticket);
        for (const t of reopens) await markReopened(sheet, t, ticketId);
        if (handoff) await appendHandoff(sheet, handoff);
        logged = true;
        await fitTabs(sheet, [[TABS.tickets, TICKETS_TABLE], ...(handoff ? [[TABS.handoffs, HANDOFFS_TABLE] as const] : [])]);
      } catch (error) {
        logger.error("Could not write the ticket to the sheet", { message: (error as Error).message });
      }
    }

    // Step 10: the handoff email. Also sent when the sheet could not be written, so nothing is lost.
    let alerted = false;
    if (handoff || !logged) {
      const h = handoff ?? buildHandoff({
        kind: "error",
        ticketId,
        createdAt: new Date().toISOString(),
        customerEmail,
        orderNo,
        reason: `Could not write the ticket to the sheet (outcome would have been: ${ticket.outcome})`,
        summary: reading?.summary ?? email.text.slice(0, 300),
        sources: ticket.sources,
        actions: ticket.actions,
      });
      alerted = await sendAlert(`${ticketId}: ${h.reason}`.slice(0, 150), handoffEmail(h, { customerName, subject: email.subject, sheetUrl, customerText: email.text }));
    }

    await labelEmail(gmail, email.messageId, PROCESSED_LABEL);
    // Model and cost stay in the run log only (not in the sheet).
    logger.info("Ticket handled", { ticketId, outcome: ticket.outcome, reason: ticket.reason, model, costUsd: costUsd.toFixed(4) });
    return { ticketId, outcome: ticket.outcome, reason: ticket.reason, reopened: reopens.map((t) => t.ticketId), logged, alerted, model, costUsd };
  },
});

/** Resizes rows to their wrapped text after a write. Layout only: a failure is logged, never fails the ticket. */
async function fitTabs(sheet: SheetClient, tabs: (readonly [string, TableSpec])[]): Promise<void> {
  for (const [title, spec] of tabs) {
    try {
      await sheet.fitColumns(await sheet.ensureTab(title), spec);
    } catch (error) {
      logger.warn("Could not resize the sheet", { tab: title, message: (error as Error).message });
    }
  }
}

function firstNameOf(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  // Only a plain name: never greet someone with an email address or initials.
  return /^[A-Za-z][A-Za-z'-]{1,}$/.test(first) ? first : "";
}
