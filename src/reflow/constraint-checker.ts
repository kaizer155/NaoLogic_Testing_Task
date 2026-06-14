import type {
  ManufacturingOrderDocument,
  WorkCenterDocument,
  WorkOrderDocument,
} from "./types.js";
import { SchedulingError } from "./types.js";

interface IdentifiedDocument {
  docId: string;
  docType: string;
}

export function validatePrepareScheduleInput(
  workOrders: WorkOrderDocument[],
  workCenters: WorkCenterDocument[],
  manufacturingOrders: ManufacturingOrderDocument[],
): void {
  assertUniqueDocIds("work orders", workOrders);
  assertUniqueDocIds("work centers", workCenters);
  assertUniqueDocIds("manufacturing orders", manufacturingOrders);
  assertWorkCenterReferencesExist(workOrders, workCenters);
  assertManufacturingOrderReferencesExist(workOrders, manufacturingOrders);
  assertValidWorkCenterShifts(workCenters);
  assertValidWorkOrderDurations(workOrders);
}

function assertUniqueDocIds(label: string, documents: IdentifiedDocument[]): void {
  const seen = new Set<string>();

  for (const document of documents) {
    if (seen.has(document.docId)) {
      throw new SchedulingError(`Duplicate ${label} docId detected: ${document.docId}`);
    }

    seen.add(document.docId);
  }
}

function assertWorkCenterReferencesExist(
  workOrders: WorkOrderDocument[],
  workCenters: WorkCenterDocument[],
): void {
  const workCenterIds = new Set(workCenters.map((workCenter) => workCenter.docId));

  for (const workOrder of workOrders) {
    if (!workCenterIds.has(workOrder.data.workCenterId)) {
      throw new SchedulingError(
        `Work order ${workOrder.docId} references missing work center ${workOrder.data.workCenterId}.`,
      );
    }
  }
}

function assertManufacturingOrderReferencesExist(
  workOrders: WorkOrderDocument[],
  manufacturingOrders: ManufacturingOrderDocument[],
): void {
  const manufacturingOrderIds = new Set(
    manufacturingOrders.map((manufacturingOrder) => manufacturingOrder.docId),
  );

  for (const workOrder of workOrders) {
    if (!manufacturingOrderIds.has(workOrder.data.manufacturingOrderId)) {
      throw new SchedulingError(
        `Work order ${workOrder.docId} references missing manufacturing order ${workOrder.data.manufacturingOrderId}.`,
      );
    }
  }
}

function assertValidWorkCenterShifts(workCenters: WorkCenterDocument[]): void {
  for (const workCenter of workCenters) {
    for (const shift of workCenter.data.shifts) {
      if (!Number.isInteger(shift.dayOfWeek) || shift.dayOfWeek < 0 || shift.dayOfWeek > 6) {
        throw new SchedulingError(
          `Shift on ${workCenter.docId} has invalid dayOfWeek ${shift.dayOfWeek}.`,
        );
      }

      assertValidHour(workCenter.docId, "startHour", shift.startHour);
      assertValidHour(workCenter.docId, "endHour", shift.endHour);

      if (shift.startHour === shift.endHour) {
        throw new SchedulingError(`Shift on ${workCenter.docId} must not have equal start/end hours.`);
      }
    }
  }
}

function assertValidHour(workCenterId: string, fieldName: string, hour: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new SchedulingError(`Shift on ${workCenterId} has invalid ${fieldName} ${hour}.`);
  }
}

function assertValidWorkOrderDurations(workOrders: WorkOrderDocument[]): void {
  for (const workOrder of workOrders) {
    if (!Number.isInteger(workOrder.data.durationMinutes) || workOrder.data.durationMinutes <= 0) {
      throw new SchedulingError(
        `Work order ${workOrder.docId} must have positive integer durationMinutes.`,
      );
    }
  }
}
