const PIXELS_PER_HOUR = 28;
const LANE_LABEL_WIDTH = 190;
const WORK_ORDER_COLORS = {
  "mo-green-pipe": "green",
  "mo-blue-pipe": "blue",
  "mo-yellow-pipe": "yellow",
};
const PRODUCT_COLOR_SEQUENCE = ["green", "blue", "yellow"];

let data = null;
let scenarioIndex = null;
let workCenterById = new Map();
let manufacturingOrderById = new Map();
let manufacturingOrderColorById = new Map();
let workOrderById = new Map();
let scheduledWorkOrderByWorkOrderAndUnit = new Map();
let chartBounds = null;

const tooltipById = new Map();

installScheduleTooltips();
await initializeApp();

async function initializeApp() {
  scenarioIndex = await fetchJson("./schedule-scenarios.json");
  renderScenarioButtons();

  const requestedScenarioId = new URLSearchParams(window.location.search).get("scenario");
  const defaultScenarioId = scenarioIndex.defaultScenarioId ?? scenarioIndex.scenarios[0]?.id;
  await loadScenario(requestedScenarioId ?? defaultScenarioId);
}

async function loadScenario(scenarioId) {
  const scenarioSummary =
    scenarioIndex.scenarios.find((scenario) => scenario.id === scenarioId) ??
    scenarioIndex.scenarios[0];

  if (scenarioSummary === undefined) {
    throw new Error("No schedule scenarios are available.");
  }

  data = await fetchJson(scenarioSummary.dataPath);
  rebuildScenarioState();
  renderPage();
  updateScenarioUrl(data.scenario.id);
}

async function fetchJson(path) {
  const response = await fetch(path);

  if (!response.ok) {
    throw new Error(`Cannot load ${path}: ${response.status}`);
  }

  return response.json();
}

function rebuildScenarioState() {
  workCenterById = new Map(data.workCenters.map((workCenter) => [workCenter.docId, workCenter]));
  manufacturingOrderById = new Map(
    data.manufacturingOrders.map((manufacturingOrder) => [
      manufacturingOrder.docId,
      manufacturingOrder,
    ]),
  );
  manufacturingOrderColorById = new Map(
    data.manufacturingOrders.map((manufacturingOrder, index) => [
      manufacturingOrder.docId,
      WORK_ORDER_COLORS[manufacturingOrder.docId] ??
        PRODUCT_COLOR_SEQUENCE[index % PRODUCT_COLOR_SEQUENCE.length],
    ]),
  );
  workOrderById = new Map(data.workOrders.map((workOrder) => [workOrder.docId, workOrder]));
  scheduledWorkOrderByWorkOrderAndUnit = new Map(
    data.scheduledWorkOrders.map((scheduledWorkOrder) => [
      executionLookupKey(scheduledWorkOrder.workOrderId, scheduledWorkOrder.unitNumber),
      scheduledWorkOrder,
    ]),
  );
  chartBounds = getChartBounds(data);
}

function renderPage() {
  renderScenarioMeta();
  renderScenarioMessage();
  renderHorizon();
  renderSummary();
  renderLegend();
  renderChart();
  renderTopologicalOrder();
  renderQueues();
  renderSourceTables();
}

function renderScenarioButtons() {
  document.querySelector("#scenario-buttons").innerHTML = scenarioIndex.scenarios
    .map(
      (scenario) => `
        <button
          type="button"
          class="scenario-button"
          data-scenario-id="${escapeHtml(scenario.id)}"
        >
          <span>${escapeHtml(scenario.title)}</span>
          <small>${escapeHtml(scenario.expectedStatus)}</small>
        </button>
      `,
    )
    .join("");

  document.querySelector("#scenario-buttons").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-scenario-id]");

    if (!button) {
      return;
    }

    await loadScenario(button.dataset.scenarioId);
  });
}

function renderScenarioMeta() {
  document.querySelector("#scenario-title").textContent = data.scenario.title;
  document.querySelector("#scenario-description").textContent = data.scenario.description;
  document.querySelector("#scenario-notes").innerHTML = data.scenario.notes
    .map((note) => `<li>${escapeHtml(note)}</li>`)
    .join("");

  for (const button of document.querySelectorAll("[data-scenario-id]")) {
    button.classList.toggle("is-active", button.dataset.scenarioId === data.scenario.id);
  }
}

function renderScenarioMessage() {
  const message = document.querySelector("#scenario-message");

  if (data.status === "scheduled") {
    message.hidden = false;
    message.className = "scenario-message success";
    message.innerHTML = `
      <strong>Schedule generated successfully.</strong>
      <span>The algorithm accepted this sample and produced execution bars below.</span>
    `;
    return;
  }

  const cyclePath = data.error?.cyclePath?.length
    ? `<p><strong>Cycle path:</strong> ${data.error.cyclePath.map(escapeHtml).join(" -> ")}</p>`
    : "";

  message.hidden = false;
  message.className = "scenario-message error";
  message.innerHTML = `
    <strong>${escapeHtml(data.error?.name ?? "SchedulingError")}</strong>
    <span>${escapeHtml(data.error?.message ?? "The scheduler rejected this sample.")}</span>
    ${cyclePath}
  `;
}

function updateScenarioUrl(scenarioId) {
  const url = new URL(window.location.href);
  url.searchParams.set("scenario", scenarioId);
  window.history.replaceState({}, "", url);
}

function renderHorizon() {
  document.querySelector("#horizon-label").textContent =
    `${formatDate(data.config.horizonStartDate)} to ${formatDate(data.config.horizonEndDate)}`;
}

function renderSummary() {
  const maintenanceCount = data.workCenters.reduce(
    (total, workCenter) => total + workCenter.data.maintenanceWindows.length,
    0,
  );
  const summaryItems = [
    ["Status", data.status === "scheduled" ? "Scheduled" : "Error"],
    ["Work centers", data.workCenters.length],
    ["Work orders", data.workOrders.length],
    ["Manufacturing orders", data.manufacturingOrders.length],
    ["Scheduled executions", data.scheduledWorkOrders.length],
    ["Blocked windows", maintenanceCount],
  ];

  document.querySelector("#summary").innerHTML = summaryItems
    .map(
      ([label, value]) => `
        <div>
          <span class="summary-value">${value}</span>
          <span class="summary-label">${label}</span>
        </div>
      `,
    )
    .join("");
}

function renderLegend() {
  document.querySelector("#legend").innerHTML = `
    <span><i class="swatch green"></i>Product color A</span>
    <span><i class="swatch blue"></i>Product color B</span>
    <span><i class="swatch yellow"></i>Product color C</span>
    <span><i class="swatch closed"></i>Closed</span>
    <span><i class="swatch maintenance"></i>Maintenance</span>
  `;
}

function renderChart() {
  if (data.status !== "scheduled") {
    tooltipById.clear();
    document.querySelector("#schedule-chart").innerHTML = `
      <div class="empty-chart">
        <strong>No schedule was generated for this sample.</strong>
        <span>The scheduler stopped on the error shown above, so there are no execution bars to display.</span>
      </div>
    `;
    return;
  }

  const timelineHours = hoursBetween(chartBounds.start, chartBounds.end);
  const timelineWidth = Math.ceil(timelineHours * PIXELS_PER_HOUR);
  const ticks = buildTicks(chartBounds.start, chartBounds.end);
  tooltipById.clear();
  const rows = data.workCenters
    .map((workCenter) => renderWorkCenterLane(workCenter, timelineWidth))
    .join("");

  document.querySelector("#schedule-chart").innerHTML = `
    <div class="timeline-content" style="width: ${LANE_LABEL_WIDTH + timelineWidth}px">
      <div class="timeline-header">
        <div class="lane-label"></div>
        <div class="timeline-rail" style="width: ${timelineWidth}px">
          ${ticks
            .map(
              (tick) => `
                <div class="tick ${tick.isDayStart ? "day-start" : ""}" style="left: ${tick.left}px">
                  ${tick.label}
                </div>
              `,
            )
            .join("")}
        </div>
      </div>
      ${rows}
    </div>
  `;
}

function renderWorkCenterLane(workCenter, timelineWidth) {
  // Closed bands are computed from the shift schedule and painted behind work bars.
  // Maintenance is separate: it is a blocked interval inside otherwise operating time.
  const closedBars = getClosedIntervals(workCenter).map(renderClosedWindow).join("");
  const scheduledBars = data.scheduledWorkOrders
    .filter((workOrder) => workOrder.workCenterId === workCenter.docId)
    .flatMap((workOrder) =>
      workOrder.segments.map((segment) => renderWorkSegment(workOrder, segment)),
    )
    .join("");
  const maintenanceBars = workCenter.data.maintenanceWindows
    .map((window) => renderMaintenanceWindow(workCenter, window))
    .join("");

  return `
    <div class="lane">
      <div class="lane-label">
        <strong>${escapeHtml(workCenter.data.name)}</strong>
        <span>${escapeHtml(workCenter.docId)}</span>
      </div>
      <div class="timeline-rail" style="width: ${timelineWidth}px">
        ${closedBars}
        ${maintenanceBars}
        ${scheduledBars}
      </div>
    </div>
  `;
}

function renderClosedWindow(interval) {
  const position = positionInterval(interval.startDate, interval.endDate, { minWidth: 4 });

  return `
    <div
      class="closed-window"
      style="left: ${position.left}px; width: ${position.width}px"
      title="Closed: ${formatTimeRange(interval.startDate, interval.endDate)}"
    ></div>
  `;
}

function renderWorkSegment(scheduledWorkOrder, segment) {
  const workOrder = workOrderById.get(scheduledWorkOrder.workOrderId);
  const color = getManufacturingOrderColor(scheduledWorkOrder.manufacturingOrderId);
  const position = positionInterval(segment.startDate, segment.endDate);
  const title = `${scheduledWorkOrder.workOrderNumber} #${scheduledWorkOrder.unitNumber}`;
  const tooltipId = toTooltipId("work", scheduledWorkOrder.executionId, segment.startDate);
  tooltipById.set(tooltipId, renderWorkTooltip(scheduledWorkOrder, segment, workOrder));

  return `
    <div
      class="bar ${color}"
      style="left: ${position.left}px; width: ${position.width}px"
      tabindex="0"
      aria-describedby="schedule-card-tooltip"
      aria-label="${escapeHtml(title)}"
      data-tooltip-id="${escapeHtml(tooltipId)}"
    >
      <div class="bar-content">
        <strong>${escapeHtml(title)}</strong>
        <span>${formatTimeRange(segment.startDate, segment.endDate)}</span>
        <em>${segment.workingMinutes} min, unit ${scheduledWorkOrder.unitNumber}/${scheduledWorkOrder.totalQuantity}, remaining ${scheduledWorkOrder.remainingQuantityAfterExecution}</em>
      </div>
    </div>
  `;
}

function renderMaintenanceWindow(workCenter, window) {
  const position = positionInterval(window.startDate, window.endDate);
  const tooltipId = toTooltipId("maintenance", workCenter.docId, window.startDate);
  tooltipById.set(tooltipId, renderMaintenanceTooltip(workCenter, window));

  return `
    <div
      class="bar maintenance"
      style="left: ${position.left}px; width: ${position.width}px"
      tabindex="0"
      aria-describedby="schedule-card-tooltip"
      aria-label="${escapeHtml(window.reason ?? "Maintenance")}"
      data-tooltip-id="${escapeHtml(tooltipId)}"
    >
      <div class="bar-content">
        <strong>Maintenance</strong>
        <span>${formatTimeRange(window.startDate, window.endDate)}</span>
        <em>${escapeHtml(window.reason ?? "Blocked")}</em>
      </div>
    </div>
  `;
}

function renderWorkTooltip(scheduledWorkOrder, segment, workOrder) {
  const manufacturingOrder = manufacturingOrderById.get(scheduledWorkOrder.manufacturingOrderId);
  const workCenter = workCenterById.get(scheduledWorkOrder.workCenterId);
  const workOrderStartDate = workOrder?.data.startDate ?? scheduledWorkOrder.originalStartDate;
  const workOrderEndDate = workOrder?.data.endDate ?? scheduledWorkOrder.originalEndDate;
  const dependsOnRows = scheduledWorkOrder.dependsOnWorkOrderIds.map((dependencyId) =>
    getDependencyRow(dependencyId, scheduledWorkOrder),
  );
  const dependentRows = getDependentWorkOrders(scheduledWorkOrder.workOrderId).map((dependentWorkOrder) =>
    getDependentRow(scheduledWorkOrder, dependentWorkOrder),
  );

  return `
    <div class="tooltip-header">
      <strong>${escapeHtml(scheduledWorkOrder.workOrderNumber)}</strong>
      <span>${escapeHtml(scheduledWorkOrder.executionId)}</span>
    </div>
    <dl class="tooltip-grid">
      ${renderTooltipItem("Manufacturing Order", `${scheduledWorkOrder.manufacturingOrderNumber} (${scheduledWorkOrder.manufacturingOrderId})`)}
      ${renderTooltipItem("Item", manufacturingOrder?.data.itemId ?? "Unknown")}
      ${renderTooltipItem("Work Center", `${workCenter?.data.name ?? scheduledWorkOrder.workCenterId} (${scheduledWorkOrder.workCenterId})`)}
      ${renderTooltipItem("Unit", `${scheduledWorkOrder.unitNumber}/${scheduledWorkOrder.totalQuantity}`)}
      ${renderTooltipItem("Remaining Quantity", scheduledWorkOrder.remainingQuantityAfterExecution)}
      ${renderTooltipItem("Segment", `${formatTimeRange(segment.startDate, segment.endDate)} (${segment.workingMinutes} min)`)}
      ${renderTooltipItem("Scheduled Execution", `${formatDateTime(scheduledWorkOrder.scheduledStartDate)}-${formatDateTime(scheduledWorkOrder.scheduledEndDate)}`)}
      ${renderTooltipItem("Work Order Start", formatDateTime(workOrderStartDate))}
      ${renderTooltipItem("Work Order End", formatDateTime(workOrderEndDate))}
      ${renderTooltipItem("Original Window", `${formatDateTime(workOrderStartDate)}-${formatDateTime(workOrderEndDate)}`)}
      ${renderTooltipItem("Duration", `${scheduledWorkOrder.durationMinutes} min`)}
    </dl>
    ${renderDependencyList("Depends On", dependsOnRows, "This work order has no predecessors.")}
    ${renderDependencyList("Dependents", dependentRows, "No later work order depends on this one.")}
  `;
}

function renderMaintenanceTooltip(workCenter, window) {
  return `
    <div class="tooltip-header">
      <strong>Maintenance Window</strong>
      <span>${escapeHtml(workCenter.data.name)}</span>
    </div>
    <dl class="tooltip-grid">
      ${renderTooltipItem("Work Center", `${workCenter.data.name} (${workCenter.docId})`)}
      ${renderTooltipItem("Time", formatTimeRange(window.startDate, window.endDate))}
      ${renderTooltipItem("Reason", window.reason ?? "Blocked")}
    </dl>
  `;
}

function renderTooltipItem(label, value) {
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `;
}

function renderDependencyList(title, rows, emptyText) {
  return `
    <section class="tooltip-section">
      <h4>${escapeHtml(title)}</h4>
      ${
        rows.length === 0
          ? `<p>${escapeHtml(emptyText)}</p>`
          : `<ul>${rows
              .map(
                (row) => `
                  <li>
                    <strong>${escapeHtml(row.relation)}</strong>
                    <span>${escapeHtml(row.detail)}</span>
                  </li>
                `,
              )
              .join("")}</ul>`
      }
    </section>
  `;
}

function getDependencyRow(dependencyId, scheduledWorkOrder) {
  const dependencyExecution = getScheduledExecution(dependencyId, scheduledWorkOrder.unitNumber);
  const dependencyLabel = formatWorkOrderReference(dependencyId);

  return {
    relation: `${dependencyLabel} -> ${scheduledWorkOrder.workOrderNumber}`,
    detail: dependencyExecution
      ? `Unit ${dependencyExecution.unitNumber}, ${dependencyExecution.executionId}, finishes ${formatDateTime(dependencyExecution.scheduledEndDate)}`
      : `Unit ${scheduledWorkOrder.unitNumber}, not scheduled in the current result`,
  };
}

function getDependentRow(scheduledWorkOrder, dependentWorkOrder) {
  const dependentExecution = getScheduledExecution(dependentWorkOrder.docId, scheduledWorkOrder.unitNumber);
  const dependentLabel = formatWorkOrderReference(dependentWorkOrder.docId);

  return {
    relation: `${scheduledWorkOrder.workOrderNumber} -> ${dependentLabel}`,
    detail: dependentExecution
      ? `Unit ${dependentExecution.unitNumber}, ${dependentExecution.executionId}, starts ${formatDateTime(dependentExecution.scheduledStartDate)}`
      : `Unit ${scheduledWorkOrder.unitNumber}, not scheduled in the current result`,
  };
}

function getDependentWorkOrders(workOrderId) {
  return data.workOrders.filter((candidate) => candidate.data.dependsOnWorkOrderIds.includes(workOrderId));
}

function getScheduledExecution(workOrderId, unitNumber) {
  return scheduledWorkOrderByWorkOrderAndUnit.get(executionLookupKey(workOrderId, unitNumber)) ?? null;
}

function formatWorkOrderReference(workOrderId) {
  const workOrder = workOrderById.get(workOrderId);

  if (!workOrder) {
    return workOrderId;
  }

  return `${workOrder.data.workOrderNumber} (${workOrder.docId})`;
}

function executionLookupKey(workOrderId, unitNumber) {
  return `${workOrderId}#${unitNumber}`;
}

function toTooltipId(...parts) {
  return parts.join("--").replace(/[^a-zA-Z0-9_-]/g, "-");
}

function installScheduleTooltips() {
  const tooltip = document.createElement("div");
  tooltip.id = "schedule-card-tooltip";
  tooltip.className = "schedule-tooltip";
  tooltip.setAttribute("role", "tooltip");
  document.body.append(tooltip);

  const chart = document.querySelector("#schedule-chart");
  let activeCard = null;

  // The fixed overlay avoids clipping inside the horizontally scrollable timeline.
  const activateFromEvent = (event) => {
    const card = getTooltipCard(event.target);

    if (!card || card === activeCard) {
      return;
    }

    activeCard = card;
    showScheduleTooltip(tooltip, activeCard);
  };

  const deactivateFromEvent = (event) => {
    const card = getTooltipCard(event.target);

    if (!card || card.contains(event.relatedTarget)) {
      return;
    }

    activeCard = null;
    hideScheduleTooltip(tooltip);
  };

  chart.addEventListener("pointerover", activateFromEvent);
  chart.addEventListener("mouseover", activateFromEvent);
  chart.addEventListener("mousemove", activateFromEvent);

  chart.addEventListener("pointerout", deactivateFromEvent);
  chart.addEventListener("mouseout", deactivateFromEvent);

  chart.addEventListener("focusin", (event) => {
    const card = getTooltipCard(event.target);

    if (!card) {
      return;
    }

    activeCard = card;
    showScheduleTooltip(tooltip, activeCard);
  });

  chart.addEventListener("focusout", (event) => {
    const card = getTooltipCard(event.target);

    if (!card || card.contains(event.relatedTarget)) {
      return;
    }

    activeCard = null;
    hideScheduleTooltip(tooltip);
  });

  window.addEventListener(
    "scroll",
    () => {
      if (activeCard) {
        positionScheduleTooltip(tooltip, activeCard);
      }
    },
    true,
  );
  window.addEventListener("resize", () => {
    if (activeCard) {
      positionScheduleTooltip(tooltip, activeCard);
    }
  });
}

function getTooltipCard(target) {
  if (!(target instanceof Element)) {
    return null;
  }

  return target.closest("[data-tooltip-id]");
}

function showScheduleTooltip(tooltip, card) {
  const tooltipHtml = tooltipById.get(card.dataset.tooltipId);

  if (!tooltipHtml) {
    hideScheduleTooltip(tooltip);
    return;
  }

  tooltip.innerHTML = tooltipHtml;
  tooltip.classList.add("is-visible");
  positionScheduleTooltip(tooltip, card);
}

function hideScheduleTooltip(tooltip) {
  tooltip.classList.remove("is-visible", "is-below");
}

function positionScheduleTooltip(tooltip, card) {
  const cardRect = card.getBoundingClientRect();
  const margin = 12;

  tooltip.style.maxHeight = `${window.innerHeight - margin * 2}px`;

  const tooltipRect = tooltip.getBoundingClientRect();
  const maxLeft = Math.max(margin, window.innerWidth - tooltipRect.width - margin);
  const hasRightSpace = cardRect.right + margin + tooltipRect.width <= window.innerWidth - margin;
  const hasLeftSpace = cardRect.left - margin - tooltipRect.width >= margin;
  let left = cardRect.right + margin;
  let top = cardRect.top + cardRect.height / 2 - tooltipRect.height / 2;

  tooltip.classList.remove("is-below");

  if (!hasRightSpace && hasLeftSpace) {
    left = cardRect.left - tooltipRect.width - margin;
  } else if (!hasRightSpace) {
    const centeredLeft = cardRect.left + cardRect.width / 2 - tooltipRect.width / 2;
    left = Math.max(margin, Math.min(maxLeft, centeredLeft));
  }

  top = Math.max(margin, Math.min(window.innerHeight - tooltipRect.height - margin, top));

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function getClosedIntervals(workCenter) {
  const operatingIntervals = getOperatingIntervals(workCenter).sort(
    (left, right) => new Date(left.startDate).getTime() - new Date(right.startDate).getTime(),
  );
  const closedIntervals = [];
  let cursor = new Date(chartBounds.start);

  // Closed time is the complement of operating intervals within the visible chart.
  for (const interval of operatingIntervals) {
    const start = new Date(interval.startDate);
    const end = new Date(interval.endDate);

    if (start > cursor) {
      closedIntervals.push(toInterval(cursor, start));
    }

    if (end > cursor) {
      cursor = end;
    }
  }

  if (cursor < chartBounds.end) {
    closedIntervals.push(toInterval(cursor, chartBounds.end));
  }

  return closedIntervals;
}

function getOperatingIntervals(workCenter) {
  const intervals = [];
  const cursor = startOfUtcDay(chartBounds.start);
  const finalDay = startOfUtcDay(chartBounds.end);

  while (cursor <= finalDay) {
    const dayOfWeek = cursor.getUTCDay();

    for (const shift of workCenter.data.shifts) {
      if (shift.dayOfWeek !== dayOfWeek) {
        continue;
      }

      const shiftStart = new Date(cursor);
      shiftStart.setUTCHours(shift.startHour, 0, 0, 0);

      const shiftEnd = new Date(cursor);
      shiftEnd.setUTCHours(shift.endHour, 0, 0, 0);

      if (shiftEnd <= shiftStart) {
        shiftEnd.setUTCDate(shiftEnd.getUTCDate() + 1);
      }

      const clipped = clipInterval(shiftStart, shiftEnd, chartBounds.start, chartBounds.end);

      if (clipped !== null) {
        intervals.push(clipped);
      }
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return mergeIntervals(intervals);
}

function clipInterval(start, end, min, max) {
  const clippedStart = new Date(Math.max(start.getTime(), min.getTime()));
  const clippedEnd = new Date(Math.min(end.getTime(), max.getTime()));

  if (clippedStart >= clippedEnd) {
    return null;
  }

  return toInterval(clippedStart, clippedEnd);
}

function mergeIntervals(intervals) {
  const sorted = [...intervals].sort(
    (left, right) => new Date(left.startDate).getTime() - new Date(right.startDate).getTime(),
  );
  const merged = [];

  for (const interval of sorted) {
    const last = merged.at(-1);

    if (!last || new Date(last.endDate) < new Date(interval.startDate)) {
      merged.push({ ...interval });
      continue;
    }

    if (new Date(interval.endDate) > new Date(last.endDate)) {
      last.endDate = interval.endDate;
    }
  }

  return merged;
}

function toInterval(start, end) {
  return {
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  };
}

function renderTopologicalOrder() {
  if (data.topologicalOrder.length === 0) {
    document.querySelector("#topological-order").innerHTML =
      `<li>Unavailable because this scenario failed before a topological order could be saved.</li>`;
    return;
  }

  document.querySelector("#topological-order").innerHTML = data.topologicalOrder
    .map((workOrderId) => `<li>${escapeHtml(workOrderId)}</li>`)
    .join("");
}

function renderQueues() {
  const queues = Object.entries(data.workCenterQueues);

  if (queues.length === 0) {
    document.querySelector("#work-center-queues").innerHTML =
      `<p>No work center queues were generated for this scenario.</p>`;
    return;
  }

  document.querySelector("#work-center-queues").innerHTML = Object.entries(data.workCenterQueues)
    .map(([workCenterId, queue]) => {
      const workCenterName = workCenterById.get(workCenterId)?.data.name ?? workCenterId;
      return `<p><strong>${escapeHtml(workCenterName)}:</strong> ${queue.map(escapeHtml).join(", ")}</p>`;
    })
    .join("");
}

function renderSourceTables() {
  document.querySelector("#work-centers-table").innerHTML = renderTable(
    ["Work center", "Name", "Shift", "Maintenance"],
    data.workCenters.map((workCenter) => [
      code(workCenter.docId),
      workCenter.data.name,
      formatShifts(workCenter.data.shifts),
      formatMaintenanceWindows(workCenter.data.maintenanceWindows),
    ]),
  );
  document.querySelector("#manufacturing-order-groups").innerHTML = data.manufacturingOrders
    .map(renderManufacturingOrderGroup)
    .join("");
}

function renderManufacturingOrderGroup(manufacturingOrder) {
  const color = getManufacturingOrderColor(manufacturingOrder.docId);
  const workOrders = getManufacturingOrderWorkOrders(manufacturingOrder.docId);

  return `
    <section class="manufacturing-order-group">
      <aside class="product-panel ${escapeHtml(color)}">
        <span class="product-kicker">Product</span>
        <h4>${dot(color)}${escapeHtml(manufacturingOrder.data.itemId)}</h4>
        <dl>
          ${renderProductFact("Manufacturing Order", manufacturingOrder.data.manufacturingOrderNumber)}
          ${renderProductFact("Quantity", manufacturingOrder.data.quantity)}
          ${renderProductFact("Due Date", formatDateTime(manufacturingOrder.data.dueDate))}
          ${renderProductFact("Work Order Steps", workOrders.length)}
        </dl>
      </aside>
      <div class="work-order-flow">
        <div class="work-order-flow-heading">
          <strong>Dependencies and steps</strong>
          <span>${escapeHtml(manufacturingOrder.data.manufacturingOrderNumber)} production chain</span>
        </div>
        <div class="work-order-step-list">
          ${
            workOrders.length === 0
              ? `<p class="empty-state">No work orders are linked to this manufacturing order.</p>`
              : workOrders.map((workOrder, index) => renderGroupedWorkOrderStep(workOrder, index + 1)).join("")
          }
        </div>
      </div>
    </section>
  `;
}

function renderGroupedWorkOrderStep(workOrder, stepNumber) {
  const workCenter = workCenterById.get(workOrder.data.workCenterId);
  const dependencies = workOrder.data.dependsOnWorkOrderIds;
  const dependents = getDependentWorkOrders(workOrder.docId);
  const executions = getScheduledExecutionsForWorkOrder(workOrder.docId);

  return `
    <article class="work-order-step">
      <div class="step-index">${stepNumber}</div>
      <div class="step-body">
        <div class="step-title">
          <div>
            <strong>${escapeHtml(workOrder.data.workOrderNumber)}</strong>
            <span>${escapeHtml(workOrder.docId)}</span>
          </div>
          <code>${escapeHtml(workOrder.data.isMaintenance ? "maintenance" : "production")}</code>
        </div>
        <dl class="step-facts">
          ${renderStepFact("Work Center", `${workCenter?.data.name ?? workOrder.data.workCenterId} (${workOrder.data.workCenterId})`)}
          ${renderStepFact("Start Date", formatDateTime(workOrder.data.startDate))}
          ${renderStepFact("End Date", formatDateTime(workOrder.data.endDate))}
          ${renderStepFact("Duration", `${workOrder.data.durationMinutes} min`)}
        </dl>
        <div class="dependency-grid">
          ${renderDependencyBlock("Depends on", dependencies, "No predecessors", (dependencyId) => {
            const dependency = workOrderById.get(dependencyId);
            return `${dependency?.data.workOrderNumber ?? dependencyId} -> ${workOrder.data.workOrderNumber}`;
          })}
          ${renderDependencyBlock("Unlocks", dependents.map((dependent) => dependent.docId), "No dependents", (dependentId) => {
            const dependent = workOrderById.get(dependentId);
            return `${workOrder.data.workOrderNumber} -> ${dependent?.data.workOrderNumber ?? dependentId}`;
          })}
        </div>
        ${renderExecutionSummary(executions)}
      </div>
    </article>
  `;
}

function renderProductFact(label, value) {
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `;
}

function renderStepFact(label, value) {
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `;
}

function renderDependencyBlock(label, dependencyIds, emptyText, formatDependency) {
  return `
    <section>
      <h5>${escapeHtml(label)}</h5>
      ${
        dependencyIds.length === 0
          ? `<p>${escapeHtml(emptyText)}</p>`
          : `<ul>${dependencyIds
              .map((dependencyId) => `<li>${escapeHtml(formatDependency(dependencyId))}</li>`)
              .join("")}</ul>`
      }
    </section>
  `;
}

function renderExecutionSummary(executions) {
  return `
    <div class="execution-summary">
      <h5>Scheduled unit executions</h5>
      ${
        executions.length === 0
          ? `<p>No executions were scheduled for this work order.</p>`
          : `<div class="execution-pills">${executions
              .map(
                (execution) => `
                  <span>
                    Unit ${execution.unitNumber}/${execution.totalQuantity}
                    <strong>${formatDateTime(execution.scheduledStartDate)}-${formatDateTime(execution.scheduledEndDate)}</strong>
                  </span>
                `,
              )
              .join("")}</div>`
      }
    </div>
  `;
}

function getManufacturingOrderWorkOrders(manufacturingOrderId) {
  const topologicalPositionByWorkOrderId = new Map(
    data.topologicalOrder.map((workOrderId, index) => [workOrderId, index]),
  );

  return data.workOrders
    .filter((workOrder) => workOrder.data.manufacturingOrderId === manufacturingOrderId)
    .sort((left, right) => {
      const topologicalComparison =
        (topologicalPositionByWorkOrderId.get(left.docId) ?? Number.MAX_SAFE_INTEGER) -
        (topologicalPositionByWorkOrderId.get(right.docId) ?? Number.MAX_SAFE_INTEGER);

      if (topologicalComparison !== 0) {
        return topologicalComparison;
      }

      return compareDates(left.data.startDate, right.data.startDate);
    });
}

function getScheduledExecutionsForWorkOrder(workOrderId) {
  return data.scheduledWorkOrders
    .filter((scheduledWorkOrder) => scheduledWorkOrder.workOrderId === workOrderId)
    .sort((left, right) => left.unitNumber - right.unitNumber);
}

function renderTable(headers, rows) {
  return `
    <table>
      <thead>
        <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                ${row.map((cell) => `<td>${cell}</td>`).join("")}
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function getChartBounds(scheduleData) {
  const allDates = [
    ...scheduleData.scheduledWorkOrders.flatMap((workOrder) =>
      workOrder.segments.flatMap((segment) => [segment.startDate, segment.endDate]),
    ),
    ...scheduleData.workOrders.flatMap((workOrder) => [
      workOrder.data.startDate,
      workOrder.data.endDate,
    ]),
    ...scheduleData.workCenters.flatMap((workCenter) =>
      workCenter.data.maintenanceWindows.flatMap((window) => [window.startDate, window.endDate]),
    ),
  ]
    .map((date) => new Date(date))
    .filter((date) => Number.isFinite(date.getTime()));

  if (allDates.length === 0) {
    return {
      start: new Date(scheduleData.config.horizonStartDate),
      end: new Date(scheduleData.config.horizonEndDate),
    };
  }

  const start = new Date(Math.min(...allDates.map((date) => date.getTime())));
  const end = new Date(Math.max(...allDates.map((date) => date.getTime())));

  start.setUTCHours(7, 0, 0, 0);
  end.setUTCHours(18, 0, 0, 0);

  return { start, end };
}

function buildTicks(start, end) {
  const ticks = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    const hour = cursor.getUTCHours();

    if (hour === 7 || hour === 10 || hour === 14 || hour === 18) {
      ticks.push({
        left: hoursBetween(start, cursor) * PIXELS_PER_HOUR,
        label: hour === 7 ? `${formatDate(cursor.toISOString())}<br />07:00` : `${String(hour).padStart(2, "0")}:00`,
        isDayStart: hour === 7,
      });
    }

    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }

  return ticks;
}

function positionInterval(startDate, endDate, options = {}) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const left = Math.max(0, hoursBetween(chartBounds.start, start) * PIXELS_PER_HOUR);
  const width = Math.max(options.minWidth ?? 18, hoursBetween(start, end) * PIXELS_PER_HOUR);

  return { left, width };
}

function hoursBetween(start, end) {
  return (end.getTime() - start.getTime()) / 3_600_000;
}

function compareDates(left, right) {
  return new Date(left).getTime() - new Date(right).getTime();
}

function formatShifts(shifts) {
  const firstShift = shifts[0];

  if (!firstShift) {
    return "No shifts";
  }

  return `Mon-Fri, ${hour(firstShift.startHour)}-${hour(firstShift.endHour)}`;
}

function formatMaintenanceWindows(windows) {
  if (windows.length === 0) {
    return "None";
  }

  return windows
    .map((window) => `${formatDateTime(window.startDate)}-${formatTime(window.endDate)}`)
    .join("<br />");
}

function formatTimeRange(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10)) {
    return `${formatTime(startDate)}-${formatTime(endDate)}`;
  }

  return `${formatDateTime(startDate)}-${formatDateTime(endDate)}`;
}

function formatDateTime(value) {
  return `${formatDate(value)} ${formatTime(value)}`;
}

function formatDate(value) {
  const date = new Date(value);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function startOfUtcDay(value) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function formatTime(value) {
  const date = new Date(value);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

function hour(value) {
  return `${String(value).padStart(2, "0")}:00`;
}

function code(value) {
  return `<code>${escapeHtml(value)}</code>`;
}

function dot(color) {
  return `<span class="dot ${escapeHtml(color)}"></span>`;
}

function getManufacturingOrderColor(manufacturingOrderId) {
  return manufacturingOrderColorById.get(manufacturingOrderId) ?? "blue";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
