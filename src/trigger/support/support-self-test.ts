import { logger, task } from "@trigger.dev/sdk";
import { todayInStore } from "./dates.js";
import { decide } from "./decide.js";
import { demoOrders } from "./demo-data.js";
import { evaluateReturn } from "./policy.js";
import type { Reading } from "./read-message.js";
import { checkFacts, templateReply, type FactsPacket } from "./reply.js";
import { checkAddress } from "./rules.js";
import { normalizeOrderNo } from "./store.js";

function reading(overrides: Partial<Reading>): Reading {
  return {
    requestType: "order_status",
    otherRequestTypes: [],
    orderNumber: "",
    otherOrderNumbers: [],
    saysNotReceived: false,
    itemsMentioned: [],
    itemCondition: "unknown",
    newAddress: { street: "", line2: "", city: "", state: "", zip: "" },
    riskSignals: [],
    riskNote: "",
    customerName: "",
    summary: "",
    ...overrides,
  };
}

const NO_ADDRESS = { street: "", line2: "", city: "", state: "", zip: "" };

/**
 * Free offline check (no Claude, Gmail or sheet): the decision rules, the policy, the address
 * check and the fact checker, run against the demo orders. Readings are written by hand here, as
 * Claude would return them for each sample email.
 */
export const supportSelfTest = task({
  id: "support-self-test",
  run: async () => {
    const today = todayInStore();
    const orders = demoOrders(today);
    const results: { name: string; pass: boolean; detail: string }[] = [];
    const expect = (name: string, actual: unknown, wanted: unknown) =>
      results.push({ name, pass: JSON.stringify(actual) === JSON.stringify(wanted), detail: `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}` });

    const run = (r: Partial<Reading>, customerEmail: string, text = "") =>
      decide({ reading: reading(r), emailText: text, customerEmail, firstName: "Test", orderNo: normalizeOrderNo(r.orderNumber ?? ""), orders, today });

    // Order numbers.
    expect("order no #1013", normalizeOrderNo("#1013"), "LH-1013");
    expect("order no lh 1006", normalizeOrderNo("lh 1006"), "LH-1006");

    // The 15 sample scenarios.
    expect("s01 status", run({ orderNumber: "LH-1001" }, "maya.chen@example.com").outcome, "Auto-resolved");
    expect("s03 wrong sender", run({ orderNumber: "LH-1011" }, "orders@quickresale-example.net").outcome, "Escalated");
    const s03 = run({ orderNumber: "LH-1011" }, "orders@quickresale-example.net");
    expect("s03 holding is suspicious", s03.outcome === "Escalated" && s03.holding, "suspicious");
    expect("s04 not found", run({ orderNumber: "LH-1099" }, "mia.torres@example.com").outcome, "Escalated");
    const s05 = run({ requestType: "return_eligibility", orderNumber: "LH-1002", itemsMentioned: ["walnut serving board"], itemCondition: "unused" }, "jordan.ellis@example.com");
    expect("s05 return ok", s05.outcome === "Auto-resolved" && s05.reason, "Return eligible");
    expect("s05 only the board", s05.outcome === "Auto-resolved" && s05.facts.facts.filter((f) => f.includes("can be returned")).length, 1);
    const s06 = run({ requestType: "return_eligibility", orderNumber: "LH-1003", itemCondition: "used" }, "priya.raman@example.com");
    expect("s06 past window", s06.outcome === "Auto-resolved" && s06.reason, "Return not eligible under the policy");
    expect("s07 final sale", run({ requestType: "return_eligibility", orderNumber: "LH-1004", itemCondition: "unused" }, "sam.okafor@example.com").reason, "Return not eligible under the policy");
    expect("s08 damaged", run({ requestType: "return_eligibility", orderNumber: "LH-1005", itemCondition: "damaged" }, "lena.fischer@example.com").outcome, "Escalated");
    const s09 = run({ requestType: "address_change", orderNumber: "LH-1006", newAddress: { street: "2450 Riverside Dr", line2: "Unit 12", city: "Austin", state: "TX", zip: "78741" } }, "carlos.mendes@example.com");
    expect("s09 address applied", s09.outcome === "Auto-resolved" && s09.addressChange?.newAddress, "2450 Riverside Dr, Unit 12, Austin, TX 78741");
    expect("s10 shipped", run({ requestType: "address_change", orderNumber: "LH-1007", newAddress: { street: "15 Maple Ct", line2: "", city: "Nashville", state: "TN", zip: "37212" } }, "hannah.brooks@example.com").outcome, "Escalated");
    expect("s11 incomplete", run({ requestType: "address_change", orderNumber: "LH-1008", newAddress: { ...NO_ADDRESS, street: "55 Elm St" } }, "theo.nguyen@example.com").outcome, "Needs info");
    expect("s12 refund", run({ requestType: "refund", orderNumber: "LH-1009" }, "ava.patel@example.com").outcome, "Escalated");
    expect("s13 cancel", run({ requestType: "cancellation", orderNumber: "LH-1010" }, "noah.kim@example.com").outcome, "Escalated");
    expect("s14 injection (signal)", run({ requestType: "return_eligibility", orderNumber: "LH-1012", riskSignals: ["instructions_to_the_assistant"] }, "ben.carter@example.com").outcome, "Escalated");
    expect("s14 injection (missed by Claude, refund asked)", run({ requestType: "refund", orderNumber: "LH-1012" }, "ben.carter@example.com").outcome, "Escalated");
    expect("several requests", run({ requestType: "order_status", otherRequestTypes: ["refund"], orderNumber: "LH-1001" }, "maya.chen@example.com").outcome, "Escalated");
    expect("backstop word", run({ orderNumber: "LH-1001" }, "maya.chen@example.com", "I will file a chargeback").outcome, "Escalated");
    expect("no order number", run({}, "maya.chen@example.com").outcome, "Needs info");
    expect("delivered but missing", run({ orderNumber: "LH-1011", saysNotReceived: true }, "grace.liu@example.com").outcome, "Escalated");
    expect("sheet error", decide({ reading: reading({ orderNumber: "LH-1001" }), emailText: "", customerEmail: "maya.chen@example.com", firstName: "", orderNo: "LH-1001", orders: new Error("API 500"), today }).outcome, "Escalated");

    // Policy edge: exactly on day 30 is still eligible, day 31 is not.
    const base = orders.find((o) => o.orderNo === "LH-1002")!;
    const at = (daysAgo: number) => ({ ...base, deliveredDate: new Date(Date.parse(`${today}T00:00:00Z`) - daysAgo * 86_400_000).toISOString().slice(0, 10) });
    const verdict = (d: ReturnType<typeof evaluateReturn>) => (d.kind === "answer" ? d.verdicts.map((v) => v.eligible) : d.kind);
    expect("day 30 eligible", verdict(evaluateReturn(at(30), ["board"], "unknown", today)), [true]);
    expect("day 31 not eligible", verdict(evaluateReturn(at(31), ["board"], "unknown", today)), [false]);

    // Address check never fills anything in.
    expect("address bad ZIP", checkAddress({ street: "1 Main St", line2: "", city: "Austin", state: "TX", zip: "787" }).complete, false);
    expect("address bad state", checkAddress({ street: "1 Main St", line2: "", city: "Austin", state: "Texas", zip: "78701" }).complete, false);

    // Fact checker.
    const packet: FactsPacket = { customerFirstName: "Maya", request: "Order status", orderNo: "LH-1001", facts: ["Status: shipped with UPS.", "Tracking number: 1Z84X7W60312458871", "Expected delivery: Saturday, October 31, 2026."], nextStep: "" };
    expect("fact check ok", checkFacts("Hi Maya,\n\nOrder LH-1001 shipped with UPS (tracking 1Z84X7W60312458871) and should arrive Saturday, October 31, 2026.", packet).ok, true);
    expect("fact check invented date", checkFacts("Hi Maya, it should arrive on November 2.", packet).ok, false);
    expect("fact check relative date", checkFacts("Hi Maya, it arrives tomorrow.", packet).ok, false);
    expect("fact check refund promise", checkFacts("Hi Maya, we'll refund the shipping for the delay.", packet).ok, false);
    expect("template passes its own check", checkFacts(templateReply(packet).replace(/\nThanks,[\s\S]*$/, ""), packet).ok, true);

    const failed = results.filter((r) => !r.pass);
    logger.info("Self-test", { passed: results.length - failed.length, total: results.length });
    return { passed: results.length - failed.length, total: results.length, failed };
  },
});
