import { DateTime } from "luxon";

import { SchedulingError } from "../reflow/types.js";

export const UTC_ZONE = "utc";

export interface DateTimeInterval {
  start: DateTime;
  end: DateTime;
}

export function parseUtcDateTime(value: string, fieldName = "date"): DateTime {
  const dateTime = DateTime.fromISO(value, { zone: UTC_ZONE });

  if (!dateTime.isValid) {
    throw new SchedulingError(
      `${fieldName} must be a valid ISO date: ${dateTime.invalidExplanation ?? value}`,
    );
  }

  return dateTime.toUTC();
}

export function toUtcIso(dateTime: DateTime): string {
  const iso = dateTime.toUTC().toISO({
    suppressMilliseconds: false,
    includeOffset: false,
  });

  if (iso === null) {
    throw new SchedulingError("Unable to format invalid UTC date.");
  }

  return `${iso}Z`;
}

export function toUtcDateKey(dateTime: DateTime): string {
  const dateKey = dateTime.toUTC().toISODate();

  if (dateKey === null) {
    throw new SchedulingError("Unable to format invalid UTC date key.");
  }

  return dateKey;
}

export function minutesBetween(start: DateTime, end: DateTime): number {
  return Math.floor(end.diff(start, "minutes").minutes);
}

export function getTechnicalTestDayOfWeek(dateTime: DateTime): number {
  return dateTime.toUTC().weekday % 7;
}

export function validateHorizon(horizonStartDate: string, horizonEndDate: string): DateTimeInterval {
  const start = parseUtcDateTime(horizonStartDate, "horizonStartDate");
  const end = parseUtcDateTime(horizonEndDate, "horizonEndDate");

  if (start.toMillis() >= end.toMillis()) {
    throw new SchedulingError("horizonStartDate must be before horizonEndDate.");
  }

  return { start, end };
}

export function eachUtcDateInHorizon(horizon: DateTimeInterval): DateTime[] {
  const dates: DateTime[] = [];
  let cursor = horizon.start.startOf("day");
  const finalDate = horizon.end.minus({ milliseconds: 1 }).startOf("day");

  while (cursor.toMillis() <= finalDate.toMillis()) {
    dates.push(cursor);
    cursor = cursor.plus({ days: 1 });
  }

  return dates;
}

export function intersectIntervals(
  left: DateTimeInterval,
  right: DateTimeInterval,
): DateTimeInterval | null {
  const start = maxDateTime(left.start, right.start);
  const end = minDateTime(left.end, right.end);

  if (start.toMillis() >= end.toMillis()) {
    return null;
  }

  return { start, end };
}

export function maxDateTime(left: DateTime, right: DateTime): DateTime {
  return left.toMillis() >= right.toMillis() ? left : right;
}

export function minDateTime(left: DateTime, right: DateTime): DateTime {
  return left.toMillis() <= right.toMillis() ? left : right;
}

export function compareIsoDates(left: string, right: string): number {
  const leftMillis = parseUtcDateTime(left).toMillis();
  const rightMillis = parseUtcDateTime(right).toMillis();

  return leftMillis - rightMillis;
}
