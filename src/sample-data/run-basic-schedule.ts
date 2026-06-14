import { ReflowService } from "../reflow/reflow.service.js";
import { basicScheduleInput, basicScheduleScenarioNotes } from "./basic-schedule.sample.js";

const result = new ReflowService().schedule(basicScheduleInput);

console.log("Scenario notes:");
for (const note of basicScheduleScenarioNotes) {
  console.log(`- ${note}`);
}

console.log("\nTopological order:");
console.log(result.preparedState.topologicalOrder.join(" -> "));

console.log("\nWork center queues:");
console.log(JSON.stringify(result.workCenterQueues, null, 2));

console.log("\nScheduled work orders:");
for (const workOrder of result.scheduledWorkOrders) {
  console.log(
    [
      workOrder.workOrderId,
      workOrder.executionId,
      workOrder.workCenterId,
      workOrder.scheduledStartDate,
      workOrder.scheduledEndDate,
      `${workOrder.durationMinutes} min`,
      `unit ${workOrder.unitNumber}/${workOrder.totalQuantity}`,
      `remaining ${workOrder.remainingQuantityAfterExecution}`,
    ].join(" | "),
  );

  for (const segment of workOrder.segments) {
    console.log(
      `  segment ${segment.startDate} -> ${segment.endDate} (${segment.workingMinutes} min)`,
    );
  }
}
