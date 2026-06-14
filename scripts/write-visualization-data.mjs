import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildBasicSchedule } from "../dist/reflow/basic-scheduler.js";
import {
  DEFAULT_REFLOW_CONFIG,
  prepareScheduleState,
} from "../dist/reflow/reflow.service.js";
import { scheduleScenarios } from "../dist/sample-data/schedule-scenarios.sample.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const visualizationPath = resolve(__dirname, "../site/schedule-visualization");
const dataPath = resolve(visualizationPath, "data");
const legacyOutputPath = resolve(visualizationPath, "schedule-data.json");
const indexOutputPath = resolve(visualizationPath, "schedule-scenarios.json");

mkdirSync(dataPath, { recursive: true });

const payloads = scheduleScenarios.map(buildScenarioPayload);
const indexPayload = {
  generatedAt: new Date().toISOString(),
  defaultScenarioId: scheduleScenarios[0]?.id ?? null,
  scenarios: payloads.map((payload) => ({
    id: payload.scenario.id,
    title: payload.scenario.title,
    description: payload.scenario.description,
    expectedStatus: payload.scenario.expectedStatus,
    status: payload.status,
    dataPath: `./data/${payload.scenario.id}.json`,
  })),
};

for (const payload of payloads) {
  const outputPath = resolve(dataPath, `${payload.scenario.id}.json`);
  writeJson(outputPath, payload);
  console.log(`Wrote ${outputPath}`);
}

writeJson(indexOutputPath, indexPayload);
console.log(`Wrote ${indexOutputPath}`);

if (payloads[0] !== undefined) {
  writeJson(legacyOutputPath, payloads[0]);
  console.log(`Wrote ${legacyOutputPath}`);
}

function buildScenarioPayload(scenario) {
  let preparedState = null;

  try {
    preparedState = prepareScheduleState(scenario.input);
    const schedule = buildBasicSchedule(preparedState);

    return {
      generatedAt: new Date().toISOString(),
      scenario: toPublicScenario(scenario),
      status: "scheduled",
      config: schedule.preparedState.config,
      workCenters: scenario.input.workCenters,
      manufacturingOrders: scenario.input.manufacturingOrders,
      workOrders: scenario.input.workOrders,
      topologicalOrder: schedule.preparedState.topologicalOrder,
      workCenterQueues: schedule.workCenterQueues,
      scheduledWorkOrders: schedule.scheduledWorkOrders,
    };
  } catch (error) {
    return {
      generatedAt: new Date().toISOString(),
      scenario: toPublicScenario(scenario),
      status: "error",
      error: serializeError(error),
      config: preparedState?.config ?? resolveConfig(scenario.input.config),
      workCenters: scenario.input.workCenters,
      manufacturingOrders: scenario.input.manufacturingOrders,
      workOrders: scenario.input.workOrders,
      topologicalOrder: preparedState?.topologicalOrder ?? [],
      workCenterQueues: {},
      scheduledWorkOrders: [],
    };
  }
}

function toPublicScenario(scenario) {
  return {
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    expectedStatus: scenario.expectedStatus,
    notes: scenario.notes,
  };
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      cyclePath: Array.isArray(error.cyclePath) ? error.cyclePath : undefined,
    };
  }

  return {
    name: "UnknownError",
    message: String(error),
  };
}

function resolveConfig(config) {
  return {
    horizonStartDate: config?.horizonStartDate ?? DEFAULT_REFLOW_CONFIG.horizonStartDate,
    horizonEndDate: config?.horizonEndDate ?? DEFAULT_REFLOW_CONFIG.horizonEndDate,
  };
}

function writeJson(outputPath, payload) {
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}
