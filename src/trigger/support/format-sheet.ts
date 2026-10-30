import { logger, task } from "@trigger.dev/sdk";
import { ALL_TABLES, RETIRED_COLUMNS, sheetAccess } from "./store.js";
import { SheetClient } from "./table.js";

/**
 * Free: re-applies the layout to every tab (widths, wrapping, row heights, colors). Data is untouched,
 * except columns listed in RETIRED_COLUMNS, which are deleted so the rest line up with the layout.
 */
export const formatSheet = task({
  id: "format-sheet",
  run: async () => {
    const sheet = await SheetClient.connect(sheetAccess());
    const removed: string[] = [];
    for (const [title, spec] of ALL_TABLES) {
      const tab = await sheet.ensureTab(title);
      const retired = RETIRED_COLUMNS[title] ?? [];
      if (retired.length > 0) {
        const header = (await sheet.getValues(title, "1:1"))[0] ?? [];
        // Right to left, so earlier deletions don't shift the columns still to delete.
        const indexes = header.map((h, i) => (retired.includes(h) ? i : -1)).filter((i) => i >= 0).reverse();
        await sheet.batchUpdate(
          indexes.map((i) => ({ deleteDimension: { range: { sheetId: tab.sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 } } })),
        );
        removed.push(...indexes.map((i) => `${title}: ${header[i]}`));
      }
      // Re-read the tab: deleting columns changes its conditional formats and banding.
      await sheet.applyLayout(await sheet.ensureTab(title), spec);
    }
    logger.info("Sheet formatted", { tabs: ALL_TABLES.length, removed });
    return { formatted: ALL_TABLES.map(([title]) => title), removed };
  },
});
