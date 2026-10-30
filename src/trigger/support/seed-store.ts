import { logger, task } from "@trigger.dev/sdk";
import { todayInStore } from "./dates.js";
import { demoOrderRows } from "./demo-data.js";
import { ALL_TABLES, ORDERS_TABLE, sheetAccess, TABS } from "./store.js";
import { SheetClient } from "./table.js";

/**
 * Sets up the sheet: creates every tab with its layout and fills Orders with the demo orders (dates
 * relative to today). Refuses to replace existing orders unless `overwrite: true`. `clearLog: true`
 * also empties Tickets, Handoffs, Address changes and Metrics (to restart a test from zero).
 */
export const seedStore = task({
  id: "seed-store",
  run: async (payload: { overwrite?: boolean; clearLog?: boolean } = {}) => {
    const sheet = await SheetClient.connect(sheetAccess());

    const existing = (await sheet.listTabs()).includes(TABS.orders) ? await sheet.getValues(TABS.orders, "A2:A") : [];
    const hasOrders = existing.some((r) => (r[0] ?? "").trim() !== "");
    if (hasOrders && !payload.overwrite) {
      return { seeded: false, message: `Orders already has ${existing.length} rows. Run again with { "overwrite": true } to replace them with fresh demo orders.` };
    }

    if (payload.clearLog) {
      for (const [title] of ALL_TABLES.filter(([t]) => t !== TABS.orders)) {
        if ((await sheet.listTabs()).includes(title)) await sheet.clearValues(title, "A2:Z");
      }
    }

    const rows = demoOrderRows(todayInStore());
    await sheet.ensureTab(TABS.orders);
    await sheet.clearValues(TABS.orders, "A2:Z");
    await sheet.putValues(TABS.orders, "A2", rows);

    // Layout last, so column widths and row heights fit the data just written.
    for (const [title, spec] of ALL_TABLES) {
      const tab = await sheet.ensureTab(title);
      await sheet.applyLayout(tab, spec);
    }
    logger.info("Store seeded", { orders: rows.length, columns: ORDERS_TABLE.columns.length });
    return { seeded: true, orders: rows.length, clearedLog: payload.clearLog === true };
  },
});
