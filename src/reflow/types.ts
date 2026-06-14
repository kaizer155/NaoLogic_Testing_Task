export type DocumentType = "workOrder" | "workCenter" | "manufacturingOrder";

export interface DocumentWrapper<TDocType extends DocumentType, TData> {
  docId: string;
  docType: TDocType;
  data: TData;
}

export interface WorkOrderData {
  workOrderNumber: string;
  manufacturingOrderId: string;
  workCenterId: string;
  startDate: string;
  endDate: string;
  durationMinutes: number;
  isMaintenance: boolean;
  dependsOnWorkOrderIds: string[];
}

export interface WorkCenterShift {
  dayOfWeek: number;
  startHour: number;
  endHour: number;
}

export interface MaintenanceWindow {
  startDate: string;
  endDate: string;
  reason?: string;
}

export interface WorkCenterData {
  name: string;
  shifts: WorkCenterShift[];
  maintenanceWindows: MaintenanceWindow[];
}

export interface ManufacturingOrderData {
  manufacturingOrderNumber: string;
  itemId: string;
  quantity: number;
  dueDate: string;
}

export type WorkOrderDocument = DocumentWrapper<"workOrder", WorkOrderData>;
export type WorkCenterDocument = DocumentWrapper<"workCenter", WorkCenterData>;
export type ManufacturingOrderDocument = DocumentWrapper<
  "manufacturingOrder",
  ManufacturingOrderData
>;

export interface ManufacturingOrderContext extends ManufacturingOrderData {
  docId: string;
}

export type EnrichedWorkOrder = DocumentWrapper<
  "workOrder",
  WorkOrderData & {
    manufacturingOrder: ManufacturingOrderContext;
  }
>;

export interface TimeInterval {
  startDate: string;
  endDate: string;
}

export interface AvailabilityDay {
  date: string;
  intervals: TimeInterval[];
  workingMinutes: number;
  cumulativeWorkingMinutes: number;
}

export type AvailabilityByDate = Record<string, AvailabilityDay>;
export type AvailabilityByWorkCenter = Record<string, AvailabilityByDate>;

export interface DependencyGraphNode {
  workOrderId: string;
  dependsOnWorkOrderIds: string[];
  dependentWorkOrderIds: string[];
}

export interface DependencyGraph {
  nodes: Record<string, DependencyGraphNode>;
  edges: Record<string, string[]>;
  incomingEdges: Record<string, string[]>;
  topologicalOrder: string[];
}

export interface ReflowConfig {
  horizonStartDate: string;
  horizonEndDate: string;
}

export interface PrepareScheduleInput {
  workOrders: WorkOrderDocument[];
  workCenters: WorkCenterDocument[];
  manufacturingOrders: ManufacturingOrderDocument[];
  config?: Partial<ReflowConfig>;
}

export interface PreparedScheduleState {
  config: ReflowConfig;
  enrichedWorkOrders: EnrichedWorkOrder[];
  availabilityByWorkCenter: AvailabilityByWorkCenter;
  dependencyGraph: DependencyGraph;
  topologicalOrder: string[];
}

export type WorkCenterQueues = Record<string, string[]>;

export interface ScheduledWorkSegment extends TimeInterval {
  workCenterId: string;
  workingMinutes: number;
}

export interface ScheduledWorkOrder {
  executionId: string;
  workOrderId: string;
  workOrderNumber: string;
  manufacturingOrderId: string;
  manufacturingOrderNumber: string;
  workCenterId: string;
  unitNumber: number;
  totalQuantity: number;
  remainingQuantityAfterExecution: number;
  originalStartDate: string;
  originalEndDate: string;
  scheduledStartDate: string;
  scheduledEndDate: string;
  durationMinutes: number;
  dependsOnWorkOrderIds: string[];
  segments: ScheduledWorkSegment[];
}

export interface BasicScheduleResult {
  preparedState: PreparedScheduleState;
  workCenterQueues: WorkCenterQueues;
  scheduledWorkOrders: ScheduledWorkOrder[];
  scheduledWorkOrdersByExecutionId: Record<string, ScheduledWorkOrder>;
  scheduledWorkOrdersById: Record<string, ScheduledWorkOrder>;
}

export class SchedulingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulingError";
  }
}

export class DependencyCycleError extends SchedulingError {
  constructor(readonly cyclePath: string[]) {
    super(`Dependency cycle detected: ${cyclePath.join(" -> ")}`);
    this.name = "DependencyCycleError";
  }
}
