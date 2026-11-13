/************************************************************
 * Budget System - Global Yearly File + Monthly Tab Automation
 *
 * Features:
 * - Creates yearly budget files from templates when a new year arrives.
 * - Manages:
 *    Brian Budget YYYY
 *    Hannah Budget YYYY
 *    Shared Expenses YYYY
 *
 * - Uses simple monthly tab names:
 *    January, February, March, etc.
 *
 * - New monthly tabs are copied from an internal template tab.
 * - Existing monthly tabs are NOT cleaned/reset on daily runs.
 *
 * - Personal budget formulas are label-based instead of hardcoded to
 *   cells like C13/C14/D19/D20.
 *
 * - Brian and Hannah can pull from different rows in Shared Expenses:
 *    Brian  -> row 4
 *    Hannah -> row 5
 *
 * - Shared Expenses and personal-budget Income date-stamping are
 *   handled by global installable edit triggers instead of sheet-bound
 *   onEdit(e) functions.
 ************************************************************/

/***********************
 * CONFIG
 ***********************/

const BUDGET_SYSTEM_FOLDER_ID = "1OgpCwunDG9_5O6tynarrYc0SfkzpX-33";

const TEMPLATE_IDS = {
  brianBudget: "1SoGUNPEoUiKC52bhYAgoL19zIGPKugS7BWj7K8FO5h4",
  hannahBudget: "112IifU7w4GPguAdA2uAcdE0mu2ukgwBNkn3RY1cbzWc",
  sharedExpenses: "1ftMoCkxAnX0DGjiWLsYvIe7ISWQhghtvpIcpOx51oYQ",
};

const KNOWN_2026_FILES = {
  brianBudgetId: "1ArI4qapaj-LGg7v5OC47WdfYijjLdu3QPRPgKLbgD3U",
  hannahBudgetId: "1lEULEvZ5UzjuhnGPncpvh56xxA8JsfYyns0JS_Okmsg",
  sharedExpensesId: "1t2Nm5luEjm-RKiiMyuIFvJBhdI0ubufWkrdjRzBsTgU",
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_TEMPLATE_SHEET_NAMES = ["Template"];
const BUDGET_TIME_ZONE = "America/Los_Angeles";
const BUDGET_PREPARE_DAYS = 7;

const MONTH_LABEL_PLACEHOLDER = "Month";
const MONTH_LABEL_SEARCH_ROWS = 10;
const MONTH_LABEL_SEARCH_COLUMNS = 10;

const PERSONAL_BUDGET_SNAPSHOT_LABELS = [
  {
    label: "Burn Rate",
    searchMode: "contains",
    targetColumnOffsetFromLabel: 1,
  },
  {
    label: "Static Bills & Subscriptions (Needs)",
    aliases: ["Subscriptions (Needs)"],
    searchMode: "exact",
    targetColumnOffsetFromLabel: null,
  },
  {
    label: "Subscriptions (Wants)",
    searchMode: "exact",
    targetColumnOffsetFromLabel: null,
  },
];

const SNAPSHOT_SEARCH_WINDOW_COLUMNS = 6;

/**
 * Formula linking rules.
 *
 * The script searches the personal budget sheet for each label,
 * then places the IMPORTRANGE formula next to that label.
 *
 * Brian pulls from row 4 in Shared Expenses.
 * Hannah pulls from row 5 in Shared Expenses.
 *
 * Example:
 * Brian Budget / May / Groceries row -> imports from Shared Expenses / May / F4
 * Hannah Budget / May / Groceries row -> imports from Shared Expenses / May / F5
 */
const PERSONAL_BUDGET_IMPORT_RULES = {
  brian: [
    {
      label: "Groceries",
      targetColumnOffsetFromLabel: 1,
      sharedExpenseCell: "F4",
    },
    {
      label: "Auto/Gas",
      targetColumnOffsetFromLabel: 1,
      sharedExpenseCell: "L4",
    },
    {
      label: "Various Need Transactions",
      targetColumnOffsetFromLabel: 1,
      sharedExpenseCell: "AJ4",
    },
    {
      label: "Eating out",
      targetColumnOffsetFromLabel: 2,
      sharedExpenseCell: "T4",
    },
    {
      label: "Shopping",
      targetColumnOffsetFromLabel: 2,
      sharedExpenseCell: "AB4",
    },
  ],

  hannah: [
    {
      label: "Groceries",
      targetColumnOffsetFromLabel: 1,
      sharedExpenseCell: "F5",
    },
    {
      label: "Auto/Gas",
      targetColumnOffsetFromLabel: 1,
      sharedExpenseCell: "L5",
    },
    {
      label: "Various Need Transactions",
      targetColumnOffsetFromLabel: 1,
      sharedExpenseCell: "AJ5",
    },
    {
      label: "Eating out",
      targetColumnOffsetFromLabel: 2,
      sharedExpenseCell: "T5",
    },
    {
      label: "Shopping",
      targetColumnOffsetFromLabel: 2,
      sharedExpenseCell: "AB5",
    },
  ],
};

/**
 * Shared Expenses edit date stamping.
 *
 * When an amount is entered, the matching date column is stamped
 * if it is currently empty.
 *
 * B  -> A   (Grocery)
 * I  -> H   (Gas)
 * P  -> N   (Food)
 * X  -> V   (Shopping)
 * AF -> AD  (Needs)
 */
const SHARED_EXPENSES_DATE_COLUMN_MAP = {
  2: 1,
  9: 8,
  16: 14,
  24: 22,
  32: 30,
};

/** Resolve the native header; old annual files remain readable. */
function sharedExpenseColumnShift(sheet) {
  const headers = sheet.getRange(1, 1, 2, Math.min(41, sheet.getMaxColumns())).getDisplayValues();
  const fields = headers[1].slice(7, 11).map(value => String(value).trim().replace(/:$/, "").toLowerCase());
  if (fields[0] === "date" && fields[1] === "amount" && fields[2] === "location" && fields[3] === "person") return 1;
  if (fields[0] === "date" && fields[1] === "amount" && fields[2] === "person") return 0;
  throw new Error("Shared Gas headers could not be verified.");
}

function personalBudgetImportRules(sharedId, monthName, owner) {
  const book = SpreadsheetApp.openById(sharedId);
  const shared = book.getSheetByName(monthName) || getMonthlyTemplateSheet(book);
  const shift = sharedExpenseColumnShift(shared);
  const shifted = {F: "F", L: "M", T: "U", AB: "AC", AJ: "AK"};
  const rules = PERSONAL_BUDGET_IMPORT_RULES[owner];
  if (!rules) throw new Error(`No import rules found for budget owner: ${owner}`);
  return rules.map(rule => ({...rule, sharedExpenseCell: shift ? rule.sharedExpenseCell.replace(/^[A-Z]+/, col => shifted[col]) : rule.sharedExpenseCell}));
}

/** Read-only deployment check. Never prepares, closes or relinks a month. */
function auditGasLocationSetup() {
  return withBudgetRolloverLock(() => {
    const config = getYearConfig(getYear(new Date()));
    if (!config) throw new Error("Current year configuration is missing.");
    const shared = SpreadsheetApp.openById(config.sharedExpensesId);
    const sheets = shared.getSheets().filter(sheet => MONTH_NAMES.includes(sheet.getName()) || MONTH_TEMPLATE_SHEET_NAMES.includes(sheet.getName()));
    for (const sheet of sheets) if (sharedExpenseColumnShift(sheet) !== 1) throw new Error(`Gas Location is missing: ${sheet.getName()}`);
    if (sharedExpenseColumnShift(SpreadsheetApp.openById(TEMPLATE_IDS.sharedExpenses).getSheetByName("Template")) !== 1) throw new Error("Annual shared master is missing Gas Location.");
    const month = getMonthName(new Date());
    for (const owner of ["brian", "hannah"]) {
      const sheet = SpreadsheetApp.openById(config[`${owner}BudgetId`]).getSheetByName(month);
      validatePreparedBudgetMonthTab(sheet, config, {name:month}, owner);
    }
    Logger.log(`Gas Location verified in ${sheets.length} shared tabs, annual master and both current personal budgets. No cells changed.`);
  });
}

const PERSONAL_BUDGET_INCOME_HEADER_SCAN_ROWS = 20;
const PERSONAL_BUDGET_INCOME_HEADER_SCAN_COLUMNS = 10;

const INCOME_SETTINGS_RANGE = "B4:E5";
const INCOME_SETTINGS_HEADERS = ["Main Income Source:", "Income Projection Mode:", "Expected Income Amount:", "Paycheck Anchor Date:"];
const INCOME_PROJECTION_MODES = ["biweekly", "fixed monthly", "off"];
const INCOME_SETTING_LABELS = {
  source: ["Main Income Source:", "Biweekly Income Source:"],
  mode: ["Income Projection Mode:"],
  amount: ["Expected Income Amount:", "Fixed Monthly Income:"],
  anchor: ["Paycheck Anchor Date:", "Biweekly Income Start:"],
};

/***********************
 * MAIN ENTRY POINT
 ***********************/

/**
 * Run this from your daily time-based trigger.
 *
 * Safe to run repeatedly.
 */
function budgetSystemRollover() {
  return withBudgetRolloverLock(() => {
    const today = new Date(), failures = [];
    // Preparation cannot freeze the still-active month. Closing is independent,
    // so a failed future copy does not prevent an already-closed month settling.
    try { prepareBudgetMonthsAt(today); } catch (error) { failures.push(error); }
    try { closePreviousBudgetMonthAt(today); } catch (error) { failures.push(error); }
    if (failures.length) throw failures[0];
  });
}

/** Evening retry/preparation entry point. Never snapshots any month. */
function prepareBudgetMonths() {
  return withBudgetRolloverLock(() => prepareBudgetMonthsAt(new Date()));
}

function withBudgetRolloverLock(work) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log("Another budget automation run is active; leaving its work untouched.");
    return {status: "busy"};
  }
  try { return work(); } finally { lock.releaseLock(); }
}

function budgetMonthPeriod(date, offset = 0) {
  const [year, month, day] = Utilities.formatDate(date, BUDGET_TIME_ZONE, "yyyy-MM-dd").split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + offset, 1, 12));
  const targetYear = target.getUTCFullYear(), targetMonth = target.getUTCMonth() + 1;
  return {year: targetYear, month: targetMonth, name: MONTH_NAMES[targetMonth - 1],
    key: `${targetYear}-${String(targetMonth).padStart(2, "0")}`, day,
    daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate()};
}

function prepareBudgetMonthsAt(today) {
  seedKnown2026ConfigIfMissing();
  const current = budgetMonthPeriod(today), periods = [current], failures = [];
  if (current.daysInMonth - current.day < BUDGET_PREPARE_DAYS) periods.push(budgetMonthPeriod(today, 1));
  for (const period of periods) {
    try { prepareBudgetMonthTabs(getOrCreateYearFiles(period.year), period); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures[0];
}

function prepareBudgetMonthTabs(config, period) {
  prepareBudgetMonthTab(config.sharedExpensesId, config, period, null);
  const failures = [];
  for (const owner of ["brian", "hannah"]) {
    try { prepareBudgetMonthTab(config[`${owner}BudgetId`], config, period, owner); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures[0];
  Logger.log(`Budget month ${period.key} is prepared in all three workbooks.`);
}

function prepareBudgetMonthTab(bookId, config, period, owner) {
  const ss = SpreadsheetApp.openById(bookId), props = PropertiesService.getScriptProperties();
  const key = `BUDGET_MONTH_PREP_V1_${period.key}_${bookId}`;
  const raw = props.getProperty(key), pending = raw ? JSON.parse(raw) : null;
  const published = ss.getSheetByName(period.name);
  if (published) {
    // The name becomes public only after configuration/validation. Never touch
    // live transactions, formulas, settings overrides or row coordinates on retry.
    if (pending && pending.sheetId && published.getSheetId() !== pending.sheetId) throw new Error(`Prepared month identity changed: ${period.key}`);
    if (pending && pending.phase !== "ready") props.setProperty(key, JSON.stringify({...pending, phase: "ready"}));
    return published;
  }
  if (pending?.phase === "ready") throw new Error(`Prepared month was removed or renamed: ${period.key}`);
  const stageName = `_BookieBot Preparing ${period.key}`;
  let sheet = ss.getSheetByName(stageName);
  if (sheet && !pending) throw new Error(`Unclaimed preparation tab requires review: ${period.key}`);
  if (pending?.sheetId && (!sheet || sheet.getSheetId() !== pending.sheetId)) throw new Error(`Preparation tab identity changed: ${period.key}`);
  if (!pending) props.setProperty(key, JSON.stringify({phase: "creating", owner, bookId, month: period.key}));
  if (!sheet) sheet = ss.insertSheet(stageName, {template: getMonthlyTemplateSheet(ss)});
  sheet.hideSheet();
  props.setProperty(key, JSON.stringify({phase: "configuring", owner, bookId, month: period.key, sheetId: sheet.getSheetId()}));
  // Personal budgets have a month heading; the shared ledger starts directly
  // with category headers and may have no month label at all.
  if (!setMonthLabel(sheet, period.name) && owner) throw new Error(`Missing month label in preparation template: ${period.key}`);
  if (owner) {
    writePersonalBudgetIncomeSettings(sheet, resolvePersonalBudgetIncomeSettings(ss, period.name, false));
    inheritPersonalBudgetIncomeSettings(ss, sheet, period.name);
    const plan = resolvePersonalBudgetSavingsPlan(ss, period.name, false);
    if (plan) writePersonalBudgetSavingsPlan(sheet, plan, period.year, false, period.name);
    updatePersonalBudgetImportRanges(sheet, config.sharedExpensesId, period.name, owner);
    applyManagedBillPlans(ss, sheet, period);
  }
  SpreadsheetApp.flush();
  validatePreparedBudgetMonthTab(sheet, config, period, owner);
  // Flush and validate before publishing the canonical name. If the rename
  // commits but its response is lost, the pinned sheet ID makes retry read-only.
  sheet.showSheet();
  sheet.setName(period.name);
  props.setProperty(key, JSON.stringify({phase: "ready", owner, bookId, month: period.key, sheetId: sheet.getSheetId()}));
  return sheet;
}

function validatePreparedBudgetMonthTab(sheet, config, period, owner) {
  if (!owner) {
    const shift = sharedExpenseColumnShift(sheet);
    if (sheet.getMaxColumns() < 40 + shift) throw new Error("Shared template is missing required expense columns.");
    const headers = sheet.getRange(1, 1, 2, 40 + shift).getDisplayValues();
    const shifted = column => column + (column >= 10 ? shift : 0);
    for (const [oldColumn, category, oldAmount, oldPerson] of [[1, "GROCERY", 2, 4], [8, "GAS", 9, 10], [14, "FOOD", 16, 18], [22, "SHOPPING", 24, 26], [30, "NEEDS", 32, 34]]) {
      const column = shifted(oldColumn), amountColumn = shifted(oldAmount), personColumn = shifted(oldPerson);
      if (headers[0][column - 1] !== category || headers[1][column - 1] !== "Date" || headers[1][amountColumn - 1] !== "Amount" || headers[1][personColumn - 1] !== "Person") throw new Error(`Shared template headers are incomplete: ${category}`);
    }
    return;
  }
  if (!findCellByAnyExactTextInTopLeft(sheet, [period.name])) throw new Error(`Prepared month label is missing: ${period.key}`);
  if (!hasPersonalBudgetIncomeSettings(sheet) || !findPersonalBudgetIncomeLayout(sheet) || !findCellByExactText(sheet, "Monthly Income:")) throw new Error("Prepared personal income layout is incomplete.");
  for (const rule of personalBudgetImportRules(config.sharedExpensesId, period.name, owner)) {
    const label = findCellByExactText(sheet, rule.label);
    const expected = `=IMPORTRANGE("${buildSpreadsheetUrl(config.sharedExpensesId)}", "${buildSheetRangeReference(period.name, rule.sharedExpenseCell)}")`;
    if (!label || label.offset(0, rule.targetColumnOffsetFromLabel).getFormula() !== expected) throw new Error(`Prepared import is incomplete: ${rule.label}`);
    const displayed = label.offset(0, rule.targetColumnOffsetFromLabel).getDisplayValue().trim();
    if (displayed.startsWith("#") || /^loading/i.test(displayed)) throw new Error(`Prepared import is still unavailable: ${rule.label}`);
  }
}

/** Close only a prior calendar month; never called from advance preparation. */
function closePreviousBudgetMonthAt(today) {
  const period = budgetMonthPeriod(today, -1), config = getYearConfig(period.year);
  if (!config) {
    Logger.log(`No configured prior year for closing ${period.key}; no close recorded.`);
    return;
  }
  const props = PropertiesService.getScriptProperties(), failures = [];
  for (const owner of ["brian", "hannah"]) {
    const bookId = config[`${owner}BudgetId`], key = `BUDGET_MONTH_CLOSED_V1_${period.key}_${bookId}`;
    if (props.getProperty(key)) continue;
    try {
      const ss = SpreadsheetApp.openById(bookId);
      if (!ss.getSheetByName(period.name)) {
        Logger.log(`No existing ${owner} month ${period.key} to close; no close recorded.`);
        continue;
      }
      snapshotPersonalBudgetMonthOutputs(bookId, period.name, owner, true);
      SpreadsheetApp.flush();
      // Per-cell freezing already skips static values. A partial/uncertain write
      // resumes remaining formulas; mark the owner complete only after success.
      props.setProperty(key, "closed");
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures[0];
}

/** Install after deploying this source. Create replacements before removing old
 * clocks, so an interrupted install cannot leave the project without a timer. */
function installBudgetRolloverTriggers() {
  return withBudgetRolloverLock(() => {
    const handlers = ["prepareBudgetMonths", "budgetSystemRollover"];
    const previous = ScriptApp.getProjectTriggers().filter(trigger => handlers.includes(trigger.getHandlerFunction()) && trigger.getEventType() === ScriptApp.EventType.CLOCK);
    const created = [];
    for (const [handler, hour] of [["prepareBudgetMonths", 20], ["budgetSystemRollover", 1]]) {
      created.push(ScriptApp.newTrigger(handler).timeBased().atHour(hour).everyDays(1).inTimezone(BUDGET_TIME_ZONE).create());
    }
    previous.forEach(trigger => ScriptApp.deleteTrigger(trigger));
    Logger.log("Installed Pacific evening preparation and overnight close/recovery timers.");
    return created.map(trigger => trigger.getUniqueId());
  });
}

/***********************
 * FIRST-TIME SETUP HELPERS
 ***********************/

/**
 * Run this once after pasting the script.
 *
 * It:
 * - Stores the known 2026 files
 * - Runs the rollover once
 * - Relinks current-year formulas
 * - Installs Shared Expenses and personal-budget edit triggers for the
 *   current year
 */
function setupBudgetSystemAutomation() {
  seedKnown2026ConfigIfMissing();
  budgetSystemRollover();
  relinkCurrentYearPersonalBudgetFormulas();
  installCurrentYearBudgetEditTriggers();
  installBudgetRolloverTriggers();

  Logger.log("Budget System automation setup complete.");
}

/**
 * Run this once manually after installing the script if you do not run
 * setupBudgetSystemAutomation().
 *
 * This stores your existing 2026 files in Script Properties.
 */
function seedKnown2026ConfigIfMissing() {
  const existing = getYearConfig(2026);

  if (existing) {
    return existing;
  }

  const config = {
    year: 2026,
    brianBudgetId: KNOWN_2026_FILES.brianBudgetId,
    hannahBudgetId: KNOWN_2026_FILES.hannahBudgetId,
    sharedExpensesId: KNOWN_2026_FILES.sharedExpensesId,
  };

  saveYearConfig(2026, config);

  return config;
}

/**
 * Optional manual test.
 *
 * Warning:
 * Running this with 2027 will actually create 2027 files
 * if they do not already exist.
 */
function testGetOrCreateYearFiles() {
  const config = getOrCreateYearFiles(2027);
  Logger.log(JSON.stringify(config, null, 2));
}

/**
 * Optional manual test.
 * Runs normal current-year/current-month rollover.
 */
function testCurrentMonthRollover() {
  budgetSystemRollover();
}

/**
 * Optional helper.
 * Shows stored year configs in Logs.
 */
function logStoredYearConfigs() {
  const props = PropertiesService.getScriptProperties().getProperties();
  Logger.log(JSON.stringify(props, null, 2));
}

/**
 * Optional helper.
 * Forces formula relinking for all month tabs in the current year.
 *
 * This does NOT clear/reset data.
 */
function relinkCurrentYearPersonalBudgetFormulas() {
  seedKnown2026ConfigIfMissing();

  const today = new Date();
  const year = getYear(today);
  const yearConfig = getOrCreateYearFiles(year);

  relinkAllPersonalBudgetSheetsForYear(
    yearConfig.brianBudgetId,
    yearConfig.sharedExpensesId,
    "brian",
  );

  relinkAllPersonalBudgetSheetsForYear(
    yearConfig.hannahBudgetId,
    yearConfig.sharedExpensesId,
    "hannah",
  );
}

/**
 * Optional manual helper.
 * Freezes previous-month personal budget formula outputs that should not
 * keep recalculating after the month closes.
 */
function snapshotPreviousMonthOutputs() {
  return withBudgetRolloverLock(() => {
    seedKnown2026ConfigIfMissing();
    closePreviousBudgetMonthAt(new Date());
  });
}

function snapshotPreviousMonthPersonalBudgetOutputs(today) {
  const previousMonthDate = getPreviousMonthDate(today);
  const previousYear = getYear(previousMonthDate);
  const previousMonthName = getMonthName(previousMonthDate);
  const previousYearConfig = getYearConfig(previousYear);

  if (!previousYearConfig) {
    Logger.log(
      `No stored year config for ${previousYear}; skipping ${previousMonthName} formula snapshots.`,
    );
    return;
  }

  snapshotPersonalBudgetMonthOutputs(
    previousYearConfig.brianBudgetId,
    previousMonthName,
    "Brian",
  );

  snapshotPersonalBudgetMonthOutputs(
    previousYearConfig.hannahBudgetId,
    previousMonthName,
    "Hannah",
  );
}

function snapshotPersonalBudgetMonthOutputs(
  personalBudgetSpreadsheetId,
  monthName,
  ownerName,
  strict = false,
) {
  const ss = SpreadsheetApp.openById(personalBudgetSpreadsheetId);
  const sheet = ss.getSheetByName(monthName);

  if (!sheet) {
    Logger.log(
      `Could not find ${ownerName} personal budget sheet "${monthName}" for formula snapshots.`,
    );
    return 0;
  }

  let snapshotCount = 0;

  PERSONAL_BUDGET_SNAPSHOT_LABELS.forEach(function (rule) {
    if (snapshotPersonalBudgetFormulaOutput(sheet, rule, strict)) {
      snapshotCount += 1;
    }
  });

  Logger.log(
    `Snapshotted ${snapshotCount} formula output cells on ${ownerName} ${monthName}.`,
  );

  return snapshotCount;
}

function snapshotPersonalBudgetFormulaOutput(sheet, rule, strict = false) {
  const labelCell =
    rule.searchMode === "contains"
      ? findCellContainingText(sheet, rule.label)
      : [rule.label, ...(rule.aliases || [])].map(label => findCellByExactText(sheet, label)).find(Boolean);

  if (!labelCell) {
    if (strict) throw new Error(`Missing closing label: ${rule.label}`);
    Logger.log(
      `Could not find snapshot label "${rule.label}" on sheet "${sheet.getName()}".`,
    );
    return false;
  }

  const targetCell =
    rule.targetColumnOffsetFromLabel === null
      ? findFirstFormulaCellToRight(labelCell, SNAPSHOT_SEARCH_WINDOW_COLUMNS)
      : labelCell.offset(0, rule.targetColumnOffsetFromLabel);

  if (!targetCell) {
    Logger.log(
      `Could not find formula output cell for "${rule.label}" on sheet "${sheet.getName()}".`,
    );
    return false;
  }

  if (snapshotFormulaCellValue(targetCell, rule.label)) {
    return true;
  }

  if (labelCell.getFormula()) {
    return snapshotFormulaCellValue(labelCell, rule.label);
  }

  return false;
}

function findFirstFormulaCellToRight(labelCell, maxColumns) {
  const sheet = labelCell.getSheet();
  const startColumn = labelCell.getColumn() + 1;
  const availableColumns = sheet.getMaxColumns() - labelCell.getColumn();
  const width = Math.min(maxColumns, availableColumns);

  if (width <= 0) {
    return null;
  }

  const formulas = sheet
    .getRange(labelCell.getRow(), startColumn, 1, width)
    .getFormulas()[0];

  for (let i = 0; i < formulas.length; i++) {
    if (formulas[i]) {
      return sheet.getRange(labelCell.getRow(), startColumn + i);
    }
  }

  return null;
}

function snapshotFormulaCellValue(cell, label) {
  if (!cell.getFormula()) {
    return false;
  }

  const value = cell.getValue();
  const displayValue = cell.getDisplayValue();

  if (value === "" || value === null || (typeof value === "string" && value.trim().startsWith("#")) || (typeof value === "number" && !Number.isFinite(value))) {
    throw new Error(`Summary is not ready to close: ${label}`);
  }

  cell.setValue(value);

  Logger.log(
    `Snapshotted ${label} on ${cell.getSheet().getName()}!${cell.getA1Notation()} as "${displayValue}".`,
  );

  return true;
}

/***********************
 * YEAR FILE MANAGEMENT
 ***********************/

function getOrCreateYearFiles(year) {
  const existingConfig = getYearConfig(year);

  if (existingConfig) {
    return existingConfig;
  }

  const newConfig = createYearFilesFromTemplates(year);
  saveYearConfig(year, newConfig);

  return newConfig;
}

function createYearFilesFromTemplates(year) {
  if (!Number.isInteger(year) || year < 2026 || year > 2100) throw new Error("Invalid budget year.");
  const budgetRootFolder = DriveApp.getFolderById(BUDGET_SYSTEM_FOLDER_ID);
  const yearFolder = getOrCreateChildFolder(budgetRootFolder, String(year));
  const props = PropertiesService.getScriptProperties(), key = `BUDGET_YEAR_PREP_V1_${year}`;
  let pending = JSON.parse(props.getProperty(key) || "null") || {year};
  for (const [kind, title] of [["brianBudget", "Brian Budget"], ["hannahBudget", "Hannah Budget"], ["sharedExpenses", "Shared Expenses"]]) {
    const idKey = `${kind}Id`, name = `${title} ${year}`;
    if (pending[idKey]) continue;
    const matches = yearFolder.getFilesByName(name), files = [];
    while (matches.hasNext()) files.push(matches.next());
    if (files.length > 1 || (files.length && pending.copying !== kind)) throw new Error(`Unclaimed or duplicate annual file requires review: ${name}`);
    // Persist intent before copying. A lost makeCopy response is recovered by
    // this exact name in this exact year folder, rather than copying it again.
    pending.copying = kind;
    props.setProperty(key, JSON.stringify(pending));
    const file = files[0] || DriveApp.getFileById(TEMPLATE_IDS[kind]).makeCopy(name, yearFolder);
    if (file.getMimeType() !== "application/vnd.google-apps.spreadsheet") throw new Error("Annual template is not a spreadsheet.");
    pending[idKey] = file.getId();
    delete pending.copying;
    props.setProperty(key, JSON.stringify(pending));
  }
  const config = {year, brianBudgetId: pending.brianBudgetId, hannahBudgetId: pending.hannahBudgetId, sharedExpensesId: pending.sharedExpensesId};
  initializeNewYearFiles(config, pending, key);
  prepareBudgetMonthTabs(config, {year, month: 1, name: "January", key: `${year}-01`});
  installBudgetEditTriggersForYearConfig(config, year);
  // getOrCreateYearFiles publishes YEAR_CONFIG only after every preceding step.
  return config;
}

function managedBillTable(ss, title) {
  const sheet=ss.getSheetByName(title);
  if (!sheet) return null;
  const rows=sheet.getDataRange().getValues(), headers=rows[0]||[];
  if (!headers.includes("plan_id")) return null;
  for(const key of ["effective_from","effective_until","active","bill_type","monthly_source","version"]) {
    if(!headers.includes(key)) throw new Error(`Incomplete managed bill schedule: ${title}`);
  }
  return {sheet,rows,headers};
}

function carryManagedBillPlans(previous, current) {
  const known=new Set(["bill_key","display_name","recurrence","pull_day","pull_months","source_label","account","notes","updated_at","expected_amount","tracking_mode","source_range","cadence","name","amount","pull_month","kind","plan_id","effective_from","effective_until","active","bill_type","category","split_method","payer_basis_points","version","request_id","monthly_source","split_starts_on"]);
  for(const title of ["_BookieBot Bill Schedule","_BookieBot Subscription Schedule"]) {
    const table=managedBillTable(previous,title);
    if(!table) continue;
    const target=current.getSheetByName(title)||current.insertSheet(title);
    // These are unpublished annual books. Carry the complete version history;
    // charge/source maps stay in their original annual book and are not copied.
    if(target.getMaxColumns()<table.headers.length)target.insertColumnsAfter(target.getMaxColumns(),table.headers.length-target.getMaxColumns());
    if(target.getMaxRows()<table.rows.length)target.insertRowsAfter(target.getMaxRows(),table.rows.length-target.getMaxRows());
    target.clearContents();
    target.getRange(1,1,table.rows.length,table.headers.length).setValues(table.rows.map(row=>Array.from({length:table.headers.length},(_,i)=>{
      const value=row[i]??"";return typeof value==="string"&&value.startsWith("=")?"'"+value:value;
    })));
    const formulas=table.sheet.getDataRange().getFormulas();
    for(let r=1;r<formulas.length;r++)for(let c=0;c<table.headers.length;c++) {
      if(!known.has(table.headers[c])&&formulas[r][c])target.getRange(r+1,c+1).setFormula(formulas[r][c]);
    }
    target.hideSheet();
  }
}

function applyManagedBillPlans(ss, sheet, period) {
  const tables=["_BookieBot Bill Schedule","_BookieBot Subscription Schedule"].map(title=>({title,table:managedBillTable(ss,title)})).filter(value=>value.table);
  if(!tables.length)return;
  const plans=[];
  for(const {title,table} of tables)for(let index=1;index<table.rows.length;index++) {
    const raw=table.rows[index], item=Object.fromEntries(table.headers.map((key,i)=>[key,raw[i]??""]));
    if(!item.plan_id)continue;
    if(String(item.effective_from)<=period.key&&period.key<String(item.effective_until))plans.push({...item,title,row:index+1,headers:table.headers});
  }
  const ids=plans.map(plan=>plan.plan_id);if(new Set(ids).size!==ids.length)throw new Error("Overlapping managed bill versions");
  let rows=sheet.getDataRange().getValues(), formulas=sheet.getDataRange().getFormulas(), tail=rows.length+2;
  const extras={3:[],4:[]}, virtual={3:[],4:[]};
  const letter=index=>{let result="";for(let n=index;n;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;return result;};
  for(const plan of plans) {
    const active=String(plan.active).toLowerCase()==="true", monthly=String(plan.monthly_source).toLowerCase()==="true";
    const day=Number(plan.pull_day), months=String(plan.pull_months||plan.pull_month||"").split(",").map(Number);
    const cadence=plan.recurrence||plan.cadence, due=active&&day>0&&(cadence==="monthly"||months.includes(period.month));
    const column=plan.category==="subscriptions_wants"?4:3;
    const amountColumn=plan.title==="_BookieBot Bill Schedule"?"expected_amount":"amount";
    const ref=`'${plan.title}'!${letter(plan.headers.indexOf(amountColumn)+1)}${plan.row}`;
    if(!monthly){if(due)virtual[column].push(ref);continue;}
    const matches=rows.map((row,i)=>String(row[1]||"").trim()===String(plan.source_label).trim()?i+1:0).filter(Boolean);
    if(matches.length>1)throw new Error("Ambiguous managed bill source");
    let row=matches[0];
    if(!row&&due){row=tail++;sheet.getRange(row,2).setValue(String(plan.source_label).startsWith("=")?"'"+plan.source_label:plan.source_label);extras[column].push(`${letter(column)}${row}`);}
    if(!row)continue;
    if(plan.bill_type!=="variable"&&due)sheet.getRange(row,column).setFormula("="+ref);
    else sheet.getRange(row,column).setValue(0);
  }
  for(const column of [3,4]) {
    const subtotal=column===3?"(Needs) Subtotal:":"(Wants) Subtotal:";
    if(extras[column].length){
      const matches=rows.map((row,i)=>row[1]===subtotal?i+1:0).filter(Boolean);if(matches.length!==1)throw new Error("Missing managed bill subtotal");
      const original=formulas[matches[0]-1][column-1],pattern=new RegExp(`SUM\\(${letter(column)}\\$?\\d+:${letter(column)}\\$?\\d+\\)`,"gi"),sums=[...new Set(original.match(pattern)||[])];
      if(sums.length!==1)throw new Error("Managed bill subtotal needs review");
      sheet.getRange(matches[0],column).setFormula(original.split(sums[0]).join(`(${sums[0]}+SUM(${extras[column].join(",")}))`));
    }
    if(tables.some(value=>value.title==="_BookieBot Subscription Schedule"))for(let i=0;i<rows.length;i++) {
      const label=String(rows[i][1]||"").toLowerCase(),matches=column===4?label==="subscriptions (wants)":label==="subscriptions (needs)"||label==="static bills & subscriptions (needs)";
      if(matches)sheet.getRange(i+1,column).setFormula(virtual[column].length?`=SUM(${virtual[column].join(",")})`:"=0");
    }
  }
}

function initializeNewYearFiles(config, pending = null, pendingKey = null) {
  const previousConfig = getYearConfig(config.year - 1);
  for (const key of ["brianBudgetId", "hannahBudgetId"]) {
    if (pending?.[`${key}Initialized`]) continue;
    const ss = SpreadsheetApp.openById(config[key]);
    const settings = previousConfig
      ? resolvePersonalBudgetIncomeSettings(SpreadsheetApp.openById(previousConfig[key]), "December", true)
      : readPersonalBudgetIncomeSettings(getMonthlyTemplateSheet(ss));
    writePersonalBudgetIncomeSettings(getMonthlyTemplateSheet(ss), settings);
    const priorSavings = previousConfig
      ? resolvePersonalBudgetSavingsPlan(SpreadsheetApp.openById(previousConfig[key]), "December", true)
      : readPersonalBudgetSavingsPlan(getMonthlyTemplateSheet(ss));
    if (priorSavings) writePersonalBudgetSavingsPlan(getMonthlyTemplateSheet(ss), priorSavings, config.year);
    if (previousConfig) carryManagedBillPlans(SpreadsheetApp.openById(previousConfig[key]), ss);
    if (pending) {
      SpreadsheetApp.flush();
      pending[`${key}Initialized`] = true;
      PropertiesService.getScriptProperties().setProperty(pendingKey, JSON.stringify(pending));
    }
  }
  // Legacy/manual callers retain their established initialization behavior.
  // The checkpointed annual path publishes only validated staging tabs.
  if (pending) return;
  ensureMonthExistsInSharedExpenses(config.sharedExpensesId, "January");

  ensureMonthExistsInPersonalBudget(
    config.brianBudgetId,
    config.sharedExpensesId,
    "January",
    "brian",
  );

  ensureMonthExistsInPersonalBudget(
    config.hannahBudgetId,
    config.sharedExpensesId,
    "January",
    "hannah",
  );

  relinkAllPersonalBudgetSheetsForYear(
    config.brianBudgetId,
    config.sharedExpensesId,
    "brian",
  );

  relinkAllPersonalBudgetSheetsForYear(
    config.hannahBudgetId,
    config.sharedExpensesId,
    "hannah",
  );
}

function getOrCreateChildFolder(parentFolder, childFolderName) {
  const folders = parentFolder.getFoldersByName(childFolderName);

  if (folders.hasNext()) {
    return folders.next();
  }

  return parentFolder.createFolder(childFolderName);
}

/***********************
 * SCRIPT PROPERTIES
 ***********************/

function getYearConfig(year) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(getYearConfigKey(year));

  if (!raw) {
    return null;
  }

  return JSON.parse(raw);
}

function saveYearConfig(year, config) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(getYearConfigKey(year), JSON.stringify(config));
}

function getYearConfigKey(year) {
  return `YEAR_CONFIG_${year}`;
}

/***********************
 * MONTH TAB MANAGEMENT
 ***********************/

function ensureMonthExistsInPersonalBudget(
  personalBudgetSpreadsheetId,
  sharedExpensesSpreadsheetId,
  monthName,
  budgetOwnerKey,
) {
  const ss = SpreadsheetApp.openById(personalBudgetSpreadsheetId);

  let sheet = ss.getSheetByName(monthName);

  if (sheet) {
    /**
     * Existing sheet:
     * - Do NOT clear/reset data.
     * - Do update formulas so they point to the correct yearly shared
     *   expense file and owner-specific row.
     */
    ensureMonthLabel(sheet, monthName);
    // Existing months retain their layout and explicit settings. The dedicated
    // migration also updates saved row references; daily runs never move rows.

    updatePersonalBudgetImportRanges(
      sheet,
      sharedExpensesSpreadsheetId,
      monthName,
      budgetOwnerKey,
    );

    return {
      sheet: sheet,
      created: false,
    };
  }

  /**
   * Brand-new monthly sheet:
   * - Copy internal template tab
   * - Rename sheet to the month
   * - Replace the template month label
   * - Relink formulas
   */
  const incomeSettings = resolvePersonalBudgetIncomeSettings(ss, monthName, false);
  sheet = createMonthSheet(ss, monthName);
  writePersonalBudgetIncomeSettings(sheet, incomeSettings);
  inheritPersonalBudgetIncomeSettings(ss, sheet, monthName);
  const savingsPlan = resolvePersonalBudgetSavingsPlan(ss, monthName, false);
  if (savingsPlan) writePersonalBudgetSavingsPlan(sheet, savingsPlan);

  updatePersonalBudgetImportRanges(
    sheet,
    sharedExpensesSpreadsheetId,
    monthName,
    budgetOwnerKey,
  );

  return {
    sheet: sheet,
    created: true,
  };
}

function ensureMonthExistsInSharedExpenses(
  sharedExpensesSpreadsheetId,
  monthName,
) {
  const ss = SpreadsheetApp.openById(sharedExpensesSpreadsheetId);

  let sheet = ss.getSheetByName(monthName);

  if (sheet) {
    /**
     * Existing sheet:
     * - Do NOT clear/reset rows.
     */
    ensureMonthLabel(sheet, monthName);

    return {
      sheet: sheet,
      created: false,
    };
  }

  /**
   * Brand-new monthly sheet:
   * - Copy internal template tab
   * - Rename sheet to the month
   * - Replace the template month label
   */
  sheet = createMonthSheet(ss, monthName);

  return {
    sheet: sheet,
    created: true,
  };
}

function createMonthSheet(ss, monthName) {
  const existingSheet = ss.getSheetByName(monthName);

  if (existingSheet) {
    return existingSheet;
  }

  const templateSheet = getMonthlyTemplateSheet(ss);
  const allSheets = ss.getSheets();

  const newSheet = templateSheet.copyTo(ss);
  newSheet.setName(monthName);
  newSheet.showSheet();
  setMonthLabel(newSheet, monthName);

  ss.setActiveSheet(newSheet);
  ss.moveActiveSheet(allSheets.length + 1);

  return newSheet;
}

function normalizeIncomeSettingLabel(value) {
  return String(value || "").trim().replace(/:\s*$/, "").trim().toLowerCase();
}

const SAVINGS_PLAN_HEADERS = ["ESPP Income Source", "ESPP Rate", "ESPP First Paycheck Date", "ESPP Cash Ideal Rate", "ESPP Cash Minimum Rate", "ESPP Last Paycheck Date"];
const SAVINGS_SUMMARY_LABELS = ["Deposited income", "Eligible payroll deposits", "ESPP contribution", "Take-home before ESPP", "Other income", "Ideal cash savings", "Minimum cash savings", "Cash savings contributed", "Combined savings + ESPP", "Needs allocation", "Wants allocation", "Cash savings allocation", "ESPP status"];
const ESPP_SETTINGS_TAB = "ESPP Settings";
const ESPP_SETTINGS_HEADERS = ["First eligible paycheck", "Last eligible paycheck", "Payroll source", "ESPP rate"];
const ESPP_MONTHLY_LABEL = "SpaceX ESPP this month";

function inlineSavingsEnrollmentLayout(sheet) {
  const rows=sheet.getDataRange().getValues();
  const index=rows.findIndex(row=>ESPP_SETTINGS_HEADERS.every((value,i)=>row[i+1]===value));
  if (index<0) return null;
  const income=findPersonalBudgetIncomeLayout(sheet);
  if (!income || income.headerRow<=index+2) throw new Error("Missing income table below ESPP settings.");
  return {headerRow:index+1, firstRow:index+2, count:income.headerRow-index-2};
}

function readPersonalBudgetSavingsPlan(sheet) {
  const inline=inlineSavingsEnrollmentLayout(sheet);
  if (inline) return {enrollments:sheet.getRange(inline.firstRow,2,inline.count,4).getValues().filter(row=>row.some(value=>value!==""))};
  if (sheet.getMaxColumns() >= 12 && sheet.getRange("G4:L4").getValues()[0].every((value, index) => value === SAVINGS_PLAN_HEADERS[index])) return sheet.getRange("G5:L5").getValues()[0];
  if (!sheet.getDataRange().getValues().some(row=>row.some(value=>String(value).startsWith(ESPP_MONTHLY_LABEL)))) return null;
  return readSavingsEnrollmentSettings(sheet.getParent());
}

function readSavingsEnrollmentSettings(ss) {
  const settings = ss.getSheetByName(ESPP_SETTINGS_TAB);
  if (!settings) return null;
  const rows = settings.getDataRange().getValues();
  if (!ESPP_SETTINGS_HEADERS.every((value, i) => rows[0]?.[i] === value)) throw new Error("Invalid ESPP Settings headers.");
  return {enrollments: rows.slice(1).filter(row => row.slice(0,4).some(value => value !== "")).map(row => row.slice(0,4))};
}

function resolvePersonalBudgetSavingsPlan(ss, monthName, includeSelected) {
  let plan = readPersonalBudgetSavingsPlan(getMonthlyTemplateSheet(ss));
  const end = MONTH_NAMES.indexOf(monthName) + (includeSelected ? 1 : 0);
  for (const name of MONTH_NAMES.slice(0, end)) {
    const sheet = ss.getSheetByName(name);
    const current = sheet && readPersonalBudgetSavingsPlan(sheet);
    if (current) plan = current;
  }
  return plan;
}

function savingsPlanDate(value) {
  if (value === "" || value === null || value === undefined) return "";
  if (value instanceof Date && !isNaN(value)) return value;
  const text=String(value);
  const us=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) || (us && [us[0],us[3],us[1],us[2]]);
  if (!match) throw new Error("Use YYYY-MM-DD for the first affected paycheck date.");
  const result = new Date(Number(match[1]), Number(match[2])-1, Number(match[3]));
  if (result.getFullYear() !== Number(match[1]) || result.getMonth()+1 !== Number(match[2]) || result.getDate() !== Number(match[3])) throw new Error("Invalid ESPP paycheck date.");
  return result;
}

function savingsEnrollmentRows(plan) {
  const enrollments = plan.enrollments || [[plan[2], plan[5] || "", plan[0], plan[1]]];
  const rows = enrollments.map(row => [savingsPlanDate(row[0]), savingsPlanDate(row[1]), String(row[2] || "").trim(), typeof row[3]==="string" && row[3].endsWith("%") ? Number(row[3].slice(0,-1))/100 : Number(row[3])]);
  if (!rows.length || rows.some(row => !row[0] || !row[2] || !Number.isFinite(row[3]) || row[3]<0 || row[3]>.2 || (row[1] && row[1]<row[0])) || new Set(rows.map(row => row[0].getTime())).size !== rows.length) throw new Error("Invalid ESPP enrollment dates, source or rate.");
  return rows;
}

function savingsEnrollmentRowsAdded(sheet, plan) {
  const inline=inlineSavingsEnrollmentLayout(sheet);
  const income=findPersonalBudgetIncomeLayout(sheet);
  if (!inline && (income.headerRow!==7 || sheet.getRange("B6:E6").getValues()[0].some(value=>value!==""))) throw new Error("Inspect space below Main Income Source before adding ESPP settings.");
  return Math.max(0,savingsEnrollmentRows(plan).length-(inline ? inline.count : 0));
}

function writeSavingsEnrollmentSettings(sheet, plan) {
  const rows=savingsEnrollmentRows(plan), inline=inlineSavingsEnrollmentLayout(sheet);
  const income=findPersonalBudgetIncomeLayout(sheet);
  const added=savingsEnrollmentRowsAdded(sheet,plan);
  if (added) sheet.insertRowsBefore(income.headerRow,added);
  const headerRow=inline ? inline.headerRow : 6;
  const count=Math.max(rows.length,inline ? inline.count : 0);
  sheet.getRange(headerRow,2,count+1,4).setValues([ESPP_SETTINGS_HEADERS,...rows,...Array.from({length:count-rows.length},()=>["","","",""])]);
  sheet.getRange(headerRow,2,1,4).setBackground("#274e13").setFontColor("#ffffff").setFontWeight("bold");
  sheet.getRange(headerRow+1,2,count,4).setBackground("#b6d7a8").setFontColor("#000000").setFontWeight("normal");
  sheet.getRange(headerRow,2,count+1,4).setFontFamily("Arial").setFontSize(10).setVerticalAlignment("middle").setWrap(true).setBorder(true,true,true,true,true,true);
  sheet.setRowHeight(headerRow,34);
  for (const column of [2,3]) sheet.getRange(headerRow+1,column,count,1).setNumberFormat("M/d/yyyy").setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
  sheet.getRange(headerRow+1,5,count,1).setNumberFormat("0.0#%").setDataValidation(SpreadsheetApp.newDataValidation().requireNumberBetween(0,.2).setAllowInvalid(false).build());
  sheet.getRange(headerRow+1,2).setNote("ESPP enrollment. Keep earlier dated rows when rates change. A new dated row supersedes the prior period. Leave Last eligible paycheck blank while enrolled. Settings carry forward to new months; prior months keep their own snapshot.");
}

/** Predict structural edits so saved income/Undo coordinates move with them. */
function personalSavingsLayoutInsertions(sheet, plan) {
  const inline=inlineSavingsEnrollmentLayout(sheet), records=savingsEnrollmentRows(plan).length;
  const layout=preflightPersonalBudgetSavingsPlan(sheet), steps=[];
  let header=inline ? inline.headerRow : 6, income=layout.income.headerRow, label=layout.label.getRow(), budget=layout.budget.getRow();
  const insert=(row,count)=>{steps.push({row,count}); if (header>=row) header+=count; if(income>=row) income+=count; if(label>=row) label+=count; if(budget>=row) budget+=count;};
  const added=savingsEnrollmentRowsAdded(sheet,plan);
  if(added) insert(income,added);
  if(header===6) insert(6,1);
  if(income-header-1<=records) insert(income,1);
  if(budget===label+1) insert(budget,1);
  return steps;
}

function spacePersonalSavingsTables(sheet) {
  let inline=inlineSavingsEnrollmentLayout(sheet);
  if(inline.headerRow===6) sheet.insertRowsBefore(6,1);
  inline=inlineSavingsEnrollmentLayout(sheet);
  let income=findPersonalBudgetIncomeLayout(sheet);
  if(sheet.getRange(income.headerRow-1,2,1,4).getValues()[0].some(value=>value!=="")) sheet.insertRowsBefore(income.headerRow,1);
  let budget=findCellContainingText(sheet,"BUDGET:"), label=findCellByExactText(sheet,ESPP_MONTHLY_LABEL) || findCellByExactText(sheet,"Monthly Income:").offset(1,0);
  if(budget.getRow()===label.getRow()+1) sheet.insertRowsBefore(budget.getRow(),1);
  inline=inlineSavingsEnrollmentLayout(sheet); income=findPersonalBudgetIncomeLayout(sheet); budget=findCellContainingText(sheet,"BUDGET:");
  for(const row of [inline.headerRow-1,income.headerRow-1,budget.getRow()-1]) {
    if(sheet.getRange(row,2,1,5).getValues()[0].some(value=>value!=="")) throw new Error("Occupied table buffer; inspect before formatting.");
    sheet.getRange(row,2,1,5).clear().setBackground("#434343").setBorder(false,false,false,false,false,false);
    sheet.setRowHeight(row,18);
  }
  sheet.getRange("B4:E5").setBorder(true,true,true,true,null,null);
  sheet.getRange(inline.headerRow,2,income.headerRow-inline.headerRow-1,4).setBorder(true,true,true,true,null,null);
  sheet.getRange(income.headerRow,2,label.getRow()-income.headerRow+1,3).setBorder(true,true,true,true,null,null);
  sheet.getRange(budget.getRow(),2,1,5).setBorder(true,null,null,null,null,null);
}

function preflightPersonalBudgetSavingsPlan(sheet) {
  const income = findPersonalBudgetIncomeLayout(sheet);
  const total = findCellByExactText(sheet, "Monthly Income:");
  const savings = findCellContainingText(sheet, "Enter Monthly Savings Contribution");
  const budget = findCellContainingText(sheet, "BUDGET:");
  const summary = findCellByExactText(sheet, "Savings & investing");
  if (!income || !income.dateColumn || !total || !savings || !budget) throw new Error(`Missing dated income, monthly savings, or Budget row on ${sheet.getName()}.`);
  if (summary && (summary.getColumn() !== 7 || !sheet.getRange(summary.getRow()+1,7,13,1).getValues().every((row,i)=>row[0]===SAVINGS_SUMMARY_LABELS[i]))) throw new Error("Incomplete savings summary; inspect before upgrading.");
  const label = findCellByExactText(sheet,ESPP_MONTHLY_LABEL) || total.offset(1,0), amount = label.offset(0,2);
  if (label.getRow() <= total.getRow() || label.getRow()>=budget.getRow() || (label.getValues()[0][0] !== "" && !String(label.getValues()[0][0]).startsWith(ESPP_MONTHLY_LABEL)) || (amount.getValues()[0][0] !== "" && !String(label.getValues()[0][0]).startsWith(ESPP_MONTHLY_LABEL))) throw new Error(`Occupied ESPP line on ${sheet.getName()}; no migration performed.`);
  const line=sheet.getRange(label.getRow(),2,1,4).getValues()[0];
  if (line.slice(1).some(value=>value!=="") && !String(line[0]).startsWith(ESPP_MONTHLY_LABEL)) throw new Error("Occupied ESPP table row.");
  return {income, total, savings, budget, summary, label, amount};
}

function writePersonalBudgetSavingsPlan(sheet, plan, explicitYear, recordedWithholding = false, explicitMonthName = null) {
  preflightPersonalBudgetSavingsPlan(sheet);
  const year = Number(explicitYear || /\b(20\d{2})\b/.exec(sheet.getParent().getName())?.[1]);
  if (!year) throw new Error("Cannot determine the budget year.");
  writeSavingsEnrollmentSettings(sheet, plan);
  spacePersonalSavingsTables(sheet);
  const {income,total,savings,budget,summary,label,amount}=preflightPersonalBudgetSavingsPlan(sheet);
  const recorded = recordedWithholding || Boolean(income.esppWithheldColumn);
  if (recorded) {
    const column = income.esppWithheldColumn || income.amountColumn + 1;
    const height = Math.max(0,total.getRow()-income.headerRow-1);
    if (!income.esppWithheldColumn && sheet.getRange(income.headerRow,column,height+1,1).getValues().some(row=>row[0]!=="")) throw new Error("Occupied ESPP withheld column; no migration performed.");
    sheet.getRange(income.headerRow,column).setValues([["ESPP withheld"]]).setBackground("#38761d").setFontColor("#ffffff").setFontWeight("bold").setFontFamily("Arial").setFontSize(10);
    if (height) sheet.getRange(income.headerRow+1,column,height,1).setBackground("#d9ead3").setFontColor("#000000").setNumberFormat("$#,##0.00")
      .setDataValidation(SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false).build())
      .setNote("Actual ESPP withheld on this paycheck's paystub. Enter 0 if confirmed none; leave blank only while unknown. Eligible payroll starts on the configured date.");
    sheet.getRange(income.headerRow,column,height+1,1).setBorder(true,true,true,true,false,false);
    income.esppWithheldColumn=column;
    const settings=inlineSavingsEnrollmentLayout(sheet);
    sheet.getRange(settings.headerRow,5).setNote("ESPP rate as a percentage of eligible gross pay. Actual deductions are recorded beside each paycheck; they are never inferred from the bank deposit.");
  }
  const legacy = sheet.getMaxColumns()>=12 && sheet.getRange("G4:L4").getValues()[0].every((value,i)=>value===SAVINGS_PLAN_HEADERS[i]);
  if (legacy) sheet.getRange("G4:L5").clear().setBackground("#434343");
  if (summary) sheet.getRange(summary.getRow(),7,14,2).clear().setBackground("#434343");
  if ((legacy || summary) && !sheet.getDataRange().getValues().some(row=>row.slice(6,12).some(value=>value!==""))) sheet.setColumnWidths(7,6,100);
  const totalRef = sheet.getRange(total.getRow(),income.amountColumn).getA1Notation();
  const headerRef = sheet.getRange(income.headerRow,income.amountColumn).getA1Notation();
  const empty = `ROW(${totalRef})<=ROW(${headerRef})+1`;
  const range = column => {
    const letter = sheet.getRange(1,column).getA1Notation().replace(/\d+$/,"");
    return `INDEX(${letter}:${letter},ROW(${headerRef})+1):INDEX(${letter}:${letter},ROW(${totalRef})-1)`;
  };
  const amounts=range(income.amountColumn), sources=range(income.sourceColumn), dates=range(income.dateColumn);
  const month=Math.max(0,MONTH_NAMES.indexOf(explicitMonthName || sheet.getName()))+1;
  const start=`DATE(${year},${month},1)`, end=`EOMONTH(${start},0)`;
  const received=`IFERROR(IF(ISNUMBER(${dates}),${dates},DATEVALUE(${dates})),0)`;
  const inline=inlineSavingsEnrollmentLayout(sheet);
  const enrollmentRange=column=>`INDEX(${column}:${column},ROW(B${inline.headerRow})+1):INDEX(${column}:${column},ROW(${headerRef})-1)`;
  const a=enrollmentRange("B"), b=enrollmentRange("C"), c=enrollmentRange("D"), d=enrollmentRange("E");
  const table=`SORT(FILTER(INDEX(B:B,ROW(B${inline.headerRow})+1):INDEX(E:E,ROW(${headerRef})-1),${a}<>""),1,TRUE)`;
  const lookup=(column,fallback)=>`IFNA(VLOOKUP(${received},${table},${column},TRUE),${fallback})`;
  const rate=lookup(4,"0"), last=lookup(2,"0");
  const normalize=value=>`LOWER(TRIM(REGEXREPLACE(${value},"[^A-Za-z0-9]+"," ")))`;
  const sourceMatches=`REGEXMATCH(${normalize(sources)},"^"&${normalize(lookup(3,'""'))}&"( (income|paycheck|payroll|salary|wages))?$")`;
  const mask=`(${sourceMatches})*(${received}>=${start})*(${received}<=${end})*((${last}=0)+(${received}<=${last}))*(IFERROR(${rate}>0,FALSE))*(${amounts}>0)`;
  const bad=`OR(COUNT(${a})=0,COUNT(${a})<>COUNTA(${a}),COUNT(${d})<>COUNT(${a}),COUNTA(${c})<>COUNT(${a}),COUNT(${b})<>COUNTA(${b}),MIN(${d})<0,MAX(${d})>0.2,SUMPRODUCT((${a}<>"")*(LEN(TRIM(${c}))=0))>0,SUMPRODUCT((${a}="")*((${b}<>"")+(${c}<>"")+(${d}<>"")))>0,SUMPRODUCT((${b}<>"")*(${b}<${a}))>0,COUNT(${a})<>IFNA(COUNTUNIQUE(FILTER(${a},${a}<>"")),0))`;
  const eligible=`IF(${empty},0,IFNA(SUM(FILTER(${amounts},${mask})),0))`;
  const withheld=recorded ? range(income.esppWithheldColumn) : null;
  const missing=recorded ? `IF(${empty},FALSE,SUMPRODUCT((${mask})*((NOT(ISNUMBER(${withheld})))+IFERROR(${withheld}<0,FALSE)))>0)` : "FALSE";
  const unexpected=recorded ? `IF(${empty},FALSE,SUMPRODUCT((1-(${mask}))*IFERROR(${withheld}>0,FALSE))>0)` : "FALSE";
  const deduction=recorded ? `IF(${empty},0,IFNA(SUM(FILTER(${withheld},${mask})),0))`
    : `IF(${empty},0,IFNA(SUM(ARRAYFORMULA(ROUND(FILTER(${amounts}*${rate}/(1-${rate}),${mask}),2))),0))`;
  const delta=`IF(${empty},0,IFNA(SUM(ARRAYFORMULA(FILTER((${amounts}+ROUND(${amounts}*${rate}/(1-${rate}),2))*(0.2-${rate})-${amounts}*0.2,${mask}))),0))`;
  const esppRef=amount.getA1Notation();
  const ideal=recorded ? `MAX(0,ROUND((${totalRef}+${esppRef})*0.2,2)-${esppRef})` : `ROUND(${totalRef}*0.2+${delta},2)`;
  const minimum=recorded ? `ROUND((${totalRef}-${eligible})*0.1+(${eligible}+${esppRef})*0.075,2)` : `ROUND((${totalRef}*0.2+${delta})/2,2)`;
  sheet.getRange(label.getRow(),2,1,4).clear();
  sheet.getRange(label.getRow(),2,1,3).setBackground("#cccccc").setFontColor("#000000").setFontWeight("bold").setFontFamily("Arial").setFontSize(10).setBorder(true,true,true,true,false,false);
  sheet.getRange(label.getRow(),5).setBackground("#434343");
  label.setValues([[ESPP_MONTHLY_LABEL]]);
  amount.setFormula(`=IF(${bad},"Check ESPP settings",IF(${eligible}>${totalRef},"Check income total",IF(${missing},"Enter ESPP withheld",IF(${unexpected},"Check ESPP date/source",${deduction}))))`).setNumberFormat("$#,##0.00").setFontColor("#000000");
  const guarded=value=>`IF(ISNUMBER(${esppRef}),${value},${esppRef})`;
  const needs=`ROUND((${totalRef}+${esppRef})*0.5,2)`;
  // Preserve currency text: existing burn-rate/margin formulas use REGEXEXTRACT.
  budget.offset(0,1).setFormula(`=${guarded(`TEXT(${needs},"$#,##0.00")`)}`);
  budget.offset(0,2).setFormula(`=${guarded(`TEXT(${totalRef}-${needs}-${ideal},"$#,##0.00")`)}`);
  budget.offset(0,3).setFormula(`=${guarded(`TEXT(${ideal},"$#,##0.00")`)}`);
  budget.offset(1,3).setValues([["Cash savings"]]).setNote(recorded ? "Cash goal = 20% of total take-home minus actual ESPP withheld. Minimum cash: 7.5% on enrolled pay and 10% on other income. Actual cash saved remains the recorded contribution." : "15% ideal / 7.5% minimum on enrolled pre-ESPP pay; unrelated income retains 20% / 10%. ESPP enrollment is below Main Income Source.");
  savings.offset(0,1).setFormula(`=${guarded(`"IDEAL = "&TEXT(${ideal},"$#,##0.00")`)}`);
  savings.offset(0,2).setFormula(`=${guarded(`"MINIMUM = "&TEXT(${minimum},"$#,##0.00")`)}`);
}

/** Explicit owner-scoped migration; never overwrites an existing enrollment schedule. */
function configureBrianESPP(firstPaycheckDate = "2026-10-23") {
  const first=savingsPlanDate(firstPaycheckDate);
  seedKnown2026ConfigIfMissing();
  const today=new Date(), config=getYearConfig(getYear(today));
  if (!config) throw new Error("No configured annual budget.");
  const ss=SpreadsheetApp.openById(config.brianBudgetId);
  const sheets=[ss.getSheetByName(getMonthName(today)),getMonthlyTemplateSheet(ss)];
  if (sheets.some(sheet=>!sheet)) throw new Error("Current month or Template is missing.");
  sheets.forEach(preflightPersonalBudgetSavingsPlan);
  const plan=readPersonalBudgetSavingsPlan(sheets[0]) || readSavingsEnrollmentSettings(ss) || ["xAI",.05,first,.15,.075,""];
  sheets.forEach(sheet=>savingsEnrollmentRowsAdded(sheet,plan));
  const references=planPersonalBudgetReferenceShifts(config,ss,"brian",getMonthName(today),personalSavingsLayoutInsertions(sheets[0],plan));
  sheets.forEach(sheet=>writePersonalBudgetSavingsPlan(sheet,plan,config.year));
  references.forEach(write=>write.range.setValue(write.value));
}

function readPersonalBudgetIncomeSettings(sheet) {
  if (hasPersonalBudgetIncomeSettings(sheet)) {
    const [source, mode, amount, anchor] = sheet.getRange("B5:E5").getValues()[0];
    return {...(source ? {source} : {}), mode: normalizeIncomeSettingLabel(mode) || "biweekly", amount, ...(anchor ? {anchor} : {})};
  }
  const values = {};
  for (const row of sheet.getDataRange().getValues()) {
    for (let column = 0; column < row.length - 1; column++) {
      const value = row[column + 1];
      if (value !== "" && value !== null && !String(value).startsWith("<")) {
        values[normalizeIncomeSettingLabel(row[column])] = value;
      }
    }
  }
  const settings = {};
  for (const [key, labels] of Object.entries(INCOME_SETTING_LABELS)) {
    const label = labels.map(normalizeIncomeSettingLabel).find(label => label in values);
    if (label !== undefined) settings[key] = values[label];
  }
  if (settings.mode !== undefined) settings.mode = normalizeIncomeSettingLabel(settings.mode);
  else if (settings.amount !== undefined) settings.mode = "fixed monthly";
  return settings;
}

function mergePersonalBudgetIncomeSettings(previous, current) {
  let result = { ...previous };
  if (current.source && normalizeIncomeSettingLabel(current.source) !== normalizeIncomeSettingLabel(previous.source)) result = {};
  return { ...result, ...current };
}

function resolvePersonalBudgetIncomeSettings(ss, monthName, includeSelected) {
  let settings = readPersonalBudgetIncomeSettings(getMonthlyTemplateSheet(ss));
  const end = MONTH_NAMES.indexOf(monthName) + (includeSelected ? 1 : 0);
  for (const name of MONTH_NAMES.slice(0, end)) {
    const sheet = ss.getSheetByName(name);
    if (sheet) settings = mergePersonalBudgetIncomeSettings(settings, readPersonalBudgetIncomeSettings(sheet));
  }
  return settings;
}

function hasPersonalBudgetIncomeSettings(sheet) {
  return sheet.getRange("B4:E4").getValues()[0].every((value, index) => value === INCOME_SETTINGS_HEADERS[index]);
}

function preparePersonalBudgetIncomeLayout(sheet) {
  if (hasPersonalBudgetIncomeSettings(sheet)) return 0;
  const layout = findPersonalBudgetIncomeLayout(sheet);
  if (!layout || layout.headerRow !== 4 || layout.dateColumn !== 2 || layout.sourceColumn !== 3 || layout.amountColumn !== 4) {
    throw new Error(`Cannot migrate ${sheet.getName()}: expected Date / Source / Amount in B4:D4.`);
  }
  const legacy = sheet.getRange("E1:F5");
  const allowed = new Set(["label", ...Object.values(INCOME_SETTING_LABELS).flat().map(normalizeIncomeSettingLabel)]);
  for (const row of legacy.getValues()) {
    if (row.some(value => value !== "") && !allowed.has(normalizeIncomeSettingLabel(row[0]))) {
      throw new Error(`Cannot migrate ${sheet.getName()}: unrelated cells are occupied in E1:F5.`);
    }
  }
  // Insert above the entire transaction section so Sheets adjusts dependent
  // formulas and merges. No settings share rows with income transactions.
  legacy.clear().clearDataValidations().clearNote();
  legacy.setBackground("#434343");
  sheet.insertRowsBefore(4, 3);
  sheet.getRange("B4:E6").clear().setBackground("#434343");
  return 3;
}

function writePersonalBudgetIncomeSettings(sheet, settings) {
  const rowsAdded = preparePersonalBudgetIncomeLayout(sheet);
  const range = sheet.getRange(INCOME_SETTINGS_RANGE);
  range.clearDataValidations();
  range.setValues([INCOME_SETTINGS_HEADERS, [settings.source ?? "", settings.mode || "biweekly", settings.amount ?? "", settings.anchor ?? ""]]);
  range.setFontFamily("Arial").setFontSize(10).setVerticalAlignment("middle").setHorizontalAlignment("left").setWrap(true);
  range.setBorder(true, true, true, true, true, true, "#000000", SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange("B4:E4").setBackground("#274e13").setFontColor("#ffffff").setFontWeight("bold");
  sheet.getRange("B5:E5").setBackground("#b6d7a8").setFontColor("#000000").setFontWeight("normal");
  sheet.setRowHeight(4, 38);
  sheet.setRowHeight(5, 28);
  sheet.setRowHeight(6, 18);
  sheet.getRange("B5:C5").setNumberFormat("@");
  sheet.getRange("C5").setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(INCOME_PROJECTION_MODES, true).setAllowInvalid(false)
    .setHelpText("Biweekly (default), fixed monthly, or off. Settings carry forward until changed.").build());
  sheet.getRange("D5").setNumberFormat("$#,##0.00").setDataValidation(SpreadsheetApp.newDataValidation()
    .requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false)
    .setHelpText("Expected take-home amount per paycheck in biweekly mode, or per month in fixed monthly mode. Blank means no estimate.").build());
  sheet.getRange("E5").setNumberFormat("M/d/yyyy").setDataValidation(SpreadsheetApp.newDataValidation()
    .requireDate().setAllowInvalid(false)
    .setHelpText("Biweekly only: this payday, then every 14 days indefinitely. Actual deposits do not shift it.").build());
  sheet.getRange("B5").setNote("Main employer/source used to identify salary entries.");
  sheet.getRange("D5").setNote("Expected take-home amount per paycheck in biweekly mode, or per month in fixed monthly mode. Actual paychecks never overwrite this expectation.");
  sheet.getRange("E5").setNote("Biweekly only: this payday, then every 14 days indefinitely. Deposits within three days fulfill the pay period, regardless of amount.");
  return rowsAdded;
}

function inheritPersonalBudgetIncomeSettings(ss, sheet, monthName) {
  const names = MONTH_NAMES.slice(0, MONTH_NAMES.indexOf(monthName)).reverse();
  const previous = names.map(name => ss.getSheetByName(name)).find(candidate => candidate && Object.keys(readPersonalBudgetIncomeSettings(candidate)).length);
  if (!previous || !hasPersonalBudgetIncomeSettings(previous)) return;
  const tab = previous.getName().replace(/'/g, "''");
  // References keep already-created future tabs in sync. Replacing a formula
  // with a value is an explicit override that later rollovers leave alone.
  const formulas = [["B", "C", "D", "E"].map(column => {
    const ref = `'${tab}'!${column}5`;
    const inherited = `IF(${ref}="","",${ref})`;
    return column === "D" || column === "E" ? `=IF($B$5='${tab}'!B5,${inherited},"")` : `=${inherited}`;
  })];
  // Sheets can defer validation errors until a later read. Commit inheritance
  // without input validators, then restore them after the formulas calculate.
  const range = sheet.getRange("B5:E5");
  const validations = range.getDataValidations();
  let writeError;
  try {
    range.clearDataValidations();
    SpreadsheetApp.flush();
    range.setFormulas(formulas);
    SpreadsheetApp.flush();
  } catch (error) {
    writeError = error;
    throw error;
  } finally {
    try {
      range.setDataValidations(validations);
      SpreadsheetApp.flush();
    } catch (validationError) {
      if (!writeError) throw validationError;
      Logger.log(`Could not restore income settings validation on ${sheet.getName()}: ${validationError}`);
    }
  }
}

function shiftedPersonalBudgetAction(action, rowsAdded, firstRow = 4) {
  if (action.worksheet !== "income" || action.metadata?.type === "system_state" || !(Number(action.row) >= firstRow)) return null;
  const updated = JSON.parse(JSON.stringify(action));
  updated.row = Number(updated.row) + rowsAdded;
  for (const key of ["source_row", "income_header_row", "income_summary_row"]) {
    if (Number(updated.metadata?.[key]) >= firstRow) updated.metadata[key] = String(Number(updated.metadata[key]) + rowsAdded);
  }
  if (firstRow === 4 && updated.kind === "restore_row" && updated.metadata?.source_type === "income") {
    const lastColumn = Number(updated.metadata.income_amount_column) || 4;
    updated.previous_values = (updated.previous_values || []).slice(0, lastColumn);
    updated.metadata.income_row_property_end_column = String(lastColumn);
    if (updated.metadata.income_row_properties) {
      const properties = JSON.parse(updated.metadata.income_row_properties);
      const firstColumn = Number(updated.metadata.income_row_property_start_column) || 2;
      properties.cells = properties.cells.slice(0, lastColumn - firstColumn + 1);
      updated.metadata.income_row_properties = JSON.stringify(properties);
    }
  }
  // Old overlapping-grid snapshots must not restore the removed settings.
  for (const key of Object.keys(updated.metadata || {})) {
    if (firstRow === 4 && key.startsWith("income_anchor_")) delete updated.metadata[key];
  }
  return updated;
}

function planPersonalBudgetReferenceShift(config, personalBook, owner, monthName, rowsAdded = 3, firstRow = 4) {
  return planPersonalBudgetReferenceShifts(config,personalBook,owner,monthName,[{row:firstRow,count:rowsAdded}]);
}

function planPersonalBudgetReferenceShifts(config, personalBook, owner, monthName, steps) {
  const actors = owner === "brian" ? ["676638528590970917", "shortcut:brian"] : ["830984827904851969", "shortcut:hannah"];
  const shared = SpreadsheetApp.openById(config.sharedExpensesId);
  const monthNumber = MONTH_NAMES.indexOf(monthName) + 1;
  const log = shared.getSheetByName(`_BookieBot Action Log - ${config.year}-${String(monthNumber).padStart(2, "0")}`);
  const writes = [];
  if (log) {
    log.getDataRange().getValues().slice(1).forEach((row, index) => {
      if (!actors.includes(String(row[2])) || !row[5]) return;
      const original=JSON.parse(row[5]); let updated=original;
      steps.forEach(step=>{updated=shiftedPersonalBudgetAction(updated,step.count,step.row) || updated;});
      if (JSON.stringify(updated)!==JSON.stringify(original)) writes.push({range: log.getRange(index + 2, 6), value: JSON.stringify(updated)});
    });
  }
  const ledger = personalBook.getSheetByName("Shared Reimbursements");
  if (ledger) {
    const rows = ledger.getDataRange().getValues();
    const column = name => rows[0].indexOf(name);
    rows.slice(1).forEach((row, index) => {
      const date = new Date(row[column("expense_date")]);
      if (row[column("source_worksheet")] === "income" && date.getFullYear() === config.year && date.getMonth() + 1 === monthNumber) {
        const original=Number(row[column("source_row")]); let value=original;
        steps.forEach(step=>{if(value>=step.row) value+=step.count;});
        if(value!==original) writes.push({range: ledger.getRange(index + 2, column("source_row") + 1), value});
      }
    });
  }
  return writes;
}

/** Migrate only the current month and internal Template in both annual budgets. */
function upgradeCurrentIncomeSettings() {
  seedKnown2026ConfigIfMissing();
  const today = new Date();
  const config = getYearConfig(getYear(today));
  if (!config) throw new Error("Current-year budget configuration is missing.");
  for (const owner of ["brian", "hannah"]) {
    const ss = SpreadsheetApp.openById(config[`${owner}BudgetId`]);
    const monthName = getMonthName(today);
    const settings = resolvePersonalBudgetIncomeSettings(ss, monthName, true);
    const sheet = ss.getSheetByName(monthName);
    const references = sheet && !hasPersonalBudgetIncomeSettings(sheet) ? planPersonalBudgetReferenceShift(config, ss, owner, monthName) : [];
    if (sheet) writePersonalBudgetIncomeSettings(sheet, settings);
    for (const write of references) write.range.setValue(write.value);
    writePersonalBudgetIncomeSettings(getMonthlyTemplateSheet(ss), settings);
  }
}

function getMonthlyTemplateSheet(ss) {
  for (let i = 0; i < MONTH_TEMPLATE_SHEET_NAMES.length; i++) {
    const templateSheet = ss.getSheetByName(MONTH_TEMPLATE_SHEET_NAMES[i]);

    if (templateSheet) {
      return templateSheet;
    }
  }

  throw new Error(
    `Could not find a monthly template tab. Expected one of: ${MONTH_TEMPLATE_SHEET_NAMES.join(", ")}`,
  );
}

function setMonthLabel(sheet, monthName) {
  const monthLabelCell =
    findCellByExactText(sheet, MONTH_LABEL_PLACEHOLDER) ||
    findCellByAnyExactTextInTopLeft(sheet, MONTH_NAMES);

  if (!monthLabelCell) {
    Logger.log(
      `Could not find month label placeholder "${MONTH_LABEL_PLACEHOLDER}" or an existing month label on template copy "${sheet.getName()}"; leaving copied sheet label unchanged.`,
    );
    return false;
  }

  monthLabelCell.setValue(monthName);
  return true;
}

function ensureMonthLabel(sheet, monthName) {
  if (findCellByAnyExactTextInTopLeft(sheet, [monthName])) {
    return true;
  }

  return setMonthLabel(sheet, monthName);
}

/***********************
 * IMPORTRANGE RELINKING
 ***********************/

function relinkAllPersonalBudgetSheetsForYear(
  personalBudgetSpreadsheetId,
  sharedExpensesSpreadsheetId,
  budgetOwnerKey,
) {
  const ss = SpreadsheetApp.openById(personalBudgetSpreadsheetId);
  const sheets = ss.getSheets();

  sheets.forEach(function (sheet) {
    const sheetName = sheet.getName();

    if (MONTH_NAMES.includes(sheetName)) {
      updatePersonalBudgetImportRanges(
        sheet,
        sharedExpensesSpreadsheetId,
        sheetName,
        budgetOwnerKey,
      );
    }
  });
}

function updatePersonalBudgetImportRanges(
  sheet,
  sharedExpensesSpreadsheetId,
  monthName,
  budgetOwnerKey,
) {
  const sharedExpensesUrl = buildSpreadsheetUrl(sharedExpensesSpreadsheetId);
  const rules = personalBudgetImportRules(sharedExpensesSpreadsheetId, monthName, budgetOwnerKey);

  if (!rules) {
    throw new Error(
      `No import rules found for budget owner: ${budgetOwnerKey}`,
    );
  }

  rules.forEach(function (rule) {
    const labelRange = findCellByExactText(sheet, rule.label);

    if (!labelRange) {
      throw new Error(
        `Could not find label "${rule.label}" on sheet "${sheet.getName()}".`,
      );
    }

    const targetRow = labelRange.getRow();
    const targetColumn =
      labelRange.getColumn() + rule.targetColumnOffsetFromLabel;

    const targetRange = sheet.getRange(targetRow, targetColumn);
    const sourceRange = buildSheetRangeReference(
      monthName,
      rule.sharedExpenseCell,
    );

    const formula = `=IMPORTRANGE("${sharedExpensesUrl}", "${sourceRange}")`;

    targetRange.setFormula(formula);
  });
}

function findCellByExactText(sheet, searchText) {
  const finder = sheet
    .createTextFinder(searchText)
    .matchEntireCell(true)
    .matchCase(false);

  return finder.findNext();
}

function findCellByAnyExactTextInTopLeft(sheet, searchTexts) {
  const rowCount = Math.min(MONTH_LABEL_SEARCH_ROWS, sheet.getMaxRows());
  const columnCount = Math.min(
    MONTH_LABEL_SEARCH_COLUMNS,
    sheet.getMaxColumns(),
  );
  const searchRange = sheet.getRange(1, 1, rowCount, columnCount);

  for (let i = 0; i < searchTexts.length; i++) {
    const finder = searchRange
      .createTextFinder(searchTexts[i])
      .matchEntireCell(true)
      .matchCase(false);
    const cell = finder.findNext();

    if (cell) {
      return cell;
    }
  }

  return null;
}

function findCellContainingText(sheet, searchText) {
  const finder = sheet
    .createTextFinder(searchText)
    .matchEntireCell(false)
    .matchCase(false);

  return finder.findNext();
}

function buildSpreadsheetUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

function buildSheetRangeReference(sheetName, cellRef) {
  const escapedSheetName = sheetName.replace(/'/g, "''");
  return `'${escapedSheetName}'!${cellRef}`;
}

/***********************
 * EDIT DATE STAMPING
 ***********************/

/**
 * Personal budget Income date stamping.
 *
 * The handler discovers Date / Source (or Employer) / Amount from the
 * visible Income header row. When an income entry is completed, its Date
 * is stamped and the Monthly Income formula is repaired. The template's
 * seed row is consumed once; this handler does not append blank rows.
 */
function handlePersonalBudgetEdit(e) {
  if (!e || !e.range || !e.source) {
    return;
  }

  const editedSpreadsheetId = e.source.getId();
  const editedSheet = e.range.getSheet();

  if (!MONTH_NAMES.includes(editedSheet.getName())) {
    return;
  }

  if (!isKnownPersonalBudgetSpreadsheet(editedSpreadsheetId)) {
    return;
  }

  const incomeLayout = findPersonalBudgetIncomeLayout(editedSheet);

  if (!incomeLayout || !incomeLayout.dateColumn) {
    return;
  }

  const editedStartColumn = e.range.getColumn();
  const editedEndColumn = editedStartColumn + e.range.getNumColumns() - 1;

  const editTouchesAmount =
    incomeLayout.amountColumn >= editedStartColumn &&
    incomeLayout.amountColumn <= editedEndColumn;
  const editTouchesSource =
    incomeLayout.sourceColumn >= editedStartColumn &&
    incomeLayout.sourceColumn <= editedEndColumn;

  if (!editTouchesAmount && !editTouchesSource) {
    return;
  }

  const monthlyIncomeCell = findCellByExactText(editedSheet, "Monthly Income:");
  const firstIncomeRow = incomeLayout.headerRow + 1;
  const lastIncomeRow = monthlyIncomeCell
    ? monthlyIncomeCell.getRow() - 1
    : editedSheet.getMaxRows();
  const editedStartRow = Math.max(e.range.getRow(), firstIncomeRow);
  const editedEndRow = Math.min(
    e.range.getRow() + e.range.getNumRows() - 1,
    lastIncomeRow,
  );

  for (let row = editedStartRow; row <= editedEndRow; row++) {
    const amountCell = editedSheet.getRange(row, incomeLayout.amountColumn);
    const amount = amountCell.getValue();

    if (!hasPersonalBudgetIncomeAmount(amount)) {
      continue;
    }

    const dateCell = editedSheet.getRange(row, incomeLayout.dateColumn);

    if (dateCell.getValue() === "") {
      dateCell.setValue(new Date()).setNumberFormat("M/d/yyyy");
    }

    const source = editedSheet
      .getRange(row, incomeLayout.sourceColumn)
      .getValue();

    if (!isCompletedPersonalBudgetIncomeSource(source)) {
      continue;
    }

    repairPersonalBudgetIncomeSummaryFormula(editedSheet, incomeLayout);
  }
}

function hasPersonalBudgetIncomeAmount(value) {
  if (value === "" || value === null) {
    return false;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = String(value).replace(/[$,]/g, "").trim();
  const numericValue = Number(normalized);

  return normalized !== "" && !Number.isNaN(numericValue) && numericValue !== 0;
}

function isCompletedPersonalBudgetIncomeSource(value) {
  const normalized = String(value || "").trim().toLowerCase();

  return (
    normalized !== "" &&
    normalized !== "<enter source>" &&
    normalized !== "<enter employer>"
  );
}

function repairPersonalBudgetIncomeSummaryFormula(sheet, incomeLayout) {
  const monthlyIncomeCell = findCellByExactText(sheet, "Monthly Income:");

  if (!monthlyIncomeCell) {
    return false;
  }

  const firstIncomeRow = incomeLayout.headerRow + 1;
  const lastIncomeRow = monthlyIncomeCell.getRow() - 1;
  const incomeAmountRange = sheet
    .getRange(
      firstIncomeRow,
      incomeLayout.amountColumn,
      lastIncomeRow - firstIncomeRow + 1,
      1,
    )
    .getA1Notation();

  sheet
    .getRange(monthlyIncomeCell.getRow(), incomeLayout.amountColumn)
    .setFormula(`=SUM(${incomeAmountRange})`);

  return true;
}

function findPersonalBudgetIncomeLayout(sheet) {
  const rowCount = Math.min(
    PERSONAL_BUDGET_INCOME_HEADER_SCAN_ROWS,
    sheet.getMaxRows(),
  );
  const columnCount = Math.min(
    PERSONAL_BUDGET_INCOME_HEADER_SCAN_COLUMNS,
    sheet.getMaxColumns(),
  );
  const values = sheet.getRange(1, 1, rowCount, columnCount).getValues();

  for (let rowIndex = 0; rowIndex < values.length; rowIndex++) {
    let dateColumn = null;
    let sourceColumn = null;
    let amountColumn = null;
    let esppWithheldColumn = null;
    for (let columnIndex = 0; columnIndex < values[rowIndex].length; columnIndex++) {
      const normalized = String(values[rowIndex][columnIndex] || "")
        .trim()
        .replace(/:\s*$/, "")
        .trim()
        .toLowerCase();

      if (normalized === "date") {
        dateColumn = columnIndex + 1;
      } else if (normalized === "source" || normalized === "employer") {
        sourceColumn = columnIndex + 1;
      } else if (normalized === "amount") {
        amountColumn = columnIndex + 1;
      } else if (normalized === "espp withheld") {
        esppWithheldColumn = columnIndex + 1;
      }
    }

    if (sourceColumn && amountColumn) {
      return {
        headerRow: rowIndex + 1,
        dateColumn: dateColumn,
        sourceColumn: sourceColumn,
        amountColumn: amountColumn,
        ...(esppWithheldColumn ? {esppWithheldColumn} : {}),
      };
    }
  }

  return null;
}

function isKnownPersonalBudgetSpreadsheet(spreadsheetId) {
  const props = PropertiesService.getScriptProperties().getProperties();

  for (const key in props) {
    if (!key.startsWith("YEAR_CONFIG_")) {
      continue;
    }

    const config = JSON.parse(props[key]);

    if (
      config.brianBudgetId === spreadsheetId ||
      config.hannahBudgetId === spreadsheetId
    ) {
      return true;
    }
  }

  return (
    spreadsheetId === KNOWN_2026_FILES.brianBudgetId ||
    spreadsheetId === KNOWN_2026_FILES.hannahBudgetId
  );
}

/***********************
 * SHARED EXPENSES EDIT DATE STAMPING
 ***********************/

/**
 * This replaces the old sheet-bound onEdit(e).
 *
 * It should be called by an installable on-edit trigger created by:
 *
 * installCurrentYearSharedExpensesEditTrigger()
 */
function handleSharedExpensesEdit(e) {
  if (!e || !e.range || !e.source) {
    return;
  }

  const editedSpreadsheetId = e.source.getId();
  const editedSheet = e.range.getSheet();
  const editedCol = e.range.getColumn();
  const editedRow = e.range.getRow();

  /**
   * Only run on normal month tabs.
   */
  if (!MONTH_NAMES.includes(editedSheet.getName())) {
    return;
  }

  /**
   * Only run below the header row.
   */
  if (editedRow <= 2) {
    return;
  }

  /**
   * Only run for configured amount columns.
   */
  /**
   * Make sure this spreadsheet is one of our known yearly Shared Expenses files.
   */
  if (!isKnownSharedExpensesSpreadsheet(editedSpreadsheetId)) {
    return;
  }

  const shift = sharedExpenseColumnShift(editedSheet);
  const dateColumns = Object.fromEntries(Object.entries(SHARED_EXPENSES_DATE_COLUMN_MAP).map(([amount, date]) => [Number(amount) + (Number(amount) >= 10 ? shift : 0), date + (date >= 10 ? shift : 0)]));
  if (!(editedCol in dateColumns)) return;
  const dateCol = dateColumns[editedCol];
  const dateCell = editedSheet.getRange(editedRow, dateCol);

  /**
   * Only stamp if empty.
   */
  if (dateCell.getValue() === "") {
    dateCell.setValue(new Date());
  }
}

function isKnownSharedExpensesSpreadsheet(spreadsheetId) {
  const props = PropertiesService.getScriptProperties().getProperties();

  for (const key in props) {
    if (!key.startsWith("YEAR_CONFIG_")) {
      continue;
    }

    const config = JSON.parse(props[key]);

    if (config.sharedExpensesId === spreadsheetId) {
      return true;
    }
  }

  /**
   * Also allow the known 2026 file before Script Properties are seeded.
   */
  return spreadsheetId === KNOWN_2026_FILES.sharedExpensesId;
}

/**
 * Run this once after installing the global automation script.
 *
 * This installs an on-edit trigger for the current year's Shared Expenses file.
 */
function installCurrentYearSharedExpensesEditTrigger() {
  seedKnown2026ConfigIfMissing();

  const today = new Date();
  const currentYear = getYear(today);

  installSharedExpensesEditTriggerForYear(currentYear);
}

/**
 * Installs all edit triggers needed by the current year's budget files.
 */
function installCurrentYearBudgetEditTriggers() {
  seedKnown2026ConfigIfMissing();

  const today = new Date();
  const currentYear = getYear(today);
  const yearConfig = getOrCreateYearFiles(currentYear);

  installBudgetEditTriggersForYearConfig(yearConfig, currentYear);
}

function installBudgetEditTriggersForYearConfig(yearConfig, year) {
  installSharedExpensesEditTriggerForSpreadsheet(
    yearConfig.sharedExpensesId,
    year,
  );
  installPersonalBudgetEditTriggerForSpreadsheet(
    yearConfig.brianBudgetId,
    year,
    "Brian",
  );
  installPersonalBudgetEditTriggerForSpreadsheet(
    yearConfig.hannahBudgetId,
    year,
    "Hannah",
  );
}

/**
 * Installs an edit trigger for a specific year's Shared Expenses spreadsheet.
 *
 * Example:
 * installSharedExpensesEditTriggerForYear(2026)
 */
function installSharedExpensesEditTriggerForYear(year) {
  const yearConfig = getOrCreateYearFiles(year);

  installSharedExpensesEditTriggerForSpreadsheet(
    yearConfig.sharedExpensesId,
    year,
  );
}

/**
 * Installs an edit trigger directly for a specific Shared Expenses file.
 */
function installSharedExpensesEditTriggerForSpreadsheet(
  sharedExpensesSpreadsheetId,
  year,
) {
  removeSharedExpensesEditTriggersForSpreadsheet(sharedExpensesSpreadsheetId);

  ScriptApp.newTrigger("handleSharedExpensesEdit")
    .forSpreadsheet(sharedExpensesSpreadsheetId)
    .onEdit()
    .create();

  Logger.log(
    `Installed Shared Expenses on-edit trigger for ${year}: ${sharedExpensesSpreadsheetId}`,
  );
}

function installPersonalBudgetEditTriggerForSpreadsheet(
  personalBudgetSpreadsheetId,
  year,
  ownerName,
) {
  removePersonalBudgetEditTriggersForSpreadsheet(personalBudgetSpreadsheetId);

  ScriptApp.newTrigger("handlePersonalBudgetEdit")
    .forSpreadsheet(personalBudgetSpreadsheetId)
    .onEdit()
    .create();

  Logger.log(
    `Installed ${ownerName} personal-budget on-edit trigger for ${year}: ${personalBudgetSpreadsheetId}`,
  );
}

/**
 * Removes duplicate handleSharedExpensesEdit triggers for the same spreadsheet.
 */
function removeSharedExpensesEditTriggersForSpreadsheet(
  sharedExpensesSpreadsheetId,
) {
  removeEditTriggersForSpreadsheet(
    "handleSharedExpensesEdit",
    sharedExpensesSpreadsheetId,
  );
}

function removePersonalBudgetEditTriggersForSpreadsheet(
  personalBudgetSpreadsheetId,
) {
  removeEditTriggersForSpreadsheet(
    "handlePersonalBudgetEdit",
    personalBudgetSpreadsheetId,
  );
}

function removeEditTriggersForSpreadsheet(
  handlerFunctionName,
  spreadsheetId,
) {
  const triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(function (trigger) {
    const handlerFunction = trigger.getHandlerFunction();

    if (handlerFunction !== handlerFunctionName) {
      return;
    }

    let triggerSourceId = null;

    try {
      triggerSourceId = trigger.getTriggerSourceId();
    } catch (err) {
      triggerSourceId = null;
    }

    /**
     * If we can identify the source, only remove matching duplicates.
     * If Apps Script cannot provide the source ID, remove the trigger
     * defensively to avoid duplicate date-stamping triggers.
     */
    if (!triggerSourceId || triggerSourceId === spreadsheetId) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

/***********************
 * DATE HELPERS
 ***********************/

function getYear(date) {
  return Number(
    Utilities.formatDate(date, BUDGET_TIME_ZONE, "yyyy"),
  );
}

function getMonthName(date) {
  return Utilities.formatDate(date, BUDGET_TIME_ZONE, "MMMM");
}

function getPreviousMonthDate(date) {
  const period = budgetMonthPeriod(date, -1);
  return new Date(Date.UTC(period.year, period.month - 1, 1, 12));
}
