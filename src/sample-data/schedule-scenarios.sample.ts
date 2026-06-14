import type {
  MaintenanceWindow,
  ManufacturingOrderDocument,
  PrepareScheduleInput,
  WorkCenterDocument,
  WorkCenterShift,
  WorkOrderDocument,
} from "../reflow/types.js";
import { basicScheduleInput, basicScheduleScenarioNotes } from "./basic-schedule.sample.js";

export type ScenarioExpectedStatus = "scheduled" | "error";

export interface ScheduleScenario {
  id: string;
  title: string;
  description: string;
  expectedStatus: ScenarioExpectedStatus;
  notes: string[];
  input: PrepareScheduleInput;
}

const iso = (day: number, hour: number, minute = 0): string =>
  `2026-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(
    minute,
  ).padStart(2, "0")}:00.000Z`;

const weekdayShift = (startHour: number, endHour: number): WorkCenterShift[] =>
  [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    dayOfWeek,
    startHour,
    endHour,
  }));

const workCenter = (
  docId: string,
  name: string,
  startHour: number,
  endHour: number,
  maintenanceWindows: MaintenanceWindow[] = [],
): WorkCenterDocument => ({
  docId,
  docType: "workCenter",
  data: {
    name,
    shifts: weekdayShift(startHour, endHour),
    maintenanceWindows,
  },
});

const manufacturingOrder = (
  docId: string,
  manufacturingOrderNumber: string,
  itemId: string,
  quantity: number,
  dueDate: string,
): ManufacturingOrderDocument => ({
  docId,
  docType: "manufacturingOrder",
  data: {
    manufacturingOrderNumber,
    itemId,
    quantity,
    dueDate,
  },
});

const workOrder = ({
  docId,
  workOrderNumber,
  manufacturingOrderId,
  workCenterId,
  startDate,
  endDate,
  durationMinutes,
  isMaintenance = false,
  dependsOnWorkOrderIds = [],
}: {
  docId: string;
  workOrderNumber: string;
  manufacturingOrderId: string;
  workCenterId: string;
  startDate: string;
  endDate: string;
  durationMinutes: number;
  isMaintenance?: boolean;
  dependsOnWorkOrderIds?: string[];
}): WorkOrderDocument => ({
  docId,
  docType: "workOrder",
  data: {
    workOrderNumber,
    manufacturingOrderId,
    workCenterId,
    startDate,
    endDate,
    durationMinutes,
    isMaintenance,
    dependsOnWorkOrderIds,
  },
});

const config = {
  horizonStartDate: "2026-01-01T00:00:00.000Z",
  horizonEndDate: "2026-02-01T00:00:00.000Z",
};

const compactWorkCenters = (): WorkCenterDocument[] => [
  workCenter("wc-alpha", "Extrusion Alpha", 8, 16, [
    {
      startDate: iso(5, 10),
      endDate: iso(5, 11),
      reason: "Short calibration stop",
    },
  ]),
  workCenter("wc-beta", "Extrusion Beta", 8, 16),
  workCenter("wc-cut", "Cutting Cell", 9, 17, [
    {
      startDate: iso(6, 13),
      endDate: iso(6, 14),
      reason: "Blade inspection",
    },
  ]),
  workCenter("wc-pack", "Packaging Cell", 10, 18),
];

const maintenanceSplitInput = {
  config,
  workCenters: compactWorkCenters(),
  manufacturingOrders: [
    manufacturingOrder("mo-maintenance-split", "MO-2001", "SPLIT-PIPE-50MM", 1, iso(8, 17)),
  ],
  workOrders: [
    workOrder({
      docId: "wo-split-extrude",
      workOrderNumber: "WO-2001-EX",
      manufacturingOrderId: "mo-maintenance-split",
      workCenterId: "wc-alpha",
      startDate: iso(5, 8),
      endDate: iso(5, 13),
      durationMinutes: 180,
    }),
    workOrder({
      docId: "wo-split-pack",
      workOrderNumber: "WO-2001-PACK",
      manufacturingOrderId: "mo-maintenance-split",
      workCenterId: "wc-pack",
      startDate: iso(5, 12),
      endDate: iso(6, 18),
      durationMinutes: 90,
      dependsOnWorkOrderIds: ["wo-split-extrude"],
    }),
  ],
} satisfies PrepareScheduleInput;

const multiParentMergeInput = {
  config,
  workCenters: compactWorkCenters(),
  manufacturingOrders: [
    manufacturingOrder("mo-merge-kit", "MO-2002", "MERGE-KIT", 2, iso(12, 17)),
  ],
  workOrders: [
    workOrder({
      docId: "wo-merge-shell",
      workOrderNumber: "WO-2002-SHELL",
      manufacturingOrderId: "mo-merge-kit",
      workCenterId: "wc-alpha",
      startDate: iso(5, 8),
      endDate: iso(8, 16),
      durationMinutes: 150,
    }),
    workOrder({
      docId: "wo-merge-insert",
      workOrderNumber: "WO-2002-INSERT",
      manufacturingOrderId: "mo-merge-kit",
      workCenterId: "wc-beta",
      startDate: iso(5, 8),
      endDate: iso(8, 16),
      durationMinutes: 120,
    }),
    workOrder({
      docId: "wo-merge-assemble",
      workOrderNumber: "WO-2002-ASM",
      manufacturingOrderId: "mo-merge-kit",
      workCenterId: "wc-cut",
      startDate: iso(5, 9),
      endDate: iso(10, 17),
      durationMinutes: 180,
      dependsOnWorkOrderIds: ["wo-merge-shell", "wo-merge-insert"],
    }),
    workOrder({
      docId: "wo-merge-pack",
      workOrderNumber: "WO-2002-PACK",
      manufacturingOrderId: "mo-merge-kit",
      workCenterId: "wc-pack",
      startDate: iso(6, 10),
      endDate: iso(12, 18),
      durationMinutes: 90,
      dependsOnWorkOrderIds: ["wo-merge-assemble"],
    }),
  ],
} satisfies PrepareScheduleInput;

const dependencyCycleInput = {
  config,
  workCenters: compactWorkCenters(),
  manufacturingOrders: [
    manufacturingOrder("mo-cycle", "MO-3001", "CYCLE-DETECTOR", 1, iso(10, 17)),
  ],
  workOrders: [
    workOrder({
      docId: "wo-cycle-a",
      workOrderNumber: "WO-3001-A",
      manufacturingOrderId: "mo-cycle",
      workCenterId: "wc-alpha",
      startDate: iso(5, 8),
      endDate: iso(10, 16),
      durationMinutes: 60,
      dependsOnWorkOrderIds: ["wo-cycle-c"],
    }),
    workOrder({
      docId: "wo-cycle-b",
      workOrderNumber: "WO-3001-B",
      manufacturingOrderId: "mo-cycle",
      workCenterId: "wc-beta",
      startDate: iso(5, 8),
      endDate: iso(10, 16),
      durationMinutes: 60,
      dependsOnWorkOrderIds: ["wo-cycle-a"],
    }),
    workOrder({
      docId: "wo-cycle-c",
      workOrderNumber: "WO-3001-C",
      manufacturingOrderId: "mo-cycle",
      workCenterId: "wc-cut",
      startDate: iso(5, 9),
      endDate: iso(10, 17),
      durationMinutes: 60,
      dependsOnWorkOrderIds: ["wo-cycle-b"],
    }),
  ],
} satisfies PrepareScheduleInput;

const impossibleWindowInput = {
  config,
  workCenters: compactWorkCenters(),
  manufacturingOrders: [
    manufacturingOrder("mo-impossible-window", "MO-3002", "TOO-TIGHT-PIPE", 1, iso(6, 17)),
  ],
  workOrders: [
    workOrder({
      docId: "wo-tight-extrude",
      workOrderNumber: "WO-3002-EX",
      manufacturingOrderId: "mo-impossible-window",
      workCenterId: "wc-alpha",
      startDate: iso(5, 9),
      endDate: iso(5, 10),
      durationMinutes: 180,
    }),
  ],
} satisfies PrepareScheduleInput;

const missingDependencyInput = {
  config,
  workCenters: compactWorkCenters(),
  manufacturingOrders: [
    manufacturingOrder("mo-missing-dependency", "MO-3003", "MISSING-PARENT", 1, iso(9, 17)),
  ],
  workOrders: [
    workOrder({
      docId: "wo-missing-pack",
      workOrderNumber: "WO-3003-PACK",
      manufacturingOrderId: "mo-missing-dependency",
      workCenterId: "wc-pack",
      startDate: iso(5, 10),
      endDate: iso(9, 18),
      durationMinutes: 90,
      dependsOnWorkOrderIds: ["wo-missing-extrude"],
    }),
  ],
} satisfies PrepareScheduleInput;

export const scheduleScenarios: ScheduleScenario[] = [
  {
    id: "massive-varied",
    title: "Massive Varied Schedule",
    description:
      "Large successful schedule with many manufacturing orders, quantities, maintenance windows, and mixed DAG shapes.",
    expectedStatus: "scheduled",
    notes: basicScheduleScenarioNotes,
    input: basicScheduleInput,
  },
  {
    id: "maintenance-split",
    title: "Maintenance Split",
    description:
      "Small successful schedule where one work order must pause across a maintenance window before a dependent work order can run.",
    expectedStatus: "scheduled",
    notes: [
      "The first work order starts before a maintenance window and resumes after it.",
      "The dependent packaging work order waits for the split execution to finish.",
    ],
    input: maintenanceSplitInput,
  },
  {
    id: "multi-parent-merge",
    title: "Multi-Parent Merge",
    description:
      "Successful DAG with two independent predecessors that must both finish before assembly can start.",
    expectedStatus: "scheduled",
    notes: [
      "Quantity 2 expands the whole dependency chain into two unit executions.",
      "Assembly depends on both shell and insert work orders.",
    ],
    input: multiParentMergeInput,
  },
  {
    id: "dependency-cycle",
    title: "Dependency Cycle Error",
    description:
      "Invalid sample where A depends on C, C depends on B, and B depends on A.",
    expectedStatus: "error",
    notes: [
      "This should fail during dependency graph preparation.",
      "The error should show the cycle path rather than trying to schedule the graph.",
    ],
    input: dependencyCycleInput,
  },
  {
    id: "impossible-window",
    title: "Impossible Window Error",
    description:
      "Invalid sample where the work order needs more working minutes than can fit inside its own start/end window.",
    expectedStatus: "error",
    notes: [
      "This should pass dependency preparation and fail during placement.",
      "The error should mention the execution that cannot fit before the window closes.",
    ],
    input: impossibleWindowInput,
  },
  {
    id: "missing-dependency",
    title: "Missing Dependency Error",
    description:
      "Invalid sample where a work order references a predecessor that does not exist.",
    expectedStatus: "error",
    notes: [
      "This should fail before topological sorting can complete.",
      "The error should point to the missing work order id.",
    ],
    input: missingDependencyInput,
  },
];
