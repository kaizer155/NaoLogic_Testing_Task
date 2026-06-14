import type {
  DependencyGraph,
  DependencyGraphNode,
  EnrichedWorkOrder,
} from "./types.js";
import { DependencyCycleError, SchedulingError } from "./types.js";
import { compareIsoDates, minutesBetween, parseUtcDateTime } from "../utils/date-utils.js";

export function buildDependencyGraph(workOrders: EnrichedWorkOrder[]): DependencyGraph {
  const workOrderById = new Map(workOrders.map((workOrder) => [workOrder.docId, workOrder]));
  const nodeMap = new Map<string, DependencyGraphNode>();
  const edgeMap = new Map<string, string[]>();
  const incomingEdgeMap = new Map<string, string[]>();

  for (const workOrder of workOrders) {
    nodeMap.set(workOrder.docId, {
      workOrderId: workOrder.docId,
      dependsOnWorkOrderIds: unique(workOrder.data.dependsOnWorkOrderIds),
      dependentWorkOrderIds: [],
    });
    edgeMap.set(workOrder.docId, []);
    incomingEdgeMap.set(workOrder.docId, []);
  }

  for (const workOrder of workOrders) {
    for (const dependencyId of unique(workOrder.data.dependsOnWorkOrderIds)) {
      if (!workOrderById.has(dependencyId)) {
        throw new SchedulingError(
          `Work order ${workOrder.docId} depends on missing work order ${dependencyId}.`,
        );
      }

      // Edges point from predecessor to successor: if C depends on B, store B -> C.
      // That direction makes topological order match the production flow.
      getRequiredArray(edgeMap, dependencyId).push(workOrder.docId);
      getRequiredArray(incomingEdgeMap, workOrder.docId).push(dependencyId);
    }
  }

  for (const [workOrderId, dependentWorkOrderIds] of edgeMap.entries()) {
    const node = nodeMap.get(workOrderId);

    if (node === undefined) {
      throw new SchedulingError(`Missing dependency graph node ${workOrderId}.`);
    }

    node.dependentWorkOrderIds = [...dependentWorkOrderIds].sort((left, right) =>
      compareWorkOrderIds(left, right, workOrderById),
    );
  }

  const topologicalOrder = topologicalSort(workOrders, edgeMap, incomingEdgeMap, workOrderById);

  return {
    nodes: mapToRecord(nodeMap),
    edges: mapToRecordWithSortedArrays(edgeMap, workOrderById),
    incomingEdges: mapToRecordWithSortedArrays(incomingEdgeMap, workOrderById),
    topologicalOrder,
  };
}

function topologicalSort(
  workOrders: EnrichedWorkOrder[],
  edgeMap: Map<string, string[]>,
  incomingEdgeMap: Map<string, string[]>,
  workOrderById: Map<string, EnrichedWorkOrder>,
): string[] {
  const indegree = new Map(
    workOrders.map((workOrder) => [
      workOrder.docId,
      getRequiredArray(incomingEdgeMap, workOrder.docId).length,
    ]),
  );
  const ready = workOrders
    .filter((workOrder) => (indegree.get(workOrder.docId) ?? 0) === 0)
    .map((workOrder) => workOrder.docId)
    .sort((left, right) => compareWorkOrderIds(left, right, workOrderById));
  const topologicalOrder: string[] = [];

  while (ready.length > 0) {
    ready.sort((left, right) => compareWorkOrderIds(left, right, workOrderById));

    const current = ready.shift();

    if (current === undefined) {
      throw new SchedulingError("Dependency graph ready queue unexpectedly empty.");
    }

    topologicalOrder.push(current);

    const dependents = [...getRequiredArray(edgeMap, current)].sort((left, right) =>
      compareWorkOrderIds(left, right, workOrderById),
    );

    for (const dependent of dependents) {
      const nextIndegree = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, nextIndegree);

      if (nextIndegree === 0) {
        ready.push(dependent);
      }
    }
  }

  if (topologicalOrder.length !== workOrders.length) {
    const cyclePath =
      findCyclePath(edgeMap, workOrders.map((workOrder) => workOrder.docId), workOrderById) ?? [];
    throw new DependencyCycleError(cyclePath);
  }

  return topologicalOrder;
}

function findCyclePath(
  edgeMap: Map<string, string[]>,
  workOrderIds: string[],
  workOrderById: Map<string, EnrichedWorkOrder>,
): string[] | null {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const sortedIds = [...workOrderIds].sort((left, right) =>
    compareWorkOrderIds(left, right, workOrderById),
  );

  const visit = (workOrderId: string): string[] | null => {
    state.set(workOrderId, "visiting");
    stack.push(workOrderId);

    const dependents = [...getRequiredArray(edgeMap, workOrderId)].sort((left, right) =>
      compareWorkOrderIds(left, right, workOrderById),
    );

    for (const dependent of dependents) {
      const dependentState = state.get(dependent);

      if (dependentState === "visiting") {
        const cycleStartIndex = stack.indexOf(dependent);
        return [...stack.slice(cycleStartIndex), dependent];
      }

      if (dependentState === undefined) {
        const cyclePath = visit(dependent);

        if (cyclePath !== null) {
          return cyclePath;
        }
      }
    }

    stack.pop();
    state.set(workOrderId, "visited");
    return null;
  };

  for (const workOrderId of sortedIds) {
    if (state.get(workOrderId) === undefined) {
      const cyclePath = visit(workOrderId);

      if (cyclePath !== null) {
        return cyclePath;
      }
    }
  }

  return null;
}

function compareWorkOrderIds(
  leftId: string,
  rightId: string,
  workOrderById: Map<string, EnrichedWorkOrder>,
): number {
  return compareWorkOrders(
    getRequiredWorkOrder(workOrderById, leftId),
    getRequiredWorkOrder(workOrderById, rightId),
  );
}

export function compareWorkOrders(left: EnrichedWorkOrder, right: EnrichedWorkOrder): number {
  // Deterministic tie-breaking keeps the schedule stable when several nodes are
  // simultaneously available. Shorter original windows are prioritized after start date.
  return (
    compareIsoDates(left.data.startDate, right.data.startDate) ||
    scheduledIntervalMinutes(left) - scheduledIntervalMinutes(right) ||
    compareIsoDates(left.data.manufacturingOrder.dueDate, right.data.manufacturingOrder.dueDate) ||
    compareIsoDates(left.data.endDate, right.data.endDate) ||
    left.data.workOrderNumber.localeCompare(right.data.workOrderNumber) ||
    left.docId.localeCompare(right.docId)
  );
}

function scheduledIntervalMinutes(workOrder: EnrichedWorkOrder): number {
  const start = parseUtcDateTime(workOrder.data.startDate, `${workOrder.docId}.startDate`);
  const end = parseUtcDateTime(workOrder.data.endDate, `${workOrder.docId}.endDate`);

  return minutesBetween(start, end);
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
    throw new SchedulingError(`Missing dependency graph entry for ${key}.`);
  }

  return value;
}

function mapToRecord<TValue>(map: Map<string, TValue>): Record<string, TValue> {
  const record: Record<string, TValue> = {};

  for (const [key, value] of map.entries()) {
    record[key] = value;
  }

  return record;
}

function mapToRecordWithSortedArrays(
  map: Map<string, string[]>,
  workOrderById: Map<string, EnrichedWorkOrder>,
): Record<string, string[]> {
  const record: Record<string, string[]> = {};

  for (const [key, value] of map.entries()) {
    record[key] = [...value].sort((left, right) =>
      compareWorkOrderIds(left, right, workOrderById),
    );
  }

  return record;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
