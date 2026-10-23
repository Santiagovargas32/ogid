// Trusted UI markup only. Model/source text is always rendered with textContent.
import {fillAgentModels} from "./agentModels.js";
import {observeInterest} from './interest.js';
import {request as coordinatedRequest} from './api.js';
export function mountAgentIntelligence({getWatchlist=()=>null,deferUntilInterested=false}={}) {
  const byId = (id) => document.getElementById(id);
  let csrf = "",
    sessionId = "",
    model = "",
    runId = "",
    events,
    stopped = false;
  const sessions = new Map();
  let initialization,capabilitiesState=null,interest=null;
  const request = async (path, options = {}) => {
    if(!options.method || options.method==='GET')return coordinatedRequest(path,{},
      {...options,headers:{...(csrf?{'x-ogid-csrf':csrf}:{}),...options.headers}});
    const r = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(csrf ? { "x-ogid-csrf": csrf } : {}),
        ...options.headers,
      },
    });
    const d = await r.json();
    if (!r.ok)
      throw new Error(d.error?.message || d.error?.code || `HTTP ${r.status}`);
    return d.ok === true ? d.data : d;
  };
  const node = (tag, text, className) => {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (className) e.className = className;
    return e;
  };
  const button = (text, handler) => {
    const b = node("button", text, "btn btn-sm btn-outline-info");
    b.type = "button";
    b.addEventListener("click", handler);
    return b;
  };
  const drawer = document.createElement("dialog");
  drawer.className = "agent-chat-dialog";
  drawer.setAttribute("aria-labelledby", "agent-chat-title");
  drawer.innerHTML =
    '<header class="agent-chat-header"><h2 id="agent-chat-title">OGID Analyst</h2><button type="button" data-close aria-label="Cerrar chat">×</button></header><p data-status role="status">Comprobando acceso…</p><div class="agent-chat-controls"><select data-model aria-label="Modelo"></select><select data-session aria-label="Conversación"><option value="">Nueva conversación</option></select><button data-new type="button">Nueva</button><button data-authorize type="button">Autorizar dispositivo</button></div><p data-context>Contexto: global · Horizonte evaluable: 24 h</p><div data-messages class="agent-chat-messages" role="log" aria-live="polite"></div><form><label for="agent-chat-input">Consulta al analista</label><textarea id="agent-chat-input" rows="3" required></textarea><div><button type="submit">Enviar</button><button data-cancel type="button">Cancelar generación</button></div></form>';
  document.body.append(drawer);
  const status = drawer.querySelector("[data-status]"),
    messages = drawer.querySelector("[data-messages]"),
    select = drawer.querySelector("[data-model]"),
    sessionSelect = drawer.querySelector("[data-session]"),
    input = drawer.querySelector("textarea");
  const reloadModels=button("Actualizar modelos",()=>void loadModels().catch(showError));
  select.after(reloadModels);
  async function loadModels(){
    reloadModels.disabled=true;
    try{
      const catalog=await request("/api/agent/v1/models");
      fillAgentModels(select,catalog,model || catalog.backgroundModel);
      model=select.value;
      if(catalog.state!=="ready")status.textContent="OpenCode no está disponible; actualiza los modelos cuando esté iniciado.";
    }finally{reloadModels.disabled=false;}
  }
  let context = [],
    pendingSend = null,
    historyTail = 0,
    olderCursor = null,
    sessionCursor = null,
    alertCursor = null;
  const loadedMessages = new Map();
  const older = button("Cargar mensajes anteriores", () =>
    history({ older: true }).catch(showError),
  );
  older.hidden = true;
  messages.before(older);
  const moreSessions = button("Más conversaciones", () =>
    loadSessions(true).catch(showError),
  );
  moreSessions.hidden = true;
  sessionSelect.after(moreSessions);
  drawer.querySelector("[data-close]").onclick = () => drawer.close();
  function open(ids = []) {
    context = ids;
    drawer.querySelector("[data-context]").textContent =
      `Contexto adjunto: ${ids.join(", ") || "global"} · Horizonte evaluable: 24 h`;
    drawer.showModal();
    void initialize().then(async()=>{
      try{const d=await request('/api/agent/v1/access');csrf=d.csrf;await loadSessions();}catch{/* Enrollment remains explicit. */}
    }).catch(showError);
    void loadModels().catch(showError);
    input.focus();
  }
  function showMessage(role, text) {
    const article = node(
      "article",
      null,
      `agent-message agent-message-${role}`,
    );
    article.append(
      node("strong", role === "user" ? "Tú" : "OGID Analyst"),
      node("p", text),
    );
    messages.append(article);
    return article;
  }
  function resetHistory() {
    historyTail = 0;
    olderCursor = null;
    loadedMessages.clear();
    messages.replaceChildren();
    older.hidden = true;
  }
  async function history({ older: backwards = false } = {}) {
    if (!sessionId) return;
    const targetSession = sessionId,
      initial = !historyTail,
      query = new URLSearchParams({
        limit: "40",
        ...(backwards
          ? { before: String(olderCursor) }
          : initial
            ? { latest: "1" }
            : { cursor: String(historyTail) }),
      });
    const page = await request(
      `/api/agent/v1/chat/sessions/${sessionId}/messages?${query}`,
    );
    if (targetSession !== sessionId) return;
    if (!backwards) {
      runId = page.activeRun?.jobId || "";
      if (page.activeRun)
        status.textContent = `${page.activeRun.status}${page.activeRun.errorCode ? " · " + page.activeRun.errorCode : ""}`;
    }
    const retained = messages.scrollTop,
      nearBottom =
        messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    if (initial || backwards) olderCursor = page.olderCursor;
    for (const m of page.items) {
      loadedMessages.set(m.messageId, m);
      historyTail = Math.max(historyTail, m.sequence);
    }
    messages.replaceChildren();
    for (const m of [...loadedMessages.values()].sort(
      (a, b) => a.sequence - b.sequence,
    )) {
      const article = showMessage(m.role, m.text);
      if (m.snapshotId && m.evidenceIds?.length)
        article.append(
          button("Ver fuentes", () =>
            showEvidence({
              snapshotId: m.snapshotId,
              proposal: { evidenceIds: m.evidenceIds },
            }).catch(showError),
          ),
        );
    }
    older.hidden = !olderCursor;
    messages.scrollTop =
      nearBottom && !backwards ? messages.scrollHeight : retained;
    if (!initial && !backwards && page.hasMore)
      messages.append(
        button("Cargar mensajes siguientes", () => history().catch(showError)),
      );
  }
  function connect() {
    events?.close();
    if (!sessionId) return;
    const eventSession = sessionId;
    events = new EventSource(`/api/agent/v1/chat/sessions/${sessionId}/events`);
    events.addEventListener("update", async (e) => {
      if (eventSession !== sessionId) return;
      const v = JSON.parse(e.data);
      if (v.reconcile || v.done) {
        await history().catch(showError);
        if (v.jobId) {
          const run = await request(`/api/agent/v1/runs/${v.jobId}`).catch(
            () => null,
          );
          if (
            run &&
            eventSession === sessionId &&
            (!runId || runId === v.jobId)
          )
            status.textContent = `${run.status}${run.errorCode ? " · " + run.errorCode : ""}`;
        }
        return;
      }
      runId = v.jobId || runId;
      let pending = messages.querySelector("[data-stream]");
      if (!pending) {
        pending = showMessage("assistant", "");
        pending.dataset.stream = "true";
      }
      pending.querySelector("p").textContent =
        v.text || "Consultando herramientas…";
      status.textContent =
        (v.tools || []).map((t) => `${t.name}: ${t.status}`).join(" · ") ||
        "Generando…";
    });
    events.onerror = () => {
      status.textContent = "Reconectando; se conservará el historial";
    };
  }
  function showError(e) {
    status.textContent = e.message;
  }
  async function loadSessions(more = false) {
    const d = await request(
      "/api/agent/v1/chat/sessions?limit=20" +
        (more && sessionCursor
          ? "&cursor=" + encodeURIComponent(sessionCursor)
          : ""),
    );
    if (!more) {
      sessionSelect.replaceChildren(node("option", "Nueva conversación"));
      sessionSelect.firstChild.value = "";
      sessions.clear();
    }
    for (const item of d.items) {
      if (sessions.has(item.sessionId)) continue;
      sessions.set(item.sessionId, item);
      const o = node("option", item.title);
      o.value = item.sessionId;
      sessionSelect.append(o);
    }
    sessionCursor = d.nextCursor;
    moreSessions.hidden = !d.hasMore;
    if (sessionId) sessionSelect.value = sessionId;
  }
  sessionSelect.onchange = async () => {
    sessionId = sessionSelect.value;
    if (sessions.has(sessionId)) {
      model = sessions.get(sessionId).model;
      select.value = model;
    }
    resetHistory();
    pendingSend = null;
    runId = "";
    await history().catch(showError);
    connect();
  };
  drawer.querySelector("[data-new]").onclick = () => {
    sessionId = "";
    sessionSelect.value = "";
    events?.close();
    resetHistory();
    pendingSend = null;
    runId = "";
  };
  select.onchange = () => {
    model = select.value;
    sessionId = "";
    sessionSelect.value = "";
    events?.close();
    resetHistory();
    pendingSend = null;
    runId = "";
    status.textContent =
      "El modelo se aplicará a una nueva conversación; no cambia el análisis de fondo.";
  };
  drawer.querySelector("[data-authorize]").onclick = async () => {
    try {
      const d = await request("/api/agent/v1/access/device", {
        method: "POST",
        body: JSON.stringify({ label: "Navegador personal" }),
      });
      csrf = d.csrf;
      status.textContent = "Dispositivo autorizado";
      await loadSessions();
      await refresh();
    } catch (e) {
      showError(e);
    }
  };
  drawer.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    if (!csrf) {
      status.textContent = "Autoriza primero este dispositivo";
      return;
    }
    const text = input.value;
    if (!text.trim()) return;
    try {
      if (!sessionId) {
        const s = await request("/api/agent/v1/chat/sessions", {
          method: "POST",
          body: JSON.stringify({ model, title: text.substring(0, 80) }),
        });
        sessionId = s.sessionId;
        await loadSessions();
        connect();
      }
      const fingerprint = JSON.stringify({ sessionId, text, context });
      if (pendingSend?.fingerprint !== fingerprint)
        pendingSend = {
          fingerprint,
          key: Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join(""),
        };
      const key = pendingSend.key;
      const d = await request(
        `/api/agent/v1/chat/sessions/${sessionId}/messages`,
        { method: "POST", body: JSON.stringify({ key, text, context }) },
      );
      runId = d.jobId;
      pendingSend = null;
      await history();
      input.value = "";
      status.textContent = "En cola";
    } catch (e) {
      showError(e);
    }
  };
  drawer.querySelector("[data-cancel]").onclick = async () => {
    if (!runId) return;
    try {
      await request(`/api/agent/v1/runs/${runId}/cancel`, {
        method: "POST",
        body: "{}",
      });
      status.textContent = "Cancelación solicitada";
    } catch (e) {
      showError(e);
    }
  };
  function publication(target, data) {
    if (!target) return;
    const previous = target.scrollTop;
    target.replaceChildren();
    if (!data?.items?.length) {
      target.append(
        node(
          "p",
          "Sin publicación validada disponible. La evidencia determinista sigue accesible.",
        ),
      );
      return;
    }
    for (const p of data.items) {
      const article = node("article", null, "agent-publication");
      article.append(
        node("p", p.proposal.summary),
        node(
          "small",
          `${p.status} · Evidencia ${p.evidenceAsOf} · Publicado ${p.publishedAt}`,
        ),
      );
      if (p.proposal.task.includes("outlook")) {
        article.append(
          node(
            "p",
            `${p.proposal.direction} · sentimiento ${p.proposal.sentiment} · estabilidad ${p.proposal.stability} · ${p.proposal.horizonHours} h`,
          ),
          node("p", "Sin probabilidad calibrada"),
          node(
            "small",
            `Ventana de evidencia: ${p.coverage?.windowHours || 24} h · Universo: ${(p.coverage?.selectedInstrumentIds || []).join(", ") || "cobertura sin instrumentos verificados"} · Target: ${p.proposal.target || "no disponible"}`,
          ),
        );
        for (const driver of p.proposal.drivers || [])
          article.append(node("p", `${driver.domain}: ${driver.description}`));
        for (const scenario of p.proposal.scenarios || [])
          article.append(
            node("p", `Escenario ${scenario.name}: ${scenario.description}`),
          );
        for (const alternative of p.proposal.alternatives || [])
          article.append(node("p", `Alternativa: ${alternative}`));
        for (const missing of p.proposal.missingEvidence || [])
          article.append(node("p", `Dato necesario: ${missing}`));
        for (const intraday of p.proposal.intradayScenarios || [])
          article.append(
            node(
              "p",
              `Escenario intradía ${intraday.horizonMinutes} min (${intraday.interval}): ${intraday.direction} · ${intraday.summary} · evaluación no disponible`,
            ),
          );
        article.append(
          button("Ver evaluación diaria", async () => {
            try {
              const result = await request(
                "/api/research/forecast-evaluation" +
                  (p.proposal.instrumentId
                    ? "?instrumentIds=" +
                      encodeURIComponent(p.proposal.instrumentId)
                    : ""),
              );
              open([p.publicationId]);
              showMessage("tool", JSON.stringify(result, null, 2));
            } catch (e) {
              showError(e);
            }
          }),
        );
        for (const v of p.proposal.invalidation)
          article.append(node("p", `Invalidación: ${v}`));
      }
      for (const limitation of p.proposal.limitations || [])
        article.append(node("p", `Limitación: ${limitation}`));
      if (p.proposal.contradictions.length)
        article.append(
          node(
            "p",
            `Contradicciones: ${p.proposal.contradictions.join(" · ")}`,
          ),
        );
      article.append(
        button("Ver evidencia", () => showEvidence(p).catch(showError)),
        button("Consultar al agente", () => open([p.publicationId])),
      );
      target.append(article);
    }
    target.scrollTop = previous;
  }
  async function showEvidence(publication) {
    open([publication.publicationId].filter(Boolean));
    messages.replaceChildren();
    for (const id of publication.proposal.evidenceIds) {
      let offset = 0,
        detail;
      const parts = [];
      do {
        detail = await request(
          `/api/agent/v1/evidence/chunk?snapshotId=${encodeURIComponent(publication.snapshotId)}&evidenceId=${encodeURIComponent(id)}&offset=${offset}`,
        );
        parts.push(Uint8Array.from(atob(detail.chunk), (c) => c.charCodeAt(0)));
        offset = detail.nextOffset;
      } while (detail.hasMore);
      const size = parts.reduce((n, b) => n + b.length, 0),
        bytes = new Uint8Array(size);
      let n = 0;
      for (const b of parts) {
        bytes.set(b, n);
        n += b.length;
      }
      const digest = crypto.subtle
        ? Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("")
        : null;
      if (size !== detail.bytes || (digest && digest !== detail.sha256))
        throw new Error("La evidencia no coincide con su hash");
      const evidence = JSON.parse(new TextDecoder().decode(bytes));
      const item = showMessage(
        "tool",
        `${id} · Disponible ${evidence.availableAt}\n${evidence.data.title || evidence.domain}\n${evidence.data.excerpt || JSON.stringify(evidence.data)}`,
      );
      const url = evidence.data.url || evidence.data.canonicalUrl;
      if (url) {
        const u = new URL(url);
        if (["http:", "https:"].includes(u.protocol)) {
          const a = node("a", "Fuente original");
          a.href = u.href;
          a.rel = "noopener noreferrer";
          a.target = "_blank";
          item.append(a);
        }
      }
    }
  }
  async function refresh() {
    if (stopped || interest?.interested===false || capabilitiesState?.mode!=='visible') return;
    const results = await Promise.allSettled([
      request("/api/agent/v1/brief"),
      request(
        "/api/agent/v1/outlooks" +
          (byId("agent-outlook-instrument")?.value
            ? "?instrumentId=" +
              encodeURIComponent(byId("agent-outlook-instrument").value)
            : ""),
      ),
      ...(csrf ? [request("/api/alerts/v1/geopolitical?" + alertQuery())] : []),
      request("/api/agent/v1/geopolitical"),
    ]);
    if (results[0].status === "fulfilled")
      publication(byId("agent-brief-body"), results[0].value);
    if (results[1].status === "fulfilled")
      publication(byId("agent-outlooks-body"), results[1].value);
    if (csrf && results[2]?.status === "fulfilled")
      renderInbox(results[2].value);
    const geopolitical = results.at(-1);
    if (geopolitical.status === "fulfilled")
      publication(byId("agent-geopolitical-body"), geopolitical.value);
  }
  const inbox = byId("geopolitical-alert-inbox");
  const stateFilter = node("select"),
    severityFilter = node("select");
  stateFilter.setAttribute("aria-label", "Estado de alertas");
  severityFilter.setAttribute("aria-label", "Severidad de alertas");
  for (const [v, label] of [
    ["open", "Activas"],
    ["unread", "Sin leer"],
    ["archived", "Archivadas"],
    ["all", "Todas"],
  ]) {
    const o = node("option", label);
    o.value = v;
    stateFilter.append(o);
  }
  for (const [v, label] of [
    ["all", "Toda severidad"],
    ["high", "Elevada o crítica"],
    ["critical", "Crítica"],
  ]) {
    const o = node("option", label);
    o.value = v;
    severityFilter.append(o);
  }
  const moreAlerts = button("Más alertas", async () => {
    try {
      renderInbox(
        await request("/api/alerts/v1/geopolitical?" + alertQuery(alertCursor)),
        true,
      );
    } catch (e) {
      showError(e);
    }
  });
  moreAlerts.hidden = true;
  if (inbox) {
    const controls = node("div", null, "agent-chat-controls");
    controls.append(stateFilter, severityFilter);
    inbox.before(controls);
    inbox.after(moreAlerts);
  }
  stateFilter.onchange = severityFilter.onchange = () =>
    refresh().catch(showError);
  function alertQuery(cursor) {
    return new URLSearchParams({
      limit: "20",
      state: stateFilter.value,
      severity: severityFilter.value,
      ...(cursor ? { cursor } : {}),
    }).toString();
  }
  function renderInbox(data, append = false) {
    if (!inbox) return;
    const y = inbox.scrollTop;
    if (!append) inbox.replaceChildren();
    for (const alert of data.items) {
      const item = node("article", null, "agent-alert");
      item.append(
        node("h3", alert.title),
        node("p", alert.summary),
        node(
          "small",
          `${alert.severity} · r${alert.revision} · ${alert.sourceId} · ${alert.verification} · ${alert.publishedAt || alert.receivedAt}`,
        ),
      );
      if (alert.agentAssessment)
        item.append(
          node("p", `Valoración del agente: ${alert.agentAssessment.summary}`),
        );
      if (alert.url) {
        try {
          const u = new URL(alert.url);
          if (["http:", "https:"].includes(u.protocol)) {
            const a = node("a", "Fuente original");
            a.href = u.href;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            item.append(a);
          }
        } catch {}
      }
      const save = async (read, archived) => {
        await request(
          `/api/alerts/v1/geopolitical/${encodeURIComponent(alert.alertId)}/state`,
          { method: "PATCH", body: JSON.stringify({ read, archived }) },
        );
        await refresh();
      };
      item.append(
        button(alert.read ? "Marcar sin leer" : "Marcar leído", () =>
          save(!alert.read, alert.archived).catch(showError),
        ),
        button(alert.archived ? "Restaurar" : "Archivar", () =>
          save(true, !alert.archived).catch(showError),
        ),
        button("Consultar", () => open([alert.alertId])),
      );
      inbox.append(item);
    }
    if (!inbox.children.length)
      inbox.append(
        node(
          "p",
          "Sin alertas para este filtro. Cobertura parcial de fuentes admitidas.",
        ),
      );
    alertCursor = data.nextCursor;
    moreAlerts.hidden = !data.hasMore;
    inbox.scrollTop = y;
  }
  const brief = byId("agent-brief-body");
  const openChat = button("Abrir chat", () => open());
  openChat.id = "agent-chat-open";
  brief?.before(openChat);
  inbox?.append(
    node(
      "p",
      "Autoriza este dispositivo desde el chat para consultar tu bandeja.",
    ),
    button("Abrir chat", () => open()),
  );
  function initialize() {
    if(initialization)return initialization;
    initialization=(async()=>{
    try {
      const capabilities = await request("/api/agent/v1/capabilities");
      capabilitiesState=capabilities;
      const watchlist = await getWatchlist() || await request("/api/market/watchlist").catch(() => ({
        instruments: [],
      }));
      const instruments = byId("agent-outlook-instrument");
      if (instruments) {
        for (const i of watchlist.instruments || []) {
          const option = node(
            "option",
            `${i.symbol || i.canonicalSymbol} · ${i.exchange || ""} · ${i.currency || ""}`,
          );
          option.value = i.instrumentId;
          instruments.append(option);
        }
        instruments.onchange = () => void refresh().catch(showError);
      }
      status.textContent =
        capabilities.mode === "off"
          ? "Analista desactivado. Los datos deterministas continúan disponibles."
          : "Análisis experimental · evaluación diaria disponible según cobertura";
      await refresh();
    } catch (e) {
      showError(e);
    }
    })();
    return initialization;
  }
  if(deferUntilInterested)interest=observeInterest(brief?.closest('article')||brief,active=>{if(active)void initialize();});
  else void initialize();
  const timer = setInterval(() => void refresh().catch(showError), 30000);
  return () => {
    stopped = true;
    clearInterval(timer);
    interest?.destroy();
    events?.close();
    drawer.remove();
  };
}
