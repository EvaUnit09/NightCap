import type { Candidate } from "./candidate";

export const NYC_TIME_ZONE = "America/New_York";

/**
 * Open-hours check in America/New_York.
 *
 * Only `{ day: 0, hour: 0, minute: 0 }` with no close is 24/7 (Places convention),
 * and only when no real close periods are present. Real hours win over the
 * 24/7 marker. Any other no-close period is malformed and ignored.
 *
 * FUTURE_OPENING is handled as `not_operational` before this runs.
 */
export function isOpenDuringSlot(
  candidate: Candidate,
  slotStart: string,
  slotEnd: string
): boolean {
  const { openingHours } = candidate;
  if (openingHours.length === 0) {
    return false;
  }

  const validPeriods = openingHours.filter(
    (
      period
    ): period is {
      open: { day: number; hour: number; minute: number };
      close: { day: number; hour: number; minute: number };
    } => period.close !== undefined
  );
  if (validPeriods.length === 0) {
    return openingHours.some(
      (period) =>
        period.close === undefined &&
        period.open.day === 0 &&
        period.open.hour === 0 &&
        period.open.minute === 0
    );
  }

  const start = parseISOToNYCTime(slotStart);
  const end = parseISOToNYCTime(slotEnd);
  if (start === null || end === null) {
    return false;
  }

  if (start.day === end.day) {
    return checkOpenOnDay(validPeriods, start.day, start.minute, end.minute);
  }

  const nextDay = (start.day + 1) % 7;
  if (end.day !== nextDay) {
    return false;
  }
  return (
    checkOpenOnDay(validPeriods, start.day, start.minute, 24 * 60 - 1) &&
    checkOpenOnDay(validPeriods, end.day, 0, end.minute)
  );
}

export function parseISOToNYCTime(
  isoString: string
): { day: number; minute: number } | null {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NYC_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const dayName = parts.find((part) => part.type === "weekday")?.value;
  let hour = Number.parseInt(
    parts.find((part) => part.type === "hour")?.value ?? "",
    10
  );
  const minute = Number.parseInt(
    parts.find((part) => part.type === "minute")?.value ?? "",
    10
  );
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || !dayName) {
    return null;
  }
  if (hour === 24) {
    hour = 0;
  }

  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const day = dayMap[dayName];
  if (day === undefined) {
    return null;
  }
  return { day, minute: hour * 60 + minute };
}

export function checkOpenOnDay(
  openingHours: Array<{
    open: { day: number; hour: number; minute: number };
    close: { day: number; hour: number; minute: number };
  }>,
  day: number,
  startMinute: number,
  endMinute: number
): boolean {
  for (const period of openingHours) {
    const openDay = period.open.day;
    const openMinute = period.open.hour * 60 + period.open.minute;
    const closeDay = period.close.day;
    const closeMinute = period.close.hour * 60 + period.close.minute;

    if (openDay === day && closeDay === day) {
      if (startMinute >= openMinute && endMinute <= closeMinute) {
        return true;
      }
    }

    if (openDay === day && closeDay !== day && startMinute >= openMinute) {
      return true;
    }

    const prevDay = (day + 6) % 7;
    if (
      closeDay === day &&
      openDay === prevDay &&
      endMinute <= closeMinute
    ) {
      return true;
    }
  }
  return false;
}
