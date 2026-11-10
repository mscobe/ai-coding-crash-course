import type { CourseSummary } from "~/services/analyticsService";
import { CourseStatus } from "~/db/schema";
import { Card } from "~/components/ui/card";
import { formatRating, usd } from "~/components/analytics-tiles";

// ─── Per-course summary table ───
// One row per published or archived course. Revenue and enrollments follow
// the selected range; completion, progress, and rating are all time.

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

export function CourseSummaryTable({
  courses,
  rangeLabel,
}: {
  courses: CourseSummary[];
  rangeLabel: string;
}) {
  return (
    <section className="mt-10">
      <h2 className="mb-1 text-xl font-semibold">Courses</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Revenue and enrollments: {rangeLabel.toLowerCase()}. Completion,
        progress, and rating: all time.
      </p>

      {courses.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          You have no published courses yet.
        </p>
      ) : (
        <Card className="overflow-x-auto py-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Course</th>
                <th className="px-4 py-3 text-right font-medium">Revenue</th>
                <th className="px-4 py-3 text-right font-medium">
                  Enrollments
                </th>
                <th className="px-4 py-3 text-right font-medium">Completion</th>
                <th className="px-4 py-3 text-right font-medium">
                  Avg. progress
                </th>
                <th className="px-4 py-3 text-right font-medium">
                  Avg. rating
                </th>
              </tr>
            </thead>
            <tbody className="divide-y tabular-nums">
              {courses.map((course) => (
                <tr key={course.courseId}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <CourseName course={course} />
                      {course.status === CourseStatus.Archived && (
                        <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800 dark:bg-gray-900/30 dark:text-gray-400">
                          Archived
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {usd.format(course.revenue / 100)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {course.enrollments.toLocaleString("en-US")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {percent(course.completionRate)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {percent(course.averageProgress)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {formatRating(course.averageRating)}
                    {course.ratingCount > 0 && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({course.ratingCount})
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}

/** The course title. Ticket #7 turns this into a link to the course's analytics. */
function CourseName({ course }: { course: CourseSummary }) {
  return <span className="font-medium">{course.title}</span>;
}
