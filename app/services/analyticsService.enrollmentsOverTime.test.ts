import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import { getEnrollmentsOverTime } from "./analyticsService";

// A fixed "now" (a Tuesday) so bucket boundaries are exact.
const NOW = new Date("2026-06-30T12:00:00.000Z");

let counter = 0;
function createCourse(
  instructorId: number,
  status: schema.CourseStatus = schema.CourseStatus.Published
) {
  counter++;
  return testDb
    .insert(schema.courses)
    .values({
      title: `Course ${counter}`,
      slug: `course-${counter}`,
      description: "A course",
      salesCopy: "Sales copy.",
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function enroll(courseId: number, enrolledAt: string) {
  counter++;
  const student = testDb
    .insert(schema.users)
    .values({
      name: `Student ${counter}`,
      email: `student${counter}@example.com`,
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
  testDb
    .insert(schema.enrollments)
    .values({ userId: student.id, courseId, enrolledAt })
    .run();
}

function countsByStart(series: ReturnType<typeof getEnrollmentsOverTime>) {
  return Object.fromEntries(series.buckets.map((b) => [b.start, b.count]));
}

describe("getEnrollmentsOverTime", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("30d — daily", () => {
    it("buckets enrollments by UTC day, covering every day the window touches", () => {
      enroll(base.course.id, "2026-06-30T01:00:00.000Z");
      enroll(base.course.id, "2026-06-30T11:59:59.000Z");
      enroll(base.course.id, "2026-06-29T23:59:59.999Z");
      enroll(base.course.id, "2026-06-15T00:00:00.000Z");

      const series = getEnrollmentsOverTime(base.instructor.id, "30d", NOW);

      expect(series.granularity).toBe("day");
      // Window is 2026-05-31T12:00Z → now: touches May 31 through June 30.
      expect(series.buckets).toHaveLength(31);
      expect(series.buckets[0]).toEqual({ start: "2026-05-31", count: 0 });
      expect(series.buckets.at(-1)).toEqual({ start: "2026-06-30", count: 2 });
      const counts = countsByStart(series);
      expect(counts["2026-06-29"]).toBe(1);
      expect(counts["2026-06-15"]).toBe(1);
      expect(counts["2026-06-14"]).toBe(0);
    });

    it("excludes an enrollment on the first day but before the window starts", () => {
      enroll(base.course.id, "2026-05-31T11:59:59.999Z");
      enroll(base.course.id, "2026-05-31T12:00:00.000Z");

      const series = getEnrollmentsOverTime(base.instructor.id, "30d", NOW);

      expect(series.buckets[0]).toEqual({ start: "2026-05-31", count: 1 });
    });
  });

  describe("90d — weekly", () => {
    it("buckets by ISO week starting Monday (UTC)", () => {
      // NOW is Tuesday 2026-06-30; its week starts Monday 2026-06-29.
      enroll(base.course.id, "2026-06-29T00:00:00.000Z");
      enroll(base.course.id, "2026-06-30T10:00:00.000Z");
      enroll(base.course.id, "2026-06-28T23:59:59.999Z"); // Sunday → previous week
      enroll(base.course.id, "2026-06-22T00:00:00.000Z");

      const series = getEnrollmentsOverTime(base.instructor.id, "90d", NOW);

      expect(series.granularity).toBe("week");
      // Window starts Wed 2026-04-01T12:00Z, in the week of Mon 2026-03-30.
      expect(series.buckets[0]).toEqual({ start: "2026-03-30", count: 0 });
      expect(series.buckets.at(-1)).toEqual({ start: "2026-06-29", count: 2 });
      expect(series.buckets).toHaveLength(14);
      expect(countsByStart(series)["2026-06-22"]).toBe(2);
      expect(countsByStart(series)["2026-06-15"]).toBe(0);
    });
  });

  describe("12m — monthly", () => {
    it("buckets by UTC calendar month across every month the window touches", () => {
      enroll(base.course.id, "2026-06-01T00:00:00.000Z");
      enroll(base.course.id, "2026-05-31T23:59:59.999Z");
      enroll(base.course.id, "2025-07-15T00:00:00.000Z");

      const series = getEnrollmentsOverTime(base.instructor.id, "12m", NOW);

      expect(series.granularity).toBe("month");
      // Window starts 2025-06-30T12:00Z (365 days before now).
      expect(series.buckets).toHaveLength(13);
      expect(series.buckets[0]).toEqual({ start: "2025-06-01", count: 0 });
      expect(series.buckets.at(-1)).toEqual({ start: "2026-06-01", count: 1 });
      const counts = countsByStart(series);
      expect(counts["2026-05-01"]).toBe(1);
      expect(counts["2025-07-01"]).toBe(1);
      expect(counts["2025-08-01"]).toBe(0);
    });
  });

  describe("all — monthly", () => {
    it("runs monthly from the first enrollment's month to now, filling gaps with zero", () => {
      enroll(base.course.id, "2026-03-20T00:00:00.000Z");
      enroll(base.course.id, "2026-06-02T00:00:00.000Z");

      const series = getEnrollmentsOverTime(base.instructor.id, "all", NOW);

      expect(series).toEqual({
        granularity: "month",
        buckets: [
          { start: "2026-03-01", count: 1 },
          { start: "2026-04-01", count: 0 },
          { start: "2026-05-01", count: 0 },
          { start: "2026-06-01", count: 1 },
        ],
      });
    });

    it("is empty when the instructor has no enrollments", () => {
      expect(getEnrollmentsOverTime(base.instructor.id, "all", NOW)).toEqual({
        granularity: "month",
        buckets: [],
      });
    });
  });

  describe("scope", () => {
    it("counts only the instructor's published and archived courses", () => {
      const archived = createCourse(
        base.instructor.id,
        schema.CourseStatus.Archived
      );
      const draft = createCourse(base.instructor.id, schema.CourseStatus.Draft);
      const otherInstructor = testDb
        .insert(schema.users)
        .values({
          name: "Other",
          email: "other@example.com",
          role: schema.UserRole.Instructor,
        })
        .returning()
        .get();
      const otherCourse = createCourse(otherInstructor.id);

      enroll(base.course.id, "2026-06-30T01:00:00.000Z");
      enroll(archived.id, "2026-06-30T02:00:00.000Z");
      enroll(draft.id, "2026-06-30T03:00:00.000Z");
      enroll(otherCourse.id, "2026-06-30T04:00:00.000Z");

      const series = getEnrollmentsOverTime(base.instructor.id, "30d", NOW);

      expect(countsByStart(series)["2026-06-30"]).toBe(2);
    });

    it("returns all-zero buckets for a fixed range with no enrollments", () => {
      const series = getEnrollmentsOverTime(base.instructor.id, "30d", NOW);

      expect(series.buckets).toHaveLength(31);
      expect(series.buckets.every((b) => b.count === 0)).toBe(true);
    });
  });
});
