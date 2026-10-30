import { createHash } from "node:crypto";
import { SheetClient, type Cell, type SheetAccess, type TableSpec } from "./table.js";

/** The Google Sheet is the store's database (Orders) and the support log (Tickets, Handoffs, ...). */
export function sheetAccess(): SheetAccess {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  const sheetId = process.env.SUPPORT_SHEET_ID;
  if (!sheetId) throw new Error("SUPPORT_SHEET_ID is not set");
  return { serviceAccountJson, sheetId };
}

export function storeName(): string {
  return process.env.STORE_NAME?.trim() || "Larkspur Home Goods";
}

export const TABS = { orders: "Orders", tickets: "Tickets", handoffs: "Handoffs", addressChanges: "Address changes", metrics: "Metrics" } as const;

// ─── Orders ─────────────────────────────────────────────────────────────────────────────────

export const ORDER_STATUSES = ["Processing", "Shipped", "Delivered", "Cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type OrderItem = { quantity: number; name: string; price: string; finalSale: boolean };

export type Order = {
  /** 1-based sheet row, used to update the address. */
  row: number;
  orderNo: string;
  customer: string;
  email: string;
  items: OrderItem[];
  itemsText: string;
  orderDate: string;
  status: OrderStatus;
  carrier: string;
  tracking: string;
  eta: string;
  deliveredDate: string;
  shipTo: string;
};

export const ORDERS_TABLE: TableSpec = {
  columns: [
    { header: "Order No", width: 95, minWidth: 95 },
    { header: "Customer", width: 150, minWidth: 140 },
    { header: "Email", width: 230, minWidth: 220 },
    { header: "Items", width: 360, minWidth: 300 },
    { header: "Order Date", width: 100 },
    { header: "Status", width: 120 },
    { header: "Carrier", width: 80 },
    { header: "Tracking", width: 190, minWidth: 180 },
    { header: "ETA", width: 100 },
    { header: "Delivered", width: 100 },
    { header: "Ship To", width: 300, minWidth: 280 },
    { header: "Updated", width: 180, minWidth: 160, muted: true },
  ],
  frozenColumns: 1,
  dropdowns: [{ column: "Status", options: [...ORDER_STATUSES] }],
  pills: [
    { column: "Status", condition: "TEXT_EQ", value: "Processing", bg: "#FFF2CC", fg: "#7F6000" },
    { column: "Status", condition: "TEXT_EQ", value: "Shipped", bg: "#DDEBF7", fg: "#1F4E78" },
    { column: "Status", condition: "TEXT_EQ", value: "Delivered", bg: "#E2EFDA", fg: "#375623" },
    { column: "Status", condition: "TEXT_EQ", value: "Cancelled", bg: "#EDEDED", fg: "#595959" },
  ],
};

/** One line per item: "2 x Linen Throw Pillow @ 38.00", with " [FINAL SALE]" at the end when it applies. */
const ITEM_LINE = /^(\d+)\s*x\s+(.+?)\s+@\s+\$?([\d.]+)(\s+\[FINAL SALE\])?$/i;

export function parseItems(text: string): OrderItem[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = ITEM_LINE.exec(line);
      if (!m) throw new Error(`Item line not understood: "${line}" (expected "2 x Name @ 38.00")`);
      return { quantity: Number(m[1]), name: m[2]!, price: `$${Number(m[3]).toFixed(2)}`, finalSale: Boolean(m[4]) };
    });
}

/** "#1006", "lh1006", "LH 1006" and "1006" all mean "LH-1006". */
export function normalizeOrderNo(value: string): string {
  const compact = value.trim().toUpperCase().replace(/^#/, "").replace(/\s+/g, "");
  const m = /^(?:LH-?)?(\d+)$/.exec(compact);
  return m ? `LH-${m[1]}` : compact;
}

export async function readOrders(sheet: SheetClient): Promise<Order[]> {
  const rows = await sheet.getValues(TABS.orders, "A2:L");
  return rows
    .map((r, i) => ({ r, row: i + 2 }))
    .filter(({ r }) => (r[0] ?? "").trim() !== "")
    .map(({ r, row }) => {
      const status = (r[5] ?? "").trim() as OrderStatus;
      if (!ORDER_STATUSES.includes(status)) throw new Error(`Order ${r[0]} has an unknown status "${r[5]}"`);
      return {
        row,
        orderNo: normalizeOrderNo(r[0]!),
        customer: (r[1] ?? "").trim(),
        email: (r[2] ?? "").trim().toLowerCase(),
        items: parseItems(r[3] ?? ""),
        itemsText: (r[3] ?? "").trim(),
        orderDate: (r[4] ?? "").trim(),
        status,
        carrier: (r[6] ?? "").trim(),
        tracking: (r[7] ?? "").trim(),
        eta: (r[8] ?? "").trim(),
        deliveredDate: (r[9] ?? "").trim(),
        shipTo: (r[10] ?? "").trim(),
      };
    });
}

/** Updates the Ship To and Updated cells of one order row. */
export async function updateShipTo(sheet: SheetClient, order: Order, newAddress: string, note: string): Promise<void> {
  await sheet.putValues(TABS.orders, `K${order.row}:L${order.row}`, [[newAddress, note]]);
}

// ─── Tickets ────────────────────────────────────────────────────────────────────────────────

export const OUTCOMES = ["Auto-resolved", "Needs info", "Escalated"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const VERDICTS = ["Correct", "Edited", "Wrong"] as const;

export const TICKETS_TABLE: TableSpec = {
  columns: [
    { header: "Ticket ID", width: 140, minWidth: 140 },
    { header: "Received (UTC)", width: 150, minWidth: 140 },
    { header: "Customer", width: 150, minWidth: 140 },
    { header: "Customer Email", width: 240, minWidth: 230 },
    { header: "Order No", width: 95, minWidth: 95 },
    { header: "Request", width: 150, minWidth: 140 },
    { header: "Outcome", width: 130, minWidth: 125 },
    { header: "Reason", width: 300, minWidth: 280 },
    { header: "Actions Taken", width: 360, minWidth: 330 },
    { header: "Sources Used", width: 320, minWidth: 300 },
    { header: "Reply Draft", width: 480, minWidth: 460 },
    { header: "Reopened", width: 90, align: "CENTER" },
    { header: "Reopened By", width: 140, minWidth: 130 },
    { header: "Reviewer Verdict", width: 150, minWidth: 140 },
    { header: "Message ID", width: 220, muted: true },
    { header: "Thread", width: 220, muted: true },
  ],
  frozenColumns: 1,
  dropdowns: [{ column: "Reviewer Verdict", options: [...VERDICTS] }],
  pills: [
    { column: "Outcome", condition: "TEXT_EQ", value: "Auto-resolved", bg: "#E2EFDA", fg: "#375623" },
    { column: "Outcome", condition: "TEXT_EQ", value: "Needs info", bg: "#FFF2CC", fg: "#7F6000" },
    { column: "Outcome", condition: "TEXT_EQ", value: "Escalated", bg: "#FCE4D6", fg: "#843C0C" },
    { column: "Reopened", condition: "TEXT_EQ", value: "Yes", bg: "#F8CBAD", fg: "#843C0C" },
    { column: "Reviewer Verdict", condition: "TEXT_EQ", value: "Correct", bg: "#E2EFDA", fg: "#375623" },
    { column: "Reviewer Verdict", condition: "TEXT_EQ", value: "Edited", bg: "#FFF2CC", fg: "#7F6000" },
    { column: "Reviewer Verdict", condition: "TEXT_EQ", value: "Wrong", bg: "#F8CBAD", fg: "#843C0C" },
  ],
};

export type Ticket = {
  ticketId: string;
  receivedAt: string;
  customer: string;
  customerEmail: string;
  orderNo: string;
  request: string;
  outcome: Outcome;
  reason: string;
  actions: string[];
  sources: string[];
  replyDraft: string;
  messageId: string;
  /** Message-IDs this email replies to (In-Reply-To + References). */
  thread: string[];
};

export type TicketRow = Ticket & { row: number; reopened: boolean; verdict: string };

/** Stable ticket id per email: the same email always gets the same id. */
export function ticketIdFor(messageId: string, receivedAt: string): string {
  const day = receivedAt.slice(2, 10).replace(/-/g, "");
  return `T-${day}-${createHash("sha256").update(messageId).digest("hex").slice(0, 4).toUpperCase()}`;
}

function ticketCells(t: Ticket): Cell[] {
  return [
    t.ticketId,
    t.receivedAt.replace("T", " ").slice(0, 16),
    t.customer,
    t.customerEmail,
    t.orderNo,
    t.request,
    t.outcome,
    t.reason,
    t.actions.join("\n"),
    t.sources.join("\n"),
    t.replyDraft,
    "",
    "",
    "",
    t.messageId,
    t.thread.join("\n"),
  ];
}

export async function appendTicket(sheet: SheetClient, ticket: Ticket): Promise<void> {
  await sheet.appendValues(TABS.tickets, [ticketCells(ticket)]);
}

export async function readTickets(sheet: SheetClient): Promise<TicketRow[]> {
  const rows = await sheet.getValues(TABS.tickets, "A2:P");
  return rows
    .map((r, i) => ({ r, row: i + 2 }))
    .filter(({ r }) => (r[0] ?? "").trim() !== "")
    .map(({ r, row }) => ({
      row,
      ticketId: r[0] ?? "",
      receivedAt: (r[1] ?? "").replace(" ", "T"),
      customer: r[2] ?? "",
      customerEmail: (r[3] ?? "").toLowerCase(),
      orderNo: r[4] ?? "",
      request: r[5] ?? "",
      outcome: (r[6] ?? "") as Outcome,
      reason: r[7] ?? "",
      actions: (r[8] ?? "").split("\n").filter(Boolean),
      sources: (r[9] ?? "").split("\n").filter(Boolean),
      replyDraft: r[10] ?? "",
      reopened: (r[11] ?? "") === "Yes",
      verdict: r[13] ?? "",
      messageId: r[14] ?? "",
      thread: (r[15] ?? "").split("\n").filter(Boolean),
    }));
}

export async function markReopened(sheet: SheetClient, ticket: TicketRow, byTicketId: string): Promise<void> {
  await sheet.putValues(TABS.tickets, `L${ticket.row}:M${ticket.row}`, [["Yes", byTicketId]]);
}

// ─── Handoffs, address log, metrics ─────────────────────────────────────────────────────────

export const HANDOFFS_TABLE: TableSpec = {
  columns: [
    { header: "Ticket ID", width: 140, minWidth: 140 },
    { header: "Created (UTC)", width: 150, minWidth: 140 },
    { header: "Customer Email", width: 240, minWidth: 230 },
    { header: "Order No", width: 95, minWidth: 95 },
    { header: "Reason", width: 300, minWidth: 280 },
    { header: "Summary", width: 400, minWidth: 380 },
    { header: "Sources Used", width: 320, minWidth: 300 },
    { header: "Actions Taken", width: 360, minWidth: 330 },
    { header: "Next Steps", width: 420, minWidth: 400 },
    { header: "Status", width: 90 },
  ],
  frozenColumns: 1,
  dropdowns: [{ column: "Status", options: ["Open", "Done"] }],
  pills: [
    { column: "Status", condition: "TEXT_EQ", value: "Open", bg: "#FCE4D6", fg: "#843C0C" },
    { column: "Status", condition: "TEXT_EQ", value: "Done", bg: "#E2EFDA", fg: "#375623" },
  ],
};

export type Handoff = {
  ticketId: string;
  createdAt: string;
  customerEmail: string;
  orderNo: string;
  reason: string;
  summary: string;
  sources: string[];
  actions: string[];
  nextSteps: string[];
};

export async function appendHandoff(sheet: SheetClient, h: Handoff): Promise<void> {
  await sheet.appendValues(TABS.handoffs, [
    [
      h.ticketId,
      h.createdAt.replace("T", " ").slice(0, 16),
      h.customerEmail,
      h.orderNo,
      h.reason,
      h.summary,
      h.sources.join("\n"),
      h.actions.join("\n"),
      h.nextSteps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
      "Open",
    ],
  ]);
}

export const ADDRESS_TABLE: TableSpec = {
  columns: [
    { header: "Ticket ID", width: 140, minWidth: 140 },
    { header: "Changed (UTC)", width: 150, minWidth: 140 },
    { header: "Order No", width: 95, minWidth: 95 },
    { header: "Old Address", width: 320, minWidth: 300 },
    { header: "New Address", width: 320, minWidth: 300 },
  ],
  frozenColumns: 1,
};

export async function appendAddressChange(sheet: SheetClient, ticketId: string, orderNo: string, oldAddress: string, newAddress: string): Promise<void> {
  await sheet.appendValues(TABS.addressChanges, [[ticketId, new Date().toISOString().replace("T", " ").slice(0, 16), orderNo, oldAddress, newAddress]]);
}

export async function addressChangedBy(sheet: SheetClient, ticketId: string): Promise<boolean> {
  const rows = await sheet.getValues(TABS.addressChanges, "A2:A");
  return rows.some((r) => r[0] === ticketId);
}

export const METRICS_TABLE: TableSpec = {
  columns: [
    { header: "Metric", width: 320, minWidth: 300 },
    { header: "Value", width: 100, align: "RIGHT" },
    { header: "Detail", width: 460, minWidth: 440 },
  ],
  frozenColumns: 1,
};

/** Columns removed from a tab's layout; format-sheet deletes them (with their data) from existing sheets. */
export const RETIRED_COLUMNS: Record<string, string[]> = {
  [TABS.tickets]: ["Model", "Est. Cost (USD)"],
};

/** Every tab the automation uses, with its layout. */
export const ALL_TABLES: [string, TableSpec][] = [
  [TABS.orders, ORDERS_TABLE],
  [TABS.tickets, TICKETS_TABLE],
  [TABS.handoffs, HANDOFFS_TABLE],
  [TABS.addressChanges, ADDRESS_TABLE],
  [TABS.metrics, METRICS_TABLE],
];
