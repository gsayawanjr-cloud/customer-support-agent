import type { HandoffKind } from "./handoff.js";
import type { Reading, RequestType, RiskSignal } from "./read-message.js";
import type { Order } from "./store.js";

/** The only requests the automation may finish without a person. */
export const SAFE_REQUESTS: RequestType[] = ["order_status", "return_eligibility", "address_change"];

export const REQUEST_LABELS: Record<RequestType, string> = {
  order_status: "Order status",
  return_eligibility: "Return eligibility",
  address_change: "Address change",
  refund: "Refund",
  cancellation: "Cancellation",
  other: "Other",
};

const RISK_LABELS: Record<RiskSignal, string> = {
  angry_or_threatening: "angry or threatening message",
  legal_or_chargeback: "legal threat or chargeback",
  asks_to_change_email_or_payment: "asks to change account email, payment or recipient",
  instructions_to_the_assistant: "message contains instructions aimed at the support system",
  shares_sensitive_data: "message contains sensitive personal data",
  claims_to_be_someone_else: "writes on behalf of someone else",
};

// Backstop in code, in case Claude misses a signal: words that always need a person.
const SENSITIVE_WORDS = /\b(chargebacks?|lawyers?|attorneys?|lawsuit|sue|legal action|fraud(ulent)?|scam|credit card|card number|cvv|password|social security|bbb)\b/i;

export type Gate = { escalate: false } | { escalate: true; reason: string; kind: HandoffKind };

/**
 * Step 4: requests that always go to a person, decided before any order data is touched.
 * Several requests at once also go to a person, so nothing in the email is silently skipped.
 */
export function gateRequest(reading: Reading, emailText: string): Gate {
  if (!SAFE_REQUESTS.includes(reading.requestType)) {
    const kind: HandoffKind = reading.requestType === "refund" ? "refund" : reading.requestType === "cancellation" ? "cancellation" : "other";
    return { escalate: true, kind, reason: `${REQUEST_LABELS[reading.requestType]} request: always handled by a person` };
  }
  const extra = reading.otherRequestTypes.filter((t) => t !== reading.requestType);
  if (extra.length > 0) {
    return { escalate: true, kind: "several", reason: `Several requests in one email (${[reading.requestType, ...extra].map((t) => REQUEST_LABELS[t]).join(", ")})` };
  }
  if (reading.otherOrderNumbers.length > 0) return { escalate: true, kind: "several", reason: "Message is about more than one order" };
  if (reading.riskSignals.length > 0) {
    const kind: HandoffKind = reading.riskSignals.includes("claims_to_be_someone_else") ? "suspicious" : "sensitive";
    return { escalate: true, kind, reason: `Sensitive: ${reading.riskSignals.map((s) => RISK_LABELS[s]).join("; ")}` };
  }
  const word = SENSITIVE_WORDS.exec(emailText);
  if (word) return { escalate: true, kind: "sensitive", reason: `Sensitive wording ("${word[0]}")` };
  return { escalate: false };
}

export type IdentityCheck = { verified: true } | { verified: false; reason: string };

/** Step 6: the email must come from the address the order was placed with. */
export function verifyIdentity(order: Order, customerEmail: string): IdentityCheck {
  if (!customerEmail) return { verified: false, reason: "Sender address unknown" };
  if (customerEmail.trim().toLowerCase() !== order.email) {
    return { verified: false, reason: `Sender ${customerEmail} is not the email on order ${order.orderNo}` };
  }
  return { verified: true };
}

const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "),
);

export type AddressCheck = { complete: true; address: string } | { complete: false; missing: string[] };

/** A new address is used only when every part is there and well-formed; nothing is ever filled in. */
export function checkAddress(a: Reading["newAddress"]): AddressCheck {
  const missing: string[] = [];
  const street = a.street.trim();
  const state = a.state.trim().toUpperCase();
  const zip = a.zip.trim();
  if (!/^\d+[A-Za-z]?\s+\S+/.test(street)) missing.push("street number and name");
  if (!a.city.trim()) missing.push("city");
  if (!US_STATES.has(state)) missing.push("state");
  if (!/^\d{5}(-\d{4})?$/.test(zip)) missing.push("ZIP code");
  if (missing.length > 0) return { complete: false, missing };
  const line2 = a.line2.trim();
  return { complete: true, address: `${street}${line2 ? `, ${line2}` : ""}, ${a.city.trim()}, ${state} ${zip}` };
}
