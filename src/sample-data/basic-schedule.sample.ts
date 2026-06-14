import type { PrepareScheduleInput, WorkCenterShift } from "../reflow/types.js";

const weekdayShift = (startHour: number, endHour: number): WorkCenterShift[] =>
  [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    dayOfWeek,
    startHour,
    endHour,
  }));

export const basicScheduleInput = {
  config: {
    horizonStartDate: "2026-01-01T00:00:00.000Z",
    horizonEndDate: "2026-02-01T00:00:00.000Z",
  },
  workCenters: [
    {
      docId: "wc-extrusion-a",
      docType: "workCenter",
      data: {
        name: "Extrusion Line A",
        shifts: weekdayShift(8, 16),
        maintenanceWindows: [
          {
            startDate: "2026-01-01T12:00:00.000Z",
            endDate: "2026-01-01T14:00:00.000Z",
            reason: "New year calibration",
          },
          {
            startDate: "2026-01-02T10:00:00.000Z",
            endDate: "2026-01-02T11:00:00.000Z",
            reason: "Extruder temperature check",
          },
        ],
      },
    },
    {
      docId: "wc-extrusion-b",
      docType: "workCenter",
      data: {
        name: "Extrusion Line B",
        shifts: weekdayShift(7, 15),
        maintenanceWindows: [
          {
            startDate: "2026-01-01T11:00:00.000Z",
            endDate: "2026-01-01T12:00:00.000Z",
            reason: "Die head inspection",
          },
        ],
      },
    },
    {
      docId: "wc-cutting",
      docType: "workCenter",
      data: {
        name: "Cutting Station",
        shifts: weekdayShift(9, 17),
        maintenanceWindows: [
          {
            startDate: "2026-01-02T10:00:00.000Z",
            endDate: "2026-01-02T11:00:00.000Z",
            reason: "Blade replacement",
          },
        ],
      },
    },
    {
      docId: "wc-packaging",
      docType: "workCenter",
      data: {
        name: "Packaging Station",
        shifts: weekdayShift(10, 18),
        maintenanceWindows: [
          {
            startDate: "2026-01-02T12:00:00.000Z",
            endDate: "2026-01-02T13:00:00.000Z",
            reason: "Label printer service",
          },
        ],
      },
    },
  ],
  manufacturingOrders: [
    {
      docId: "mo-green-pipe",
      docType: "manufacturingOrder",
      data: {
        manufacturingOrderNumber: "MO-1001",
        itemId: "GREEN-PIPE-50MM",
        quantity: 2,
        dueDate: "2026-01-15T17:00:00.000Z",
      },
    },
    {
      docId: "mo-blue-pipe",
      docType: "manufacturingOrder",
      data: {
        manufacturingOrderNumber: "MO-1002",
        itemId: "BLUE-PIPE-75MM",
        quantity: 3,
        dueDate: "2026-01-18T17:00:00.000Z",
      },
    },
    {
      docId: "mo-yellow-pipe",
      docType: "manufacturingOrder",
      data: {
        manufacturingOrderNumber: "MO-1003",
        itemId: "YELLOW-PIPE-100MM",
        quantity: 2,
        dueDate: "2026-01-22T17:00:00.000Z",
      },
    },
  ],
  workOrders: [
    {
      docId: "wo-green-extrude",
      docType: "workOrder",
      data: {
        workOrderNumber: "WO-1001-EX",
        manufacturingOrderId: "mo-green-pipe",
        workCenterId: "wc-extrusion-b",
        startDate: "2026-01-01T07:00:00.000Z",
        endDate: "2026-01-01T10:00:00.000Z",
        durationMinutes: 180,
        isMaintenance: false,
        dependsOnWorkOrderIds: [],
      },
    },
    {
      docId: "wo-blue-extrude",
      docType: "workOrder",
      data: {
        workOrderNumber: "WO-1002-EX",
        manufacturingOrderId: "mo-blue-pipe",
        workCenterId: "wc-extrusion-a",
        startDate: "2026-01-01T08:00:00.000Z",
        endDate: "2026-01-01T16:00:00.000Z",
        durationMinutes: 360,
        isMaintenance: false,
        dependsOnWorkOrderIds: [],
      },
    },
    {
      docId: "wo-green-cut",
      docType: "workOrder",
      data: {
        workOrderNumber: "WO-1001-CUT",
        manufacturingOrderId: "mo-green-pipe",
        workCenterId: "wc-cutting",
        startDate: "2026-01-01T10:00:00.000Z",
        endDate: "2026-01-01T14:00:00.000Z",
        durationMinutes: 240,
        isMaintenance: false,
        dependsOnWorkOrderIds: ["wo-green-extrude"],
      },
    },
    {
      docId: "wo-yellow-extrude",
      docType: "workOrder",
      data: {
        workOrderNumber: "WO-1003-EX",
        manufacturingOrderId: "mo-yellow-pipe",
        workCenterId: "wc-extrusion-a",
        startDate: "2026-01-01T13:00:00.000Z",
        endDate: "2026-01-02T11:00:00.000Z",
        durationMinutes: 300,
        isMaintenance: false,
        dependsOnWorkOrderIds: [],
      },
    },
    {
      docId: "wo-green-pack",
      docType: "workOrder",
      data: {
        workOrderNumber: "WO-1001-PACK",
        manufacturingOrderId: "mo-green-pipe",
        workCenterId: "wc-packaging",
        startDate: "2026-01-01T14:00:00.000Z",
        endDate: "2026-01-01T16:00:00.000Z",
        durationMinutes: 120,
        isMaintenance: false,
        dependsOnWorkOrderIds: ["wo-green-cut"],
      },
    },
    {
      docId: "wo-blue-cut",
      docType: "workOrder",
      data: {
        workOrderNumber: "WO-1002-CUT",
        manufacturingOrderId: "mo-blue-pipe",
        workCenterId: "wc-cutting",
        startDate: "2026-01-01T16:00:00.000Z",
        endDate: "2026-01-02T11:00:00.000Z",
        durationMinutes: 180,
        isMaintenance: false,
        dependsOnWorkOrderIds: ["wo-blue-extrude"],
      },
    },
    {
      docId: "wo-blue-pack",
      docType: "workOrder",
      data: {
        workOrderNumber: "WO-1002-PACK",
        manufacturingOrderId: "mo-blue-pipe",
        workCenterId: "wc-packaging",
        startDate: "2026-01-02T11:00:00.000Z",
        endDate: "2026-01-02T13:00:00.000Z",
        durationMinutes: 120,
        isMaintenance: false,
        dependsOnWorkOrderIds: ["wo-blue-cut"],
      },
    },
    {
      docId: "wo-yellow-pack",
      docType: "workOrder",
      data: {
        workOrderNumber: "WO-1003-PACK",
        manufacturingOrderId: "mo-yellow-pipe",
        workCenterId: "wc-packaging",
        startDate: "2026-01-02T13:00:00.000Z",
        endDate: "2026-01-02T16:00:00.000Z",
        durationMinutes: 180,
        isMaintenance: false,
        dependsOnWorkOrderIds: ["wo-yellow-extrude"],
      },
    },
  ],
} satisfies PrepareScheduleInput;

export const basicScheduleScenarioNotes = [
  "Maximum four work centers: two extrusion lines, one cutting station, one packaging station.",
  "Manufacturing quantities are small values from 2 to 3, so each chain is repeated by unit number.",
  "Green and blue pipe orders share downstream cutting and packaging work centers.",
  "Maintenance windows split work on multiple work centers.",
  "Downstream work orders wait for their dependency finish times even across work centers.",
];
