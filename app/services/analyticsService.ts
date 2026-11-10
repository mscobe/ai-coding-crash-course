import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  CourseStatus,
  courseRatings,
  courses,
  enrollments,
  purchases,
} from "~/db/schema";

// ─── Analytics Service ───
// All aggregate queries behind the instructor analytics dashboard, computed
// live from existing tables. Uses positional parameters (project convention).

// ─── Ranges ───

export const ANALYTICS_RANGES = ["30d", "90d", "12m", "all"] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = "30d";

/** Parses a `?range=` value; anything unrecognised falls back to 30d. */
export function parseAnalyticsRange(value: string | null): AnalyticsRange {
  return (ANALYTICS_RANGES as readonly string[]).includes(value ?? "")
    ? (value as AnalyticsRange)
    : DEFAULT_ANALYTICS_RANGE;
}

// ─── Shared helpers ───
// Window and course-scope helpers reused by every aggregate below. Add new
// queries as their own section, built on these.

/** Half-open [start, end) in ISO timestamps; a null start means unbounded. */
type Window = { start: string | null; end: string };

const RANGE_DAYS: Record<Exclude<AnalyticsRange, "all">, number> = {
  "30d": 30,
  "90d": 90,
  "12m": 365,
};

const DAY_MS = 86_400_000;

const ANALYTICS_COURSE_STATUSES = [
  CourseStatus.Published,
  CourseStatus.Archived,
];

/**
 * The selected range ending at `now` (inclusive), and the immediately
 * preceding window of equal length — null for "all", which has no comparison.
 */
function getRangeWindows(
  range: AnalyticsRange,
  now: Date
): { current: Window; previous: Window | null } {
  const end = new Date(now.getTime() + 1).toISOString();
  if (range === "all") return { current: { start: null, end }, previous: null };

  const length = RANGE_DAYS[range] * DAY_MS;
  const start = new Date(now.getTime() - length).toISOString();
  const previousStart = new Date(now.getTime() - 2 * length).toISOString();
  return {
    current: { start, end },
    previous: { start: previousStart, end: start },
  };
}

/**
 * Courses that count towards an instructor's analytics: published and
 * archived (archived courses still carry historical revenue); drafts excluded.
 */
function instructorCourseFilter(instructorId: number) {
  return and(
    eq(courses.instructorId, instructorId),
    inArray(courses.status, ANALYTICS_COURSE_STATUSES)
  );
}

function withinWindow(column: SQLiteColumn, window: Window) {
  return and(
    window.start === null ? undefined : gte(column, window.start),
    lt(column, window.end)
  );
}

/** Current and previous-period values of one metric. */
export type PeriodComparison = { current: number; previous: number | null };

function comparePeriods(
  range: AnalyticsRange,
  now: Date,
  measure: (window: Window) => number
): PeriodComparison {
  const { current, previous } = getRangeWindows(range, now);
  return {
    current: measure(current),
    previous: previous ? measure(previous) : null,
  };
}

// ─── Enrollments over time ───
// New enrollments bucketed by UTC day (30d), ISO week starting Monday (90d),
// or month (12m, all). Buckets span every period the range's window touches,
// so the first one may be partial and the series sums to the overview's
// new-enrollments figure. Empty periods are zero rather than skipped.

export type TimeGranularity = "day" | "week" | "month";

/** `start` is the bucket's first UTC day as `YYYY-MM-DD`. */
export type EnrollmentBucket = { start: string; count: number };

export type EnrollmentsOverTime = {
  granularity: TimeGranularity;
  buckets: EnrollmentBucket[];
};

const RANGE_GRANULARITY: Record<AnalyticsRange, TimeGranularity> = {
  "30d": "day",
  "90d": "week",
  "12m": "month",
  all: "month",
};

/** Start (UTC midnight) of the bucket containing `date`. */
function bucketStart(date: Date, granularity: TimeGranularity): Date {
  const day = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  if (granularity === "day") return day;
  if (granularity === "week") {
    const daysSinceMonday = (day.getUTCDay() + 6) % 7;
    return new Date(day.getTime() - daysSinceMonday * DAY_MS);
  }
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
}

function nextBucket(start: Date, granularity: TimeGranularity): Date {
  if (granularity === "day") return new Date(start.getTime() + DAY_MS);
  if (granularity === "week") return new Date(start.getTime() + 7 * DAY_MS);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

const toDateKey = (date: Date) => date.toISOString().slice(0, 10);

export function getEnrollmentsOverTime(
  instructorId: number,
  range: AnalyticsRange,
  now: Date = new Date()
): EnrollmentsOverTime {
  const granularity = RANGE_GRANULARITY[range];
  const { current } = getRangeWindows(range, now);

  const rows = db
    .select({ enrolledAt: enrollments.enrolledAt })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(
      and(
        instructorCourseFilter(instructorId),
        withinWindow(enrollments.enrolledAt, current)
      )
    )
    .all();

  const counts = new Map<string, number>();
  let earliest: Date | null = null;
  for (const { enrolledAt } of rows) {
    const date = new Date(enrolledAt);
    if (earliest === null || date < earliest) earliest = date;
    const key = toDateKey(bucketStart(date, granularity));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // "All time" starts at the first enrollment; with none there is no series.
  const firstDay = current.start === null ? earliest : new Date(current.start);
  if (firstDay === null) return { granularity, buckets: [] };

  const buckets: EnrollmentBucket[] = [];
  for (
    let start = bucketStart(firstDay, granularity);
    start <= now;
    start = nextBucket(start, granularity)
  ) {
    const key = toDateKey(start);
    buckets.push({ start: key, count: counts.get(key) ?? 0 });
  }
  return { granularity, buckets };
}

// ─── Instructor overview ───

function sumRevenue(instructorId: number, window: Window): number {
  const result = db
    .select({ total: sql<number>`coalesce(sum(${purchases.amountPaid}), 0)` })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        instructorCourseFilter(instructorId),
        withinWindow(purchases.createdAt, window)
      )
    )
    .get();
  return result?.total ?? 0;
}

function countEnrollments(instructorId: number, window: Window): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(
      and(
        instructorCourseFilter(instructorId),
        withinWindow(enrollments.enrolledAt, window)
      )
    )
    .get();
  return result?.count ?? 0;
}

/** Completed ÷ total enrollments, all time. 0 when there are none. */
function getCompletionRate(instructorId: number): number {
  const result = db
    .select({
      total: sql<number>`count(*)`,
      completed: sql<number>`count(${enrollments.completedAt})`,
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(instructorCourseFilter(instructorId))
    .get();
  if (!result || result.total === 0) return 0;
  return result.completed / result.total;
}

/** Mean of every individual rating, all time. Null average when unrated. */
function getRatingSummary(instructorId: number) {
  const result = db
    .select({
      average: sql<number | null>`avg(${courseRatings.rating})`,
      count: sql<number>`count(*)`,
    })
    .from(courseRatings)
    .innerJoin(courses, eq(courseRatings.courseId, courses.id))
    .where(instructorCourseFilter(instructorId))
    .get();
  return { average: result?.average ?? null, count: result?.count ?? 0 };
}

export type InstructorOverview = {
  /** Gross amount paid, in cents. */
  revenue: PeriodComparison;
  newEnrollments: PeriodComparison;
  /** 0–1, all time (ignores the range). */
  completionRate: number;
  /** 1–5, unrounded; null when no ratings. All time. */
  averageRating: number | null;
  ratingCount: number;
};

export function getInstructorOverview(
  instructorId: number,
  range: AnalyticsRange,
  now: Date = new Date()
): InstructorOverview {
  const rating = getRatingSummary(instructorId);
  return {
    revenue: comparePeriods(range, now, (w) => sumRevenue(instructorId, w)),
    newEnrollments: comparePeriods(range, now, (w) =>
      countEnrollments(instructorId, w)
    ),
    completionRate: getCompletionRate(instructorId),
    averageRating: rating.average,
    ratingCount: rating.count,
  };
}
