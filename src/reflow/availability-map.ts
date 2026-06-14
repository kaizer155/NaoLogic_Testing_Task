import type { DateTime } from "luxon";

import type {
  AvailabilityByDate,
  AvailabilityByWorkCenter,
  AvailabilityDay,
  ReflowConfig,
  TimeInterval,
  WorkCenterDocument,
  WorkCenterShift,
} from "./types.js";
import { SchedulingError } from "./types.js";
import {
  type DateTimeInterval,
  eachUtcDateInHorizon,
  getTechnicalTestDayOfWeek,
  intersectIntervals,
  maxDateTime,
  minDateTime,
  minutesBetween,
  parseUtcDateTime,
  toUtcDateKey,
  toUtcIso,
  validateHorizon,
} from "../utils/date-utils.js";

export function buildAvailabilityByWorkCenter(
  workCenters: WorkCenterDocument[],
  config: ReflowConfig,
): AvailabilityByWorkCenter {
  const horizon = validateHorizon(config.horizonStartDate, config.horizonEndDate);
  const result: AvailabilityByWorkCenter = {};

  for (const workCenter of workCenters) {
    result[workCenter.docId] = buildAvailabilityForWorkCenter(workCenter, horizon);
  }

  return result;
}

function buildAvailabilityForWorkCenter(
  workCenter: WorkCenterDocument,
  horizon: DateTimeInterval,
): AvailabilityByDate {
  const availabilityByDate = initializeAvailabilityByDate(horizon);
  // Shifts define possible work time; maintenance windows subtract blocked time
  // from those shifts before the scheduler tries to place any work orders.
  const availableIntervals = subtractBlockedIntervals(
    mergeIntervals(buildShiftIntervals(workCenter, horizon)),
    mergeIntervals(buildMaintenanceIntervals(workCenter, horizon)),
  );
  const intervalBuckets = initializeIntervalBuckets(horizon);

  for (const interval of availableIntervals) {
    addIntervalToDateBuckets(intervalBuckets, interval);
  }

  let cumulativeWorkingMinutes = 0;

  for (const dateKey of Object.keys(availabilityByDate).sort()) {
    const availabilityDay = availabilityByDate[dateKey];

    if (availabilityDay === undefined) {
      throw new SchedulingError(`Missing availability date bucket ${dateKey}.`);
    }

    const intervals = mergeIntervals(intervalBuckets[dateKey] ?? []);
    const workingMinutes = intervals.reduce(
      (total, interval) => total + minutesBetween(interval.start, interval.end),
      0,
    );

    cumulativeWorkingMinutes += workingMinutes;
    availabilityByDate[dateKey] = {
      ...availabilityDay,
      intervals: intervals.map(toPublicInterval),
      workingMinutes,
      cumulativeWorkingMinutes,
    };
  }

  return availabilityByDate;
}

function initializeAvailabilityByDate(horizon: DateTimeInterval): AvailabilityByDate {
  // Every date in the horizon gets an entry, including dates with zero work time.
  // This keeps reporting predictable and avoids missing-key checks for closed days.
  return Object.fromEntries(
    eachUtcDateInHorizon(horizon).map((date) => {
      const dateKey = toUtcDateKey(date);
      const availabilityDay: AvailabilityDay = {
        date: dateKey,
        intervals: [],
        workingMinutes: 0,
        cumulativeWorkingMinutes: 0,
      };

      return [dateKey, availabilityDay];
    }),
  );
}

function initializeIntervalBuckets(horizon: DateTimeInterval): Record<string, DateTimeInterval[]> {
  return Object.fromEntries(
    eachUtcDateInHorizon(horizon).map((date) => [toUtcDateKey(date), []]),
  );
}

function buildShiftIntervals(
  workCenter: WorkCenterDocument,
  horizon: DateTimeInterval,
): DateTimeInterval[] {
  const intervals: DateTimeInterval[] = [];
  const scanHorizon = {
    start: horizon.start.minus({ days: 1 }).startOf("day"),
    end: horizon.end,
  };

  // Scan one day before the horizon so overnight shifts that begin before the
  // horizon can still contribute their clipped in-horizon portion.
  for (const date of eachUtcDateInHorizon(scanHorizon)) {
    const dayOfWeek = getTechnicalTestDayOfWeek(date);

    for (const shift of workCenter.data.shifts) {
      if (shift.dayOfWeek !== dayOfWeek) {
        continue;
      }

      const clippedInterval = intersectIntervals(createShiftInterval(date, shift), horizon);

      if (clippedInterval !== null) {
        intervals.push(clippedInterval);
      }
    }
  }

  return intervals;
}

function createShiftInterval(date: DateTime, shift: WorkCenterShift): DateTimeInterval {
  const start = date.set({
    hour: shift.startHour,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  let end = date.set({
    hour: shift.endHour,
    minute: 0,
    second: 0,
    millisecond: 0,
  });

  if (end.toMillis() <= start.toMillis()) {
    end = end.plus({ days: 1 });
  }

  return { start, end };
}

function buildMaintenanceIntervals(
  workCenter: WorkCenterDocument,
  horizon: DateTimeInterval,
): DateTimeInterval[] {
  const intervals: DateTimeInterval[] = [];

  for (const window of workCenter.data.maintenanceWindows) {
    const interval = {
      start: parseUtcDateTime(
        window.startDate,
        `${workCenter.docId}.maintenanceWindows.startDate`,
      ),
      end: parseUtcDateTime(window.endDate, `${workCenter.docId}.maintenanceWindows.endDate`),
    };

    if (interval.start.toMillis() >= interval.end.toMillis()) {
      throw new SchedulingError(
        `Maintenance window on ${workCenter.docId} must have startDate before endDate.`,
      );
    }

    const clippedInterval = intersectIntervals(interval, horizon);

    if (clippedInterval !== null) {
      intervals.push(clippedInterval);
    }
  }

  return intervals;
}

function subtractBlockedIntervals(
  availableIntervals: DateTimeInterval[],
  blockedIntervals: DateTimeInterval[],
): DateTimeInterval[] {
  const blocked = mergeIntervals(blockedIntervals);
  const result: DateTimeInterval[] = [];

  for (const available of mergeIntervals(availableIntervals)) {
    let remaining = [available];

    for (const blockedInterval of blocked) {
      remaining = remaining.flatMap((candidate) =>
        subtractSingleBlockedInterval(candidate, blockedInterval),
      );
    }

    result.push(...remaining);
  }

  return mergeIntervals(result);
}

function subtractSingleBlockedInterval(
  available: DateTimeInterval,
  blocked: DateTimeInterval,
): DateTimeInterval[] {
  const overlap = intersectIntervals(available, blocked);

  if (overlap === null) {
    return [available];
  }

  const result: DateTimeInterval[] = [];

  if (available.start.toMillis() < overlap.start.toMillis()) {
    result.push({ start: available.start, end: overlap.start });
  }

  if (overlap.end.toMillis() < available.end.toMillis()) {
    result.push({ start: overlap.end, end: available.end });
  }

  return result;
}

function addIntervalToDateBuckets(
  intervalBuckets: Record<string, DateTimeInterval[]>,
  interval: DateTimeInterval,
): void {
  let cursor = interval.start;

  while (cursor.toMillis() < interval.end.toMillis()) {
    const dayEnd = cursor.startOf("day").plus({ days: 1 });
    const segmentEnd = minDateTime(dayEnd, interval.end);
    const dateKey = toUtcDateKey(cursor);
    const bucket = intervalBuckets[dateKey];

    if (bucket !== undefined) {
      bucket.push({ start: cursor, end: segmentEnd });
    }

    cursor = segmentEnd;
  }
}

function mergeIntervals(intervals: DateTimeInterval[]): DateTimeInterval[] {
  const sorted = [...intervals].sort((left, right) => left.start.toMillis() - right.start.toMillis());
  const merged: DateTimeInterval[] = [];

  for (const interval of sorted) {
    const last = merged.at(-1);

    if (last === undefined || last.end.toMillis() < interval.start.toMillis()) {
      merged.push({ ...interval });
      continue;
    }

    last.end = maxDateTime(last.end, interval.end);
  }

  return merged;
}

function toPublicInterval(interval: DateTimeInterval): TimeInterval {
  return {
    startDate: toUtcIso(interval.start),
    endDate: toUtcIso(interval.end),
  };
}
