import { logger, task } from "@trigger.dev/sdk";
import { METRICS_TABLE, readTickets, sheetAccess, TABS, type TicketRow } from "./store.js";
import { SheetClient } from "./table.js";

function pct(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(1)}%`;
}

/** The two numbers the user tracks, plus context, computed from the Tickets tab. */
export function computeMetrics(tickets: TicketRow[]) {
  const auto = tickets.filter((t) => t.outcome === "Auto-resolved");
  const correct = auto.filter((t) => t.verdict === "Correct");
  const reopened = auto.filter((t) => t.reopened);
  const unreviewed = auto.filter((t) => t.verdict === "");
  const escalated = tickets.filter((t) => t.outcome === "Escalated");
  const needsInfo = tickets.filter((t) => t.outcome === "Needs info");
  const byRequest = [...new Set(tickets.map((t) => t.request))].map((request) => {
    const all = tickets.filter((t) => t.request === request);
    const ok = all.filter((t) => t.outcome === "Auto-resolved" && t.verdict === "Correct").length;
    return { request, tickets: all.length, resolvedCorrectly: ok };
  });
  return {
    tickets: tickets.length,
    resolvedCorrectlyWithoutPerson: { count: correct.length, rate: pct(correct.length, tickets.length) },
    reopenRate: { count: reopened.length, rate: pct(reopened.length, auto.length) },
    autoResolved: auto.length,
    escalated: escalated.length,
    needsInfo: needsInfo.length,
    autoResolvedNotReviewed: unreviewed.length,
    editedOrWrong: auto.filter((t) => t.verdict === "Edited" || t.verdict === "Wrong").length,
    byRequest,
  };
}

/** Manual task: recomputes the Metrics tab. Free (no Claude). */
export const supportMetrics = task({
  id: "support-metrics",
  run: async () => {
    const sheet = await SheetClient.connect(sheetAccess());
    const m = computeMetrics(await readTickets(sheet));
    const rows: (string | number)[][] = [
      ["Resolved correctly without a person", m.resolvedCorrectlyWithoutPerson.rate, `${m.resolvedCorrectlyWithoutPerson.count} of ${m.tickets} tickets: auto-resolved AND marked Correct in Reviewer Verdict`],
      ["Reopen rate", m.reopenRate.rate, `${m.reopenRate.count} of ${m.autoResolved} auto-resolved tickets: same customer + order came back within 7 days`],
      ["Tickets", m.tickets, `${m.autoResolved} auto-resolved, ${m.needsInfo} needs info, ${m.escalated} escalated`],
      ["Escalation rate", pct(m.escalated, m.tickets), "Sent to a person with a handoff"],
      ["Auto-resolved, not reviewed yet", m.autoResolvedNotReviewed, "Fill in Reviewer Verdict on the Tickets tab, then run support-metrics again"],
      ["Auto-resolved, marked Edited or Wrong", m.editedOrWrong, "Read these drafts: they show where the automation needs work"],
      ...m.byRequest.map((r) => [`By request: ${r.request}`, r.tickets, `${r.resolvedCorrectly} resolved correctly without a person`]),
      ["Updated", new Date().toISOString().slice(0, 16).replace("T", " "), "UTC"],
    ];
    const tab = await sheet.ensureTab(TABS.metrics);
    await sheet.clearValues(TABS.metrics, "A2:Z");
    await sheet.putValues(TABS.metrics, "A2", rows);
    await sheet.fitColumns(tab, METRICS_TABLE);
    logger.info("Metrics updated", { tickets: m.tickets });
    return m;
  },
});
