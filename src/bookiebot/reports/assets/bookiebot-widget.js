// BookieBot Home Screen widget · v1.5
// Download this script from your own BookieBot Settings → Widgets.
// Credentials belong in Scriptable Keychain, never in this file or a widget parameter.
const BOOKIEBOT_ORIGIN = "__BOOKIEBOT_ORIGIN__";

const BB = {
  background: new Color("17201C"), text: new Color("F0EDE5"),
  muted: new Color("AAAFA5"), sage: new Color("B4D5C1"), warning: new Color("DAA383"),
  panel: new Color("AECABA"), ink: new Color("183127"), negativeInk: new Color("78351F"),
};
const files = FileManager.local();
const scope = encodeURIComponent(BOOKIEBOT_ORIGIN) + "." + encodeURIComponent(Script.name());
const profileKey = "bookiebot.widget.v1." + scope;
const themeKey = "bookiebot.widget.theme.v1." + scope;
const selectionKey = "bookiebot.widget.selection.v1." + scope;
const cacheRoot = files.joinPath(files.cacheDirectory(), "bookiebot-widget-" + scope);

function normalizedTheme(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (name === "editorial" || name === "a") return "editorial";
  if (name === "two-tone" || name === "two tone" || name === "c") return "two-tone";
  return null;
}
function preferredTheme() {
  try { return normalizedTheme(Keychain.get(themeKey)) || "editorial"; } catch (_) { return "editorial"; }
}
const widgetTypes = ["budget", "upcoming", "savings", "categories", "shared"];
const widgetNames = { budget: "Budget", upcoming: "Upcoming payments", savings: "Savings goal", categories: "Category budgets", shared: "Shared balance" };
function widgetSelection() {
  const fallback = { type: "budget", theme: preferredTheme(), goalId: null };
  const parameter = typeof args === "undefined" ? null : args.widgetParameter;
  if (parameter == null || parameter === "") return fallback;
  if (typeof parameter !== "string" || parameter.length > 160) return { ...fallback, invalid: true };
  const legacy = normalizedTheme(parameter);
  if (legacy) return { ...fallback, theme: legacy };
  const parts = parameter.split(";").map((part) => part.trim());
  const type = parts.shift();
  if (!widgetTypes.includes(type)) return { ...fallback, invalid: true };
  let theme = fallback.theme, goalId = null;
  if (parts.length && !parts[0].startsWith("goal=")) {
    const candidate = normalizedTheme(parts.shift());
    if (!candidate) return { ...fallback, invalid: true };
    theme = candidate;
  }
  if (parts.length) {
    const goal = parts.shift();
    if (type !== "savings" || !goal.startsWith("goal=") || !isGoalId(goal.slice(5))) return { ...fallback, invalid: true };
    goalId = goal.slice(5);
  }
  return parts.length ? { ...fallback, invalid: true } : { type, theme, goalId };
}
function preferredSelection(current, family = "medium") {
  try {
    const value = JSON.parse(Keychain.get(selectionKey));
    if (value.connectionId === current.connectionId && widgetTypes.includes(value.type) &&
      normalizedTheme(value.theme) && ["small", "medium"].includes(value.family) &&
      (value.goalId === null || (value.type === "savings" && isGoalId(value.goalId)))) return value;
  } catch (_) {}
  return { type: "budget", theme: preferredTheme(), goalId: null, family };
}
function selectionParameter(selection) {
  return selection.type + ";" + selection.theme + (selection.goalId ? ";goal=" + selection.goalId : "");
}
async function chooseWidgetPreview(current) {
  const menu = new Alert(); menu.title = "Widget & preview";
  menu.message = "Preview a widget here. Each Home Screen widget uses its own Parameter from BookieBot Settings → Widgets.";
  widgetTypes.forEach((type) => menu.addAction(widgetNames[type])); menu.addCancelAction("Cancel");
  const selected = await menu.presentSheet();
  if (selected < 0) return null;
  const type = widgetTypes[selected];
  let goalId = null;
  if (type === "savings") {
    const result = await snapshot(current, { type, goalId: null });
    if (!result.data || !result.data.content.goals.length) {
      const alert = new Alert();
      alert.title = result.state === "reconnect" ? "Reconnect widget" : result.data ? "No savings goals" : "Goals unavailable";
      alert.message = result.state === "reconnect" ? "Run this script again to pair." : result.data ? "Add a goal in BookieBot Savings, then return here." : "Try again when BookieBot can load your goals.";
      alert.addAction("OK"); await alert.presentAlert(); return null;
    }
    const goals = new Alert(); goals.title = "Choose a savings goal";
    result.data.content.goals.forEach((goal) => goals.addAction(goal.name)); goals.addCancelAction("Cancel");
    const goal = await goals.presentSheet();
    if (goal < 0) return null;
    goalId = result.data.content.goals[goal].id;
  }
  const themeMenu = new Alert(); themeMenu.title = "Widget theme";
  themeMenu.addAction("Editorial"); themeMenu.addAction("Two-tone"); themeMenu.addCancelAction("Cancel");
  const choice = await themeMenu.presentSheet();
  if (choice < 0) return null;
  const theme = choice === 1 ? "two-tone" : "editorial";
  const sizeMenu = new Alert(); sizeMenu.title = "Preview size";
  sizeMenu.addAction("Small"); sizeMenu.addAction("Medium"); sizeMenu.addCancelAction("Cancel");
  const size = await sizeMenu.presentSheet();
  if (size < 0) return null;
  const selection = { connectionId: current.connectionId, type, goalId, theme, family: size === 0 ? "small" : "medium" };
  try {
    const saved = JSON.stringify(selection);
    Keychain.set(selectionKey, saved); Keychain.set(themeKey, theme);
    if (Keychain.get(selectionKey) !== saved || Keychain.get(themeKey) !== theme) throw new Error("Preference was not saved");
  } catch (_) {
    const alert = new Alert(); alert.title = "Preview only";
    alert.message = "The preview choice couldn't be saved. Your pairing is unchanged. You can set this Home Screen widget's Parameter to " + selectionParameter(selection) + ".";
    alert.addAction("Show preview"); await alert.presentAlert();
  }
  return selection;
}
function trustedOrigin() {
  return /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(BOOKIEBOT_ORIGIN);
}
function isMode(value) { return value === "current" || value === "projected"; }
function isId(value) { return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value); }
function isGoalId(value) { return typeof value === "string" && /^[a-f0-9]{32}$/.test(value); }
function isLabel(value) { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value); }
function isName(value) { return typeof value === "string" && value.length > 0 && value.length <= 80 && !/[\u0000-\u001f]/.test(value); }
function isDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
}
function isoTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value));
}
function moneyNumber(value) { return value === null || (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12); }
function validProfile(value) {
  return value && value.origin === BOOKIEBOT_ORIGIN && typeof value.token === "string" && /^bbw_read_[A-Za-z0-9_-]{43}$/.test(value.token) &&
    isId(value.connectionId) && isName(value.ownerName) && isMode(value.mode) && isoTime(value.expiresAt);
}
function clearScopeCache() {
  try { if (files.fileExists(cacheRoot)) files.remove(cacheRoot); } catch (_) {}
}
function profile() {
  let raw;
  try { raw = Keychain.get(profileKey); } catch (_) {
    // Another execution context may have forgotten/revoked this shared Keychain profile.
    try { if (!Keychain.contains(profileKey)) clearScopeCache(); } catch (_) {}
    return null;
  }
  try { const value = JSON.parse(raw); if (validProfile(value)) return value; } catch (_) {}
  // A locked Keychain read above does not destroy a valid pairing. A readable malformed
  // profile does: its old cache cannot safely be associated with a known connection.
  clearScopeCache();
  try { if (Keychain.contains(profileKey)) Keychain.remove(profileKey); } catch (_) {}
  return null;
}
function removeCache(connection) {
  if (!isId(connection)) return;
  try {
    for (const name of files.listContents(cacheRoot)) {
      if (name.startsWith(connection + ".")) files.remove(files.joinPath(cacheRoot, name));
    }
  } catch (_) {}
}
function forget(current) {
  removeCache(current && current.connectionId);
  if (Keychain.contains(profileKey)) Keychain.remove(profileKey);
}
function pathFor(current, suffix) { return files.joinPath(cacheRoot, current.connectionId + suffix); }
function snapshotPath(current, selection) {
  return pathFor(current, selection.type === "budget" ? ".json" : "." + selection.type + (selection.goalId ? ".goal-" + selection.goalId : ".auto") + ".json");
}
function dataPath(selection) {
  return "/app/widgets/data" + (selection.type === "budget" ? "" : "/" + selection.type) +
    (selection.type === "savings" && selection.goalId ? "?goalId=" + encodeURIComponent(selection.goalId) : "");
}
function validEnvelope(value, current) {
  return value && value.connectionId === current.connectionId && value.ownerName === current.ownerName &&
    isMode(value.mode) && typeof value.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.month) && isDay(value.asOfDate) &&
    value.asOfDate.startsWith(value.month + "-") && value.timezone === "America/Los_Angeles" && isoTime(value.updatedAt) &&
    Date.parse(value.updatedAt) <= Date.now() + 300000 &&
    Number.isInteger(value.staleAfterSeconds) && value.staleAfterSeconds >= 60 && value.staleAfterSeconds <= 86400 &&
    Number.isInteger(value.refreshAfterSeconds) && value.refreshAfterSeconds >= 60 && value.refreshAfterSeconds <= 86400 &&
    typeof value.avatarUrl === "string" && value.avatarUrl.startsWith(BOOKIEBOT_ORIGIN + "/app/avatar.png?day=") &&
    isDay(value.avatarUrl.slice((BOOKIEBOT_ORIGIN + "/app/avatar.png?day=").length)) &&
    value.appUrl === BOOKIEBOT_ORIGIN + "/app/expenses" && value.status === "fresh";
}
function finiteMoney(value) { return typeof value === "number" && moneyNumber(value); }
function nonnegative(value) { return finiteMoney(value) && value >= 0; }
function validSnapshot(value, current, selection = { type: "budget", goalId: null }) {
  if (!validEnvelope(value, current)) return false;
  if (selection.type === "budget") return value.schemaVersion === 1 && moneyNumber(value.budgetRemaining) && moneyNumber(value.availableToday) &&
    ["under", "over", "not_started", "unavailable"].includes(value.todayState);
  if (value.schemaVersion !== 2 || value.type !== selection.type || !value.content || typeof value.content !== "object") return false;
  const content = value.content;
  if (value.type === "upcoming") return Array.isArray(content.payments) && content.payments.length <= 2 &&
    Number.isSafeInteger(content.totalCount) && content.totalCount >= content.payments.length && isDay(content.windowEnd) && content.windowEnd >= value.asOfDate &&
    content.payments.every((payment) => payment && isLabel(payment.label) && nonnegative(payment.amount) && isDay(payment.date) &&
      payment.date >= value.asOfDate && payment.date <= content.windowEnd && ["bill", "subscription"].includes(payment.kind));
  if (value.type === "categories") return [content.needs, content.wants].every((category) => category && finiteMoney(category.remaining) && nonnegative(category.budget));
  if (value.type === "shared") return nonnegative(content.owedToYou) && nonnegative(content.youOwe) && isName(content.partnerName) &&
    Number.isSafeInteger(content.pendingCount) && content.pendingCount >= 0 && typeof content.projectionPending === "boolean";
  if (value.type === "savings") {
    if (!Array.isArray(content.goals) || content.goals.length > 200 || !content.goals.every((goal) => goal && isGoalId(goal.id) && isName(goal.name)) ||
      new Set(content.goals.map((goal) => goal.id)).size !== content.goals.length) return false;
    if (content.goal === null) return ["no_goals", "goal_unavailable"].includes(content.emptyReason);
    const goal = content.goal;
    return content.emptyReason === null && goal && isGoalId(goal.id) && isName(goal.name) && nonnegative(goal.balance) && nonnegative(goal.target) && goal.target > 0 &&
      nonnegative(goal.remaining) && typeof goal.progress === "number" && Number.isFinite(goal.progress) && goal.progress >= 0 && goal.progress <= 1 &&
      (!selection.goalId || goal.id === selection.goalId) && content.goals.some((item) => item.id === goal.id && item.name === goal.name);
  }
  return false;
}
function readSnapshot(current, selection) {
  try {
    const value = JSON.parse(files.readString(snapshotPath(current, selection)));
    return validSnapshot(value, current, selection) ? value : null;
  } catch (_) { return null; }
}
function cleanContent(type, content) {
  if (type === "upcoming") return { payments: content.payments.map(({ label, amount, date, kind }) => ({ label, amount, date, kind })), totalCount: content.totalCount, windowEnd: content.windowEnd };
  if (type === "categories") return { needs: { remaining: content.needs.remaining, budget: content.needs.budget }, wants: { remaining: content.wants.remaining, budget: content.wants.budget } };
  if (type === "shared") return { owedToYou: content.owedToYou, youOwe: content.youOwe, partnerName: content.partnerName, pendingCount: content.pendingCount, projectionPending: content.projectionPending };
  const goal = content.goal;
  return { goal: goal ? { id: goal.id, name: goal.name, balance: goal.balance, target: goal.target, remaining: goal.remaining, progress: goal.progress } : null,
    goals: content.goals.map(({ id, name }) => ({ id, name })), emptyReason: content.emptyReason };
}
function saveSnapshot(current, value, selection) {
  // Whitelist nested content too: cache no receipt history, credentials or arbitrary response fields.
  const saved = {};
  for (const key of ["schemaVersion", "connectionId", "ownerName", "mode", "month", "asOfDate", "timezone", "updatedAt", "staleAfterSeconds", "refreshAfterSeconds", "avatarUrl", "appUrl", "status"]) saved[key] = value[key];
  if (selection.type === "budget") {
    for (const key of ["budgetRemaining", "availableToday", "todayState"]) saved[key] = value[key];
  } else { saved.type = value.type; saved.content = cleanContent(value.type, value.content); }
  try { files.createDirectory(cacheRoot, true); files.writeString(snapshotPath(current, selection), JSON.stringify(saved)); } catch (_) {}
  return saved;
}
function makeRequest(path, token) {
  const request = new Request(BOOKIEBOT_ORIGIN + path);
  request.timeoutInterval = 10;
  request.allowInsecureRequest = false;
  request.onRedirect = () => null;
  // Scriptable bridges native dictionaries by value. Mutating request.headers
  // after reading it changes a copy and can silently omit the bearer.
  const headers = { Accept: "application/json", "Cache-Control": "no-cache" };
  if (token) headers.Authorization = "Bearer " + token;
  request.headers = headers;
  return request;
}
function acceptedResponse(request, expectedUrl) {
  return request.response && request.response.url === expectedUrl && request.response.statusCode >= 200 && request.response.statusCode < 300;
}
async function pair() {
  const alert = new Alert();
  alert.title = "Pair BookieBot";
  alert.message = "Paste the private setup link from Settings → Widgets on " + BOOKIEBOT_ORIGIN + ".";
  alert.addSecureTextField("Private setup link", "");
  alert.addAction("Pair this phone");
  alert.addCancelAction("Cancel");
  if (await alert.presentAlert() < 0) return null;
  const link = alert.textFieldValue(0).trim();
  const prefix = BOOKIEBOT_ORIGIN + "/app/widgets/connect#";
  const token = link.startsWith(prefix) ? link.slice(prefix.length) : "";
  if (!/^bbw_pair_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Use a new setup link from this BookieBot server. Other sites and modified links are not accepted.");
  const request = makeRequest("/app/widgets/pair");
  request.method = "POST";
  request.headers = { ...request.headers, "Content-Type": "application/json" };
  request.body = JSON.stringify({ pairingToken: token });
  let value;
  try { value = await request.loadJSON(); } catch (_) { throw new Error("Pairing could not finish. Create a fresh setup link in BookieBot and try again."); }
  const next = { ...(value || {}), origin: BOOKIEBOT_ORIGIN };
  if (!acceptedResponse(request, BOOKIEBOT_ORIGIN + "/app/widgets/pair") || !validProfile(next) || Date.parse(next.expiresAt) <= Date.now()) {
    throw new Error("This setup link could not be used. Create a new one in Settings → Widgets.");
  }
  const previous = profile();
  const saved = { origin: BOOKIEBOT_ORIGIN, token: next.token, connectionId: next.connectionId, ownerName: next.ownerName, mode: next.mode, expiresAt: next.expiresAt };
  const serialized = JSON.stringify(saved);
  try {
    Keychain.set(profileKey, serialized);
    if (Keychain.get(profileKey) !== serialized) throw new Error("Secure storage readback did not match");
  } catch (_) {
    // Keep a potentially valid Keychain write for the next unlocked run. Never
    // announce success or fall back to plaintext if the write cannot be verified.
    throw new Error("Secure storage could not confirm this pairing. Unlock your phone, then run this script again in Scriptable. If it still asks to pair, use a fresh setup link.");
  }
  if (previous) removeCache(previous.connectionId);
  const confirmation = new Alert();
  confirmation.title = "Paired with " + saved.ownerName;
  confirmation.message = "When you edit the Home Screen widget, select the script “" + Script.name() + "”. Keep this script name unchanged so the widget can find its pairing. iOS may take a little time to update the Home Screen.";
  confirmation.addAction("Show preview");
  await confirmation.presentAlert();
  return saved;
}
async function snapshot(current, selection = { type: "budget", goalId: null }) {
  if (Date.parse(current.expiresAt) <= Date.now()) { forget(current); return { state: "reconnect" }; }
  const urlPath = dataPath(selection);
  const request = makeRequest(urlPath, current.token);
  let value;
  try { value = await request.loadJSON(); } catch (_) {}
  if (request.response && [401, 403].includes(request.response.statusCode)) {
    forget(current);
    return { state: "reconnect" };
  }
  if (acceptedResponse(request, BOOKIEBOT_ORIGIN + urlPath) && validSnapshot(value, current, selection)) {
    return { state: "loaded", data: saveSnapshot(current, value, selection) };
  }
  const cached = readSnapshot(current, selection);
  return cached ? { state: "stale", data: cached } : { state: "unavailable" };
}
function reportDay(date, timezone) {
  // JavaScriptCore's Intl keeps the financial date in the report timezone while travelling.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type).value;
  return part("year") + "-" + part("month") + "-" + part("day");
}
function staleResult(result) {
  if (!result.data) return false;
  const data = result.data;
  return result.state === "stale" || Date.now() - Date.parse(data.updatedAt) > data.staleAfterSeconds * 1000 ||
    data.asOfDate !== reportDay(new Date(), data.timezone);
}
async function avatar(current, data, refresh) {
  const imagePath = pathFor(current, ".png");
  const urlPath = pathFor(current, ".avatar-url");
  let cached = null;
  try { cached = files.readImage(imagePath); if (files.readString(urlPath) === data.avatarUrl && cached) return cached; } catch (_) {}
  if (refresh) {
    const request = makeRequest(data.avatarUrl.slice(BOOKIEBOT_ORIGIN.length));
    request.timeoutInterval = 3;
    try {
      const image = await request.loadImage();
      if (acceptedResponse(request, data.avatarUrl) && image) {
        try { files.createDirectory(cacheRoot, true); files.writeImage(imagePath, image); files.writeString(urlPath, data.avatarUrl); } catch (_) {}
        return image;
      }
    } catch (_) {}
  }
  return cached || SFSymbol.named("book.closed.fill").image;
}
function text(parent, value, size, color, bold) {
  const item = parent.addText(value);
  item.font = bold ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  item.textColor = color || BB.text;
  item.lineLimit = 1;
  item.minimumScaleFactor = 0.65;
  return item;
}
function money(value) {
  if (value === null) return "—";
  const absolute = Math.abs(value).toFixed(2).split(".");
  return (value < 0 ? "−" : "") + "$" + absolute[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + absolute[1];
}
function amount(parent, value, size, color, editorial = false) {
  const item = text(parent, money(value), size, color, true);
  if (editorial) {
    try { item.font = new Font("Georgia", size); } catch (_) { item.font = Font.systemFont(size); }
  } else item.font = Font.semiboldRoundedSystemFont(size);
  // Native WidgetText shrinks to its available width, preserving cents on narrow widgets.
  item.minimumScaleFactor = 0.35;
  return item;
}
// Conservative glyph estimate sets the starting font; native fitting handles
// device font differences without abbreviating the signed amount or its cents.
function moneyWidth(value, size) {
  return [...money(value)].reduce((width, character) => width +
    (character === "," || character === "." ? 0.28 : character === "—" ? 1 : 0.64), 0) * size;
}
function fittedAmount(parent, value, width, maximumSize, color, editorial = false) {
  return amount(parent, value, Math.min(maximumSize, width / moneyWidth(value, 1)), color, editorial);
}
function moneyLeftLabel(value, width, labelSize, amountSize, gap) {
  return moneyWidth(value, amountSize) + labelSize * 4.8 + gap <= width ? "Money left" : "Left";
}
function todayFigure(parent, data, width, scale, editorial, maximumSize) {
  text(parent, "Available today", 10 * scale, BB.muted);
  parent.addSpacer(1 * scale);
  fittedAmount(parent, data.availableToday, width, maximumSize * scale,
    data.availableToday < 0 ? BB.warning : BB.sage, editorial);
}
function stamp(date) {
  const format = new DateFormatter();
  format.locale = "en_US";
  format.dateFormat = "MMM d '·' h:mm a";
  return format.string(date);
}
function background(parent, light = false) {
  const gradient = new LinearGradient();
  gradient.colors = light ? [new Color("BAD4C3"), BB.panel] : [new Color("23382D"), new Color("14211B")];
  gradient.locations = [0, 1];
  gradient.startPoint = new Point(0, 0);
  gradient.endPoint = new Point(1, 1);
  parent.backgroundGradient = gradient;
}
function identityHeader(parent, imageValue, name, mode, small, inlineMode = false, scale = 1) {
  const header = parent.addStack();
  header.centerAlignContent();
  const image = header.addImage(imageValue);
  const size = (small ? 24 : 28) * scale;
  image.imageSize = new Size(size, size);
  image.cornerRadius = size / 2;
  header.addSpacer((small ? 6 : 8) * scale);
  const identity = header.addStack();
  identity.layoutVertically();
  text(identity, name, (small ? 11 : 13) * scale, BB.text, true);
  if (!inlineMode) text(identity, mode, (small ? 9 : 10) * scale, BB.muted);
  header.addSpacer();
  if (inlineMode) text(header, mode, 10 * scale, BB.muted);
}
function freshness(parent, data, stale, small, scale = 1) {
  // One absolute source timestamp stays truthful even if iOS delays execution.
  // The Stale flag is evaluated at each run; never render a frozen relative age.
  const row = parent.addStack();
  row.centerAlignContent();
  const color = stale ? BB.warning : BB.muted;
  const clock = row.addImage(SFSymbol.named("clock").image);
  clock.imageSize = new Size((small ? 9 : 11) * scale, (small ? 9 : 11) * scale);
  clock.tintColor = color;
  row.addSpacer(4 * scale);
  text(row, (stale ? "Stale · " : "") + stamp(new Date(data.updatedAt)), (small ? 8.5 : 9) * scale, color);
  row.addSpacer();
}
// WidgetKit owns the actual container. These supported phone bounds keep explicit
// column widths conservative; larger/unknown screens use the approved reference size.
function widgetBounds(family) {
  let width = 430;
  try { const screen = Device.screenSize(); width = Math.min(screen.width, screen.height); } catch (_) {}
  const small = width <= 320 ? 141 : width <= 375 ? 155 : width <= 393 ? 158 : width <= 414 ? 169 : 176;
  const medium = width <= 320 ? 292 : width <= 375 ? 329 : width <= 393 ? 338 : width <= 414 ? 360 : 376;
  return { width: family === "small" ? small : medium, height: small, scale: small / 176 };
}
function centered(parent, value, size, color, moneyValue = false, editorial = false) {
  const row = parent.addStack(); row.centerAlignContent(); row.addSpacer();
  const item = moneyValue ? amount(row, value, size, color, editorial) : text(row, value, size, color);
  row.addSpacer(); return item;
}
function shortMoney(value) { return money(value).replace(/\.00$/, ""); }
function shortDay(value) {
  const parts = value.split("-");
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(parts[1]) - 1] + " " + Number(parts[2]);
}
function monthName(value) { return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(value.slice(5)) - 1]; }
function progressTrack(parent, ratio, width, light = false, negative = false) {
  const fraction = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  const drawing = new DrawContext(); drawing.size = new Size(Math.max(1, width), 5);
  drawing.opaque = false; drawing.respectScreenScale = true;
  const pill = (length, color) => {
    if (length <= 0) return;
    drawing.setFillColor(color);
    const shape = new Path(); shape.addRoundedRect(new Rect(0, 0, length, 5), Math.min(2.5, length / 2), 2.5);
    drawing.addPath(shape); drawing.fillPath();
  };
  pill(width, new Color(light ? "193B2C" : "FFFFFF", light ? 0.15 : 0.10));
  pill(width * fraction, negative ? (light ? BB.negativeInk : BB.warning) : light ? BB.ink : BB.sage);
  const image = parent.addImage(drawing.getImage()); image.imageSize = new Size(width, 5); image.resizable = true;
}
function goalRing(parent, progress, diameter, light) {
  const drawing = new DrawContext(); drawing.size = new Size(diameter, diameter);
  drawing.opaque = false; drawing.respectScreenScale = true;
  const center = diameter / 2, radius = diameter * 0.40, stroke = diameter * 0.075;
  const rect = new Rect(center - radius, center - radius, radius * 2, radius * 2);
  const ink = light ? BB.ink : BB.text, fill = light ? BB.ink : BB.sage;
  drawing.setLineWidth(stroke); drawing.setStrokeColor(new Color(light ? "193B2C" : "FFFFFF", light ? 0.15 : 0.10));
  drawing.strokeEllipse(rect);
  const fraction = Math.max(0, Math.min(1, progress));
  drawing.setStrokeColor(fill);
  if (fraction === 1) drawing.strokeEllipse(rect);
  else if (fraction > 0) {
    const path = new Path(); const steps = Math.max(2, Math.ceil(fraction * 160));
    const pointAt = (step) => { const theta = -Math.PI / 2 + fraction * Math.PI * 2 * step / steps; return new Point(center + radius * Math.cos(theta), center + radius * Math.sin(theta)); };
    path.move(pointAt(0)); for (let step = 1; step <= steps; step++) path.addLine(pointAt(step));
    drawing.addPath(path); drawing.strokePath(); drawing.setFillColor(fill);
    for (const point of [pointAt(0), pointAt(steps)]) drawing.fillEllipse(new Rect(point.x - stroke / 2, point.y - stroke / 2, stroke, stroke));
  }
  drawing.setTextColor(ink); drawing.setFont(Font.semiboldSystemFont(diameter * 0.25)); drawing.setTextAlignedCenter();
  drawing.drawTextInRect(Math.round(fraction * 100) + "%", new Rect(diameter * 0.10, diameter * 0.35, diameter * 0.80, diameter * 0.34));
  const row = parent.addStack(); row.addSpacer();
  const image = row.addImage(drawing.getImage()); image.imageSize = new Size(diameter, diameter); image.resizable = true;
  row.addSpacer();
}
function columnBody(column, height, draw) {
  const body = column.addStack(); body.layoutVertically(); body.size = new Size(0, height);
  body.addSpacer(); draw(body); body.addSpacer();
  return body;
}
function contextLabel(type, data) {
  if (type === "savings") return "Savings";
  if (type === "shared") return "With " + data.content.partnerName;
  if (type === "upcoming") return "Scheduled";
  return data.mode === "current" ? "Current" : "Projected";
}
function emptyGoal(parent, content, size, light = false) {
  const title = content.emptyReason === "goal_unavailable" ? "Goal unavailable" : "No savings goals";
  text(parent, title, size, light ? BB.ink : BB.text, true);
  const helper = text(parent, content.emptyReason === "goal_unavailable" ? "Choose another goal" : "Add a goal in BookieBot", size - 2, light ? BB.ink : BB.muted);
  helper.lineLimit = 2;
}
function sharedNote(content) {
  return content.pendingCount > 0 ? "Awaiting confirmation" : content.projectionPending ? "Sheet sync pending" : null;
}
async function renderCollection(current, result, theme, family, type) {
  if (!result.data) {
    const widget = await render(current, result, theme, family, "budget");
    return widget;
  }
  const data = result.data, content = data.content;
  const bounds = widgetBounds(family), scale = bounds.scale, small = family === "small", twoTone = theme === "two-tone";
  const editorial = !twoTone, padding = 12 * scale, headerHeight = 28 * scale, footerHeight = 18 * scale;
  const picture = await avatar(current, data, result.state === "loaded");
  const widget = new ListWidget(); widget.backgroundColor = BB.background; background(widget); widget.setPadding(0, 0, 0, 0);
  widget.url = BOOKIEBOT_ORIGIN + "/app/expenses";
  widget.refreshAfterDate = new Date(Date.now() + data.refreshAfterSeconds * 1000);
  const stale = staleResult(result), context = contextLabel(type, data);
  const sharedWarning = type === "shared" ? sharedNote(content) : null;
  if (small) {
    const header = widget.addStack(); header.layoutVertically(); header.setPadding(padding, padding, 0, padding);
    identityHeader(header, picture, data.ownerName, context, true);
    widget.addSpacer();
    const section = (light = false, verticalPadding = 3) => {
      const stack = widget.addStack(); stack.layoutVertically(); stack.setPadding(verticalPadding * scale, padding, verticalPadding * scale, padding);
      if (light) background(stack, true); return stack;
    };
    if (type === "upcoming") {
      if (!content.payments.length) {
        const empty = section(); text(empty, "No scheduled payments", 12 * scale, BB.text, true);
        text(empty, "Through " + shortDay(content.windowEnd), 10 * scale, BB.muted);
      }
      content.payments.forEach((payment, index) => {
        const light = twoTone && index === 1, panel = section(light, index === 1 && twoTone ? 6 : 4);
        const row = panel.addStack();
        const wideAmount = money(payment.amount).length > 12;
        if (wideAmount) row.layoutVertically(); else row.centerAlignContent();
        const labels = row.addStack(); labels.layoutVertically();
        if (!wideAmount) labels.size = new Size((bounds.width - padding * 2) * 0.49, 0);
        text(labels, payment.label, 10.5 * scale, light ? BB.ink : BB.text);
        text(labels, shortDay(payment.date), 9.5 * scale, light ? BB.ink : BB.muted);
        if (!wideAmount) { row.addSpacer(5 * scale); row.addSpacer(); }
        amount(row, payment.amount, 19 * scale, light ? BB.ink : index === 0 ? BB.sage : BB.text, editorial);
      });
      if (content.totalCount > 2) text(section(false, 1), "+" + (content.totalCount - 2) + " more this month", 8.5 * scale, BB.muted);
    } else if (type === "savings") {
      const main = section();
      if (!content.goal) emptyGoal(main, content, 13 * scale);
      else {
        const goal = content.goal;
        text(main, goal.name, 10.5 * scale, BB.text);
        amount(main, goal.balance, 27 * scale, BB.sage, editorial);
        const strip = section(twoTone, twoTone ? 7 : 3);
        progressTrack(strip, goal.progress, bounds.width - padding * 2, twoTone);
        strip.addSpacer(5 * scale);
        const caption = strip.addStack();
        text(caption, shortMoney(goal.target) + " goal", 9.5 * scale, twoTone ? BB.ink : BB.muted);
        caption.addSpacer(5); caption.addSpacer();
        text(caption, Math.round(goal.progress * 100) + "%", 10 * scale, twoTone ? BB.ink : BB.sage, true);
      }
    } else if (type === "categories") {
      [content.needs, content.wants].forEach((category, index) => {
        const light = twoTone && index === 1, panel = section(light, twoTone && index === 1 ? 6 : 4);
        const row = panel.addStack(); row.centerAlignContent();
        text(row, index === 0 ? "Needs left" : "Wants left", 10 * scale, light ? BB.ink : BB.muted);
        row.addSpacer(4); row.addSpacer();
        amount(row, category.remaining, 20 * scale, category.remaining < 0 ? light ? BB.negativeInk : BB.warning : light ? BB.ink : BB.sage, editorial);
        panel.addSpacer(3 * scale);
        const lower = panel.addStack(); lower.centerAlignContent();
        progressTrack(lower, category.budget > 0 ? category.remaining / category.budget : 0, (bounds.width - padding * 2) * 0.52, light, category.remaining < 0);
        lower.addSpacer(5); lower.addSpacer(); text(lower, "of " + shortMoney(category.budget), 8.5 * scale, light ? BB.ink : BB.muted);
      });
    } else {
      const main = section(); text(main, "Owed to you", 10.5 * scale, BB.muted);
      amount(main, content.owedToYou, 27 * scale, BB.sage, editorial);
      const lower = section(twoTone, twoTone ? 7 : 3); const row = lower.addStack(); row.centerAlignContent();
      text(row, "You owe", 10.5 * scale, twoTone ? BB.ink : BB.muted); row.addSpacer(6); row.addSpacer();
      amount(row, content.youOwe, 21 * scale, twoTone ? BB.ink : BB.text, editorial);
      if (sharedWarning) text(section(false, 1), sharedWarning, 8 * scale, BB.warning);
    }
    widget.addSpacer();
    const footer = widget.addStack(); footer.setPadding(4 * scale, padding, 10 * scale, padding); freshness(footer, data, stale, true);
  } else {
    const columns = widget.addStack(); columns.size = new Size(bounds.width, bounds.height);
    const leftWidth = Math.round(bounds.width * (type === "shared" ? 0.50 : 0.56)), rightWidth = bounds.width - leftWidth;
    const left = columns.addStack(); left.layoutVertically(); left.size = new Size(leftWidth, bounds.height); left.setPadding(padding, padding, padding, padding);
    const right = columns.addStack(); right.layoutVertically(); right.size = new Size(rightWidth, bounds.height); right.setPadding(padding, padding, padding, padding);
    if (twoTone) background(right, true);
    const header = left.addStack(); header.size = new Size(0, headerHeight);
    identityHeader(header, picture, data.ownerName, context, false);
    const bodyHeight = bounds.height - padding * 2 - headerHeight - footerHeight;
    const rightColor = twoTone ? BB.ink : BB.text, rightQuiet = twoTone ? BB.ink : BB.muted;
    if (type === "savings") {
      columnBody(left, bodyHeight, (body) => {
        if (!content.goal) emptyGoal(body, content, 14 * scale);
        else { text(body, content.goal.name, 11 * scale, BB.muted); body.addSpacer(4 * scale); amount(body, content.goal.balance, 32 * scale, BB.sage, editorial); }
      });
      right.addSpacer();
      if (content.goal) {
        const goal = content.goal;
        centered(right, "Goal · " + shortMoney(goal.target), 10 * scale, rightQuiet);
        right.addSpacer(4 * scale);
        goalRing(right, goal.progress, Math.min(102 * scale, rightWidth - padding * 2), twoTone);
        right.addSpacer(4 * scale);
        centered(right, goal.remaining === 0 ? "Goal reached" : shortMoney(goal.remaining) + " to go", 10 * scale, rightQuiet);
      }
      right.addSpacer();
    } else {
      const top = right.addStack(); top.layoutVertically(); top.size = new Size(0, headerHeight);
      if (type === "upcoming") {
        text(top, monthName(data.month).toUpperCase(), 9.5 * scale, twoTone ? BB.ink : BB.sage, true);
        text(top, content.totalCount > 2 ? "+" + (content.totalCount - 2) + " more this month" : "Upcoming payments", 9 * scale, rightQuiet);
      } else if (type === "categories") text(top, monthName(data.month), 10 * scale, rightQuiet);
      const drawColumn = (body, index, light) => {
        const quiet = light ? BB.ink : BB.muted, primary = light ? BB.ink : index === 0 ? BB.sage : BB.text;
        if (type === "shared") {
          centered(body, index === 0 ? "Owed to you" : "You owe", 11 * scale, quiet);
          body.addSpacer(5 * scale); centered(body, index === 0 ? content.owedToYou : content.youOwe, 32 * scale, primary, true, editorial);
        } else if (type === "upcoming") {
          const payment = content.payments[index];
          if (!payment) { text(body, index === 0 ? "No scheduled payments" : "Nothing else scheduled", 12 * scale, light ? BB.ink : BB.text); return; }
          text(body, (index === 0 ? "Next · " : "Then · ") + shortDay(payment.date), 10 * scale, quiet);
          body.addSpacer(3 * scale); text(body, payment.label, 12 * scale, light ? BB.ink : BB.text);
          body.addSpacer(4 * scale); amount(body, payment.amount, 32 * scale, primary, editorial);
        } else {
          const category = index === 0 ? content.needs : content.wants;
          text(body, index === 0 ? "Needs remaining" : "Wants remaining", 11 * scale, quiet);
          amount(body, category.remaining, 31 * scale, category.remaining < 0 ? light ? BB.negativeInk : BB.warning : primary, editorial);
          text(body, "of " + shortMoney(category.budget), 10 * scale, quiet); body.addSpacer(6 * scale);
          progressTrack(body, category.budget > 0 ? category.remaining / category.budget : 0, (index === 0 ? leftWidth : rightWidth) - padding * 2, light, category.remaining < 0);
        }
      };
      columnBody(left, bodyHeight, (body) => drawColumn(body, 0, false));
      columnBody(right, bodyHeight, (body) => drawColumn(body, 1, twoTone));
      const bottom = right.addStack(); bottom.size = new Size(0, footerHeight);
      if (sharedWarning) text(bottom, sharedWarning, 8 * scale, twoTone ? BB.negativeInk : BB.warning);
    }
    const footer = left.addStack(); footer.size = new Size(0, footerHeight); footer.centerAlignContent();
    freshness(footer, data, stale, false);
  }
  return widget;
}
async function render(current, result, theme = "editorial", family = "medium", type = "budget") {
  if (type !== "budget" && result.data) return renderCollection(current, result, theme, family, type);
  const widget = new ListWidget();
  widget.backgroundColor = BB.background;
  background(widget);
  const small = family === "small";
  const twoTone = theme === "two-tone";
  const data = result.data;
  // ListWidget.url overrides On Tap; styles and parameters never control authority.
  if (trustedOrigin()) widget.url = data ? BOOKIEBOT_ORIGIN + "/app/expenses" : URLScheme.forRunningScript();
  const picture = data ? await avatar(current, data, result.state === "loaded") : SFSymbol.named("book.closed.fill").image;
  if (!data) {
    widget.setPadding(12, 14, 12, 14);
    identityHeader(widget, picture, current ? current.ownerName : "BookieBot", "Home Screen", small);
    widget.addSpacer();
    text(widget, result.state === "reconnect" ? "Reconnect widget" : result.state === "unpaired" ? "Pair this phone" : result.state === "invalid" ? "Check widget parameter" : widgetNames[type] + " unavailable", 15, BB.text, true);
    const helper = text(widget, result.state === "unavailable" ? "Tap to retry in Scriptable" : result.state === "reconnect" ? "Tap to pair again" : result.state === "invalid" ? "Tap to configure in Scriptable" : "Tap to pair in Scriptable", 11, BB.muted);
    helper.lineLimit = 2;
    widget.addSpacer();
    if (current && result.state === "unavailable") widget.refreshAfterDate = new Date(Date.now() + 900000);
    return widget;
  }
  const stale = staleResult(result);
  widget.refreshAfterDate = new Date(Date.now() + data.refreshAfterSeconds * 1000);
  const mode = data.mode === "current" ? "Current" : "Projected";
  const bounds = widgetBounds(family), scale = bounds.scale, padding = 12 * scale;
  const editorial = !twoTone;
  widget.setPadding(0, 0, 0, 0);
  if (small) {
    const top = widget.addStack(); top.layoutVertically();
    top.size = new Size(bounds.width, bounds.height - 56 * scale);
    top.setPadding(10 * scale, padding, 4 * scale, padding);
    identityHeader(top, picture, data.ownerName, mode, true, false, scale);
    // Give the label/number equal breathing room above and below, instead of
    // accumulating unused height between the amount and the secondary strip.
    top.addSpacer();
    const primary = top.addStack(); primary.layoutVertically();
    todayFigure(primary, data, bounds.width - padding * 2, scale, editorial, 48);
    top.addSpacer();
    const remaining = widget.addStack(); remaining.centerAlignContent();
    remaining.size = new Size(bounds.width, 31 * scale);
    remaining.setPadding(6 * scale, padding, 6 * scale, padding);
    if (twoTone) background(remaining, true);
    const contentWidth = bounds.width - padding * 2, gap = 6 * scale;
    const label = moneyLeftLabel(data.budgetRemaining, contentWidth, 9 * scale, 14 * scale, gap);
    text(remaining, label, 9 * scale, twoTone ? BB.ink : BB.muted);
    remaining.addSpacer(gap); remaining.addSpacer();
    const amountWidth = contentWidth - (label === "Left" ? 1.9 : 4.8) * 9 * scale - gap;
    fittedAmount(remaining, data.budgetRemaining, amountWidth, 14 * scale,
      data.budgetRemaining < 0 ? twoTone ? BB.negativeInk : BB.warning : twoTone ? BB.ink : BB.text);
    const footer = widget.addStack(); footer.size = new Size(bounds.width, 25 * scale);
    footer.setPadding(6 * scale, padding, 8 * scale, padding);
    freshness(footer, data, stale, true, scale);
  } else {
    const columns = widget.addStack(); columns.size = new Size(bounds.width, bounds.height);
    const leftWidth = bounds.width * 0.56, rightWidth = bounds.width - leftWidth;
    const left = columns.addStack(); left.layoutVertically(); left.size = new Size(leftWidth, bounds.height);
    left.setPadding(12 * scale, padding, 11 * scale, padding);
    identityHeader(left, picture, data.ownerName, mode, false, false, scale);
    left.addSpacer();
    const primary = left.addStack(); primary.layoutVertically();
    todayFigure(primary, data, leftWidth - padding * 2, scale, editorial, 52);
    left.addSpacer();
    freshness(left, data, stale, false, scale);
    const right = columns.addStack(); right.layoutVertically(); right.size = new Size(rightWidth, bounds.height);
    right.setPadding(padding, padding, padding, padding);
    if (twoTone) background(right, true);
    right.addSpacer();
    text(right, "Money left", 11 * scale, twoTone ? BB.ink : BB.muted);
    right.addSpacer(4 * scale);
    fittedAmount(right, data.budgetRemaining, rightWidth - padding * 2, 30 * scale,
      data.budgetRemaining < 0 ? twoTone ? BB.negativeInk : BB.warning : twoTone ? BB.ink : BB.text);
    right.addSpacer();
  }
  return widget;
}
async function main() {
  let selection = widgetSelection();
  let theme = selection.theme;
  let family = config.widgetFamily === "small" ? "small" : "medium";
  if (!trustedOrigin()) {
    const widget = await render(null, { state: "unpaired" }, theme, family);
    Script.setWidget(widget);
    if (config.runsInApp) {
      const alert = new Alert(); alert.title = "Download the configured script";
      alert.message = "Use Copy script in your BookieBot Settings → Widgets → Setup & widgets. That copy includes your trusted server address.";
      alert.addAction("OK"); await alert.presentAlert();
    }
    Script.complete(); return;
  }
  let current = profile();
  if (config.runsInApp && current && !(typeof args !== "undefined" && args.widgetParameter)) {
    selection = preferredSelection(current, family); theme = selection.theme; family = selection.family;
  }
  if (config.runsInApp) {
    try {
      if (!current) {
        current = await pair();
        if (!current) { Script.complete(); return; }
      }
      else {
        const menu = new Alert(); menu.title = "BookieBot · " + current.ownerName;
        menu.message = "Widget view comes from Settings → Widgets. Updating here fetches a new snapshot; iOS chooses when the Home Screen redraws.";
        menu.addAction("Refresh & preview"); menu.addAction("Pair again"); menu.addDestructiveAction("Forget this phone"); menu.addAction("Widget & preview"); menu.addCancelAction("Cancel");
        const action = await menu.presentSheet();
        if (action < 0) { Script.complete(); return; }
        if (action === 1) {
          const replacement = await pair();
          if (!replacement) { Script.complete(); return; }
          current = replacement;
          selection = { type: "budget", theme: preferredTheme(), goalId: null }; theme = selection.theme;
        }
        if (action === 2) {
          const confirm = new Alert(); confirm.title = "Forget widget access?";
          confirm.message = "Removes the credential and cached amounts from this Scriptable profile. Also revoke this connection in BookieBot Settings → Widgets.";
          confirm.addDestructiveAction("Forget"); confirm.addCancelAction("Cancel");
          if (await confirm.presentAlert() === 0) { forget(current); current = null; }
        }
        if (action === 3) {
          const preview = await chooseWidgetPreview(current);
          if (!preview) { Script.complete(); return; }
          selection = preview; theme = preview.theme; family = preview.family;
        }
      }
    } catch (error) {
      const alert = new Alert(); alert.title = "Couldn't pair BookieBot";
      // Pairing errors are our own generic messages, never raw server bodies or URLs with secrets.
      alert.message = error.message.startsWith("Use a new") || error.message.startsWith("This setup") || error.message.startsWith("Pairing could") || error.message.startsWith("Secure storage could") ? error.message : "Try a new setup link from Settings → Widgets.";
      alert.addAction("OK"); await alert.presentAlert();
      Script.complete(); return;
    }
  }
  const result = selection.invalid ? { state: "invalid" } : current ? await snapshot(current, selection) : { state: "unpaired" };
  const widget = await render(current, result, theme, family, selection.type);
  Script.setWidget(widget);
  if (config.runsInApp) {
    if (family === "small") await widget.presentSmall();
    else await widget.presentMedium();
  }
  Script.complete();
}
await main();
