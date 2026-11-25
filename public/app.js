const elements = {
  list: document.querySelector("#errors-list"),
  filter: document.querySelector("#severity-filter"),
  refresh: document.querySelector("#refresh-button"),
  count: document.querySelector("#results-count"),
  empty: document.querySelector("#insight-empty"),
  detail: document.querySelector("#insight-detail"),
  toast: document.querySelector("#toast"),
};

let errors = [];
let selectedId = null;
let refreshTimer;
let mermaidModulePromise;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function getId(error) {
  return String(error.errorId ?? error.id ?? "");
}

function formatTime(value) {
  if (!value) return "Hora no disponible";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("es", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function normalizedSeverity(error) {
  const severity = String(error.criticality || error.severity || "medium").toLowerCase();
  if (["critical", "high", "medium", "low"].includes(severity)) return severity;
  return "medium";
}

function renderMetrics() {
  document.querySelector("#metric-total").textContent = errors.length;
  document.querySelector("#metric-critical").textContent =
    errors.filter((error) => normalizedSeverity(error) === "critical").length;
  document.querySelector("#metric-thinking").textContent =
    errors.filter((error) => error.status === "thinking").length;
  document.querySelector("#metric-services").textContent =
    new Set(errors.map((error) => error.service).filter(Boolean)).size;
}

function renderList() {
  const severityFilter = elements.filter.value;
  const visibleErrors = errors.filter(
    (error) => severityFilter === "all" || normalizedSeverity(error) === severityFilter,
  );
  elements.count.textContent = `${visibleErrors.length} incident${visibleErrors.length === 1 ? "e" : "es"}`;

  if (!visibleErrors.length) {
    elements.list.innerHTML = '<div class="cards-message">No hay errores para mostrar con este filtro.</div>';
    return;
  }

  elements.list.innerHTML = visibleErrors.map((error) => {
    const id = getId(error);
    const severity = normalizedSeverity(error);
    const status = error.status === "answered" ? "answered" : error.status === "thinking" ? "thinking" : "pending";
    const statusLabel = status === "answered" ? "Respuesta lista" : status === "thinking" ? "Pensando…" : "Pendiente";
    const button = status === "pending"
      ? `<button class="consult-button" type="button" data-consult="${escapeHtml(id)}">Consultar…</button>`
      : "";
    return `<article class="error-card ${id === selectedId ? "selected" : ""}" data-row="${escapeHtml(id)}" role="button" tabindex="0" aria-pressed="${id === selectedId}">
      <div class="error-card-heading">
        <div class="error-name" title="${escapeHtml(error.message || error.errorType || "Error sin descripción")}">${escapeHtml(error.message || error.errorType || "Error sin descripción")}</div>
        <span class="card-chevron" aria-hidden="true">↗</span>
      </div>
      <div class="error-service">${escapeHtml(error.service || "Servicio sin nombre")} · ${escapeHtml(formatTime(error.timestamp))}</div>
      <div class="card-fields">
        <div class="card-field"><span class="card-label">CATEGORÍA</span><span class="category-cell">${escapeHtml(error.category || "General")}</span></div>
        <div class="card-field"><span class="card-label">CRITICIDAD</span><span class="severity severity-${severity}">${severity === "critical" ? "CRÍTICA" : severity === "high" ? "ALTA" : severity === "low" ? "BAJA" : "MEDIA"}</span></div>
        <div class="card-field card-agent-field"><span class="card-label">ESTADO DEL AGENTE</span><span class="agent-state ${status}"><i></i>${statusLabel}</span></div>
      </div>
      ${button ? `<div class="card-action">${button}</div>` : ""}</article>`;
  }).join("");
}

function renderDetail(error) {
  if (!error) {
    elements.empty.classList.remove("hidden");
    elements.detail.classList.add("hidden");
    return;
  }

  elements.empty.classList.add("hidden");
  elements.detail.classList.remove("hidden");
  const severity = normalizedSeverity(error);
  const response = error.agentResponse || error.response;
  const origin = error.agentOrigin || error.origin;
  const diagram = error.agentMermaid || error.mermaid;
  const analysisContent = error.status === "thinking"
    ? "<p>El agente está investigando el incidente. La respuesta aparecerá aquí cuando esté lista.</p>"
    : response
      ? `<p>${escapeHtml(response)}</p>`
      : "<p>Este incidente aún no tiene un análisis. Usa «Consultar…» para solicitar la investigación del agente.</p>";

  elements.detail.innerHTML = `
    <div class="detail-severity">${severity.toUpperCase()} · ${escapeHtml(error.category || "GENERAL")}</div>
    <h2 class="detail-title">${escapeHtml(error.message || error.errorType || "Error sin descripción")}</h2>
    <div class="detail-meta">${escapeHtml(error.service || "Servicio sin nombre")} · ${escapeHtml(formatTime(error.timestamp))}</div>
    <section class="detail-section"><h3>ESTADO DEL ANÁLISIS</h3>${analysisContent}</section>
    ${origin ? `<section class="detail-section"><h3>ORIGEN DEL ERROR</h3><p>${escapeHtml(origin)}</p></section>` : ""}
    ${diagram ? `<section class="detail-section"><h3>FLUJO DEL INCIDENTE</h3><div id="mermaid-diagram" class="detail-code">${escapeHtml(diagram)}</div></section>` : ""}
    ${error.log ? `<section class="detail-section"><h3>LOG ORIGINAL</h3><pre class="detail-code">${escapeHtml(error.log)}</pre></section>` : ""}
    ${error.status === "pending" ? `<button class="consult-button" type="button" data-consult="${escapeHtml(getId(error))}">Consultar…</button>` : ""}`;
  if (diagram) renderMermaid(diagram);
}

function renderMermaid(source) {
  const container = document.querySelector("#mermaid-diagram");
  if (!container) return;
  container.dataset.source = source;
  mermaidModulePromise ||= import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs");
  mermaidModulePromise
    .then(({ default: mermaid }) => {
      if (!container.isConnected || container.dataset.source !== source) return null;
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
      return mermaid.render(`incident-${Date.now()}`, source);
    })
    .then((result) => {
      if (result && container.isConnected && container.dataset.source === source) {
        container.innerHTML = result.svg;
        container.classList.add("mermaid-output");
      }
    })
    .catch(() => {
      if (container.isConnected && container.dataset.source === source) {
        container.textContent = source;
      }
    });
}

function selectError(id) {
  selectedId = id;
  renderList();
  renderDetail(errors.find((error) => getId(error) === id));
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => elements.toast.classList.add("hidden"), 4500);
}

async function loadErrors({ quiet = false } = {}) {
  if (!quiet) {
    elements.list.innerHTML = '<div class="cards-message">Cargando errores…</div>';
  }
  try {
    const response = await fetch("/api/errors");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "No se pudieron cargar los errores.");
    errors = result.errors || [];
    renderMetrics();
    renderList();
    renderDetail(errors.find((error) => getId(error) === selectedId));
  } catch (error) {
    if (!quiet) {
      elements.list.innerHTML = `<div class="cards-message error">${escapeHtml(error.message)}</div>`;
      elements.count.textContent = "Error de conexión";
    }
  }
}

async function consultError(id) {
  if (!id) {
    showToast("Este registro no tiene un identificador de error válido.");
    return;
  }
  const button = document.querySelector(`[data-consult="${CSS.escape(id)}"]`);
  if (button) {
    button.disabled = true;
    button.textContent = "Consultando…";
  }
  const error = errors.find((item) => getId(item) === id);
  if (error) {
    error.status = "thinking";
    selectError(id);
  }

  try {
    const response = await fetch(`/api/errors/${encodeURIComponent(id)}/consult`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "No se pudo consultar al agente.");
    const index = errors.findIndex((item) => getId(item) === id);
    if (index >= 0) errors[index] = result.error;
    renderMetrics();
    renderList();
    renderDetail(result.error);
  } catch (error) {
    showToast(error.message);
    await loadErrors({ quiet: true });
    if (selectedId) renderDetail(errors.find((item) => getId(item) === selectedId));
  }
}

elements.list.addEventListener("click", (event) => {
  const consultButton = event.target.closest("[data-consult]");
  if (consultButton) {
    event.stopPropagation();
    consultError(consultButton.dataset.consult);
    return;
  }
  const row = event.target.closest("[data-row]");
  if (row) selectError(row.dataset.row);
});
elements.list.addEventListener("keydown", (event) => {
  const card = event.target.closest("[data-row]");
  if (!card || event.target.closest("button")) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectError(card.dataset.row);
  }
});
elements.detail.addEventListener("click", (event) => {
  const consultButton = event.target.closest("[data-consult]");
  if (consultButton) consultError(consultButton.dataset.consult);
});
elements.filter.addEventListener("change", renderList);
elements.refresh.addEventListener("click", () => loadErrors());

loadErrors();
refreshTimer = setInterval(() => loadErrors({ quiet: true }), 15000);
window.addEventListener("pagehide", () => clearInterval(refreshTimer), { once: true });
