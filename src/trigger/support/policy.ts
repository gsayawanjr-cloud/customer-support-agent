import { daysBetween, longDate, addDays } from "./dates.js";
import type { Order, OrderItem } from "./store.js";

/**
 * The store's return policy: the ONLY policy source the automation answers from. Each section has an
 * id, so tickets and handoffs can say exactly which lines an answer used. `evaluateReturn` below
 * enforces the same numbers; change both together.
 */
export const RETURN_WINDOW_DAYS = 30;
export const LABEL_FEE = "$6.95";
export const RETURNS_ADDRESS = "Larkspur Home Goods Returns, 410 Harbor Road, Portland, OR 97209";

export const POLICY_SECTIONS = {
  "RP-1": `Items can be returned within ${RETURN_WINDOW_DAYS} days of delivery.`,
  "RP-2": "Returned items must be unused, with their original tags and packaging.",
  "RP-3": "Items marked Final Sale cannot be returned or exchanged.",
  "RP-4": `To return, pack the item(s) with the order number written on the packing slip and ship them to ${RETURNS_ADDRESS}. Customers can use their own carrier, or ask us for a prepaid label (${LABEL_FEE}, deducted from the refund).`,
  "RP-5": "Refunds go back to the original payment method after the return arrives and is checked by our team.",
  "RP-6": "Damaged or defective items are handled by a teammate, who will arrange a replacement or refund.",
  "RP-7": "Orders that have not shipped yet can have their shipping address changed. Once an order has shipped, the address can no longer be changed by us.",
} as const;

export type PolicyId = keyof typeof POLICY_SECTIONS;

export function policyText(ids: PolicyId[]): string {
  return ids.map((id) => `${id}: ${POLICY_SECTIONS[id]}`).join("\n");
}

export type ItemCondition = "unused" | "used" | "damaged" | "defective" | "unknown";

export type ItemVerdict = {
  item: string;
  eligible: boolean;
  /** Customer-facing reason, built from the policy only. */
  reason: string;
  policy: PolicyId[];
};

export type ReturnDecision =
  | { kind: "answer"; verdicts: ItemVerdict[]; facts: string[]; policy: PolicyId[] }
  | { kind: "escalate"; reason: string; policy: PolicyId[] };

/**
 * Decides return eligibility from the order row and the policy alone. Claude never decides this.
 * `mentioned` are the item names the customer wrote; with none, every item on the order is checked.
 */
export function evaluateReturn(order: Order, mentioned: string[], condition: ItemCondition, today: string): ReturnDecision {
  if (condition === "damaged" || condition === "defective") {
    return { kind: "escalate", reason: `Customer reports the item is ${condition}`, policy: ["RP-6"] };
  }
  if (order.status === "Cancelled") return { kind: "escalate", reason: "Return asked for a cancelled order", policy: [] };
  if (order.status === "Processing") {
    // Wanting to return something that hasn't shipped is really a cancellation.
    return { kind: "escalate", reason: "Return asked before the order shipped (likely a cancellation)", policy: [] };
  }

  const items = matchItems(order.items, mentioned);
  if (order.status === "Shipped") {
    return {
      kind: "answer",
      verdicts: [],
      facts: [
        `The order has not been delivered yet. Return window: ${RETURN_WINDOW_DAYS} days, starting on the delivery date.`,
        ...(order.eta ? [`Expected delivery: ${longDate(order.eta)}`] : []),
      ],
      policy: ["RP-1", "RP-2", "RP-3"],
    };
  }

  // Delivered.
  if (!order.deliveredDate) return { kind: "escalate", reason: "Order is marked Delivered but has no delivery date", policy: [] };
  const daysSince = daysBetween(order.deliveredDate, today);
  const lastDay = addDays(order.deliveredDate, RETURN_WINDOW_DAYS);
  const verdicts = items.map((item): ItemVerdict => {
    if (item.finalSale) return { item: item.name, eligible: false, reason: "It is a Final Sale item, which can't be returned.", policy: ["RP-3"] };
    if (daysSince > RETURN_WINDOW_DAYS) {
      return { item: item.name, eligible: false, reason: `The ${RETURN_WINDOW_DAYS}-day return window ended on ${longDate(lastDay)}.`, policy: ["RP-1"] };
    }
    if (condition === "used") return { item: item.name, eligible: false, reason: "Returned items must be unused.", policy: ["RP-2"] };
    return { item: item.name, eligible: true, reason: `It can be returned until ${longDate(lastDay)} if it is unused, with its tags and packaging.`, policy: ["RP-1", "RP-2"] };
  });
  const anyEligible = verdicts.some((v) => v.eligible);
  const policy = [...new Set<PolicyId>([...verdicts.flatMap((v) => v.policy), ...(anyEligible ? (["RP-4", "RP-5"] as PolicyId[]) : [])])];
  return {
    kind: "answer",
    verdicts,
    facts: [`Delivered on ${longDate(order.deliveredDate)}.`, ...(anyEligible ? [`How to return: ${POLICY_SECTIONS["RP-4"]}`, POLICY_SECTIONS["RP-5"]] : [])],
    policy,
  };
}

// Words that appear in many item names ("set of 4") or requests, so they say nothing about which item.
const MATCH_STOPWORDS = new Set(["set", "the", "and", "for", "with", "item", "items", "one", "two", "queen", "king"]);

/** The order items the customer means: name word overlap, or every item when nothing matches. */
export function matchItems(items: OrderItem[], mentioned: string[]): OrderItem[] {
  const words = (text: string) => new Set((text.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !MATCH_STOPWORDS.has(w)));
  const matched = items.filter((item) => {
    const itemWords = words(item.name);
    return mentioned.some((m) => [...words(m)].some((w) => itemWords.has(w) || itemWords.has(w.replace(/s$/, ""))));
  });
  return matched.length > 0 ? matched : items;
}
