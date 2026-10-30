// Copied from RFQ Automation/src/trigger/rfq-intake/sheet.ts (generic table machinery only).
import { JWT } from "google-auth-library";

/** Access to the spreadsheet; each table (Orders, Tickets, Handoffs, ...) is a tab in it. */
export type SheetAccess = { serviceAccountJson: string; sheetId: string };
export type SheetConfig = SheetAccess & { tab: string };

export type Cell = string | number;

export type Column = {
  header: string;
  /** Maximum width in pixels. Columns are sized to their content up to this; longer text wraps. */
  width: number;
  /** Minimum width in pixels (default 60). */
  minWidth?: number;
  align?: "LEFT" | "CENTER" | "RIGHT";
  muted?: boolean;
  /** Sheets number format pattern, e.g. "#,##0.00" for prices. */
  numberFormat?: string;
};

/** Colored "pill" for cells whose value matches. */
export type Pill = { column: string; condition: "TEXT_EQ" | "NUMBER_EQ"; value: string; bg: string; fg: string };

export type TableSpec = {
  columns: Column[];
  frozenColumns: number;
  pills?: Pill[];
  dropdowns?: { column: string; options: string[] }[];
};

// ─── Shared table machinery ─────────────────────────────────────────────────────────────────

// Sheets can't auto-fit row heights to wrapped text from the API, so estimate it: average glyph width
// of 10pt Arial, line height, and cell padding, all in pixels.
const CHAR_WIDTH = 7;
const LINE_HEIGHT = 17;
const CELL_PADDING = 8;
const MIN_ROW_HEIGHT = 21;
const HEADER_MIN_HEIGHT = 40;
const DEFAULT_MIN_WIDTH = 60;
// Bold header text is a little wider than body text.
const BOLD_FACTOR = 1.1;
// Every header has a filter button on its right, which takes this much of the text width.
const FILTER_BUTTON = 24;
// Headers wrap onto at most this many lines.
const HEADER_MAX_LINES = 2;

// Dropdown cells show an arrow chip on their right, which takes this much of the text width.
const DROPDOWN_ARROW = 24;

// Muted columns (Message-IDs) use 8pt text, about 80% the width of the 10pt body text.
const MUTED_FACTOR = 0.8;

/**
 * Per-column body text metrics: pill columns show bold text, muted columns small text, and
 * dropdown columns lose room to their arrow.
 */
function bodyMetrics(spec: TableSpec) {
  const pills = new Set((spec.pills ?? []).map((p) => p.column));
  const dropdowns = new Map((spec.dropdowns ?? []).map((d) => [d.column, d.options]));
  return spec.columns.map((c) => ({
    charWidth: CHAR_WIDTH * (c.muted ? MUTED_FACTOR : 1) * (pills.has(c.header) ? BOLD_FACTOR : 1),
    reserved: dropdowns.has(c.header) ? DROPDOWN_ARROW : 0,
    options: dropdowns.get(c.header) ?? [],
  }));
}

/**
 * Lines a text takes when wrapped like Sheets does: whole words per line, breaking a word only
 * when it is longer than a full line.
 */
function wrappedLines(text: string, charsPerLine: number): number {
  return text.split("\n").reduce((total, paragraph) => {
    let lines = 1;
    let used = 0;
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const need = used === 0 ? word.length : used + 1 + word.length;
      if (need <= charsPerLine) used = need;
      else if (word.length <= charsPerLine) {
        lines++;
        used = word.length;
      } else {
        // A word longer than a line breaks across lines.
        lines += used === 0 ? Math.ceil(word.length / charsPerLine) - 1 : Math.ceil(word.length / charsPerLine);
        used = word.length % charsPerLine || charsPerLine;
      }
    }
    return total + lines;
  }, 0);
}

/** Row height for wrapped text, from the columns' actual widths (less `reserved(i)` px per cell). */
function estimateRowHeight(
  widths: number[],
  row: Cell[],
  charWidth: (i: number) => number = () => CHAR_WIDTH,
  reserved: (i: number) => number = () => 0,
): number {
  const lines = row.map((value, i) => {
    const charsPerLine = Math.max(1, Math.floor(((widths[i] ?? 100) - CELL_PADDING * 2 - reserved(i)) / charWidth(i)));
    return wrappedLines(String(value ?? ""), charsPerLine);
  });
  return Math.max(MIN_ROW_HEIGHT, Math.max(1, ...lines) * LINE_HEIGHT + CELL_PADDING);
}

/** Width a header needs to show whole words on at most HEADER_MAX_LINES lines, beside its filter button. */
function headerWidth(header: string): number {
  let chars = Math.max(1, ...header.split(/\s+/).map((w) => w.length));
  while (wrappedLines(header, chars) > HEADER_MAX_LINES) chars++;
  return Math.ceil(chars * CHAR_WIDTH * BOLD_FACTOR + CELL_PADDING * 2 + FILTER_BUTTON + 4);
}

/**
 * Width each column needs: its data's longest line, within [minWidth, width], but never narrower
 * than its header needs or (for dropdowns) its longest option on one line, so headers and
 * dropdown values stay readable whatever the column's maximum.
 */
function fitWidths(spec: TableSpec, values: string[][]): number[] {
  const metrics = bodyMetrics(spec);
  return spec.columns.map((c, i) => {
    const { charWidth, reserved, options } = metrics[i]!;
    const longest = values
      .slice(1)
      .reduce((max, row) => Math.max(max, ...String(row[i] ?? "").split("\n").map((l) => l.length)), 0);
    const dataNeed = Math.ceil(longest * charWidth + CELL_PADDING * 2 + reserved + 4);
    const longestOption = Math.max(0, ...options.map((o) => o.length));
    const optionNeed = options.length > 0 ? Math.ceil(longestOption * CHAR_WIDTH * BOLD_FACTOR + CELL_PADDING * 2 + reserved + 4) : 0;
    return Math.max(headerWidth(c.header), optionNeed, Math.min(c.width, Math.max(c.minWidth ?? DEFAULT_MIN_WIDTH, dataNeed)));
  });
}

function rgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

export function columnLetter(index: number): string {
  let letter = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letter = String.fromCharCode(65 + ((n - 1) % 26)) + letter;
  }
  return letter;
}

async function getToken(serviceAccountJson: string): Promise<string> {
  let credentials: { client_email?: string; private_key?: string };
  try {
    credentials = JSON.parse(serviceAccountJson);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
  }
  const jwt = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("Could not get a Google access token for the service account");
  return token;
}

async function sheetsFetch(token: string, url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Google Sheets API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

export type TabInfo = { title: string; sheetId: number; bandedRangeIds: number[]; conditionalFormatCount: number };

export class SheetClient {
  readonly spreadsheet: string;

  private constructor(private token: string, access: SheetAccess) {
    this.spreadsheet = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(access.sheetId)}`;
  }

  static async connect(access: SheetAccess): Promise<SheetClient> {
    return new SheetClient(await getToken(access.serviceAccountJson), access);
  }

  private range(tab: string, range: string) {
    return encodeURIComponent(`'${tab.replace(/'/g, "''")}'!${range}`);
  }

  batchUpdate(requests: object[]) {
    if (requests.length === 0) return Promise.resolve({});
    return sheetsFetch(this.token, `${this.spreadsheet}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
  }

  /** Values as displayed (formatted), one array per row. */
  async getValues(tab: string, range: string): Promise<string[][]> {
    const result = await sheetsFetch(this.token, `${this.spreadsheet}/values/${this.range(tab, range)}`);
    return result.values ?? [];
  }

  /** Raw values: numbers stay numbers (prices, stock). */
  async getRawValues(tab: string, range: string): Promise<Cell[][]> {
    const result = await sheetsFetch(this.token, `${this.spreadsheet}/values/${this.range(tab, range)}?valueRenderOption=UNFORMATTED_VALUE`);
    return result.values ?? [];
  }

  putValues(tab: string, range: string, values: Cell[][]) {
    return sheetsFetch(this.token, `${this.spreadsheet}/values/${this.range(tab, range)}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values }),
    });
  }

  clearValues(tab: string, range: string) {
    return sheetsFetch(this.token, `${this.spreadsheet}/values/${this.range(tab, range)}:clear`, { method: "POST", body: "{}" });
  }

  /** Appends rows and returns the 1-based sheet row of the first one. */
  async appendValues(tab: string, values: Cell[][]): Promise<number | null> {
    // OVERWRITE fills the next empty, already-formatted rows. INSERT_ROWS would insert new rows that
    // copy the formatting of the row above — for the first row, the header's white bold text.
    const result = await sheetsFetch(
      this.token,
      `${this.spreadsheet}/values/${this.range(tab, "A1")}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`,
      { method: "POST", body: JSON.stringify({ values }) },
    );
    // updatedRange looks like "'RFQs'!A3:T3"; the number after the "!" column letters is the first row written.
    return Number(/!\$?[A-Z]+\$?(\d+)/.exec(result.updates?.updatedRange ?? "")?.[1]) || null;
  }

  /**
   * Sizes every column to its content (within the column's min/max; longer text wraps), then sets
   * every row tall enough for its wrapped text at those widths. Call after any data is written.
   */
  async fitColumns(tab: TabInfo, spec: TableSpec): Promise<void> {
    const values = await this.getValues(tab.title, `A1:${columnLetter(spec.columns.length - 1)}`);
    const widths = fitWidths(spec, values);
    const metrics = bodyMetrics(spec);
    const headerHeight = Math.max(
      HEADER_MIN_HEIGHT,
      estimateRowHeight(widths, spec.columns.map((c) => c.header), () => CHAR_WIDTH * BOLD_FACTOR, () => FILTER_BUTTON),
    );
    await this.batchUpdate([
      ...widths.map((w, i) => ({
        updateDimensionProperties: {
          range: { sheetId: tab.sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: w },
          fields: "pixelSize",
        },
      })),
      {
        updateDimensionProperties: {
          range: { sheetId: tab.sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
          properties: { pixelSize: headerHeight },
          fields: "pixelSize",
        },
      },
      ...values.slice(1).map((row, i) => ({
        updateDimensionProperties: {
          range: { sheetId: tab.sheetId, dimension: "ROWS", startIndex: i + 1, endIndex: i + 2 },
          properties: {
            pixelSize: estimateRowHeight(widths, row, (col) => metrics[col]?.charWidth ?? CHAR_WIDTH, (col) => metrics[col]?.reserved ?? 0),
          },
          fields: "pixelSize",
        },
      })),
    ]);
  }

  /** Titles of all tabs in the spreadsheet. */
  async listTabs(): Promise<string[]> {
    const meta = await sheetsFetch(this.token, `${this.spreadsheet}?fields=sheets(properties(title))`);
    return (meta.sheets ?? []).map((s: any) => s.properties.title);
  }

  /** Finds a tab, creating it (optionally hidden) if it doesn't exist yet. */
  async ensureTab(title: string, options: { hidden?: boolean } = {}): Promise<TabInfo> {
    const meta = await sheetsFetch(
      this.token,
      `${this.spreadsheet}?fields=sheets(properties(sheetId,title),bandedRanges(bandedRangeId),conditionalFormats(booleanRule))`,
    );
    const sheet = (meta.sheets ?? []).find((s: any) => s.properties.title === title);
    if (sheet) {
      return {
        title,
        sheetId: sheet.properties.sheetId,
        bandedRangeIds: (sheet.bandedRanges ?? []).map((b: any) => b.bandedRangeId),
        conditionalFormatCount: (sheet.conditionalFormats ?? []).length,
      };
    }
    const created = await this.batchUpdate([{ addSheet: { properties: { title, hidden: options.hidden === true } } }]);
    return { title, sheetId: created.replies[0].addSheet.properties.sheetId, bandedRangeIds: [], conditionalFormatCount: 0 };
  }

  /**
   * Writes the header and applies the table styling: wrapped text everywhere, banding, pills,
   * dropdowns, filter, and columns sized to their content. Safe to run repeatedly. Every visible
   * table tab must be created through this, so new tabs always wrap and auto-size.
   */
  async applyLayout(tab: TabInfo, spec: TableSpec): Promise<void> {
    const header = spec.columns.map((c) => c.header);
    await this.putValues(tab.title, "A1", [header]);

    const sheetId = tab.sheetId;
    const all = { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: spec.columns.length };
    const body = (col: number) => ({ sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 });
    const col = (name: string) => {
      const index = header.indexOf(name);
      if (index === -1) throw new Error(`Table has no column "${name}"`);
      return index;
    };
    const navy = rgb("#1F3864");

    await this.batchUpdate([
      // Clear earlier styling so re-running doesn't stack duplicates.
      ...tab.bandedRangeIds.map((id) => ({ deleteBanding: { bandedRangeId: id } })),
      ...Array.from({ length: tab.conditionalFormatCount }, (_, i) => ({
        deleteConditionalFormatRule: { sheetId, index: tab.conditionalFormatCount - 1 - i },
      })),
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: spec.frozenColumns } },
          fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
        },
      },
      {
        repeatCell: {
          range: { ...all, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: navy,
              horizontalAlignment: "LEFT",
              verticalAlignment: "MIDDLE",
              wrapStrategy: "WRAP",
              textFormat: { bold: true, fontSize: 10, foregroundColor: rgb("#FFFFFF") },
            },
          },
          fields: "userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)",
        },
      },
      ...spec.columns.map((c, i) => ({
        repeatCell: {
          range: body(i),
          cell: {
            userEnteredFormat: {
              horizontalAlignment: c.align ?? "LEFT",
              verticalAlignment: "TOP",
              wrapStrategy: "WRAP",
              textFormat: { fontSize: c.muted ? 8 : 10, foregroundColor: rgb(c.muted ? "#808080" : "#1F1F1F") },
              ...(c.numberFormat ? { numberFormat: { type: "NUMBER", pattern: c.numberFormat } } : {}),
            },
          },
          // backgroundColor is listed but unset, which clears any fill so the row banding shows.
          fields: `userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,textFormat${c.numberFormat ? ",numberFormat" : ""})`,
        },
      })),
      {
        addBanding: {
          bandedRange: {
            range: all,
            rowProperties: { headerColor: navy, firstBandColor: rgb("#FFFFFF"), secondBandColor: rgb("#F3F6FB") },
          },
        },
      },
      ...(spec.pills ?? []).map((p) => ({
        addConditionalFormatRule: {
          index: 0,
          rule: {
            ranges: [body(col(p.column))],
            booleanRule: {
              condition: { type: p.condition, values: [{ userEnteredValue: p.value }] },
              format: { backgroundColor: rgb(p.bg), textFormat: { bold: true, foregroundColor: rgb(p.fg) } },
            },
          },
        },
      })),
      ...(spec.dropdowns ?? []).map((d) => ({
        setDataValidation: {
          range: body(col(d.column)),
          rule: {
            condition: { type: "ONE_OF_LIST", values: d.options.map((v) => ({ userEnteredValue: v })) },
            showCustomUi: true,
            strict: true,
          },
        },
      })),
      { setBasicFilter: { filter: { range: all } } },
    ]);
    // Column widths and row heights follow the content.
    await this.fitColumns(tab, spec);
  }
}

