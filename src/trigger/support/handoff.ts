import type { Handoff } from "./store.js";

/** Why a ticket went to a person; picks the recommended next steps. */
export type HandoffKind =
  | "refund"
  | "cancellation"
  | "damaged"
  | "suspicious"
  | "sensitive"
  | "several"
  | "other"
  | "not_found"
  | "error"
  | "shipped_address"
  | "return_not_shipped"
  | "late_or_missing"
  | "open_question"
  | "data_problem";

const NEXT_STEPS: Record<HandoffKind, string[]> = {
  refund: [
    "Open the order in the Orders tab and check the return policy (RP-1 to RP-5).",
    "Decide on the refund in the payment system; the automation never issues refunds.",
    "Reply to the customer in the same Gmail thread (a holding draft is already there).",
  ],
  cancellation: [
    "Check the order's Status in the Orders tab.",
    "If it is still Processing, cancel it with fulfilment and set Status to Cancelled; if it has shipped, explain the return option instead.",
    "Reply in the same Gmail thread (a holding draft is already there).",
  ],
  damaged: [
    "Ask the customer for a photo of the damage if they didn't send one.",
    "Arrange a replacement or refund under RP-6.",
    "Reply in the same Gmail thread (a holding draft is already there).",
  ],
  suspicious: [
    "Do NOT share order details with the sender: the email does not match the order.",
    "Write to the email address on the order to confirm whether the customer made this request.",
    "If it was not them, note it on the order and watch for further attempts.",
  ],
  sensitive: [
    "Read the full message in Gmail before replying.",
    "Reply personally; if the customer shared card numbers or passwords, ask them not to and delete that data from the thread.",
    "Escalate to the store owner if there is a legal or chargeback threat.",
  ],
  several: [
    "Read the full message: it asks for more than one thing (or mentions more than one order), so the automation did none of it.",
    "Handle each request, then reply once in the same Gmail thread.",
  ],
  other: ["Read the message and answer it; it is outside the three automated request types."],
  not_found: [
    "Search the Orders tab by the customer's email address and name.",
    "If an order is found, reply with the answer; if not, ask the customer for their order confirmation email.",
  ],
  error: [
    "Look up the order by hand in the Orders tab and answer from it.",
    "Check the run in Trigger.dev for the error shown under Actions; fix it if it repeats.",
  ],
  shipped_address: [
    "The order has already shipped, so the address cannot be changed in the Orders tab (RP-7).",
    "Check with the carrier whether a delivery redirect is possible for this tracking number.",
    "Reply in the same Gmail thread with what the carrier allows.",
  ],
  return_not_shipped: [
    "The customer wants to return an order that has not shipped: treat it as a cancellation request.",
    "Confirm with the customer, then cancel with fulfilment if they agree.",
  ],
  late_or_missing: [
    "Check the tracking number on the carrier's site for the latest scan.",
    "If it shows delivered but the customer has nothing, or it is stuck past the ETA, open a claim with the carrier.",
    "Decide on a replacement or refund; reply in the same Gmail thread (a holding draft is already there).",
  ],
  open_question: [
    "Open the reply draft in Gmail: it already answers what the order record shows.",
    "Answer the open part named in the Reason (add it to the draft), then send it.",
  ],
  data_problem: [
    "Fix the order row in the Orders tab (the automation could not read it).",
    "Answer the customer by hand from the corrected row.",
  ],
};

export function buildHandoff(input: Omit<Handoff, "nextSteps"> & { kind: HandoffKind }): Handoff {
  const { kind, ...rest } = input;
  return { ...rest, nextSteps: NEXT_STEPS[kind] };
}

/** The alert email: the four parts a teammate needs so they don't start from zero. */
export function handoffEmail(h: Handoff, context: { customerName: string; subject: string; sheetUrl: string; customerText: string }): string {
  return [
    `Ticket ${h.ticketId} needs a person.`,
    `Reason: ${h.reason}`,
    `Customer: ${context.customerName || "(no name)"} <${h.customerEmail || "unknown"}>`,
    `Order: ${h.orderNo || "(none given)"}`,
    `Subject: ${context.subject}`,
    "",
    "CONVERSATION SUMMARY",
    h.summary,
    "",
    "SOURCES USED",
    ...(h.sources.length > 0 ? h.sources.map((s) => `- ${s}`) : ["- none (nothing was looked up)"]),
    "",
    "ACTIONS TAKEN",
    ...(h.actions.length > 0 ? h.actions.map((a) => `- ${a}`) : ["- none"]),
    "",
    "RECOMMENDED NEXT STEPS",
    ...h.nextSteps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "CUSTOMER'S MESSAGE",
    context.customerText.slice(0, 3000),
    "",
    `Sheet: ${context.sheetUrl}`,
  ].join("\n");
}
