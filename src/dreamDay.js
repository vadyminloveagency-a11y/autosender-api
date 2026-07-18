/** Dream agency business day starts at 10:00 Europe/Kyiv. */
export const DREAM_DAY_TZ = "Europe/Kyiv";
export const DREAM_DAY_START_HOUR = 10;

function pad2(value) {
  return String(value).padStart(2, "0");
}

/** YYYY-MM-DD for the Dream business day containing `date`. */
export function dreamDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DREAM_DAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date instanceof Date ? date : new Date(date));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  let year = Number(get("year"));
  let month = Number(get("month"));
  let day = Number(get("day"));
  const hour = Number(get("hour"));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return "";
  }
  if (Number.isFinite(hour) && hour < DREAM_DAY_START_HOUR) {
    const prev = new Date(Date.UTC(year, month - 1, day));
    prev.setUTCDate(prev.getUTCDate() - 1);
    year = prev.getUTCFullYear();
    month = prev.getUTCMonth() + 1;
    day = prev.getUTCDate();
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * SQL fragment: Dream day start for date param `$N` as timestamptz.
 * Dream day D = [D 10:00 Kyiv, (D+1) 10:00 Kyiv).
 */
export function sqlDreamDayStart(paramIndex) {
  return `(($${paramIndex}::date + TIME '${DREAM_DAY_START_HOUR}:00') AT TIME ZONE '${DREAM_DAY_TZ}')`;
}

/** SQL fragment: exclusive end of Dream day for date param `$N`. */
export function sqlDreamDayEnd(paramIndex) {
  return `((($${paramIndex}::date + 1) + TIME '${DREAM_DAY_START_HOUR}:00') AT TIME ZONE '${DREAM_DAY_TZ}')`;
}

/** SQL fragment: start of the current Dream business day. */
export function sqlCurrentDreamDayStart() {
  return `(
    (
      date_trunc(
        'day',
        (NOW() AT TIME ZONE '${DREAM_DAY_TZ}') - INTERVAL '${DREAM_DAY_START_HOUR} hours'
      ) + INTERVAL '${DREAM_DAY_START_HOUR} hours'
    ) AT TIME ZONE '${DREAM_DAY_TZ}'
  )`;
}
