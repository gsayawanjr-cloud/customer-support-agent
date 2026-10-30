import { logger, task } from "@trigger.dev/sdk";
import samples from "../../../samples/emails.json";
import type { Sample } from "./send-test-emails.js";
import { readOrders, readTickets, sheetAccess } from "./store.js";
import { SheetClient } from "./table.js";

/**
 * Free (no Claude): compares the latest ticket for each sample email with its expected result in
 * samples/emails.json. Outcome, reopen and address are pass/fail; a different request label is a
 * warning only (e.g. an injection email read as "Refund" instead of "Return" still escalates).
 */
export const checkTestResults = task({
  id: "check-test-results",
  run: async (payload: { batch?: string } = {}) => {
    const sheet = await SheetClient.connect(sheetAccess());
    const tickets = await readTickets(sheet);
    const orders = await readOrders(sheet);

    const rows = (samples as Sample[]).map((s) => {
      const ticket = tickets
        .filter((t) => t.messageId.startsWith(`${s.id}.`) && (!payload.batch || t.messageId.includes(`.${payload.batch}@`)))
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
      if (!ticket) return { id: s.id, pass: false, problems: ["no ticket found"] };
      const problems: string[] = [];
      const warnings: string[] = [];
      if (ticket.outcome !== s.expect.outcome) problems.push(`outcome ${ticket.outcome}, expected ${s.expect.outcome}`);
      if (ticket.request !== s.expect.request) warnings.push(`request ${ticket.request}, expected ${s.expect.request}`);
      const expect = s.expect as { reopened?: boolean; shipTo?: string };
      if (expect.reopened !== undefined && ticket.reopened !== expect.reopened) problems.push(`reopened ${ticket.reopened}, expected ${expect.reopened}`);
      if (expect.shipTo) {
        const order = orders.find((o) => o.orderNo === ticket.orderNo);
        if (order?.shipTo !== expect.shipTo) problems.push(`Ship To is "${order?.shipTo}", expected "${expect.shipTo}"`);
      }
      return { id: s.id, ticketId: ticket.ticketId, pass: problems.length === 0, problems, warnings, reason: ticket.reason, replyDraft: ticket.replyDraft };
    });

    const passed = rows.filter((r) => r.pass).length;
    logger.info("Test results", { passed, total: rows.length });
    return { passed, total: rows.length, rows };
  },
});
