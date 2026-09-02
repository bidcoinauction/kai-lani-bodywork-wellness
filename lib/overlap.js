/**
 * Half-open interval overlap test used to mirror the database exclusion
 * constraint (no two active booking requests may overlap in time).
 *
 * With `bufferMs` > 0, each interval occupies [start, end + buffer). This
 * reserves private turnaround time after the appointment without changing the
 * treatment duration.
 */
export function isOverlap(aStart, aEnd, bStart, bEnd, { bufferMs = 30 * 60_000 } = {}) {
  const a1 = new Date(aStart).getTime();
  const a2 = new Date(aEnd).getTime();
  const b1 = new Date(bStart).getTime();
  const b2 = new Date(bEnd).getTime();
  if ([a1, a2, b1, b2].some((value) => Number.isNaN(value))) {
    throw new TypeError("isOverlap requires four valid dates");
  }
  return a1 < b2 + bufferMs && b1 < a2 + bufferMs;
}
