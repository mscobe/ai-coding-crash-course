import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { calculatePppPrice } from "../app/lib/ppp";
import * as schema from "../app/db/schema";
import {
  LessonProgressStatus,
  TeamMemberRole,
  UserRole,
} from "../app/db/schema";

// ─── Generated Demo Data ───
// Deterministic bulk data so the instructor analytics dashboard has something
// realistic to show: ~80 extra students buying, progressing through, and rating
// both courses over the last ~11 months. A fixed-seed PRNG plus the
// midnight-anchored `now` make same-day reseeds produce identical rows.

function mulberry32(seedValue: number) {
  let a = seedValue;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GENERATED_STUDENT_COUNT = 80;
const GENERATED_SPAN_DAYS = 330;

const FIRST_NAMES = [
  "Ava", "Noah", "Mia", "Lucas", "Isla", "Mateo", "Zara", "Ethan", "Priya",
  "Arjun", "Chloe", "Diego", "Hana", "Kenji", "Lena", "Omar", "Ruby", "Tariq",
  "Yuki", "Felix", "Amara", "Ivan", "Nia", "Sven", "Leila", "Rafael", "Ines",
  "Kofi", "Maya", "Theo",
];
const LAST_NAMES = [
  "Nguyen", "Patel", "Garcia", "Kim", "Okafor", "Silva", "Kowalski", "Haddad",
  "Tanaka", "Muller", "Ahmed", "Rossi", "Lopez", "Novak", "Mensah", "Larsen",
  "Reyes", "Sato", "Costa", "Ibrahim",
];
// Weighted toward full-price markets, with a tail across every PPP tier.
const COUNTRIES = [
  "US", "US", "US", "US", "US", "GB", "GB", "CA", "CA", "DE", "AU", "FR",
  "BR", "MX", "PL", "IN", "IN", "IN", "PH", "ZA", "NG", "PK", "KE",
];

export type GeneratedCourse = {
  id: number;
  price: number;
  lessonIds: number[];
  codePrefix: string;
};

export function seedGeneratedData(
  db: BetterSQLite3Database<typeof schema>,
  now: Date,
  courses: GeneratedCourse[]
) {
  const rand = mulberry32(20240601);
  const pick = <T,>(items: T[]) => items[Math.floor(rand() * items.length)];
  const between = (min: number, max: number) => min + rand() * (max - min);
  // A timestamp `days` days before `now` (fractional days give a time of day).
  const at = (days: number) =>
    new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  const counts = {
    students: 0,
    enrollments: 0,
    completed: 0,
    purchases: 0,
    lessonProgress: 0,
    ratings: 0,
    teams: 0,
    coupons: 0,
    redeemed: 0,
  };

  // ─── Students ───
  const generatedStudents = db
    .insert(schema.users)
    .values(
      Array.from({ length: GENERATED_STUDENT_COUNT }, (_, i) => {
        const first = pick(FIRST_NAMES);
        const last = pick(LAST_NAMES);
        return {
          name: `${first} ${last}`,
          email: `${first}.${last}.${i + 1}@student.dev`.toLowerCase(),
          role: UserRole.Student,
          avatarUrl: `https://api.dicebear.com/9.x/avataaars/svg?seed=gen-${i + 1}`,
          createdAt: at(GENERATED_SPAN_DAYS + 5),
        };
      })
    )
    .returning()
    .all();
  counts.students = generatedStudents.length;

  const enrolledByCourse = new Map<number, Set<number>>(
    courses.map((c) => [c.id, new Set<number>()])
  );

  // Enrolls a student, fills lesson progress that decays with lesson order,
  // and maybe leaves a rating. Every student completes a prefix of the course,
  // so per-lesson completion counts never increase down the course.
  function enroll(userId: number, course: GeneratedCourse, enrolledDaysAgo: number) {
    enrolledByCourse.get(course.id)!.add(userId);
    const lessonCount = course.lessonIds.length;

    // Per-student stickiness: some students drop early, some push through.
    const stickiness = between(0.82, 0.97);
    let completedLessons = 0;
    while (completedLessons < lessonCount && rand() <= stickiness) {
      completedLessons++;
    }
    const finished = completedLessons === lessonCount;

    // Lessons are completed at even intervals between enrollment and now.
    const progressRows: (typeof schema.lessonProgress.$inferInsert)[] = [];
    for (let i = 0; i < completedLessons; i++) {
      const done = enrolledDaysAgo - (enrolledDaysAgo * (i + 1)) / (lessonCount + 2);
      progressRows.push({
        userId,
        lessonId: course.lessonIds[i],
        status: LessonProgressStatus.Completed,
        completedAt: at(done),
      });
    }
    if (!finished && rand() < 0.5) {
      progressRows.push({
        userId,
        lessonId: course.lessonIds[completedLessons],
        status: LessonProgressStatus.InProgress,
      });
    }
    if (progressRows.length > 0) {
      db.insert(schema.lessonProgress).values(progressRows).run();
      counts.lessonProgress += progressRows.length;
    }

    db.insert(schema.enrollments)
      .values({
        userId,
        courseId: course.id,
        enrolledAt: at(enrolledDaysAgo),
        completedAt: finished ? at(enrolledDaysAgo / (lessonCount + 2)) : null,
      })
      .run();
    counts.enrollments++;
    if (finished) counts.completed++;

    // Students who got further are likelier to rate, and to rate higher.
    const progressRatio = completedLessons / lessonCount;
    if (completedLessons > 0 && rand() < 0.2 + 0.5 * progressRatio) {
      const rating = Math.min(
        5,
        Math.max(1, Math.round(2.8 + 2 * progressRatio + between(-1, 1)))
      );
      const ratedAt = at(enrolledDaysAgo / 3);
      db.insert(schema.courseRatings)
        .values({ userId, courseId: course.id, rating, createdAt: ratedAt, updatedAt: ratedAt })
        .run();
      counts.ratings++;
    }
  }

  // ─── Individual purchases + enrollments ───
  // Enrollment dates skew recent, so the dashboard shows growth.
  for (const student of generatedStudents) {
    const country = pick(COUNTRIES);
    for (const course of courses) {
      if (rand() > 0.6) continue;
      const enrolledDaysAgo = GENERATED_SPAN_DAYS * rand() ** 1.6 + 0.2;
      db.insert(schema.purchases)
        .values({
          userId: student.id,
          courseId: course.id,
          amountPaid: calculatePppPrice(course.price, country),
          country,
          createdAt: at(enrolledDaysAgo),
        })
        .run();
      counts.purchases++;
      enroll(student.id, course, enrolledDaysAgo);
    }
  }

  // ─── Team purchases with partially redeemed seats ───
  // One team per course; redeemers are generated students not already enrolled.
  const teamBuyers = [
    { name: "Priya Raman", email: "priya.raman@acme.dev", country: "GB", seats: 10, redeem: 4, daysAgo: 140 },
    { name: "Gustav Lind", email: "gustav.lind@nordtech.dev", country: "SE", seats: 6, redeem: 2, daysAgo: 80 },
  ];
  for (const [ci, course] of courses.entries()) {
    const spec = teamBuyers[ci % teamBuyers.length];

    const [buyer] = db
      .insert(schema.users)
      .values({
        name: spec.name,
        email: spec.email,
        role: UserRole.Student,
        avatarUrl: `https://api.dicebear.com/9.x/avataaars/svg?seed=team-${ci + 1}`,
        createdAt: at(spec.daysAgo + 3),
      })
      .returning()
      .all();
    counts.students++;

    const [team] = db
      .insert(schema.teams)
      .values({ createdAt: at(spec.daysAgo) })
      .returning()
      .all();
    db.insert(schema.teamMembers)
      .values({
        teamId: team.id,
        userId: buyer.id,
        role: TeamMemberRole.Admin,
        createdAt: at(spec.daysAgo),
      })
      .run();
    counts.teams++;

    const [purchase] = db
      .insert(schema.purchases)
      .values({
        userId: buyer.id,
        courseId: course.id,
        amountPaid: course.price * spec.seats,
        country: spec.country,
        createdAt: at(spec.daysAgo),
      })
      .returning()
      .all();
    counts.purchases++;

    const redeemers = generatedStudents
      .filter((s) => !enrolledByCourse.get(course.id)!.has(s.id))
      .slice(0, spec.redeem);

    for (let seat = 0; seat < spec.seats; seat++) {
      const redeemer = redeemers[seat];
      const redeemedDaysAgo = spec.daysAgo - 2 - seat * 7;
      db.insert(schema.coupons)
        .values({
          teamId: team.id,
          courseId: course.id,
          code: `TEAM-${course.codePrefix}-GEN${String(seat + 1).padStart(3, "0")}`,
          purchaseId: purchase.id,
          redeemedByUserId: redeemer?.id ?? null,
          redeemedAt: redeemer ? at(redeemedDaysAgo) : null,
          createdAt: at(spec.daysAgo),
        })
        .run();
      counts.coupons++;
      if (redeemer) {
        counts.redeemed++;
        enroll(redeemer.id, course, redeemedDaysAgo);
      }
    }
  }

  console.log(
    `Generated ${counts.students} students, ${counts.purchases} purchases, ${counts.enrollments} enrollments (${counts.completed} completed), ${counts.lessonProgress} lesson progress rows, ${counts.ratings} ratings, ${counts.teams} teams with ${counts.coupons} coupons (${counts.redeemed} redeemed).`
  );

  return counts;
}
