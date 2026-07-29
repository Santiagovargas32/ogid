import { SmartPollLoop } from "./smartPollLoop.js";
import {
  AWARENESS_MAP_EVENT_NAME,
  AWARENESS_PREFERENCES_KEY,
  allAwarenessEvents,
  awarenessEventKey,
  eventMatchesAwarenessTab,
  isFullAwarenessPayload,
  mergeAwarenessPayload,
  normalizeAwarenessEvent,
  normalizeAwarenessPayload,
  normalizeAwarenessTab,
  projectLocatedAwarenessEvents,
  safeCanonicalUrl
} from "./awarenessModel.js";

const DEFAULT_ROOT_IDS = Object.freeze({
  panel: "panel-awareness",
  meta: "awareness-meta",
  upcoming: "awareness-upcoming-list",
  recent: "awareness-recent-list",
  tabs: "awareness-tabs",
  inboxBadge: "awareness-inbox-badge",
  topbarButton: "awareness-inbox-button",
  topbarBadge: "awareness-unread-badge",
  markAllRead: "awareness-mark-all-read",
  toastRegion: "awareness-toast-region"
});

const PREFERENCE_LIMIT = 1_000;

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value = "", maximumLength = 320) {
  const normalized = String(value || "").trim();
  return normalized.length > maximumLength ? `${normalized.slice(0, maximumLength - 1).trimEnd()}…` : normalized;
}

function validTimestamp(value) {
  const timestamp = new Date(value || 0);
  return Number.isFinite(timestamp.getTime()) ? timestamp : null;
}

function resolvedLocalTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

function formatZonedTimestamp(value, timezone = null) {
  const timestamp = validTimestamp(value);
  if (!timestamp) {
    return "--";
  }
  try {
    return new Intl.DateTimeFormat([], {
      timeZone: timezone || undefined,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(timestamp);
  } catch {
    return "invalid timezone";
  }
}

export function formatAwarenessCountdown(event = {}, now = Date.now()) {
  const scheduled = validTimestamp(event.scheduledAt);
  const published = validTimestamp(event.publishedAt || event.updatedAt || event.observedAt);
  if (event.status === "cancelled") {
    return "cancelado";
  }
  if (event.status === "live") {
    return "en directo";
  }
  const target = scheduled || published;
  if (!target) {
    return "hora no disponible";
  }
  const differenceMs = target.getTime() - Number(now);
  const future = differenceMs > 0;
  const absoluteMinutes = Math.max(0, Math.floor(Math.abs(differenceMs) / 60_000));
  const days = Math.floor(absoluteMinutes / 1_440);
  const hours = Math.floor((absoluteMinutes % 1_440) / 60);
  const minutes = absoluteMinutes % 60;
  let amount;
  if (days > 0) {
    amount = `${days} d ${hours} h`;
  } else if (hours > 0) {
    amount = `${hours} h ${minutes} min`;
  } else if (absoluteMinutes > 0) {
    amount = `${absoluteMinutes} min`;
  } else {
    amount = "< 1 min";
  }
  return future ? `en ${amount}` : `hace ${amount}`;
}

export function scheduledAlertThreshold(event = {}, preference = {}, now = Date.now()) {
  if (event.importance !== "high" || !["scheduled", "live"].includes(event.status) || !event.scheduledAt) return null;
  const deltaMs = new Date(event.scheduledAt).getTime() - Number(now);
  if (!Number.isFinite(deltaMs) || deltaMs <= 0 || deltaMs > 60 * 60_000) return null;
  if (deltaMs <= 15 * 60_000 && preference.alertT15 !== true) return "alertT15";
  if (preference.alertT60 !== true) return "alertT60";
  return null;
}

function primaryEventTimestamp(event = {}) {
  return event.scheduledAt || event.publishedAt || event.updatedAt || event.observedAt || null;
}

function buildEventTimeHtml(event = {}, now = Date.now()) {
  const timestamp = primaryEventTimestamp(event);
  const sourceTimezone = event.source?.timezone || "UTC";
  const localTimezone = resolvedLocalTimezone();
  return `
    <div class="awareness-event-time">
      <strong>${escapeHtml(formatAwarenessCountdown(event, now))}</strong>
      <time datetime="${escapeHtml(timestamp || "")}">Local (${escapeHtml(localTimezone)}): ${escapeHtml(formatZonedTimestamp(timestamp))}</time>
      <span>Source TZ (${escapeHtml(sourceTimezone)}): ${escapeHtml(formatZonedTimestamp(timestamp, sourceTimezone))}</span>
    </div>`;
}

function eventBadge(label, className = "") {
  return `<span class="awareness-badge ${escapeHtml(className)}">${escapeHtml(label)}</span>`;
}

function buildEventBadges(event = {}) {
  const badges = [
    eventBadge(event.importance, `awareness-importance-${event.importance}`),
    eventBadge(event.status),
    eventBadge(event.kind.replaceAll("_", " "))
  ];
  if (event.source?.official) {
    badges.push(eventBadge("official", "awareness-badge-official"));
  }
  badges.push(eventBadge(event.claimStatus, `awareness-claim-${event.claimStatus}`));
  if (event.location) {
    badges.push(eventBadge(`precision: ${event.location.precision}`, `awareness-precision-${event.location.precision}`));
  }
  if (event.dataMode === "stale" || event.provenance?.stale) {
    badges.push(eventBadge("stale", "awareness-badge-stale"));
  }
  return badges.join("");
}

function buildEventScopeHtml(event = {}) {
  const scope = [
    ...(event.domains || []),
    ...(event.countries || []),
    ...(event.instrumentIds || []),
    ...(event.sectors || []),
    ...(event.assetClasses || [])
  ].slice(0, 12);
  return scope.length
    ? `<div class="awareness-event-scope">${scope.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>`
    : "";
}

export function buildAwarenessEventHtml(rawEvent = {}, preference = {}, now = Date.now()) {
  const event = normalizeAwarenessEvent(rawEvent);
  if (!event) {
    return "";
  }
  const key = awarenessEventKey(event);
  const canonicalUrl = safeCanonicalUrl(event.canonicalUrl);
  const sourceLink = canonicalUrl
    ? `<a class="awareness-source-link" href="${escapeHtml(canonicalUrl)}" target="_blank" rel="noopener noreferrer" data-awareness-action="open-source" data-awareness-key="${escapeHtml(key)}">${escapeHtml(event.source.name)}</a>`
    : `<span class="awareness-source-name">${escapeHtml(event.source.name)}</span>`;
  const location = event.location?.label
    ? `<span>Location: ${escapeHtml(event.location.label)}</span>`
    : "";
  const read = preference.read === true;

  return `
    <article class="awareness-event-card${read ? " is-read" : ""}" data-awareness-event-key="${escapeHtml(key)}">
      <div class="awareness-event-heading">
        <div>
          <div class="awareness-event-badges">${buildEventBadges(event)}</div>
          <h4>${escapeHtml(event.title)}</h4>
        </div>
        <span class="awareness-read-state">${read ? "leído" : "nuevo"}</span>
      </div>
      ${event.summary ? `<p>${escapeHtml(truncate(event.summary))}</p>` : ""}
      ${buildEventTimeHtml(event, now)}
      <div class="awareness-event-source">
        ${sourceLink}
        <span>role: ${escapeHtml(event.source.role)}</span>
        ${location}
      </div>
      ${buildEventScopeHtml(event)}
      <div class="awareness-event-actions">
        <button class="btn btn-sm btn-outline-light" type="button" data-awareness-action="toggle-read" data-awareness-key="${escapeHtml(key)}">${read ? "Marcar no leído" : "Marcar leído"}</button>
        <button class="btn btn-sm btn-outline-secondary" type="button" data-awareness-action="dismiss" data-awareness-key="${escapeHtml(key)}">Descartar</button>
      </div>
    </article>`;
}

function defaultPreferenceState() {
  return { version: 1, entries: {}, storageAvailable: true };
}

function loadPreferenceState(storage) {
  const state = defaultPreferenceState();
  if (!storage || typeof storage.getItem !== "function") {
    state.storageAvailable = false;
    return state;
  }
  try {
    const parsed = JSON.parse(storage.getItem(AWARENESS_PREFERENCES_KEY) || "null");
    if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      state.entries = parsed.entries;
    }
  } catch {
    state.storageAvailable = false;
  }
  return state;
}

function persistPreferenceState(state, storage) {
  const entries = Object.fromEntries(
    Object.entries(state.entries || {})
      .sort(([, left], [, right]) => Number(right.changedAt || 0) - Number(left.changedAt || 0))
      .slice(0, PREFERENCE_LIMIT)
  );
  state.entries = entries;
  if (!storage || typeof storage.setItem !== "function") {
    state.storageAvailable = false;
    return false;
  }
  try {
    storage.setItem(AWARENESS_PREFERENCES_KEY, JSON.stringify({ version: 1, entries }));
    state.storageAvailable = true;
    return true;
  } catch {
    state.storageAvailable = false;
    return false;
  }
}

function preferenceFor(state, event) {
  return state.entries?.[awarenessEventKey(event)] || {};
}

function isDismissed(state, event) {
  return preferenceFor(state, event).dismissed === true;
}

function setPreference(state, key, values = {}) {
  if (!key) {
    return;
  }
  state.entries[key] = {
    ...(state.entries[key] || {}),
    ...values,
    changedAt: Date.now()
  };
}

function eventListHtml(events, preferences, now, emptyMessage) {
  const html = events
    .filter((event) => !isDismissed(preferences, event))
    .map((event) => buildAwarenessEventHtml(event, preferenceFor(preferences, event), now))
    .join("");
  return html || `<div class="awareness-empty-state">${escapeHtml(emptyMessage)}</div>`;
}

function sourceStatusSummary(sourceStatus = []) {
  const statuses = Array.isArray(sourceStatus) ? sourceStatus : [];
  const degraded = statuses.filter((item) => item?.stale === true || ["stale", "degraded", "failed", "error"].includes(String(item?.status || "").toLowerCase())).length;
  return `${statuses.length} fuentes${degraded ? ` · ${degraded} degradadas` : ""}`;
}

function generatedAtLabel(value) {
  return value ? formatZonedTimestamp(value) : "--";
}

function renderToastHtml(event) {
  const canonicalUrl = safeCanonicalUrl(event.canonicalUrl);
  const key = awarenessEventKey(event);
  const link = canonicalUrl
    ? `<a href="${escapeHtml(canonicalUrl)}" target="_blank" rel="noopener noreferrer" data-awareness-action="open-source" data-awareness-key="${escapeHtml(key)}">Abrir fuente</a>`
    : "";
  return `
    <div class="awareness-toast-copy">
      <div class="awareness-toast-kicker">${escapeHtml(event.importance)} · ${escapeHtml(event.source?.name || "Awareness")}</div>
      <strong>${escapeHtml(event.title)}</strong>
      <span>${escapeHtml(formatAwarenessCountdown(event))}</span>
      ${link}
    </div>
    <button type="button" aria-label="Cerrar alerta" data-awareness-action="close-toast">×</button>`;
}

export function mountAwarenessCenter({
  api,
  rootIds = {},
  intervalMs = 60_000,
  hiddenIntervalMs = 180_000,
  storage = typeof window !== "undefined" ? window.localStorage : null
} = {}) {
  const ids = { ...DEFAULT_ROOT_IDS, ...rootIds };
  const roots = Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, document.getElementById(id)]));
  if (!roots.panel || !roots.upcoming || !roots.recent || !roots.tabs) {
    return { applyRealtime() {}, syncCompact() {}, refresh: () => Promise.resolve(null), stop() {} };
  }

  let snapshot = normalizeAwarenessPayload();
  let preferences = loadPreferenceState(storage);
  let activeTab = "all";
  let stopped = false;
  let requestInFlight = false;
  let requestToken = 0;
  let initialHydrationSettled = false;
  const toastTimers = new Set();

  function visibleEvents(events = []) {
    return events.filter((event) => eventMatchesAwarenessTab(event, activeTab) && !isDismissed(preferences, event));
  }

  function unreadEvents() {
    return allAwarenessEvents(snapshot).filter((event) => {
      const preference = preferenceFor(preferences, event);
      return preference.read !== true && preference.dismissed !== true;
    });
  }

  function render() {
    const now = Date.now();
    const upcoming = visibleEvents(snapshot.upcoming);
    const recent = visibleEvents(snapshot.recent);
    const unreadCount = unreadEvents().length;
    roots.upcoming.innerHTML = eventListHtml(upcoming, preferences, now, "No hay eventos próximos para este filtro.");
    roots.recent.innerHTML = eventListHtml(recent, preferences, now, "No hay eventos recientes para este filtro.");
    roots.panel.dataset.awarenessMode = snapshot.mode;
    roots.panel.dataset.awarenessRevision = String(snapshot.revision);

    for (const button of roots.tabs.querySelectorAll("[data-awareness-tab]")) {
      const selected = normalizeAwarenessTab(button.dataset.awarenessTab) === activeTab;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    if (roots.inboxBadge) {
      roots.inboxBadge.textContent = `${unreadCount} sin leer`;
    }
    if (roots.topbarBadge) {
      roots.topbarBadge.textContent = String(unreadCount);
      roots.topbarBadge.classList.toggle("d-none", unreadCount === 0);
    }
    if (roots.markAllRead) {
      roots.markAllRead.disabled = unreadCount === 0;
    }
    if (roots.meta) {
      const quality = snapshot.quality || {};
      const persistenceNote = preferences.storageAvailable ? "" : " · preferencias sólo en esta sesión";
      roots.meta.textContent = `Modo ${snapshot.mode} · rev ${snapshot.revision} · ${Number(quality.total || 0)} eventos · ${sourceStatusSummary(snapshot.sourceStatus)} · generado ${generatedAtLabel(snapshot.generatedAt)}${persistenceNote}`;
    }
  }

  function dispatchMapProjection() {
    const events = projectLocatedAwarenessEvents(snapshot);
    window.dispatchEvent(new CustomEvent(AWARENESS_MAP_EVENT_NAME, {
      detail: {
        schemaVersion: "awareness-map-projection-v1",
        revision: snapshot.revision,
        generatedAt: snapshot.generatedAt,
        events
      }
    }));
  }

  function showToast(event) {
    if (!roots.toastRegion) {
      return;
    }
    const toast = document.createElement("article");
    toast.className = `awareness-toast awareness-toast-${event.importance}`;
    toast.setAttribute("role", "status");
    toast.dataset.awarenessEventKey = awarenessEventKey(event);
    toast.innerHTML = renderToastHtml(event);
    roots.toastRegion.prepend(toast);
    while (roots.toastRegion.children.length > 3) {
      roots.toastRegion.lastElementChild?.remove();
    }
    const timer = setTimeout(() => {
      toast.remove();
      toastTimers.delete(timer);
    }, 8_000);
    toastTimers.add(timer);
  }

  function suppressBootstrapScheduleAlerts() {
    let changed = false;
    const now = Date.now();
    for (const event of snapshot.upcoming) {
      if (event.importance !== "high" || !event.scheduledAt) continue;
      const deltaMs = new Date(event.scheduledAt).getTime() - now;
      if (!Number.isFinite(deltaMs) || deltaMs <= 0 || deltaMs > 60 * 60_000) continue;
      const values = { alertT60: true };
      if (deltaMs <= 15 * 60_000) values.alertT15 = true;
      setPreference(preferences, awarenessEventKey(event), values);
      changed = true;
    }
    if (changed) persistPreferenceState(preferences, storage);
  }

  function processScheduledAlerts() {
    if (!initialHydrationSettled) return;
    let changed = false;
    const now = Date.now();
    for (const event of snapshot.upcoming) {
      const key = awarenessEventKey(event);
      const preference = preferenceFor(preferences, event);
      const threshold = scheduledAlertThreshold(event, preference, now);
      if (!threshold || isDismissed(preferences, event)) continue;
      const values = threshold === "alertT15" ? { alertT60: true, alertT15: true } : { alertT60: true };
      setPreference(preferences, key, values);
      showToast(event);
      changed = true;
    }
    if (changed) persistPreferenceState(preferences, storage);
  }

  function applyPayload(rawPayload, { realtime = false, delta = false } = {}) {
    const previousEvents = allAwarenessEvents(snapshot);
    const previousKeys = new Set(previousEvents.map(awarenessEventKey));
    const previousById = new Map(previousEvents.map((event) => [event.eventId, event]));
    snapshot = mergeAwarenessPayload(snapshot, rawPayload || {}, { delta });
    render();
    dispatchMapProjection();
    if (realtime && initialHydrationSettled) {
      const incoming = allAwarenessEvents(snapshot)
        .filter((event) => !previousKeys.has(awarenessEventKey(event)))
        .filter((event) => !isDismissed(preferences, event))
        .filter((event) => {
          const previous = previousById.get(event.eventId);
          if (previous && event.revision > previous.revision) return true;
          if (["released", "updated", "cancelled"].includes(event.status)) return true;
          return event.kind === "official_security_release" && event.importance === "high" && event.source?.official === true;
        });
      incoming.slice(0, 3).forEach(showToast);
    }
    return snapshot;
  }

  function renderFailure(error) {
    roots.panel.dataset.awarenessRefresh = "error";
    if (roots.meta) {
      const current = roots.meta.textContent;
      roots.meta.textContent = `Actualización fallida: ${error?.message || "snapshot no disponible"}. ${current}`;
    }
  }

  async function loadSnapshot() {
    if (stopped || requestInFlight || typeof api?.getAwarenessSnapshot !== "function") {
      return null;
    }
    requestInFlight = true;
    const token = ++requestToken;
    try {
      const payload = await api.getAwarenessSnapshot();
      if (!stopped && token === requestToken) {
        roots.panel.dataset.awarenessRefresh = "ok";
        const isBootstrap = !initialHydrationSettled;
        const result = applyPayload(payload || {}, { realtime: false, delta: false });
        if (isBootstrap) suppressBootstrapScheduleAlerts();
        initialHydrationSettled = true;
        if (!isBootstrap) processScheduledAlerts();
        return result;
      }
      return null;
    } catch (error) {
      if (!stopped && token === requestToken) {
        renderFailure(error);
      }
      return null;
    } finally {
      requestInFlight = false;
    }
  }

  function handleAction(event) {
    const actionTarget = event.target.closest("[data-awareness-action]");
    if (!actionTarget) {
      return;
    }
    const action = actionTarget.dataset.awarenessAction;
    if (action === "close-toast") {
      actionTarget.closest(".awareness-toast")?.remove();
      return;
    }
    const key = actionTarget.dataset.awarenessKey;
    if (action === "toggle-read" && key) {
      const current = preferences.entries[key] || {};
      setPreference(preferences, key, { read: current.read !== true, dismissed: false });
      persistPreferenceState(preferences, storage);
      render();
      return;
    }
    if (action === "dismiss" && key) {
      setPreference(preferences, key, { read: true, dismissed: true });
      persistPreferenceState(preferences, storage);
      render();
      return;
    }
    if (action === "open-source" && key) {
      setPreference(preferences, key, { read: true });
      persistPreferenceState(preferences, storage);
      queueMicrotask(render);
    }
  }

  function handleTabClick(event) {
    const button = event.target.closest("[data-awareness-tab]");
    if (!button) {
      return;
    }
    activeTab = normalizeAwarenessTab(button.dataset.awarenessTab);
    render();
  }

  function markAllRead() {
    for (const event of allAwarenessEvents(snapshot)) {
      if (!isDismissed(preferences, event)) {
        setPreference(preferences, awarenessEventKey(event), { read: true });
      }
    }
    persistPreferenceState(preferences, storage);
    render();
  }

  function scrollToPanel() {
    roots.panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  roots.panel.addEventListener("click", handleAction);
  roots.tabs.addEventListener("click", handleTabClick);
  roots.markAllRead?.addEventListener("click", markAllRead);
  roots.topbarButton?.addEventListener("click", scrollToPanel);
  roots.toastRegion?.addEventListener("click", handleAction);

  const loop = new SmartPollLoop({ task: loadSnapshot, intervalMs, hiddenIntervalMs });
  const countdownTimer = setInterval(() => {
    processScheduledAlerts();
    render();
  }, 30_000);
  render();
  loop.start();

  return {
    applyRealtime(payload = {}) {
      const delta = !isFullAwarenessPayload(payload);
      const backfill = payload?.delivery?.backfill === true;
      const result = applyPayload(payload, { realtime: !backfill, delta });
      if (backfill) suppressBootstrapScheduleAlerts();
      return result;
    },
    syncCompact(compact = {}) {
      if (!compact || typeof compact !== "object") {
        return snapshot;
      }
      const delta = {
        revision: compact.revision,
        generatedAt: compact.generatedAt,
        mode: compact.mode,
        sourceStatus: compact.sourceStatus,
        quality: compact.quality
      };
      return applyPayload(delta, { realtime: false, delta: true });
    },
    refresh() {
      loop.trigger(loop.getDelayMs());
      return loadSnapshot();
    },
    stop() {
      stopped = true;
      requestToken += 1;
      loop.stop();
      clearInterval(countdownTimer);
      toastTimers.forEach(clearTimeout);
      toastTimers.clear();
      roots.panel.removeEventListener("click", handleAction);
      roots.tabs.removeEventListener("click", handleTabClick);
      roots.markAllRead?.removeEventListener("click", markAllRead);
      roots.topbarButton?.removeEventListener("click", scrollToPanel);
      roots.toastRegion?.removeEventListener("click", handleAction);
    }
  };
}
