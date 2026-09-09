// BookieBot Home Screen widget · v1.1
// Download this script from your own BookieBot Settings → Widgets.
// Credentials belong in Scriptable Keychain, never in this file or a widget parameter.
const BOOKIEBOT_ORIGIN = "__BOOKIEBOT_ORIGIN__";

const BB = {
  background: new Color("17201C"), text: new Color("F0EDE5"),
  muted: new Color("AAAFA5"), sage: new Color("96C4B0"), warning: new Color("DAA383"),
};
const files = FileManager.local();
const scope = encodeURIComponent(BOOKIEBOT_ORIGIN) + "." + encodeURIComponent(Script.name());
const profileKey = "bookiebot.widget.v1." + scope;
const cacheRoot = files.joinPath(files.cacheDirectory(), "bookiebot-widget-" + scope);

function trustedOrigin() {
  return /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(BOOKIEBOT_ORIGIN);
}
function isMode(value) { return value === "current" || value === "projected"; }
function isId(value) { return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value); }
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
  for (const suffix of [".json", ".png", ".avatar-url"]) {
    try { const path = files.joinPath(cacheRoot, connection + suffix); if (files.fileExists(path)) files.remove(path); } catch (_) {}
  }
}
function forget(current) {
  removeCache(current && current.connectionId);
  if (Keychain.contains(profileKey)) Keychain.remove(profileKey);
}
function pathFor(current, suffix) { return files.joinPath(cacheRoot, current.connectionId + suffix); }
function validSnapshot(value, current) {
  return value && value.schemaVersion === 1 && value.connectionId === current.connectionId && value.ownerName === current.ownerName &&
    isMode(value.mode) && typeof value.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.month) && isDay(value.asOfDate) &&
    value.asOfDate.startsWith(value.month + "-") && value.timezone === "America/Los_Angeles" &&
    moneyNumber(value.budgetRemaining) && moneyNumber(value.availableToday) &&
    ["under", "over", "not_started", "unavailable"].includes(value.todayState) && isoTime(value.updatedAt) &&
    Date.parse(value.updatedAt) <= Date.now() + 300000 &&
    Number.isInteger(value.staleAfterSeconds) && value.staleAfterSeconds >= 60 && value.staleAfterSeconds <= 86400 &&
    Number.isInteger(value.refreshAfterSeconds) && value.refreshAfterSeconds >= 60 && value.refreshAfterSeconds <= 86400 &&
    typeof value.avatarUrl === "string" && value.avatarUrl.startsWith(BOOKIEBOT_ORIGIN + "/app/avatar.png?day=") &&
    isDay(value.avatarUrl.slice((BOOKIEBOT_ORIGIN + "/app/avatar.png?day=").length)) &&
    value.appUrl === BOOKIEBOT_ORIGIN + "/app/expenses" && value.status === "fresh";
}
function readSnapshot(current) {
  try {
    const value = JSON.parse(files.readString(pathFor(current, ".json")));
    return validSnapshot(value, current) ? value : null;
  } catch (_) { return null; }
}
function saveSnapshot(current, value) {
  // Only the widget contract is cached; never persist arbitrary response fields or credentials.
  const saved = {};
  for (const key of ["schemaVersion", "connectionId", "ownerName", "mode", "month", "asOfDate", "timezone", "budgetRemaining", "availableToday", "todayState", "updatedAt", "staleAfterSeconds", "refreshAfterSeconds", "avatarUrl", "appUrl", "status"]) saved[key] = value[key];
  try { files.createDirectory(cacheRoot, true); files.writeString(pathFor(current, ".json"), JSON.stringify(saved)); } catch (_) {}
  return saved;
}
function makeRequest(path, token) {
  const request = new Request(BOOKIEBOT_ORIGIN + path);
  request.timeoutInterval = 10;
  request.allowInsecureRequest = false;
  request.onRedirect = () => null;
  request.headers = { Accept: "application/json", "Cache-Control": "no-cache" };
  if (token) request.headers.Authorization = "Bearer " + token;
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
  request.headers["Content-Type"] = "application/json";
  request.body = JSON.stringify({ pairingToken: token });
  let value;
  try { value = await request.loadJSON(); } catch (_) { throw new Error("Pairing could not finish. Create a fresh setup link in BookieBot and try again."); }
  const next = { ...(value || {}), origin: BOOKIEBOT_ORIGIN };
  if (!acceptedResponse(request, BOOKIEBOT_ORIGIN + "/app/widgets/pair") || !validProfile(next) || Date.parse(next.expiresAt) <= Date.now()) {
    throw new Error("This setup link could not be used. Create a new one in Settings → Widgets.");
  }
  const previous = profile();
  if (previous) removeCache(previous.connectionId);
  const saved = { origin: BOOKIEBOT_ORIGIN, token: next.token, connectionId: next.connectionId, ownerName: next.ownerName, mode: next.mode, expiresAt: next.expiresAt };
  Keychain.set(profileKey, JSON.stringify(saved));
  const confirmation = new Alert();
  confirmation.title = "Paired with " + saved.ownerName;
  confirmation.message = "When you edit the Home Screen widget, select the script “" + Script.name() + "”. Keep this script name unchanged so the widget can find its pairing. iOS may take a little time to update the Home Screen.";
  confirmation.addAction("Show preview");
  await confirmation.presentAlert();
  return saved;
}
async function snapshot(current) {
  if (Date.parse(current.expiresAt) <= Date.now()) { forget(current); return { state: "reconnect" }; }
  const request = makeRequest("/app/widgets/data", current.token);
  let value;
  try { value = await request.loadJSON(); } catch (_) {}
  if (request.response && [401, 403].includes(request.response.statusCode)) {
    forget(current);
    return { state: "reconnect" };
  }
  if (acceptedResponse(request, BOOKIEBOT_ORIGIN + "/app/widgets/data") && validSnapshot(value, current)) {
    return { state: "loaded", data: saveSnapshot(current, value) };
  }
  const cached = readSnapshot(current);
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
function amount(parent, value, size, color) {
  const item = text(parent, money(value), size, color, true);
  // Native WidgetText shrinks to its available width, preserving cents on narrow widgets.
  item.minimumScaleFactor = 0.35;
  return item;
}
function stamp(date) {
  const format = new DateFormatter();
  format.locale = "en_US";
  format.dateFormat = "MMM d, h:mm a";
  return format.string(date);
}
function dateElement(parent, date, size, color) {
  const item = parent.addDate(date);
  item.applyRelativeStyle();
  item.font = Font.systemFont(size);
  item.textColor = color;
  item.lineLimit = 1;
  item.minimumScaleFactor = 0.65;
}
async function render(current, result) {
  const widget = new ListWidget();
  widget.backgroundColor = BB.background;
  widget.setPadding(12, 14, 12, 14);
  const data = result.data;
  // ListWidget.url overrides the Home Screen's On Tap setting. Recovery must run
  // this exact script in Scriptable; populated widgets keep the normal browser link.
  if (trustedOrigin()) widget.url = data ? BOOKIEBOT_ORIGIN + "/app/expenses" : URLScheme.forRunningScript();
  const small = config.widgetFamily === "small";
  const header = widget.addStack();
  header.centerAlignContent();
  const image = header.addImage(data ? await avatar(current, data, result.state === "loaded") : SFSymbol.named("book.closed.fill").image);
  image.imageSize = new Size(26, 26);
  image.cornerRadius = 13;
  header.addSpacer(7);
  const identity = header.addStack();
  identity.layoutVertically();
  text(identity, data ? data.ownerName : (current ? current.ownerName : "BookieBot"), 12, BB.text, true);
  text(identity, data ? (data.mode === "current" ? "Current" : "Projected") : "Home Screen", 10, BB.muted);
  if (!data) {
    widget.addSpacer();
    text(widget, result.state === "reconnect" ? "Reconnect widget" : result.state === "unpaired" ? "Pair this phone" : "Budget unavailable", 15, BB.text, true);
    const helper = text(widget, result.state === "unavailable" ? "Tap to retry in Scriptable" : result.state === "reconnect" ? "Tap to pair again" : "Tap to pair in Scriptable", 11, BB.muted);
    helper.lineLimit = 2;
    widget.addSpacer();
    if (current && result.state === "unavailable") widget.refreshAfterDate = new Date(Date.now() + 900000);
    return widget;
  }
  const stale = staleResult(result);
  widget.refreshAfterDate = new Date(Date.now() + data.refreshAfterSeconds * 1000);
  widget.addSpacer(small ? 5 : 10);
  if (small) {
    text(widget, "Budget remaining", 10, BB.muted);
    amount(widget, data.budgetRemaining, 24, data.budgetRemaining < 0 ? BB.warning : BB.sage);
    widget.addSpacer(3);
    const today = widget.addStack();
    text(today, "Available today", 10, BB.muted);
    today.addSpacer(6);
    today.addSpacer();
    amount(today, data.availableToday, 14, data.availableToday < 0 ? BB.warning : BB.text);
  } else {
    const metrics = widget.addStack();
    const left = metrics.addStack(); left.layoutVertically();
    text(left, "Budget remaining", 11, BB.muted);
    amount(left, data.budgetRemaining, 29, data.budgetRemaining < 0 ? BB.warning : BB.sage);
    metrics.addSpacer(20);
    const right = metrics.addStack(); right.layoutVertically();
    text(right, "Available today", 11, BB.muted);
    amount(right, data.availableToday, 25, data.availableToday < 0 ? BB.warning : BB.text);
  }
  widget.addSpacer();
  const color = stale ? BB.warning : BB.muted;
  text(widget, (stale ? "Stale · " : "Updated · ") + stamp(new Date(data.updatedAt)), small ? 8 : 10, color);
  const age = widget.addStack();
  text(age, "Age", small ? 8 : 10, color);
  age.addSpacer(3);
  dateElement(age, new Date(data.updatedAt), small ? 8 : 10, color);
  age.addSpacer();
  return widget;
}
async function main() {
  if (!trustedOrigin()) {
    const widget = await render(null, { state: "unpaired" });
    Script.setWidget(widget);
    if (config.runsInApp) {
      const alert = new Alert(); alert.title = "Download the configured script";
      alert.message = "Use Copy script in your BookieBot Settings → Widgets → Set up widget. That copy includes your trusted server address.";
      alert.addAction("OK"); await alert.presentAlert();
    }
    Script.complete(); return;
  }
  let current = profile();
  if (config.runsInApp) {
    try {
      if (!current) {
        current = await pair();
        if (!current) { Script.complete(); return; }
      }
      else {
        const menu = new Alert(); menu.title = "BookieBot · " + current.ownerName;
        menu.message = "Widget view comes from Settings → Widgets. Updating here fetches a new snapshot; iOS chooses when the Home Screen redraws.";
        menu.addAction("Refresh & preview"); menu.addAction("Pair again"); menu.addDestructiveAction("Forget this phone"); menu.addCancelAction("Cancel");
        const action = await menu.presentSheet();
        if (action < 0) { Script.complete(); return; }
        if (action === 1) {
          const replacement = await pair();
          if (!replacement) { Script.complete(); return; }
          current = replacement;
        }
        if (action === 2) {
          const confirm = new Alert(); confirm.title = "Forget widget access?";
          confirm.message = "Removes the credential and cached amounts from this Scriptable profile. Also revoke this connection in BookieBot Settings → Widgets.";
          confirm.addDestructiveAction("Forget"); confirm.addCancelAction("Cancel");
          if (await confirm.presentAlert() === 0) { forget(current); current = null; }
        }
      }
    } catch (error) {
      const alert = new Alert(); alert.title = "Couldn't pair BookieBot";
      // Pairing errors are our own generic messages, never raw server bodies or URLs with secrets.
      alert.message = error.message.startsWith("Use a new") || error.message.startsWith("This setup") || error.message.startsWith("Pairing could") ? error.message : "Try a new setup link from Settings → Widgets.";
      alert.addAction("OK"); await alert.presentAlert();
      Script.complete(); return;
    }
  }
  const result = current ? await snapshot(current) : { state: "unpaired" };
  const widget = await render(current, result);
  Script.setWidget(widget);
  if (config.runsInApp) {
    if (config.widgetFamily === "small") await widget.presentSmall();
    else await widget.presentMedium();
  }
  Script.complete();
}
await main();
