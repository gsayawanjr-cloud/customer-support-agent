import { longDate } from "./dates.js";
import type { HandoffKind } from "./handoff.js";
import { evaluateReturn, LABEL_FEE } from "./policy.js";
import type { Reading } from "./read-message.js";
import type { FactsPacket, HoldingKind } from "./reply.js";
import { checkAddress, gateRequest, REQUEST_LABELS, verifyIdentity } from "./rules.js";
import type { Order } from "./store.js";

export type Decision =
  | { outcome: "Auto-resolved"; reason: string; facts: FactsPacket; sources: string[]; actions: string[]; addressChange?: { order: Order; newAddress: string } }
  | { outcome: "Needs info"; reason: string; reply: { kind: "need_order_no" } | { kind: "need_address"; missing: string[] }; sources: string[]; actions: string[] }
  | { outcome: "Escalated"; reason: string; kind: HandoffKind; holding: HoldingKind; sources: string[]; actions: string[] };

export type DecideInput = {
  reading: Reading;
  emailText: string;
  customerEmail: string;
  firstName: string;
  /** Normalized order number ("" if none was given). */
  orderNo: string;
  /** The Orders tab, or the error reading it. */
  orders: Order[] | Error;
  today: string;
};

/**
 * Steps 4–7: every decision the automation makes, in code. Claude's reading is only an input; the
 * order row and the policy decide. Pure (no network), so the self-test can run it for free.
 */
export function decide(input: DecideInput): Decision {
  const { reading, orderNo, today } = input;
  const sources: string[] = [];
  const actions: string[] = [];
  const escalate = (kind: HandoffKind, reason: string, holding: HoldingKind = "handoff"): Decision => ({
    outcome: "Escalated",
    kind,
    reason,
    holding,
    sources,
    actions: [...actions, "No changes made to the order"],
  });

  if (input.orders instanceof Error) {
    actions.push(`Order lookup failed: ${input.orders.message}`);
    return escalate("error", "Could not read the Orders tab", "error");
  }
  const order = orderNo ? input.orders.find((o) => o.orderNo === orderNo) : undefined;
  if (order) sources.push(orderSource(order));

  // Refunds, cancellations and sensitive messages go to a person even when the order is fine. The
  // order row is still listed in the sources, so the teammate has it at hand.
  const gate = gateRequest(reading, input.emailText);
  if (gate.escalate) {
    if (order && !verifyIdentity(order, input.customerEmail).verified) {
      actions.push(`Identity NOT verified: sender ${input.customerEmail} is not the order's email`);
      return escalate("suspicious", `${gate.reason}; sender does not match the order`, "suspicious");
    }
    return escalate(gate.kind, gate.reason);
  }

  if (!orderNo) {
    return { outcome: "Needs info", reason: "No order number in the message", reply: { kind: "need_order_no" }, sources, actions: ["Asked the customer for the order number", "No changes made"] };
  }
  if (!order) {
    actions.push(`Looked up ${orderNo}: not in the Orders tab`);
    return escalate("not_found", `Order ${orderNo} not found`, "not_found");
  }
  actions.push(`Looked up order ${order.orderNo}`);

  const identity = verifyIdentity(order, input.customerEmail);
  if (!identity.verified) {
    actions.push("Identity NOT verified; no order details shared");
    return escalate("suspicious", identity.reason, "suspicious");
  }
  actions.push("Identity verified: sender matches the email on the order");

  const request = REQUEST_LABELS[reading.requestType];
  const packet = (facts: string[], nextStep = ""): FactsPacket => ({ customerFirstName: input.firstName, request, orderNo: order.orderNo, facts, nextStep });

  switch (reading.requestType) {
    case "order_status": {
      const late = order.status === "Shipped" && order.eta !== "" && order.eta < today;
      if (reading.saysNotReceived && (order.status === "Delivered" || late)) {
        return escalate("late_or_missing", order.status === "Delivered" ? "Marked delivered but the customer says it has not arrived" : "Past the ETA and the customer says it has not arrived");
      }
      actions.push("Answered from the order row");
      return { outcome: "Auto-resolved", reason: "Order status answered from the order record", facts: packet(statusFacts(order)), sources, actions };
    }

    case "return_eligibility": {
      const decision = evaluateReturn(order, reading.itemsMentioned, reading.itemCondition, today);
      sources.push(`Return policy ${decision.policy.join(", ") || "(none)"}`);
      if (decision.kind === "escalate") {
        const kind: HandoffKind = decision.reason.includes("damaged") || decision.reason.includes("defective") ? "damaged" : order.status === "Processing" ? "return_not_shipped" : order.status === "Delivered" ? "data_problem" : "other";
        return escalate(kind, decision.reason);
      }
      actions.push("Checked return eligibility with the policy rules (no refund issued)");
      const verdictLines = decision.verdicts.map((v) => `${v.item}: ${v.eligible ? "can be returned" : "can't be returned"}. ${v.reason}`);
      const anyEligible = decision.verdicts.some((v) => v.eligible);
      const reason = decision.verdicts.length === 0 ? "Not delivered yet; return window explained" : anyEligible ? "Return eligible" : "Return not eligible under the policy";
      return {
        outcome: "Auto-resolved",
        reason,
        facts: packet(
          [...verdictLines, ...decision.facts],
          anyEligible ? `Ship the item(s) to the returns address with the order number on the packing slip, or reply to ask for a prepaid label (${LABEL_FEE}, deducted from the refund).` : "",
        ),
        sources,
        actions,
      };
    }

    case "address_change": {
      sources.push("Return policy RP-7 (address changes)");
      if (order.status === "Shipped" || order.status === "Delivered") return escalate("shipped_address", `Address change asked but the order is already ${order.status.toLowerCase()}`);
      if (order.status === "Cancelled") return escalate("other", "Address change asked for a cancelled order");
      const address = checkAddress(reading.newAddress);
      if (!address.complete) {
        return { outcome: "Needs info", reason: `New address incomplete (missing ${address.missing.join(", ")})`, reply: { kind: "need_address", missing: address.missing }, sources, actions: [...actions, "Asked the customer for the full address", "No changes made to the order"] };
      }
      if (address.address.toLowerCase() === order.shipTo.toLowerCase()) {
        actions.push("Address already matches; nothing changed");
        return { outcome: "Auto-resolved", reason: "Address already up to date", facts: packet([`The shipping address on the order is already ${order.shipTo}. Nothing needed changing.`]), sources, actions };
      }
      actions.push(`Changed Ship To from "${order.shipTo}" to "${address.address}" (logged in Address changes)`);
      return {
        outcome: "Auto-resolved",
        reason: "Shipping address changed (order not shipped yet)",
        facts: packet([`The shipping address was changed from ${order.shipTo} to ${address.address}.`, "The order is still being prepared and will ship to the new address."]),
        sources,
        actions,
        addressChange: { order, newAddress: address.address },
      };
    }

    default:
      // gateRequest already escalated every other request type.
      return escalate("other", `${request} request`);
  }
}

function orderSource(o: Order): string {
  return `Orders tab: ${o.orderNo} (status ${o.status}${o.carrier ? `, ${o.carrier} ${o.tracking}` : ""}${o.eta ? `, ETA ${o.eta}` : ""}${o.deliveredDate ? `, delivered ${o.deliveredDate}` : ""})`;
}

function statusFacts(o: Order): string[] {
  const items = `Items: ${o.items.map((i) => `${i.quantity} x ${i.name}`).join("; ")}`;
  switch (o.status) {
    case "Processing":
      return [`Status: being prepared, not shipped yet (ordered ${longDate(o.orderDate)}).`, ...(o.eta ? [`Expected delivery: ${longDate(o.eta)}.`] : []), items, `Shipping to: ${o.shipTo}`];
    case "Shipped":
      return [`Status: shipped with ${o.carrier}.`, `Tracking number: ${o.tracking}`, ...(o.eta ? [`Expected delivery: ${longDate(o.eta)}.`] : []), items, `Shipping to: ${o.shipTo}`];
    case "Delivered":
      return [`Status: delivered on ${longDate(o.deliveredDate)} by ${o.carrier}.`, `Tracking number: ${o.tracking}`, items];
    case "Cancelled":
      return ["Status: cancelled.", items, "Questions about the cancellation are answered by a teammate."];
  }
}
