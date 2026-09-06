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
  seedKnown2026ConfigIfMissing();

  const today = new Date();
  const year = getYear(today);
  const monthName = getMonthName(today);

  snapshotPreviousMonthPersonalBudgetOutputs(today);

  const yearConfig = getOrCreateYearFiles(year);

  ensureMonthExistsInSharedExpenses(yearConfig.sharedExpensesId, monthName);

  ensureMonthExistsInPersonalBudget(
    yearConfig.brianBudgetId,
    yearConfig.sharedExpensesId,
    monthName,
    "brian",
  );

  ensureMonthExistsInPersonalBudget(
    yearConfig.hannahBudgetId,
    yearConfig.sharedExpensesId,
    monthName,
    "hannah",
  );
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
  seedKnown2026ConfigIfMissing();
  snapshotPreviousMonthPersonalBudgetOutputs(new Date());
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
    if (snapshotPersonalBudgetFormulaOutput(sheet, rule)) {
      snapshotCount += 1;
    }
  });

  Logger.log(
    `Snapshotted ${snapshotCount} formula output cells on ${ownerName} ${monthName}.`,
  );

  return snapshotCount;
}

function snapshotPersonalBudgetFormulaOutput(sheet, rule) {
  const labelCell =
    rule.searchMode === "contains"
      ? findCellContainingText(sheet, rule.label)
      : findCellByExactText(sheet, rule.label);

  if (!labelCell) {
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
  const budgetRootFolder = DriveApp.getFolderById(BUDGET_SYSTEM_FOLDER_ID);
  const yearFolder = getOrCreateChildFolder(budgetRootFolder, String(year));

  const brianBudgetFile = DriveApp.getFileById(
    TEMPLATE_IDS.brianBudget,
  ).makeCopy(`Brian Budget ${year}`, yearFolder);

  const hannahBudgetFile = DriveApp.getFileById(
    TEMPLATE_IDS.hannahBudget,
  ).makeCopy(`Hannah Budget ${year}`, yearFolder);

  const sharedExpensesFile = DriveApp.getFileById(
    TEMPLATE_IDS.sharedExpenses,
  ).makeCopy(`Shared Expenses ${year}`, yearFolder);

  const config = {
    year: year,
    brianBudgetId: brianBudgetFile.getId(),
    hannahBudgetId: hannahBudgetFile.getId(),
    sharedExpensesId: sharedExpensesFile.getId(),
  };

  initializeNewYearFiles(config);

  installBudgetEditTriggersForYearConfig(config, year);

  return config;
}

function initializeNewYearFiles(config) {
  const previousConfig = getYearConfig(config.year - 1);
  for (const key of ["brianBudgetId", "hannahBudgetId"]) {
    const ss = SpreadsheetApp.openById(config[key]);
    const settings = previousConfig
      ? resolvePersonalBudgetIncomeSettings(SpreadsheetApp.openById(previousConfig[key]), "December", true)
      : readPersonalBudgetIncomeSettings(getMonthlyTemplateSheet(ss));
    writePersonalBudgetIncomeSettings(getMonthlyTemplateSheet(ss), settings);
  }
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
  sheet.getRange("B5:E5").setFormulas([["B", "C", "D", "E"].map(column => {
    const ref = `'${tab}'!${column}5`;
    const inherited = `IF(${ref}="","",${ref})`;
    return column === "D" || column === "E" ? `=IF($B$5='${tab}'!B5,${inherited},"")` : `=${inherited}`;
  })]);
}

function shiftedPersonalBudgetAction(action, rowsAdded) {
  if (action.worksheet !== "income" || !(Number(action.row) >= 4)) return null;
  const updated = JSON.parse(JSON.stringify(action));
  updated.row = Number(updated.row) + rowsAdded;
  for (const key of ["income_header_row", "income_summary_row"]) {
    if (Number(updated.metadata?.[key]) >= 4) updated.metadata[key] = String(Number(updated.metadata[key]) + rowsAdded);
  }
  if (updated.kind === "restore_row" && updated.metadata?.source_type === "income") {
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
    if (key.startsWith("income_anchor_")) delete updated.metadata[key];
  }
  return updated;
}

function planPersonalBudgetReferenceShift(config, personalBook, owner, monthName) {
  const actors = owner === "brian" ? ["676638528590970917", "shortcut:brian"] : ["830984827904851969", "shortcut:hannah"];
  const shared = SpreadsheetApp.openById(config.sharedExpensesId);
  const monthNumber = MONTH_NAMES.indexOf(monthName) + 1;
  const log = shared.getSheetByName(`_BookieBot Action Log - ${config.year}-${String(monthNumber).padStart(2, "0")}`);
  const writes = [];
  if (log) {
    log.getDataRange().getValues().slice(1).forEach((row, index) => {
      if (!actors.includes(String(row[2])) || !row[5]) return;
      const updated = shiftedPersonalBudgetAction(JSON.parse(row[5]), 3);
      if (updated) writes.push({range: log.getRange(index + 2, 6), value: JSON.stringify(updated)});
    });
  }
  const ledger = personalBook.getSheetByName("Shared Reimbursements");
  if (ledger) {
    const rows = ledger.getDataRange().getValues();
    const column = name => rows[0].indexOf(name);
    rows.slice(1).forEach((row, index) => {
      const date = new Date(row[column("expense_date")]);
      if (row[column("source_worksheet")] === "income" && date.getFullYear() === config.year && date.getMonth() + 1 === monthNumber && Number(row[column("source_row")]) >= 4) {
        writes.push({range: ledger.getRange(index + 2, column("source_row") + 1), value: Number(row[column("source_row")]) + 3});
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
  const rules = PERSONAL_BUDGET_IMPORT_RULES[budgetOwnerKey];

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
      }
    }

    if (sourceColumn && amountColumn) {
      return {
        headerRow: rowIndex + 1,
        dateColumn: dateColumn,
        sourceColumn: sourceColumn,
        amountColumn: amountColumn,
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
  if (editedRow <= 1) {
    return;
  }

  /**
   * Only run for configured amount columns.
   */
  if (!(editedCol in SHARED_EXPENSES_DATE_COLUMN_MAP)) {
    return;
  }

  /**
   * Make sure this spreadsheet is one of our known yearly Shared Expenses files.
   */
  if (!isKnownSharedExpensesSpreadsheet(editedSpreadsheetId)) {
    return;
  }

  const dateCol = SHARED_EXPENSES_DATE_COLUMN_MAP[editedCol];
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
    Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy"),
  );
}

function getMonthName(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "MMMM");
}

function getPreviousMonthDate(date) {
  return new Date(date.getFullYear(), date.getMonth() - 1, 1);
}
