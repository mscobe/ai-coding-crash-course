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
  getLessonFunnel,
  getRevenueByCountry,
  getUnredeemedSeatCount,
} from "./analyticsService";

let counter = 0;
function createStudent() {
  counter++;
  return testDb
    .insert(schema.users)
    .values({
      name: `Student ${counter}`,
      email: `student${counter}@example.com`,
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
}

function createModule(courseId: number, title: string, position: number) {
  return testDb
    .insert(schema.modules)
    .values({ courseId, title, position })
    .returning()
    .get();
}

function createLesson(moduleId: number, title: string, position: number) {
  return testDb
    .insert(schema.lessons)
    .values({ moduleId, title, position })
    .returning()
    .get();
}

function enroll(courseId: number) {
  const student = createStudent();
  testDb.insert(schema.enrollments).values({ userId: student.id, courseId }).run();
  return student;
}

function setProgress(
  userId: number,
  lessonId: number,
  status: schema.LessonProgressStatus = schema.LessonProgressStatus.Completed
) {
  testDb
    .insert(schema.lessonProgress)
    .values({ userId, lessonId, status })
    .run();
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

describe("getLessonFunnel", () => {
  it("lists lessons in course order: module position, then lesson position", () => {
    const courseId = base.course.id;
    // Inserted out of order on purpose.
    const m2 = createModule(courseId, "Module Two", 2);
    const m1 = createModule(courseId, "Module One", 1);
    createLesson(m2.id, "2.2", 2);
    createLesson(m1.id, "1.2", 2);
    createLesson(m2.id, "2.1", 1);
    createLesson(m1.id, "1.1", 1);

    const funnel = getLessonFunnel(courseId);

    expect(funnel.lessons.map((l) => [l.moduleTitle, l.title])).toEqual([
      ["Module One", "1.1"],
      ["Module One", "1.2"],
      ["Module Two", "2.1"],
      ["Module Two", "2.2"],
    ]);
  });

  it("counts only completed progress of enrolled students, as a share of enrollments", () => {
    const courseId = base.course.id;
    const m1 = createModule(courseId, "Module One", 1);
    const lesson1 = createLesson(m1.id, "1.1", 1);
    const lesson2 = createLesson(m1.id, "1.2", 2);

    const a = enroll(courseId);
    const b = enroll(courseId);
    const c = enroll(courseId);
    enroll(courseId);
    setProgress(a.id, lesson1.id);
    setProgress(b.id, lesson1.id);
    setProgress(c.id, lesson1.id, schema.LessonProgressStatus.InProgress);
    setProgress(a.id, lesson2.id);
    setProgress(b.id, lesson2.id, schema.LessonProgressStatus.InProgress);
    // Completed but not enrolled in this course: ignored.
    setProgress(createStudent().id, lesson2.id);

    const funnel = getLessonFunnel(courseId);

    expect(funnel.enrolledCount).toBe(4);
    expect(
      funnel.lessons.map((l) => [l.title, l.completedCount, l.completionRate])
    ).toEqual([
      ["1.1", 2, 0.5],
      ["1.2", 1, 0.25],
    ]);
  });

  it("identifies the lesson with the largest point fall from the one before it, across modules", () => {
    const courseId = base.course.id;
    const m1 = createModule(courseId, "Module One", 1);
    const m2 = createModule(courseId, "Module Two", 2);
    const l1 = createLesson(m1.id, "1.1", 1);
    const l2 = createLesson(m1.id, "1.2", 2);
    const l3 = createLesson(m2.id, "2.1", 1);
    const l4 = createLesson(m2.id, "2.2", 2);

    // 10 students: 1.1 → 100%, 1.2 → 80%, 2.1 → 30%, 2.2 → 20%.
    const students = Array.from({ length: 10 }, () => enroll(courseId));
    students.forEach((s, i) => {
      setProgress(s.id, l1.id);
      if (i < 8) setProgress(s.id, l2.id);
      if (i < 3) setProgress(s.id, l3.id);
      if (i < 2) setProgress(s.id, l4.id);
    });

    const funnel = getLessonFunnel(courseId);

    expect(funnel.biggestDrop).toEqual({
      lessonId: l3.id,
      title: "2.1",
      drop: 0.5,
    });
  });

  it("has no biggest drop when no lesson falls below the one before it", () => {
    const courseId = base.course.id;
    const m1 = createModule(courseId, "Module One", 1);
    const l1 = createLesson(m1.id, "1.1", 1);
    createLesson(m1.id, "1.2", 2);
    const s = enroll(courseId);
    setProgress(s.id, l1.id);
    setProgress(enroll(courseId).id, l1.id);

    // 1.1 → 100%, 1.2 → 0%: a drop. Then check a flat course separately.
    expect(getLessonFunnel(courseId).biggestDrop?.title).toBe("1.2");

    const flat = createCourseWithOneLesson();
    expect(getLessonFunnel(flat).biggestDrop).toBeNull();
  });

  it("returns an empty funnel for a course with no lessons or enrollments", () => {
    expect(getLessonFunnel(base.course.id)).toEqual({
      enrolledCount: 0,
      lessons: [],
      biggestDrop: null,
    });
  });

  it("reports zero rates, not NaN, when lessons exist but nobody is enrolled", () => {
    const m1 = createModule(base.course.id, "Module One", 1);
    createLesson(m1.id, "1.1", 1);
    createLesson(m1.id, "1.2", 2);

    const funnel = getLessonFunnel(base.course.id);

    expect(funnel.lessons.map((l) => l.completionRate)).toEqual([0, 0]);
    expect(funnel.biggestDrop).toBeNull();
  });
});

function createPurchase(
  courseId: number,
  amountPaid: number,
  country: string | null
) {
  return testDb
    .insert(schema.purchases)
    .values({ userId: createStudent().id, courseId, amountPaid, country })
    .returning()
    .get();
}

describe("getRevenueByCountry", () => {
  it("groups this course's purchases by country, highest revenue first, with no-country purchases as null", () => {
    const courseId = base.course.id;
    createPurchase(courseId, 10000, "US");
    createPurchase(courseId, 10000, "US");
    createPurchase(courseId, 4000, "IN");
    createPurchase(courseId, 6000, null);
    createPurchase(courseId, 3000, null);
    const other = createCourseWithOneLesson();
    createPurchase(other, 99900, "US");

    expect(getRevenueByCountry(courseId)).toEqual([
      { country: "US", revenue: 20000, purchaseCount: 2 },
      { country: null, revenue: 9000, purchaseCount: 2 },
      { country: "IN", revenue: 4000, purchaseCount: 1 },
    ]);
  });

  it("is empty when the course has no purchases", () => {
    expect(getRevenueByCountry(base.course.id)).toEqual([]);
  });
});

describe("getUnredeemedSeatCount", () => {
  function createTeamPurchase(courseId: number, seats: number, redeemed: number) {
    const purchase = createPurchase(courseId, 10000 * seats, "US");
    const team = testDb.insert(schema.teams).values({}).returning().get();
    for (let i = 0; i < seats; i++) {
      counter++;
      testDb
        .insert(schema.coupons)
        .values({
          teamId: team.id,
          courseId,
          purchaseId: purchase.id,
          code: `CODE-${counter}`,
          ...(i < redeemed
            ? {
                redeemedByUserId: createStudent().id,
                redeemedAt: new Date().toISOString(),
              }
            : {}),
        })
        .run();
    }
  }

  it("counts unredeemed coupons from this course's team purchases", () => {
    createTeamPurchase(base.course.id, 5, 2);
    createTeamPurchase(base.course.id, 3, 0);
    createTeamPurchase(createCourseWithOneLesson(), 4, 0);

    expect(getUnredeemedSeatCount(base.course.id)).toBe(6);
  });

  it("is zero when the course has no team purchases", () => {
    expect(getUnredeemedSeatCount(base.course.id)).toBe(0);
  });
});

function createCourseWithOneLesson() {
  const course = testDb
    .insert(schema.courses)
    .values({
      title: "Flat",
      slug: "flat",
      description: "A course",
      salesCopy: "Sales copy.",
      instructorId: base.instructor.id,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
  const m = createModule(course.id, "Only", 1);
  const lesson = createLesson(m.id, "Only lesson", 1);
  setProgress(enroll(course.id).id, lesson.id);
  return course.id;
}
