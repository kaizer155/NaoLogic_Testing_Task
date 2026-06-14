import { buildAvailabilityByWorkCenter } from "./availability-map.js";
import { buildBasicSchedule } from "./basic-scheduler.js";
import { validatePrepareScheduleInput } from "./constraint-checker.js";
import { buildDependencyGraph } from "./dependency-graph.js";
import type {
  BasicScheduleResult,
  EnrichedWorkOrder,
  ManufacturingOrderDocument,
  PrepareScheduleInput,
  PreparedScheduleState,
  ReflowConfig,
  WorkOrderDocument,
} from "./types.js";
import { SchedulingError } from "./types.js";

export const DEFAULT_REFLOW_CONFIG: ReflowConfig = {
  horizonStartDate: "2026-01-01T00:00:00.000Z",
  horizonEndDate: "2026-02-01T00:00:00.000Z",
};

export class ReflowService {
  prepare(input: PrepareScheduleInput): PreparedScheduleState {
    return this.prepareScheduleState(input);
  }

  prepareScheduleState(input: PrepareScheduleInput): PreparedScheduleState {
    return prepareScheduleState(input);
  }

  schedule(input: PrepareScheduleInput): BasicScheduleResult {
    return buildBasicSchedule(this.prepareScheduleState(input));
  }
}

export function prepareScheduleState(input: PrepareScheduleInput): PreparedScheduleState {
  const config = resolveConfig(input.config);

  validatePrepareScheduleInput(input.workOrders, input.workCenters, input.manufacturingOrders);

  // Keep the public document shape unchanged, but enrich work orders internally
  // so scheduling code can read manufacturing context without repeated lookups.
  const enrichedWorkOrders = enrichWorkOrders(input.workOrders, input.manufacturingOrders);
  const availabilityByWorkCenter = buildAvailabilityByWorkCenter(input.workCenters, config);
  const dependencyGraph = buildDependencyGraph(enrichedWorkOrders);

  return {
    config,
    enrichedWorkOrders,
    availabilityByWorkCenter,
    dependencyGraph,
    topologicalOrder: dependencyGraph.topologicalOrder,
  };
}

export function enrichWorkOrders(
  workOrders: WorkOrderDocument[],
  manufacturingOrders: ManufacturingOrderDocument[],
): EnrichedWorkOrder[] {
  const manufacturingOrderById = new Map(
    manufacturingOrders.map((manufacturingOrder) => [manufacturingOrder.docId, manufacturingOrder]),
  );

  return workOrders.map((workOrder) => {
    const manufacturingOrder = manufacturingOrderById.get(workOrder.data.manufacturingOrderId);

    if (manufacturingOrder === undefined) {
      throw new SchedulingError(
        `Work order ${workOrder.docId} references missing manufacturing order ${workOrder.data.manufacturingOrderId}.`,
      );
    }

    return {
      docId: workOrder.docId,
      docType: workOrder.docType,
      data: {
        ...workOrder.data,
        dependsOnWorkOrderIds: [...workOrder.data.dependsOnWorkOrderIds],
        manufacturingOrder: {
          docId: manufacturingOrder.docId,
          ...manufacturingOrder.data,
        },
      },
    };
  });
}

function resolveConfig(config?: Partial<ReflowConfig>): ReflowConfig {
  return {
    horizonStartDate: config?.horizonStartDate ?? DEFAULT_REFLOW_CONFIG.horizonStartDate,
    horizonEndDate: config?.horizonEndDate ?? DEFAULT_REFLOW_CONFIG.horizonEndDate,
  };
}
