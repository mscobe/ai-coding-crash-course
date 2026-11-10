import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import { calculateProgress } from "~/services/progressService";
import {
  CourseStatus,
  courseRatings,
  courses,
  coupons,
  enrollments,
  LessonProgressStatus,
  lessonProgress,
  lessons,
  modules,
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

// ─── Per-course summary ───

/** Range-scoped revenue (cents) per course id. */
function revenueByCourse(instructorId: number, window: Window) {
  const rows = db
    .select({
      courseId: purchases.courseId,
      total: sql<number>`sum(${purchases.amountPaid})`,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        instructorCourseFilter(instructorId),
        withinWindow(purchases.createdAt, window)
      )
    )
    .groupBy(purchases.courseId)
    .all();
  return new Map(rows.map((r) => [r.courseId, r.total]));
}

/** Range-scoped enrollment count per course id. */
function enrollmentsByCourse(instructorId: number, window: Window) {
  const rows = db
    .select({
      courseId: enrollments.courseId,
      count: sql<number>`count(*)`,
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(
      and(
        instructorCourseFilter(instructorId),
        withinWindow(enrollments.enrolledAt, window)
      )
    )
    .groupBy(enrollments.courseId)
    .all();
  return new Map(rows.map((r) => [r.courseId, r.count]));
}

/** All-time rating average and count per course id. */
function ratingsByCourse(instructorId: number) {
  const rows = db
    .select({
      courseId: courseRatings.courseId,
      average: sql<number>`avg(${courseRatings.rating})`,
      count: sql<number>`count(*)`,
    })
    .from(courseRatings)
    .innerJoin(courses, eq(courseRatings.courseId, courses.id))
    .where(instructorCourseFilter(instructorId))
    .groupBy(courseRatings.courseId)
    .all();
  return new Map(rows.map((r) => [r.courseId, r]));
}

/**
 * All-time completion rate and average progress (both 0–1) per course id.
 * Progress reuses the student-facing calculation: unweighted, quizzes excluded.
 */
function outcomesByCourse(instructorId: number) {
  const rows = db
    .select({
      userId: enrollments.userId,
      courseId: enrollments.courseId,
      completedAt: enrollments.completedAt,
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(instructorCourseFilter(instructorId))
    .all();

  const totals = new Map<
    number,
    { enrolled: number; completed: number; progress: number }
  >();
  for (const row of rows) {
    const t = totals.get(row.courseId) ?? {
      enrolled: 0,
      completed: 0,
      progress: 0,
    };
    t.enrolled++;
    if (row.completedAt !== null) t.completed++;
    t.progress += calculateProgress(row.userId, row.courseId, false, false);
    totals.set(row.courseId, t);
  }

  return new Map(
    [...totals].map(([courseId, t]) => [
      courseId,
      {
        completionRate: t.completed / t.enrolled,
        averageProgress: t.progress / t.enrolled / 100,
      },
    ])
  );
}

export type CourseSummary = {
  courseId: number;
  title: string;
  status: CourseStatus;
  /** Gross amount paid in the selected range, in cents. */
  revenue: number;
  /** New enrollments in the selected range. */
  enrollments: number;
  /** 0–1, all time. 0 when there are no enrollments. */
  completionRate: number;
  /** Mean per-student progress, 0–1, all time. 0 when there are no enrollments. */
  averageProgress: number;
  /** 1–5, unrounded; null when unrated. All time. */
  averageRating: number | null;
  ratingCount: number;
};

/** One row per non-draft course of the instructor, ordered by title. */
export function getCourseSummaries(
  instructorId: number,
  range: AnalyticsRange,
  now: Date = new Date()
): CourseSummary[] {
  const { current } = getRangeWindows(range, now);
  const revenue = revenueByCourse(instructorId, current);
  const enrolled = enrollmentsByCourse(instructorId, current);
  const outcomes = outcomesByCourse(instructorId);
  const ratings = ratingsByCourse(instructorId);

  return db
    .select({
      courseId: courses.id,
      title: courses.title,
      status: courses.status,
    })
    .from(courses)
    .where(instructorCourseFilter(instructorId))
    .orderBy(courses.title)
    .all()
    .map((course) => ({
      ...course,
      revenue: revenue.get(course.courseId) ?? 0,
      enrollments: enrolled.get(course.courseId) ?? 0,
      completionRate: outcomes.get(course.courseId)?.completionRate ?? 0,
      averageProgress: outcomes.get(course.courseId)?.averageProgress ?? 0,
      averageRating: ratings.get(course.courseId)?.average ?? null,
      ratingCount: ratings.get(course.courseId)?.count ?? 0,
    }));
}

// ─── Lesson funnel ───
// For one course, the share of its enrolled students who completed each
// lesson, in course order (module position, then lesson position). Only
// `completed` progress counts. All time; ignores the date range.

export type FunnelLesson = {
  lessonId: number;
  title: string;
  moduleId: number;
  moduleTitle: string;
  /** Enrolled students whose progress on this lesson is `completed`. */
  completedCount: number;
  /** completedCount ÷ enrolled students, 0–1. 0 when nobody is enrolled. */
  completionRate: number;
};

/** The lesson with the largest fall from the lesson before it. */
export type BiggestDrop = {
  lessonId: number;
  title: string;
  /** Fall in completion rate from the preceding lesson, 0–1 (points ÷ 100). */
  drop: number;
};

export type LessonFunnel = {
  enrolledCount: number;
  lessons: FunnelLesson[];
  /** Null when no lesson falls below the one before it. */
  biggestDrop: BiggestDrop | null;
};

function findBiggestDrop(funnel: FunnelLesson[]): BiggestDrop | null {
  let biggest: BiggestDrop | null = null;
  for (let i = 1; i < funnel.length; i++) {
    const drop = funnel[i - 1].completionRate - funnel[i].completionRate;
    if (drop > 0 && (biggest === null || drop > biggest.drop)) {
      biggest = { lessonId: funnel[i].lessonId, title: funnel[i].title, drop };
    }
  }
  return biggest;
}

export function getLessonFunnel(courseId: number): LessonFunnel {
  const courseLessons = db
    .select({
      lessonId: lessons.id,
      title: lessons.title,
      moduleId: modules.id,
      moduleTitle: modules.title,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .orderBy(modules.position, lessons.position)
    .all();

  const enrolledCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(enrollments)
      .where(eq(enrollments.courseId, courseId))
      .get()?.count ?? 0;

  // Completions per lesson, counting only students enrolled in this course.
  const completedRows = db
    .select({
      lessonId: lessonProgress.lessonId,
      count: sql<number>`count(distinct ${lessonProgress.userId})`,
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessonProgress.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.userId, lessonProgress.userId),
        eq(enrollments.courseId, modules.courseId)
      )
    )
    .where(
      and(
        eq(modules.courseId, courseId),
        eq(lessonProgress.status, LessonProgressStatus.Completed)
      )
    )
    .groupBy(lessonProgress.lessonId)
    .all();
  const completed = new Map(completedRows.map((r) => [r.lessonId, r.count]));

  const funnel = courseLessons.map((lesson) => {
    const completedCount = completed.get(lesson.lessonId) ?? 0;
    return {
      ...lesson,
      completedCount,
      completionRate: enrolledCount === 0 ? 0 : completedCount / enrolledCount,
    };
  });

  return { enrolledCount, lessons: funnel, biggestDrop: findBiggestDrop(funnel) };
}

// ─── Revenue by country ───
// One course's purchases grouped by their stored country code, all time. No
// attempt to reconstruct PPP discounts: the tier isn't stored.

export type CountryRevenue = {
  /** ISO country code as stored; null for purchases with no country. */
  country: string | null;
  /** Gross amount paid, in cents. */
  revenue: number;
  purchaseCount: number;
};

/** Highest revenue first. */
export function getRevenueByCountry(courseId: number): CountryRevenue[] {
  return db
    .select({
      country: purchases.country,
      revenue: sql<number>`sum(${purchases.amountPaid})`,
      purchaseCount: sql<number>`count(*)`,
    })
    .from(purchases)
    .where(eq(purchases.courseId, courseId))
    .groupBy(purchases.country)
    .orderBy(sql`sum(${purchases.amountPaid}) desc`, purchases.country)
    .all();
}

// ─── Unredeemed seats ───

/** Coupons from this course's team purchases that nobody has redeemed. */
export function getUnredeemedSeatCount(courseId: number): number {
  return (
    db
      .select({ count: sql<number>`count(*)` })
      .from(coupons)
      .where(
        and(eq(coupons.courseId, courseId), isNull(coupons.redeemedByUserId))
      )
      .get()?.count ?? 0
  );
}
