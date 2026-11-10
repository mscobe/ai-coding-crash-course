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
import {
  getCourseSummaries,
  getInstructorOverview,
  parseAnalyticsRange,
} from "./analyticsService";

// A fixed "now" so window boundaries are exact.
const NOW = new Date("2026-06-30T12:00:00.000Z");
const DAY = 86_400_000;

function daysBeforeNow(days: number) {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

let emailCounter = 0;
function createStudent() {
  emailCounter++;
  return testDb
    .insert(schema.users)
    .values({
      name: `Student ${emailCounter}`,
      email: `student${emailCounter}@example.com`,
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
}

function createCourse(
  instructorId: number,
  status: schema.CourseStatus = schema.CourseStatus.Published
) {
  emailCounter++;
  return testDb
    .insert(schema.courses)
    .values({
      title: `Course ${emailCounter}`,
      slug: `course-${emailCounter}`,
      description: "A course",
      salesCopy: "Sales copy.",
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function createPurchase(
  courseId: number,
  amountPaid: number,
  createdAt: string
) {
  const buyer = createStudent();
  return testDb
    .insert(schema.purchases)
    .values({ userId: buyer.id, courseId, amountPaid, createdAt })
    .returning()
    .get();
}

function createEnrollment(
  courseId: number,
  enrolledAt: string,
  completedAt: string | null = null
) {
  const student = createStudent();
  return testDb
    .insert(schema.enrollments)
    .values({ userId: student.id, courseId, enrolledAt, completedAt })
    .returning()
    .get();
}

describe("analyticsService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("getInstructorOverview — revenue", () => {
    it("sums purchases of the instructor's courses within the range", () => {
      createPurchase(base.course.id, 4900, daysBeforeNow(1));
      createPurchase(base.course.id, 2500, daysBeforeNow(29));

      const overview = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(overview.revenue.current).toBe(7400);
    });

    it("excludes purchases of other instructors' courses", () => {
      const other = testDb
        .insert(schema.users)
        .values({
          name: "Other Instructor",
          email: "other@example.com",
          role: schema.UserRole.Instructor,
        })
        .returning()
        .get();
      const otherCourse = createCourse(other.id);
      createPurchase(base.course.id, 1000, daysBeforeNow(2));
      createPurchase(otherCourse.id, 9999, daysBeforeNow(2));

      const overview = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(overview.revenue.current).toBe(1000);
    });

    it("puts a purchase exactly at the range start in the current period, and one just before it in the previous period", () => {
      createPurchase(base.course.id, 1000, daysBeforeNow(30));
      createPurchase(
        base.course.id,
        300,
        new Date(NOW.getTime() - 30 * DAY - 1).toISOString()
      );

      const overview = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(overview.revenue).toEqual({ current: 1000, previous: 300 });
    });

    it("compares with the previous window of equal length and ignores anything older", () => {
      createPurchase(base.course.id, 5000, daysBeforeNow(10)); // current
      createPurchase(base.course.id, 2000, daysBeforeNow(45)); // previous
      createPurchase(base.course.id, 700, daysBeforeNow(59)); // previous
      createPurchase(base.course.id, 9000, daysBeforeNow(61)); // too old

      const overview = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(overview.revenue).toEqual({ current: 5000, previous: 2700 });
    });

    it("uses 90-day and 12-month windows for those ranges", () => {
      createPurchase(base.course.id, 100, daysBeforeNow(80));
      createPurchase(base.course.id, 200, daysBeforeNow(100));
      createPurchase(base.course.id, 400, daysBeforeNow(300));
      createPurchase(base.course.id, 800, daysBeforeNow(400));

      expect(
        getInstructorOverview(base.instructor.id, "90d", NOW).revenue
      ).toEqual({ current: 100, previous: 200 });
      expect(
        getInstructorOverview(base.instructor.id, "12m", NOW).revenue
      ).toEqual({ current: 700, previous: 800 });
    });

    it("excludes draft courses and includes archived ones", () => {
      const draft = createCourse(base.instructor.id, schema.CourseStatus.Draft);
      const archived = createCourse(
        base.instructor.id,
        schema.CourseStatus.Archived
      );
      createPurchase(draft.id, 1111, daysBeforeNow(3));
      createPurchase(archived.id, 2000, daysBeforeNow(3));

      const overview = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(overview.revenue.current).toBe(2000);
    });

    it("counts a team purchase in full on its purchase date, regardless of when seats are redeemed", () => {
      // 5 seats at $40 each, bought 40 days ago (previous period).
      const purchase = createPurchase(base.course.id, 20000, daysBeforeNow(40));
      const team = testDb.insert(schema.teams).values({}).returning().get();
      const redeemer = createStudent();
      for (let i = 0; i < 5; i++) {
        testDb
          .insert(schema.coupons)
          .values({
            teamId: team.id,
            courseId: base.course.id,
            code: `SEAT-${i}`,
            purchaseId: purchase.id,
            ...(i === 0
              ? { redeemedByUserId: redeemer.id, redeemedAt: daysBeforeNow(5) }
              : {}),
          })
          .run();
      }

      const overview = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(overview.revenue).toEqual({ current: 0, previous: 20000 });
    });

    it("has no previous period for all time", () => {
      createPurchase(base.course.id, 100, daysBeforeNow(5));
      createPurchase(base.course.id, 200, daysBeforeNow(2000));

      const overview = getInstructorOverview(base.instructor.id, "all", NOW);

      expect(overview.revenue).toEqual({ current: 300, previous: null });
    });
  });

  describe("getInstructorOverview — new enrollments", () => {
    it("counts enrollments in the range and the previous period, scoped to the instructor's non-draft courses", () => {
      const draft = createCourse(base.instructor.id, schema.CourseStatus.Draft);
      const archived = createCourse(
        base.instructor.id,
        schema.CourseStatus.Archived
      );
      const other = testDb
        .insert(schema.users)
        .values({
          name: "Other Instructor",
          email: "other@example.com",
          role: schema.UserRole.Instructor,
        })
        .returning()
        .get();
      const otherCourse = createCourse(other.id);

      createEnrollment(base.course.id, daysBeforeNow(1));
      createEnrollment(archived.id, daysBeforeNow(20));
      createEnrollment(base.course.id, daysBeforeNow(31));
      createEnrollment(base.course.id, daysBeforeNow(90));
      createEnrollment(draft.id, daysBeforeNow(1));
      createEnrollment(otherCourse.id, daysBeforeNow(1));

      const overview = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(overview.newEnrollments).toEqual({ current: 2, previous: 1 });
    });

    it("has no previous period for all time", () => {
      createEnrollment(base.course.id, daysBeforeNow(1));
      createEnrollment(base.course.id, daysBeforeNow(1000));

      const overview = getInstructorOverview(base.instructor.id, "all", NOW);

      expect(overview.newEnrollments).toEqual({ current: 2, previous: null });
    });
  });

  describe("getInstructorOverview — completion rate and rating", () => {
    it("divides completed enrollments by all enrollments across non-draft courses, ignoring the range", () => {
      const archived = createCourse(
        base.instructor.id,
        schema.CourseStatus.Archived
      );
      const draft = createCourse(base.instructor.id, schema.CourseStatus.Draft);
      createEnrollment(base.course.id, daysBeforeNow(400), daysBeforeNow(300));
      createEnrollment(base.course.id, daysBeforeNow(5));
      createEnrollment(archived.id, daysBeforeNow(200), daysBeforeNow(100));
      createEnrollment(archived.id, daysBeforeNow(200));
      createEnrollment(draft.id, daysBeforeNow(5), daysBeforeNow(1));

      const overview = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(overview.completionRate).toBe(0.5);
    });

    it("averages every rating across the instructor's non-draft courses", () => {
      const second = createCourse(base.instructor.id);
      const draft = createCourse(base.instructor.id, schema.CourseStatus.Draft);
      const rate = (courseId: number, rating: number) =>
        testDb
          .insert(schema.courseRatings)
          .values({ userId: createStudent().id, courseId, rating })
          .run();
      rate(base.course.id, 5);
      rate(base.course.id, 4);
      rate(second.id, 3);
      rate(draft.id, 1);

      const overview = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(overview.averageRating).toBe(4);
      expect(overview.ratingCount).toBe(3);
    });

    it("returns zeroed values for an instructor with no data", () => {
      const overview = getInstructorOverview(base.instructor.id, "30d", NOW);

      expect(overview).toEqual({
        revenue: { current: 0, previous: 0 },
        newEnrollments: { current: 0, previous: 0 },
        completionRate: 0,
        averageRating: null,
        ratingCount: 0,
      });
    });
  });

  describe("getCourseSummaries", () => {
    it("lists the instructor's published and archived courses with their status, excluding drafts and other instructors' courses", () => {
      const other = testDb
        .insert(schema.users)
        .values({
          name: "Other Instructor",
          email: "other@example.com",
          role: schema.UserRole.Instructor,
        })
        .returning()
        .get();
      createCourse(other.id);
      createCourse(base.instructor.id, schema.CourseStatus.Draft);
      const archived = createCourse(
        base.instructor.id,
        schema.CourseStatus.Archived
      );

      const rows = getCourseSummaries(base.instructor.id, "30d", NOW);

      expect(
        rows.map((r) => ({ courseId: r.courseId, status: r.status }))
      ).toEqual([
        { courseId: archived.id, status: schema.CourseStatus.Archived },
        { courseId: base.course.id, status: schema.CourseStatus.Published },
      ]);
    });
    it("sums each course's revenue and enrollments within the selected range only", () => {
      const second = createCourse(base.instructor.id);
      createPurchase(base.course.id, 1000, daysBeforeNow(2));
      createPurchase(base.course.id, 500, daysBeforeNow(29));
      createPurchase(base.course.id, 9000, daysBeforeNow(31));
      createPurchase(second.id, 700, daysBeforeNow(10));
      createEnrollment(base.course.id, daysBeforeNow(1));
      createEnrollment(base.course.id, daysBeforeNow(45));
      createEnrollment(second.id, daysBeforeNow(3));
      createEnrollment(second.id, daysBeforeNow(4));

      const rows = getCourseSummaries(base.instructor.id, "30d", NOW);
      const byId = (id: number) => rows.find((r) => r.courseId === id)!;

      expect(byId(base.course.id)).toMatchObject({
        revenue: 1500,
        enrollments: 1,
      });
      expect(byId(second.id)).toMatchObject({ revenue: 700, enrollments: 2 });

      const allTime = getCourseSummaries(base.instructor.id, "all", NOW);
      expect(allTime.find((r) => r.courseId === base.course.id)).toMatchObject({
        revenue: 10500,
        enrollments: 2,
      });
    });
    it("reports all-time completion, average progress, and average rating, ignoring the range", () => {
      const lessonIds = [1, 2].flatMap((modulePosition) => {
        const mod = testDb
          .insert(schema.modules)
          .values({
            courseId: base.course.id,
            title: `Module ${modulePosition}`,
            position: modulePosition,
          })
          .returning()
          .get();
        return [1, 2].map(
          (position) =>
            testDb
              .insert(schema.lessons)
              .values({ moduleId: mod.id, title: "Lesson", position })
              .returning()
              .get().id
        );
      });
      const progress = (
        userId: number,
        lessonId: number,
        status: schema.LessonProgressStatus
      ) =>
        testDb
          .insert(schema.lessonProgress)
          .values({ userId, lessonId, status })
          .run();

      // Finished all four lessons, long before the selected range.
      const finished = createEnrollment(
        base.course.id,
        daysBeforeNow(200),
        daysBeforeNow(150)
      );
      for (const id of lessonIds) {
        progress(finished.userId, id, schema.LessonProgressStatus.Completed);
      }
      // Completed two of four lessons; a third in progress doesn't count.
      const halfway = createEnrollment(base.course.id, daysBeforeNow(100));
      progress(
        halfway.userId,
        lessonIds[0],
        schema.LessonProgressStatus.Completed
      );
      progress(
        halfway.userId,
        lessonIds[1],
        schema.LessonProgressStatus.Completed
      );
      progress(
        halfway.userId,
        lessonIds[2],
        schema.LessonProgressStatus.InProgress
      );

      for (const rating of [5, 4]) {
        testDb
          .insert(schema.courseRatings)
          .values({
            userId: createStudent().id,
            courseId: base.course.id,
            rating,
          })
          .run();
      }

      const [row] = getCourseSummaries(base.instructor.id, "30d", NOW);

      expect(row).toMatchObject({
        enrollments: 0,
        completionRate: 0.5,
        averageProgress: 0.75,
        averageRating: 4.5,
        ratingCount: 2,
      });
    });

    it("shows zeros for a course with no enrollments, purchases, or ratings", () => {
      const [row] = getCourseSummaries(base.instructor.id, "all", NOW);

      expect(row).toEqual({
        courseId: base.course.id,
        title: base.course.title,
        status: schema.CourseStatus.Published,
        revenue: 0,
        enrollments: 0,
        completionRate: 0,
        averageProgress: 0,
        averageRating: null,
        ratingCount: 0,
      });
    });
  });

  describe("parseAnalyticsRange", () => {
    it("accepts the four ranges and falls back to 30d otherwise", () => {
      expect(parseAnalyticsRange("90d")).toBe("90d");
      expect(parseAnalyticsRange("12m")).toBe("12m");
      expect(parseAnalyticsRange("all")).toBe("all");
      expect(parseAnalyticsRange("30d")).toBe("30d");
      expect(parseAnalyticsRange(null)).toBe("30d");
      expect(parseAnalyticsRange("7d")).toBe("30d");
    });
  });
});
