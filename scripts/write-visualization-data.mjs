import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ReflowService } from "../dist/reflow/reflow.service.js";
import { basicScheduleInput } from "../dist/sample-data/basic-schedule.sample.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(__dirname, "../site/schedule-visualization/schedule-data.json");
const schedule = new ReflowService().schedule(basicScheduleInput);

const payload = {
  generatedAt: new Date().toISOString(),
  config: schedule.preparedState.config,
  workCenters: basicScheduleInput.workCenters,
  manufacturingOrders: basicScheduleInput.manufacturingOrders,
  workOrders: basicScheduleInput.workOrders,
  topologicalOrder: schedule.preparedState.topologicalOrder,
  workCenterQueues: schedule.workCenterQueues,
  scheduledWorkOrders: schedule.scheduledWorkOrders,
};

writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Wrote ${outputPath}`);
