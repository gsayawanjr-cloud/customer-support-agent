# Customer Support Agent

An automation for an online store's support inbox. It reads each customer email, looks up the order, and answers the routine questions with a reply saved as a Gmail draft. Anything risky goes to a person with a summary and recommended next steps.

Built with TypeScript on [Trigger.dev](https://trigger.dev), Claude, Gmail and Google Sheets. The demo store is a made-up one, "Larkspur Home Goods".

## How it works

1. **Read the inbox.** `check-support-inbox` fetches new emails over IMAP and starts one `handle-ticket` run per email.
2. **Understand the email.** Claude reads it into structured fields: request type, order number, and risk signals (angry or threatening, legal threat or chargeback, a request to change account email or payment, instructions aimed at the AI, sensitive personal data, writing on behalf of someone else).
3. **Decide in code.** Claude's reading is only an input. The order row in the sheet and the store's return policy decide the outcome (`decide.ts`, `policy.ts`). Only three request types can be finished without a person: **order status**, **return eligibility** and **address change**.
4. **Reply or hand off.**
   - Safe and clear: Claude words a reply from the facts code has checked, and it is saved as a **Gmail draft**. Nothing is sent automatically.
   - Anything else (refunds, cancellations, any risk signal, an order that can't be found): a **handoff** email to staff with what the customer wants, why it needs a person, and the next steps.
5. **Log everything.** Every ticket gets a row in the **Tickets** tab. `support-metrics` reports how many tickets were resolved without a person and how many of those a reviewer marked correct.

## Design choices

- **Claude never decides.** It reads and writes text. Whether a return is allowed, or whether an address can still change, is checked in plain code against the order data and the written policy.
- **A keyword backstop.** Words that always need a person are also checked in code, in case the model misses a signal.
- **Policy answers cite their source.** Each policy section has an ID, so a reply or handoff shows exactly which rule it used.
- **Testable for free.** `support-self-test` runs the decision rules on made-up cases with no AI or network. `samples/emails.json` holds 15 mock emails with expected outcomes, and `check-test-results` compares a real run against them.

## Project layout

```
src/trigger/support/
  check-support-inbox.ts   finds new emails, one run per ticket
  handle-ticket.ts         the pipeline for one email
  read-message.ts          Claude: email → structured reading
  decide.ts, rules.ts      every decision, in code
  policy.ts                the return policy (the only policy source)
  reply.ts, handoff.ts     customer draft / staff handoff
  store.ts, table.ts       Google Sheets: orders and tickets
  support-metrics.ts       the numbers that show it works
```

## Running it

Setup and the test sequence are in [SETUP.md](SETUP.md). Copy `.env.example` to `.env`, fill in each value (every line has a comment saying where to get it), then run `npm install` and `npm run dev`.
