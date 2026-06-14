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
  edges: Map<string, string[]>;
  incomingEdges: Map<string, string[]>;
  topologicalOrder: string[];
}

interface ScheduleExecutionContext {
  availabilityByWorkCenter: Record<string, DateTimeInterval[]>;
  horizon: DateTimeInterval;
  scheduledWorkOrdersByExecutionId: Record<string, ScheduledWorkOrder>;
  workCenterNextFreeAt: Map<string, DateTime>;
}

interface PrioritySelection {
  executionId: string;
  priorityPath: string[];
}

// This is intentionally a simple first-pass scheduler: it consumes the prepared DAG,
// expands manufacturing quantity into per-unit executions, then picks ready work with
// a conservative work-center balancing heuristic before placing each execution.
export function buildBasicSchedule(preparedState: PreparedScheduleState): BasicScheduleResult {
  const workOrderById = new Map(
    preparedState.enrichedWorkOrders.map((workOrder) => [workOrder.docId, workOrder]),
  );
  const executionGraph = buildExecutionGraph(preparedState, workOrderById);
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
  const scheduleOrder = scheduleExecutions(executionGraph, {
    availabilityByWorkCenter,
    horizon,
    scheduledWorkOrdersByExecutionId,
    workCenterNextFreeAt,
  });

  return {
    preparedState,
    workCenterQueues: buildWorkCenterQueues(executionGraph, scheduleOrder),
    scheduledWorkOrders: scheduleOrder.map(
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
    edges,
    incomingEdges,
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

function scheduleExecutions(
  executionGraph: ExecutionGraph,
  context: ScheduleExecutionContext,
): string[] {
  const indegree = new Map(
    [...executionGraph.executionsById.keys()].map((executionId) => [
      executionId,
      getRequiredArray(executionGraph.incomingEdges, executionId).length,
    ]),
  );
  const originalOrderRank = new Map(
    executionGraph.topologicalOrder.map((executionId, index) => [executionId, index]),
  );
  const ready = [...executionGraph.executionsById.keys()]
    .filter((executionId) => (indegree.get(executionId) ?? 0) === 0)
    .sort((left, right) => compareExecutionIdsByRank(left, right, originalOrderRank));
  const scheduleOrder: string[] = [];
  let priorityPath: string[] = [];

  while (ready.length > 0) {
    ready.sort((left, right) => compareExecutionIdsByRank(left, right, originalOrderRank));

    const selection = selectNextExecution(
      ready,
      priorityPath,
      executionGraph,
      context,
      originalOrderRank,
    );
    priorityPath = selection.priorityPath;
    const readyIndex = ready.indexOf(selection.executionId);

    if (readyIndex === -1) {
      throw new SchedulingError(`Selected execution ${selection.executionId} is not ready.`);
    }

    ready.splice(readyIndex, 1);

    const scheduledWorkOrder = scheduleExecution(
      getRequiredExecution(executionGraph.executionsById, selection.executionId),
      context,
    );
    context.scheduledWorkOrdersByExecutionId[selection.executionId] = scheduledWorkOrder;
    context.workCenterNextFreeAt.set(
      scheduledWorkOrder.workCenterId,
      parseUtcDateTime(
        scheduledWorkOrder.scheduledEndDate,
        `${selection.executionId}.scheduledEndDate`,
      ),
    );
    scheduleOrder.push(selection.executionId);

    for (const dependentId of getRequiredArray(executionGraph.edges, selection.executionId)) {
      const nextIndegree = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, nextIndegree);

      if (nextIndegree === 0) {
        ready.push(dependentId);
      }
    }
  }

  if (scheduleOrder.length !== executionGraph.executionsById.size) {
    throw new SchedulingError("Expanded execution graph contains unscheduled executions.");
  }

  return scheduleOrder;
}

function selectNextExecution(
  ready: string[],
  priorityPath: string[],
  executionGraph: ExecutionGraph,
  context: ScheduleExecutionContext,
  originalOrderRank: Map<string, number>,
): PrioritySelection {
  const readySet = new Set(ready);
  const nextPriorityExecutionId = priorityPath.find((executionId) => readySet.has(executionId));

  // Once a safe BFS path is selected, keep following it while its next nodes are ready.
  if (nextPriorityExecutionId !== undefined) {
    return {
      executionId: nextPriorityExecutionId,
      priorityPath: priorityPath.slice(priorityPath.indexOf(nextPriorityExecutionId) + 1),
    };
  }

  // If a ready execution can use the earliest free work center immediately, take it
  // before walking deeper through the graph.
  const directlyAvailable = ready
    .filter((executionId) =>
      isWorkCenterAtEarliestReadyTime(
        getRequiredExecution(executionGraph.executionsById, executionId).workOrder.data
          .workCenterId,
        context.workCenterNextFreeAt,
      ),
    )
    .sort((left, right) => compareExecutionIdsByRank(left, right, originalOrderRank));

  if (directlyAvailable[0] !== undefined) {
    return { executionId: directlyAvailable[0], priorityPath: [] };
  }

  const candidates = ready
    .map((executionId) =>
      findWorkCenterBalancingPath(executionId, executionGraph, context, originalOrderRank),
    )
    .filter((candidate): candidate is { path: string[]; durationMinutes: number } => candidate !== null)
    .sort(
      (left, right) =>
        left.path.length - right.path.length ||
        left.durationMinutes - right.durationMinutes ||
        compareExecutionIdsByRank(left.path[0] as string, right.path[0] as string, originalOrderRank),
    );

  const candidate = candidates[0];

  if (candidate !== undefined) {
    return {
      executionId: candidate.path[0] as string,
      priorityPath: candidate.path.slice(1),
    };
  }

  return { executionId: ready[0] as string, priorityPath: [] };
}

function findWorkCenterBalancingPath(
  startExecutionId: string,
  executionGraph: ExecutionGraph,
  context: ScheduleExecutionContext,
  originalOrderRank: Map<string, number>,
): { path: string[]; durationMinutes: number } | null {
  const startExecution = getRequiredExecution(executionGraph.executionsById, startExecutionId);
  const targetWorkCenterIds = getEarlierReadyWorkCenterIds(
    startExecution.workOrder.data.workCenterId,
    context.workCenterNextFreeAt,
  );

  if (targetWorkCenterIds.size === 0) {
    return null;
  }

  // BFS finds the closest descendant that would move work onto a work center that
  // is ready earlier than the candidate's current work center.
  const queue: string[][] = [[startExecutionId]];
  const visited = new Set([startExecutionId]);

  while (queue.length > 0) {
    const path = queue.shift() as string[];
    const currentExecutionId = path.at(-1) as string;
    const currentExecution = getRequiredExecution(
      executionGraph.executionsById,
      currentExecutionId,
    );
    const isTarget =
      currentExecutionId !== startExecutionId &&
      targetWorkCenterIds.has(currentExecution.workOrder.data.workCenterId);

    if (isTarget && canSchedulePathBeforeDeadlines(path, executionGraph, context)) {
      return {
        path,
        durationMinutes: path.reduce(
          (total, executionId) =>
            total + getRequiredExecution(executionGraph.executionsById, executionId).workOrder.data.durationMinutes,
          0,
        ),
      };
    }

    const dependents = [...getRequiredArray(executionGraph.edges, currentExecutionId)].sort(
      (left, right) => compareExecutionIdsByRank(left, right, originalOrderRank),
    );

    for (const dependentId of dependents) {
      if (visited.has(dependentId)) {
        continue;
      }

      const nextPath = [...path, dependentId];

      if (!dependenciesAreReachableByPath(dependentId, nextPath, executionGraph, context)) {
        continue;
      }

      visited.add(dependentId);
      queue.push(nextPath);
    }
  }

  return null;
}

function dependenciesAreReachableByPath(
  executionId: string,
  path: string[],
  executionGraph: ExecutionGraph,
  context: ScheduleExecutionContext,
): boolean {
  const pathSet = new Set(path);
  const scheduledSet = new Set(Object.keys(context.scheduledWorkOrdersByExecutionId));

  return getRequiredArray(executionGraph.incomingEdges, executionId).every(
    (dependencyId) => scheduledSet.has(dependencyId) || pathSet.has(dependencyId),
  );
}

function canSchedulePathBeforeDeadlines(
  path: string[],
  executionGraph: ExecutionGraph,
  context: ScheduleExecutionContext,
): boolean {
  const scheduledWorkOrdersByExecutionId = { ...context.scheduledWorkOrdersByExecutionId };
  const workCenterNextFreeAt = new Map(context.workCenterNextFreeAt);
  const simulationContext: ScheduleExecutionContext = {
    availabilityByWorkCenter: context.availabilityByWorkCenter,
    horizon: context.horizon,
    scheduledWorkOrdersByExecutionId,
    workCenterNextFreeAt,
  };

  try {
    for (const executionId of path) {
      const execution = getRequiredExecution(executionGraph.executionsById, executionId);

      if (
        !execution.dependsOnExecutionIds.every(
          (dependencyId) => scheduledWorkOrdersByExecutionId[dependencyId] !== undefined,
        )
      ) {
        return false;
      }

      const scheduledWorkOrder = scheduleExecution(execution, simulationContext);
      const manufacturingDueDate = parseUtcDateTime(
        execution.workOrder.data.manufacturingOrder.dueDate,
        `${execution.workOrder.data.manufacturingOrder.docId}.dueDate`,
      );
      const scheduledEndDate = parseUtcDateTime(
        scheduledWorkOrder.scheduledEndDate,
        `${executionId}.scheduledEndDate`,
      );

      if (scheduledEndDate.toMillis() > manufacturingDueDate.toMillis()) {
        return false;
      }

      scheduledWorkOrdersByExecutionId[executionId] = scheduledWorkOrder;
      workCenterNextFreeAt.set(execution.workOrder.data.workCenterId, scheduledEndDate);
    }
  } catch (error) {
    if (error instanceof SchedulingError) {
      return false;
    }

    throw error;
  }

  return true;
}

function scheduleExecution(
  execution: WorkOrderExecution,
  context: ScheduleExecutionContext,
): ScheduledWorkOrder {
  const dependencyReadyAt = getDependencyReadyAt(
    execution,
    context.scheduledWorkOrdersByExecutionId,
    context.horizon.start,
  );
  const workCenterReadyAt =
    context.workCenterNextFreeAt.get(execution.workOrder.data.workCenterId) ??
    context.horizon.start;
  const workOrderWindowStart = parseUtcDateTime(
    execution.workOrder.data.startDate,
    `${execution.workOrder.docId}.startDate`,
  );
  const workOrderWindowEnd = parseUtcDateTime(
    execution.workOrder.data.endDate,
    `${execution.workOrder.docId}.endDate`,
  );
  const earliestStart = maxDateTime(
    maxDateTime(dependencyReadyAt, workCenterReadyAt),
    workOrderWindowStart,
  );

  return placeWorkOrder(
    execution,
    context.availabilityByWorkCenter[execution.workOrder.data.workCenterId] ?? [],
    earliestStart,
    workOrderWindowEnd,
    context.horizon,
  );
}

function isWorkCenterAtEarliestReadyTime(
  workCenterId: string,
  workCenterNextFreeAt: Map<string, DateTime>,
): boolean {
  const workCenterReadyAt = workCenterNextFreeAt.get(workCenterId);

  if (workCenterReadyAt === undefined) {
    return false;
  }

  return workCenterReadyAt.toMillis() === getEarliestWorkCenterReadyAt(workCenterNextFreeAt);
}

function getEarlierReadyWorkCenterIds(
  workCenterId: string,
  workCenterNextFreeAt: Map<string, DateTime>,
): Set<string> {
  const workCenterReadyAt = workCenterNextFreeAt.get(workCenterId);

  if (workCenterReadyAt === undefined) {
    return new Set();
  }

  return new Set(
    [...workCenterNextFreeAt.entries()]
      .filter(([candidateWorkCenterId, readyAt]) =>
        candidateWorkCenterId !== workCenterId &&
        readyAt.toMillis() < workCenterReadyAt.toMillis()
      )
      .map(([candidateWorkCenterId]) => candidateWorkCenterId),
  );
}

function getEarliestWorkCenterReadyAt(workCenterNextFreeAt: Map<string, DateTime>): number {
  return Math.min(...[...workCenterNextFreeAt.values()].map((readyAt) => readyAt.toMillis()));
}

function compareExecutionIdsByRank(
  leftId: string,
  rightId: string,
  originalOrderRank: Map<string, number>,
): number {
  return (
    (originalOrderRank.get(leftId) ?? Number.MAX_SAFE_INTEGER) -
      (originalOrderRank.get(rightId) ?? Number.MAX_SAFE_INTEGER) ||
    leftId.localeCompare(rightId)
  );
}

function buildWorkCenterQueues(
  executionGraph: ExecutionGraph,
  scheduleOrder: string[],
): WorkCenterQueues {
  const queues: WorkCenterQueues = {};

  for (const executionId of scheduleOrder) {
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
  latestEnd: DateTime,
  horizon: DateTimeInterval,
): ScheduledWorkOrder {
  let remainingMinutes = execution.workOrder.data.durationMinutes;
  const segments: ScheduledWorkSegment[] = [];

  if (latestEnd.toMillis() <= earliestStart.toMillis()) {
    throw new SchedulingError(
      `Execution ${execution.executionId} cannot start before its work order window closes at ${toUtcIso(
        latestEnd,
      )}.`,
    );
  }

  for (const interval of availabilityIntervals) {
    if (interval.end.toMillis() <= earliestStart.toMillis()) {
      continue;
    }

    if (interval.start.toMillis() >= latestEnd.toMillis()) {
      break;
    }

    const segmentStart = maxDateTime(interval.start, earliestStart);
    const segmentBoundary = minDateTime(interval.end, latestEnd);
    const availableMinutes = minutesBetween(segmentStart, segmentBoundary);

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
    `Execution ${execution.executionId} cannot fit inside its work order window ending ${toUtcIso(
      latestEnd,
    )} before the planning horizon ending ${toUtcIso(horizon.end)}. Remaining minutes: ${remainingMinutes}.`,
  );
}

function minDateTime(...values: DateTime[]): DateTime {
  return values.reduce((minimum, value) =>
    value.toMillis() < minimum.toMillis() ? value : minimum,
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
