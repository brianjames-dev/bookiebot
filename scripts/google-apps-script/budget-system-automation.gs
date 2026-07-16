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
 * - Shared Expenses date-stamping is handled by a global installable
 *   edit trigger instead of a sheet-bound onEdit(e).
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
 * - Installs the Shared Expenses edit trigger for the current year
 */
function setupBudgetSystemAutomation() {
  seedKnown2026ConfigIfMissing();
  budgetSystemRollover();
  relinkCurrentYearPersonalBudgetFormulas();
  installCurrentYearSharedExpensesEditTrigger();

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

  /**
   * Install the Shared Expenses edit trigger for the new yearly
   * Shared Expenses file.
   */
  installSharedExpensesEditTriggerForSpreadsheet(config.sharedExpensesId, year);

  return config;
}

function initializeNewYearFiles(config) {
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
  sheet = createMonthSheet(ss, monthName);

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

/**
 * Removes duplicate handleSharedExpensesEdit triggers for the same spreadsheet.
 */
function removeSharedExpensesEditTriggersForSpreadsheet(
  sharedExpensesSpreadsheetId,
) {
  const triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(function (trigger) {
    const handlerFunction = trigger.getHandlerFunction();

    if (handlerFunction !== "handleSharedExpensesEdit") {
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
    if (!triggerSourceId || triggerSourceId === sharedExpensesSpreadsheetId) {
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
