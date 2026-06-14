const PIXELS_PER_HOUR = 28;
const LANE_LABEL_WIDTH = 190;
const CLICK_DELAY_MINUTES = 20;
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
let activeDelaySimulation = null;

const tooltipById = new Map();

installScheduleTooltips();
installDelayInteractions();
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
  activeDelaySimulation = null;
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
  tooltipById.clear();
  renderChart();
  renderReflowSection();
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
    <span><i class="swatch delay"></i>20 min delay</span>
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

  renderScheduleChart(document.querySelector("#schedule-chart"), data.scheduledWorkOrders, {
    clickable: true,
    isReflow: false,
    scheduledLookup: scheduledWorkOrderByWorkOrderAndUnit,
  });
}

function renderReflowSection() {
  const section = document.querySelector("#reflow-section");
  const chart = document.querySelector("#reflow-chart");
  const summary = document.querySelector("#reflow-summary");

  if (activeDelaySimulation === null || data.status !== "scheduled") {
    section.hidden = true;
    chart.innerHTML = "";
    summary.textContent = "";
    return;
  }

  section.hidden = false;
  summary.textContent =
    `${activeDelaySimulation.workOrderNumber} ${activeDelaySimulation.executionId} was extended by ${CLICK_DELAY_MINUTES} working minutes. Later executions were placed linearly after their dependencies and work-center availability.`;

  if (activeDelaySimulation.error !== null) {
    chart.innerHTML = `
      <div class="empty-chart">
        <strong>Reflow failed.</strong>
        <span>${escapeHtml(activeDelaySimulation.error.message)}</span>
      </div>
    `;
    return;
  }

  renderScheduleChart(chart, activeDelaySimulation.scheduledWorkOrders, {
    clickable: false,
    isReflow: true,
    selectedExecutionId: activeDelaySimulation.executionId,
    selectedOriginalDurationMinutes: activeDelaySimulation.originalDurationMinutes,
    scheduledLookup: activeDelaySimulation.scheduledLookup,
  });
}

function renderScheduleChart(container, scheduledWorkOrders, options) {
  const timelineHours = hoursBetween(chartBounds.start, chartBounds.end);
  const timelineWidth = Math.ceil(timelineHours * PIXELS_PER_HOUR);
  const ticks = buildTicks(chartBounds.start, chartBounds.end);
  const rows = data.workCenters
    .map((workCenter) => renderWorkCenterLane(workCenter, timelineWidth, scheduledWorkOrders, options))
    .join("");

  container.innerHTML = `
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

function renderWorkCenterLane(workCenter, timelineWidth, scheduledWorkOrders, options) {
  // Closed bands are computed from the shift schedule and painted behind work bars.
  // Maintenance is separate: it is a blocked interval inside otherwise operating time.
  const closedBars = getClosedIntervals(workCenter).map(renderClosedWindow).join("");
  const scheduledBars = scheduledWorkOrders
    .filter((workOrder) => workOrder.workCenterId === workCenter.docId)
    .flatMap((workOrder) =>
      getDisplaySegments(workOrder, options).map(({ segment, segmentKind }) =>
        renderWorkSegment(workOrder, segment, { ...options, segmentKind }),
      ),
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

function getDisplaySegments(scheduledWorkOrder, options) {
  if (!options.isReflow || scheduledWorkOrder.executionId !== options.selectedExecutionId) {
    return scheduledWorkOrder.segments.map((segment) => ({
      segment,
      segmentKind: "normal",
    }));
  }

  return splitSegmentsByWorkingMinutes(
    scheduledWorkOrder.segments,
    options.selectedOriginalDurationMinutes,
  );
}

function splitSegmentsByWorkingMinutes(segments, baseWorkingMinutes) {
  const result = [];
  let remainingBaseMinutes = baseWorkingMinutes;

  for (const segment of segments) {
    if (remainingBaseMinutes <= 0) {
      result.push({ segment, segmentKind: "delay" });
      continue;
    }

    if (segment.workingMinutes <= remainingBaseMinutes) {
      result.push({ segment, segmentKind: "normal" });
      remainingBaseMinutes -= segment.workingMinutes;
      continue;
    }

    const normalSegment = {
      ...segment,
      endDate: addMinutesIso(segment.startDate, remainingBaseMinutes),
      workingMinutes: remainingBaseMinutes,
    };
    const delaySegment = {
      ...segment,
      startDate: normalSegment.endDate,
      workingMinutes: segment.workingMinutes - remainingBaseMinutes,
    };

    result.push({ segment: normalSegment, segmentKind: "normal" });
    result.push({ segment: delaySegment, segmentKind: "delay" });
    remainingBaseMinutes = 0;
  }

  return result;
}

function renderWorkSegment(scheduledWorkOrder, segment, options) {
  const workOrder = workOrderById.get(scheduledWorkOrder.workOrderId);
  const color =
    options.segmentKind === "delay"
      ? "delay-extension"
      : getManufacturingOrderColor(scheduledWorkOrder.manufacturingOrderId);
  const position = positionInterval(segment.startDate, segment.endDate);
  const isSelectedSource =
    options.clickable && activeDelaySimulation?.executionId === scheduledWorkOrder.executionId;
  const title =
    options.segmentKind === "delay"
      ? `${scheduledWorkOrder.workOrderNumber} #${scheduledWorkOrder.unitNumber} +20`
      : `${scheduledWorkOrder.workOrderNumber} #${scheduledWorkOrder.unitNumber}`;
  const tooltipId = toTooltipId(
    options.isReflow ? "reflow-work" : "work",
    scheduledWorkOrder.executionId,
    segment.startDate,
  );
  tooltipById.set(
    tooltipId,
    renderWorkTooltip(scheduledWorkOrder, segment, workOrder, {
      segmentKind: options.segmentKind,
      scheduledLookup: options.scheduledLookup,
    }),
  );

  return `
    <div
      class="bar ${color} ${isSelectedSource ? "selected-source" : ""}"
      style="left: ${position.left}px; width: ${position.width}px"
      tabindex="0"
      aria-describedby="schedule-card-tooltip"
      aria-label="${escapeHtml(title)}"
      data-tooltip-id="${escapeHtml(tooltipId)}"
      ${options.clickable ? `data-delay-source="true" data-execution-id="${escapeHtml(scheduledWorkOrder.executionId)}"` : ""}
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

function renderWorkTooltip(scheduledWorkOrder, segment, workOrder, options) {
  const manufacturingOrder = manufacturingOrderById.get(scheduledWorkOrder.manufacturingOrderId);
  const workCenter = workCenterById.get(scheduledWorkOrder.workCenterId);
  const workOrderStartDate = workOrder?.data.startDate ?? scheduledWorkOrder.originalStartDate;
  const workOrderEndDate = workOrder?.data.endDate ?? scheduledWorkOrder.originalEndDate;
  const dependsOnRows = scheduledWorkOrder.dependsOnWorkOrderIds.map((dependencyId) =>
    getDependencyRow(dependencyId, scheduledWorkOrder, options.scheduledLookup),
  );
  const dependentRows = getDependentWorkOrders(scheduledWorkOrder.workOrderId).map((dependentWorkOrder) =>
    getDependentRow(scheduledWorkOrder, dependentWorkOrder, options.scheduledLookup),
  );
  const segmentLabel = options.segmentKind === "delay" ? "Delay Extension" : "Segment";

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
      ${renderTooltipItem(segmentLabel, `${formatTimeRange(segment.startDate, segment.endDate)} (${segment.workingMinutes} min)`)}
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

function getDependencyRow(dependencyId, scheduledWorkOrder, scheduledLookup) {
  const dependencyExecution = getScheduledExecution(
    dependencyId,
    scheduledWorkOrder.unitNumber,
    scheduledLookup,
  );
  const dependencyLabel = formatWorkOrderReference(dependencyId);

  return {
    relation: `${dependencyLabel} -> ${scheduledWorkOrder.workOrderNumber}`,
    detail: dependencyExecution
      ? `Unit ${dependencyExecution.unitNumber}, ${dependencyExecution.executionId}, finishes ${formatDateTime(dependencyExecution.scheduledEndDate)}`
      : `Unit ${scheduledWorkOrder.unitNumber}, not scheduled in the current result`,
  };
}

function getDependentRow(scheduledWorkOrder, dependentWorkOrder, scheduledLookup) {
  const dependentExecution = getScheduledExecution(
    dependentWorkOrder.docId,
    scheduledWorkOrder.unitNumber,
    scheduledLookup,
  );
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

function getScheduledExecution(workOrderId, unitNumber, scheduledLookup = scheduledWorkOrderByWorkOrderAndUnit) {
  return scheduledLookup.get(executionLookupKey(workOrderId, unitNumber)) ?? null;
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

function installDelayInteractions() {
  const chart = document.querySelector("#schedule-chart");

  chart.addEventListener("click", (event) => {
    const card = getDelaySourceCard(event.target);

    if (!card) {
      return;
    }

    applyDelaySimulation(card.dataset.executionId);
  });

  chart.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    const card = getDelaySourceCard(event.target);

    if (!card) {
      return;
    }

    event.preventDefault();
    applyDelaySimulation(card.dataset.executionId);
  });
}

function getDelaySourceCard(target) {
  if (!(target instanceof Element)) {
    return null;
  }

  return target.closest("[data-delay-source][data-execution-id]");
}

function applyDelaySimulation(executionId) {
  if (!executionId || data.status !== "scheduled") {
    return;
  }

  activeDelaySimulation = buildDelaySimulation(executionId);
  tooltipById.clear();
  renderChart();
  renderReflowSection();
  document.querySelector("#reflow-section").scrollIntoView({
    behavior: "smooth",
    block: "start",
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

function getOperatingIntervals(workCenter, bounds = chartBounds) {
  const intervals = [];
  const cursor = startOfUtcDay(bounds.start);
  const finalDay = startOfUtcDay(bounds.end);

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

      const clipped = clipInterval(shiftStart, shiftEnd, bounds.start, bounds.end);

      if (clipped !== null) {
        intervals.push(clipped);
      }
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return mergeIntervals(intervals);
}

function buildDelaySimulation(executionId) {
  const selectedExecution = data.scheduledWorkOrders.find(
    (scheduledWorkOrder) => scheduledWorkOrder.executionId === executionId,
  );

  if (selectedExecution === undefined) {
    return {
      executionId,
      workOrderNumber: executionId,
      originalDurationMinutes: 0,
      scheduledWorkOrders: [],
      scheduledLookup: new Map(),
      error: {
        message: `Execution ${executionId} was not found in the current scenario.`,
      },
    };
  }

  try {
    const scheduledWorkOrders = calculateDelayedSchedule(executionId);

    return {
      executionId,
      workOrderNumber: selectedExecution.workOrderNumber,
      originalDurationMinutes: selectedExecution.durationMinutes,
      scheduledWorkOrders,
      scheduledLookup: buildScheduledLookup(scheduledWorkOrders),
      error: null,
    };
  } catch (error) {
    return {
      executionId,
      workOrderNumber: selectedExecution.workOrderNumber,
      originalDurationMinutes: selectedExecution.durationMinutes,
      scheduledWorkOrders: [],
      scheduledLookup: new Map(),
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function calculateDelayedSchedule(executionId) {
  const originalByExecutionId = new Map(
    data.scheduledWorkOrders.map((scheduledWorkOrder) => [
      scheduledWorkOrder.executionId,
      scheduledWorkOrder,
    ]),
  );
  const resultByExecutionId = new Map(
    data.scheduledWorkOrders.map((scheduledWorkOrder) => [
      scheduledWorkOrder.executionId,
      cloneScheduledWorkOrder(scheduledWorkOrder),
    ]),
  );

  if (!originalByExecutionId.has(executionId)) {
    throw new Error(`Execution ${executionId} was not found in the current scenario.`);
  }

  const availableByWorkCenter = buildAvailableIntervalsByWorkCenter();
  const occupancyByWorkCenter = buildOccupancyByWorkCenter(resultByExecutionId.values());
  const queue = [];
  const queuedExecutionIds = new Set();

  enqueueAffectedExecution(executionId, {
    queue,
    queuedExecutionIds,
    occupancyByWorkCenter,
    resultByExecutionId,
  });

  while (queue.length > 0) {
    const currentExecutionId = takeNextReflowExecution(queue, queuedExecutionIds, resultByExecutionId);
    const current = resultByExecutionId.get(currentExecutionId);
    const original = originalByExecutionId.get(currentExecutionId);

    if (current === undefined || original === undefined) {
      throw new Error(`Execution ${currentExecutionId} was not found while reflowing delay.`);
    }

    const scheduled =
      currentExecutionId === executionId
        ? rescheduleDelayedSource(original, {
            availableByWorkCenter,
            extraDurationMinutes: CLICK_DELAY_MINUTES,
          })
        : rescheduleAffectedExecution(original, {
            availableByWorkCenter,
            occupancyByWorkCenter,
            resultByExecutionId,
            queue,
            queuedExecutionIds,
          });
    resultByExecutionId.set(currentExecutionId, scheduled);
    addOccupancy(scheduled, occupancyByWorkCenter);

    const overlappedExecutionIds =
      currentExecutionId === executionId
        ? findOverlappingExecutionIds(scheduled, occupancyByWorkCenter)
        : [];

    for (const overlappedExecutionId of overlappedExecutionIds) {
      enqueueAffectedExecution(overlappedExecutionId, {
        queue,
        queuedExecutionIds,
        occupancyByWorkCenter,
        resultByExecutionId,
      });
    }

    for (const dependentExecutionId of getDependentExecutionIds(scheduled)) {
      const dependent = resultByExecutionId.get(dependentExecutionId);

      if (dependent === undefined) {
        continue;
      }

      const dependencyReadyAt = getReflowDependencyReadyAt(dependent, resultByExecutionId);

      if (
        dependencyReadyAt > new Date(dependent.scheduledStartDate)
      ) {
        enqueueAffectedExecution(dependentExecutionId, {
          queue,
          queuedExecutionIds,
          occupancyByWorkCenter,
          resultByExecutionId,
        });
      }
    }
  }

  return data.scheduledWorkOrders.map((scheduledWorkOrder) => {
    const reflowed = resultByExecutionId.get(scheduledWorkOrder.executionId);

    if (reflowed === undefined) {
      throw new Error(`Execution ${scheduledWorkOrder.executionId} disappeared during reflow.`);
    }

    return reflowed;
  });
}

function enqueueAffectedExecution(
  executionId,
  { queue, queuedExecutionIds, occupancyByWorkCenter, resultByExecutionId },
) {
  if (queuedExecutionIds.has(executionId)) {
    return;
  }

  const scheduledWorkOrder = resultByExecutionId.get(executionId);

  if (scheduledWorkOrder === undefined) {
    return;
  }

  // Remove the affected execution from its old place immediately. The reflow
  // pass will search the remaining schedule for the first gap where it fits.
  removeOccupancy(executionId, occupancyByWorkCenter);
  queue.push(executionId);
  queuedExecutionIds.add(executionId);
}

function takeNextReflowExecution(queue, queuedExecutionIds, resultByExecutionId) {
  queue.sort(compareExecutionIdsByBaselineOrder);

  const readyIndex = queue.findIndex((executionId) => {
    const scheduledWorkOrder = resultByExecutionId.get(executionId);

    if (scheduledWorkOrder === undefined) {
      return true;
    }

    return scheduledWorkOrder.dependsOnWorkOrderIds.every((dependencyId) => {
      const dependencyExecutionId = executionLookupKey(
        dependencyId,
        scheduledWorkOrder.unitNumber,
      );

      return !queuedExecutionIds.has(dependencyExecutionId);
    });
  });
  const selectedIndex = readyIndex === -1 ? 0 : readyIndex;
  const [executionId] = queue.splice(selectedIndex, 1);

  if (executionId === undefined) {
    throw new Error("Reflow queue unexpectedly became empty.");
  }

  queuedExecutionIds.delete(executionId);
  return executionId;
}

function compareExecutionIdsByBaselineOrder(leftExecutionId, rightExecutionId) {
  return getBaselineExecutionRank(leftExecutionId) - getBaselineExecutionRank(rightExecutionId);
}

function getBaselineExecutionRank(executionId) {
  const index = data.scheduledWorkOrders.findIndex(
    (scheduledWorkOrder) => scheduledWorkOrder.executionId === executionId,
  );

  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function buildOccupancyByWorkCenter(scheduledWorkOrders) {
  const occupancyByWorkCenter = new Map();

  for (const scheduledWorkOrder of scheduledWorkOrders) {
    addOccupancy(scheduledWorkOrder, occupancyByWorkCenter);
  }

  return occupancyByWorkCenter;
}

function addOccupancy(scheduledWorkOrder, occupancyByWorkCenter) {
  const occupancy = occupancyByWorkCenter.get(scheduledWorkOrder.workCenterId) ?? [];

  for (const segment of scheduledWorkOrder.segments) {
    occupancy.push({
      executionId: scheduledWorkOrder.executionId,
      workCenterId: scheduledWorkOrder.workCenterId,
      startDate: segment.startDate,
      endDate: segment.endDate,
    });
  }

  occupancy.sort(compareIntervals);
  occupancyByWorkCenter.set(scheduledWorkOrder.workCenterId, occupancy);
}

function removeOccupancy(executionId, occupancyByWorkCenter) {
  for (const [workCenterId, occupancy] of occupancyByWorkCenter.entries()) {
    occupancyByWorkCenter.set(
      workCenterId,
      occupancy.filter((interval) => interval.executionId !== executionId),
    );
  }
}

function findOverlappingExecutionIds(scheduledWorkOrder, occupancyByWorkCenter) {
  const overlappingExecutionIds = new Set();
  const occupancy = occupancyByWorkCenter.get(scheduledWorkOrder.workCenterId) ?? [];

  for (const segment of scheduledWorkOrder.segments) {
    for (const occupiedInterval of occupancy) {
      if (
        occupiedInterval.executionId !== scheduledWorkOrder.executionId &&
        intervalsOverlap(segment, occupiedInterval)
      ) {
        overlappingExecutionIds.add(occupiedInterval.executionId);
      }
    }
  }

  return [...overlappingExecutionIds].sort(compareExecutionIdsByBaselineOrder);
}

function findNextBlockingExecutionId({
  workCenterId,
  earliestStart,
  latestEnd,
  occupancyByWorkCenter,
}) {
  const blocker = (occupancyByWorkCenter.get(workCenterId) ?? [])
    .filter((interval) => new Date(interval.endDate) > earliestStart)
    .filter((interval) => new Date(interval.startDate) < latestEnd)
    .sort(
      (left, right) =>
        compareIntervals(left, right) ||
        compareExecutionIdsByBaselineOrder(left.executionId, right.executionId),
    )[0];

  return blocker?.executionId ?? null;
}

function getDependentExecutionIds(scheduledWorkOrder) {
  return data.workOrders
    .filter((workOrder) =>
      workOrder.data.dependsOnWorkOrderIds.includes(scheduledWorkOrder.workOrderId),
    )
    .map((workOrder) => executionLookupKey(workOrder.docId, scheduledWorkOrder.unitNumber));
}

function rescheduleDelayedSource(original, context) {
  return placeExecution(original, {
    availableByWorkCenter: context.availableByWorkCenter,
    blockedIntervals: [],
    earliestStart: maxDate(
      new Date(original.scheduledStartDate),
      new Date(original.originalStartDate),
    ),
    durationMinutes: original.durationMinutes + context.extraDurationMinutes,
  });
}

function rescheduleAffectedExecution(original, context) {
  const dependencyReadyAt = getReflowDependencyReadyAt(original, context.resultByExecutionId);
  const earliestStart = maxDate(
    dependencyReadyAt,
    new Date(original.originalStartDate),
    new Date(original.scheduledStartDate),
  );
  let lastError = null;

  for (let attempt = 0; attempt <= data.scheduledWorkOrders.length; attempt += 1) {
    try {
      return placeExecution(original, {
        availableByWorkCenter: context.availableByWorkCenter,
        blockedIntervals: context.occupancyByWorkCenter.get(original.workCenterId) ?? [],
        earliestStart,
        durationMinutes: original.durationMinutes,
      });
    } catch (error) {
      lastError = error;

      const blockerExecutionId = findNextBlockingExecutionId({
        workCenterId: original.workCenterId,
        earliestStart,
        latestEnd: new Date(original.originalEndDate),
        occupancyByWorkCenter: context.occupancyByWorkCenter,
      });

      if (blockerExecutionId === null) {
        throw error;
      }

      enqueueAffectedExecution(blockerExecutionId, {
        queue: context.queue,
        queuedExecutionIds: context.queuedExecutionIds,
        occupancyByWorkCenter: context.occupancyByWorkCenter,
        resultByExecutionId: context.resultByExecutionId,
      });
    }
  }

  throw lastError ?? new Error(`Execution ${original.executionId} could not be reflowed.`);
}

function placeExecution(original, context) {
  const workOrderWindowEnd = new Date(original.originalEndDate);
  const segments = placeDurationInAvailability({
    availabilityIntervals: context.availableByWorkCenter[original.workCenterId] ?? [],
    blockedIntervals: context.blockedIntervals,
    durationMinutes: context.durationMinutes,
    earliestStart: context.earliestStart,
    latestEnd: workOrderWindowEnd,
    executionId: original.executionId,
  });
  const firstSegment = segments[0];
  const lastSegment = segments.at(-1);

  if (firstSegment === undefined || lastSegment === undefined) {
    throw new Error(`Execution ${original.executionId} did not produce any reflowed segments.`);
  }

  return {
    ...original,
    durationMinutes: context.durationMinutes,
    scheduledStartDate: firstSegment.startDate,
    scheduledEndDate: lastSegment.endDate,
    segments,
  };
}

function getReflowDependencyReadyAt(scheduledWorkOrder, resultByExecutionId) {
  const dependencyEndDates = scheduledWorkOrder.dependsOnWorkOrderIds.map((dependencyId) => {
    const dependency = resultByExecutionId.get(
      executionLookupKey(dependencyId, scheduledWorkOrder.unitNumber),
    );

    if (dependency === undefined) {
      throw new Error(
        `Execution ${scheduledWorkOrder.executionId} cannot be reflowed before dependency ${dependencyId}#${scheduledWorkOrder.unitNumber}.`,
      );
    }

    return new Date(dependency.scheduledEndDate);
  });

  return maxDate(new Date(data.config.horizonStartDate), ...dependencyEndDates);
}

function placeDurationInAvailability({
  availabilityIntervals,
  blockedIntervals = [],
  durationMinutes,
  earliestStart,
  latestEnd,
  executionId,
}) {
  let remainingMinutes = durationMinutes;
  const segments = [];
  const openIntervals = subtractBlockedIntervals(availabilityIntervals, blockedIntervals);

  for (const interval of openIntervals) {
    const intervalStart = new Date(interval.startDate);
    const intervalEnd = new Date(interval.endDate);

    if (intervalEnd <= earliestStart) {
      continue;
    }

    if (intervalStart >= latestEnd) {
      break;
    }

    const segmentStart = maxDate(intervalStart, earliestStart);
    const segmentBoundary = minDate(intervalEnd, latestEnd);
    const availableMinutes = minutesBetweenDates(segmentStart, segmentBoundary);

    if (availableMinutes <= 0) {
      continue;
    }

    const workingMinutes = Math.min(availableMinutes, remainingMinutes);
    const segmentEnd = addMinutes(segmentStart, workingMinutes);

    segments.push({
      workCenterId: interval.workCenterId,
      startDate: segmentStart.toISOString(),
      endDate: segmentEnd.toISOString(),
      workingMinutes,
    });

    remainingMinutes -= workingMinutes;

    if (remainingMinutes === 0) {
      return segments;
    }
  }

  throw new Error(
    `Execution ${executionId} cannot fit after the delay before its work order window closes at ${latestEnd.toISOString()}. Remaining minutes: ${remainingMinutes}.`,
  );
}

function buildAvailableIntervalsByWorkCenter() {
  const horizon = {
    start: new Date(data.config.horizonStartDate),
    end: new Date(data.config.horizonEndDate),
  };
  const result = {};

  for (const workCenter of data.workCenters) {
    const operatingIntervals = getOperatingIntervals(workCenter, horizon).map((interval) => ({
      ...interval,
      workCenterId: workCenter.docId,
    }));
    const maintenanceIntervals = workCenter.data.maintenanceWindows
      .map((window) =>
        clipInterval(new Date(window.startDate), new Date(window.endDate), horizon.start, horizon.end),
      )
      .filter((interval) => interval !== null);

    result[workCenter.docId] = subtractBlockedIntervals(
      operatingIntervals,
      maintenanceIntervals,
    ).map((interval) => ({
      ...interval,
      workCenterId: workCenter.docId,
    }));
  }

  return result;
}

function subtractBlockedIntervals(availableIntervals, blockedIntervals) {
  let result = mergeIntervals(availableIntervals);

  for (const blockedInterval of mergeIntervals(blockedIntervals)) {
    result = result.flatMap((availableInterval) =>
      subtractSingleBlockedInterval(availableInterval, blockedInterval),
    );
  }

  return mergeIntervals(result);
}

function subtractSingleBlockedInterval(availableInterval, blockedInterval) {
  const overlap = intersectInterval(availableInterval, blockedInterval);

  if (overlap === null) {
    return [availableInterval];
  }

  const result = [];

  if (new Date(availableInterval.startDate) < new Date(overlap.startDate)) {
    result.push({
      ...availableInterval,
      endDate: overlap.startDate,
    });
  }

  if (new Date(overlap.endDate) < new Date(availableInterval.endDate)) {
    result.push({
      ...availableInterval,
      startDate: overlap.endDate,
    });
  }

  return result;
}

function intersectInterval(left, right) {
  const start = maxDate(new Date(left.startDate), new Date(right.startDate));
  const end = minDate(new Date(left.endDate), new Date(right.endDate));

  if (start >= end) {
    return null;
  }

  return {
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  };
}

function initializeReflowWorkCenterReadiness(availableByWorkCenter) {
  return new Map(
    data.workCenters.map((workCenter) => [
      workCenter.docId,
      getFirstAvailableStart(availableByWorkCenter[workCenter.docId]) ??
        new Date(data.config.horizonStartDate),
    ]),
  );
}

function moveWorkCenterReadiness(workCenterNextFreeAt, workCenterId, candidateReadyAt) {
  const currentReadyAt = workCenterNextFreeAt.get(workCenterId);
  workCenterNextFreeAt.set(
    workCenterId,
    currentReadyAt === undefined ? candidateReadyAt : maxDate(currentReadyAt, candidateReadyAt),
  );
}

function getFirstAvailableStart(availabilityIntervals = []) {
  const firstInterval = availabilityIntervals[0];

  return firstInterval === undefined ? null : new Date(firstInterval.startDate);
}

function cloneScheduledWorkOrder(scheduledWorkOrder) {
  return {
    ...scheduledWorkOrder,
    segments: scheduledWorkOrder.segments.map((segment) => ({ ...segment })),
  };
}

function buildScheduledLookup(scheduledWorkOrders) {
  return new Map(
    scheduledWorkOrders.map((scheduledWorkOrder) => [
      executionLookupKey(scheduledWorkOrder.workOrderId, scheduledWorkOrder.unitNumber),
      scheduledWorkOrder,
    ]),
  );
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
    compareIntervals,
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

function compareIntervals(left, right) {
  return new Date(left.startDate).getTime() - new Date(right.startDate).getTime();
}

function intervalsOverlap(left, right) {
  return new Date(left.startDate) < new Date(right.endDate) &&
    new Date(right.startDate) < new Date(left.endDate);
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

function minutesBetweenDates(start, end) {
  return Math.floor((end.getTime() - start.getTime()) / 60_000);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

function addMinutesIso(value, minutes) {
  return addMinutes(new Date(value), minutes).toISOString();
}

function maxDate(...dates) {
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function minDate(...dates) {
  return new Date(Math.min(...dates.map((date) => date.getTime())));
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
