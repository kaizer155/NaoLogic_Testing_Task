import type { DateTime } from "luxon";

import type {
  AvailabilityByDate,
  BasicScheduleResult,
  EnrichedWorkOrder,
  PreparedScheduleState,
  ScheduledWorkOrder,
  ScheduledWorkSegment,
  TimeInterval,
  WorkCenterQueues,
} from "./types.js";
import { SchedulingError } from "./types.js";
import {
  type DateTimeInterval,
  maxDateTime,
  minutesBetween,
  parseUtcDateTime,
  toUtcIso,
  validateHorizon,
} from "../utils/date-utils.js";

interface WorkOrderExecution {
  executionId: string;
  workOrder: EnrichedWorkOrder;
  unitNumber: number;
  totalQuantity: number;
  dependsOnExecutionIds: string[];
}

interface ExecutionGraph {
  executionsById: Map<string, WorkOrderExecution>;
  topologicalOrder: string[];
}

// This is intentionally a simple first-pass scheduler: it consumes the prepared DAG,
// expands manufacturing quantity into per-unit executions, then places each execution
// at the first available interval allowed by dependencies and work-center capacity.
export function buildBasicSchedule(preparedState: PreparedScheduleState): BasicScheduleResult {
  const workOrderById = new Map(
    preparedState.enrichedWorkOrders.map((workOrder) => [workOrder.docId, workOrder]),
  );
  const executionGraph = buildExecutionGraph(preparedState, workOrderById);
  const workCenterQueues = buildWorkCenterQueues(executionGraph);
  const availabilityByWorkCenter = flattenAvailability(preparedState);
  const horizon = validateHorizon(
    preparedState.config.horizonStartDate,
    preparedState.config.horizonEndDate,
  );
  const workCenterNextFreeAt = initializeWorkCenterNextFreeAt(
    preparedState,
    availabilityByWorkCenter,
    horizon.start,
  );
  const scheduledWorkOrdersByExecutionId: Record<string, ScheduledWorkOrder> = {};

  for (const executionId of executionGraph.topologicalOrder) {
    const execution = getRequiredExecution(executionGraph.executionsById, executionId);
    const dependencyReadyAt = getDependencyReadyAt(
      execution,
      scheduledWorkOrdersByExecutionId,
      horizon.start,
    );
    const workCenterReadyAt =
      workCenterNextFreeAt.get(execution.workOrder.data.workCenterId) ?? horizon.start;
    const earliestStart = maxDateTime(dependencyReadyAt, workCenterReadyAt);
    const scheduledWorkOrder = placeWorkOrder(
      execution,
      availabilityByWorkCenter[execution.workOrder.data.workCenterId] ?? [],
      earliestStart,
      horizon,
    );

    scheduledWorkOrdersByExecutionId[execution.executionId] = scheduledWorkOrder;
    workCenterNextFreeAt.set(
      execution.workOrder.data.workCenterId,
      parseUtcDateTime(
        scheduledWorkOrder.scheduledEndDate,
        `${execution.executionId}.scheduledEndDate`,
      ),
    );
  }

  return {
    preparedState,
    workCenterQueues,
    scheduledWorkOrders: executionGraph.topologicalOrder.map(
      (executionId) => scheduledWorkOrdersByExecutionId[executionId] as ScheduledWorkOrder,
    ),
    scheduledWorkOrdersByExecutionId,
    scheduledWorkOrdersById: scheduledWorkOrdersByExecutionId,
  };
}

function buildExecutionGraph(
  preparedState: PreparedScheduleState,
  workOrderById: Map<string, EnrichedWorkOrder>,
): ExecutionGraph {
  const executionsById = new Map<string, WorkOrderExecution>();
  const edges = new Map<string, string[]>();
  const incomingEdges = new Map<string, string[]>();
  const originalOrderRank = new Map(
    preparedState.topologicalOrder.map((workOrderId, index) => [workOrderId, index]),
  );

  for (const workOrderId of preparedState.topologicalOrder) {
    const workOrder = getRequiredWorkOrder(workOrderById, workOrderId);
    const totalQuantity = getManufacturingQuantity(workOrder);

    // A manufacturing quantity of N means the same work-order chain must run N times.
    // Dependencies are copied by unit number, so A#2 depends on its matching predecessor B#2,
    // not on B#1 from another finished unit.
    for (let unitNumber = 1; unitNumber <= totalQuantity; unitNumber += 1) {
      const executionId = buildExecutionId(workOrder.docId, unitNumber);
      const execution: WorkOrderExecution = {
        executionId,
        workOrder,
        unitNumber,
        totalQuantity,
        dependsOnExecutionIds: workOrder.data.dependsOnWorkOrderIds.map((dependencyId) =>
          buildExecutionId(dependencyId, unitNumber),
        ),
      };

      executionsById.set(executionId, execution);
      edges.set(executionId, []);
      incomingEdges.set(executionId, []);
    }
  }

  for (const execution of executionsById.values()) {
    for (const dependencyExecutionId of execution.dependsOnExecutionIds) {
      if (!executionsById.has(dependencyExecutionId)) {
        throw new SchedulingError(
          `Execution ${execution.executionId} depends on missing execution ${dependencyExecutionId}.`,
        );
      }

      getRequiredArray(edges, dependencyExecutionId).push(execution.executionId);
      getRequiredArray(incomingEdges, execution.executionId).push(dependencyExecutionId);
    }
  }

  return {
    executionsById,
    topologicalOrder: topologicalSortExecutions(
      executionsById,
      edges,
      incomingEdges,
      originalOrderRank,
    ),
  };
}

function topologicalSortExecutions(
  executionsById: Map<string, WorkOrderExecution>,
  edges: Map<string, string[]>,
  incomingEdges: Map<string, string[]>,
  originalOrderRank: Map<string, number>,
): string[] {
  const indegree = new Map(
    [...executionsById.keys()].map((executionId) => [
      executionId,
      getRequiredArray(incomingEdges, executionId).length,
    ]),
  );
  const ready = [...executionsById.keys()]
    .filter((executionId) => (indegree.get(executionId) ?? 0) === 0)
    .sort((left, right) => compareExecutionIds(left, right, executionsById, originalOrderRank));
  const topologicalOrder: string[] = [];

  while (ready.length > 0) {
    ready.sort((left, right) => compareExecutionIds(left, right, executionsById, originalOrderRank));

    const current = ready.shift();

    if (current === undefined) {
      throw new SchedulingError("Execution ready queue unexpectedly empty.");
    }

    topologicalOrder.push(current);

    const dependents = [...getRequiredArray(edges, current)].sort((left, right) =>
      compareExecutionIds(left, right, executionsById, originalOrderRank),
    );

    for (const dependent of dependents) {
      const nextIndegree = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, nextIndegree);

      if (nextIndegree === 0) {
        ready.push(dependent);
      }
    }
  }

  if (topologicalOrder.length !== executionsById.size) {
    throw new SchedulingError("Expanded execution graph contains a cycle.");
  }

  return topologicalOrder;
}

function compareExecutionIds(
  leftId: string,
  rightId: string,
  executionsById: Map<string, WorkOrderExecution>,
  originalOrderRank: Map<string, number>,
): number {
  const left = getRequiredExecution(executionsById, leftId);
  const right = getRequiredExecution(executionsById, rightId);
  const leftRank = originalOrderRank.get(left.workOrder.docId) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = originalOrderRank.get(right.workOrder.docId) ?? Number.MAX_SAFE_INTEGER;

  return leftRank - rightRank || left.unitNumber - right.unitNumber || leftId.localeCompare(rightId);
}

function buildWorkCenterQueues(executionGraph: ExecutionGraph): WorkCenterQueues {
  const queues: WorkCenterQueues = {};

  for (const executionId of executionGraph.topologicalOrder) {
    const execution = getRequiredExecution(executionGraph.executionsById, executionId);
    const workCenterId = execution.workOrder.data.workCenterId;

    queues[workCenterId] ??= [];
    queues[workCenterId].push(executionId);
  }

  return queues;
}

function flattenAvailability(
  preparedState: PreparedScheduleState,
): Record<string, DateTimeInterval[]> {
  const result: Record<string, DateTimeInterval[]> = {};

  for (const [workCenterId, availabilityByDate] of Object.entries(
    preparedState.availabilityByWorkCenter,
  )) {
    result[workCenterId] = flattenAvailabilityDays(availabilityByDate);
  }

  return result;
}

function flattenAvailabilityDays(availabilityByDate: AvailabilityByDate): DateTimeInterval[] {
  return Object.values(availabilityByDate)
    .flatMap((day) => day.intervals)
    .map(toDateTimeInterval)
    .sort((left, right) => left.start.toMillis() - right.start.toMillis());
}

function toDateTimeInterval(interval: TimeInterval): DateTimeInterval {
  return {
    start: parseUtcDateTime(interval.startDate, "availability.interval.startDate"),
    end: parseUtcDateTime(interval.endDate, "availability.interval.endDate"),
  };
}

function initializeWorkCenterNextFreeAt(
  preparedState: PreparedScheduleState,
  availabilityByWorkCenter: Record<string, DateTimeInterval[]>,
  horizonStart: DateTime,
): Map<string, DateTime> {
  const nextFreeAt = new Map<string, DateTime>();

  for (const workCenterId of Object.keys(preparedState.availabilityByWorkCenter)) {
    nextFreeAt.set(workCenterId, availabilityByWorkCenter[workCenterId]?.[0]?.start ?? horizonStart);
  }

  return nextFreeAt;
}

function getDependencyReadyAt(
  execution: WorkOrderExecution,
  scheduledWorkOrdersByExecutionId: Record<string, ScheduledWorkOrder>,
  horizonStart: DateTime,
): DateTime {
  return execution.dependsOnExecutionIds.reduce((readyAt, dependencyId) => {
    const scheduledDependency = scheduledWorkOrdersByExecutionId[dependencyId];

    if (scheduledDependency === undefined) {
      throw new SchedulingError(
        `Execution ${execution.executionId} cannot be scheduled before dependency ${dependencyId}.`,
      );
    }

    return maxDateTime(
      readyAt,
      parseUtcDateTime(
        scheduledDependency.scheduledEndDate,
        `${dependencyId}.scheduledEndDate`,
      ),
    );
  }, horizonStart);
}

function placeWorkOrder(
  execution: WorkOrderExecution,
  availabilityIntervals: DateTimeInterval[],
  earliestStart: DateTime,
  horizon: DateTimeInterval,
): ScheduledWorkOrder {
  let remainingMinutes = execution.workOrder.data.durationMinutes;
  const segments: ScheduledWorkSegment[] = [];

  for (const interval of availabilityIntervals) {
    if (interval.end.toMillis() <= earliestStart.toMillis()) {
      continue;
    }

    const segmentStart = maxDateTime(interval.start, earliestStart);
    const availableMinutes = minutesBetween(segmentStart, interval.end);

    if (availableMinutes <= 0) {
      continue;
    }

    const workingMinutes = Math.min(availableMinutes, remainingMinutes);
    const segmentEnd = segmentStart.plus({ minutes: workingMinutes });

    // Store every actual working segment, because a single execution can pause
    // across closed hours or maintenance windows and resume later.
    segments.push({
      workCenterId: execution.workOrder.data.workCenterId,
      startDate: toUtcIso(segmentStart),
      endDate: toUtcIso(segmentEnd),
      workingMinutes,
    });

    remainingMinutes -= workingMinutes;

    if (remainingMinutes === 0) {
      return toScheduledWorkOrder(execution, segments);
    }
  }

  throw new SchedulingError(
    `Execution ${execution.executionId} cannot fit inside the planning horizon ending ${toUtcIso(
      horizon.end,
    )}. Remaining minutes: ${remainingMinutes}.`,
  );
}

function toScheduledWorkOrder(
  execution: WorkOrderExecution,
  segments: ScheduledWorkSegment[],
): ScheduledWorkOrder {
  const { workOrder } = execution;
  const firstSegment = segments[0];
  const lastSegment = segments.at(-1);

  if (firstSegment === undefined || lastSegment === undefined) {
    throw new SchedulingError(`Execution ${execution.executionId} produced no scheduled segments.`);
  }

  return {
    executionId: execution.executionId,
    workOrderId: workOrder.docId,
    workOrderNumber: workOrder.data.workOrderNumber,
    manufacturingOrderId: workOrder.data.manufacturingOrderId,
    manufacturingOrderNumber: workOrder.data.manufacturingOrder.manufacturingOrderNumber,
    workCenterId: workOrder.data.workCenterId,
    unitNumber: execution.unitNumber,
    totalQuantity: execution.totalQuantity,
    remainingQuantityAfterExecution: execution.totalQuantity - execution.unitNumber,
    originalStartDate: workOrder.data.startDate,
    originalEndDate: workOrder.data.endDate,
    scheduledStartDate: firstSegment.startDate,
    scheduledEndDate: lastSegment.endDate,
    durationMinutes: workOrder.data.durationMinutes,
    dependsOnWorkOrderIds: [...workOrder.data.dependsOnWorkOrderIds],
    segments,
  };
}

function getManufacturingQuantity(workOrder: EnrichedWorkOrder): number {
  const quantity = workOrder.data.manufacturingOrder.quantity;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new SchedulingError(
      `Manufacturing order ${workOrder.data.manufacturingOrder.docId} must have a positive integer quantity.`,
    );
  }

  return quantity;
}

function buildExecutionId(workOrderId: string, unitNumber: number): string {
  return `${workOrderId}#${unitNumber}`;
}

function getRequiredExecution(
  executionsById: Map<string, WorkOrderExecution>,
  executionId: string,
): WorkOrderExecution {
  const execution = executionsById.get(executionId);

  if (execution === undefined) {
    throw new SchedulingError(`Missing execution ${executionId}.`);
  }

  return execution;
}

function getRequiredWorkOrder(
  workOrderById: Map<string, EnrichedWorkOrder>,
  workOrderId: string,
): EnrichedWorkOrder {
  const workOrder = workOrderById.get(workOrderId);

  if (workOrder === undefined) {
    throw new SchedulingError(`Missing work order ${workOrderId}.`);
  }

  return workOrder;
}

function getRequiredArray(map: Map<string, string[]>, key: string): string[] {
  const value = map.get(key);

  if (value === undefined) {
    throw new SchedulingError(`Missing execution graph entry for ${key}.`);
  }

  return value;
}
