import { Link, data, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/instructor.$courseId.analytics";
import { getCourseById } from "~/services/courseService";
import {
  getLessonFunnel,
  getRevenueByCountry,
  getUnredeemedSeatCount,
} from "~/services/analyticsService";
import { requireStaff } from "~/lib/access.server";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { usd } from "~/components/analytics-tiles";
import { LessonFunnelChart } from "~/components/lesson-funnel-chart";
import { AlertTriangle, ArrowLeft, Globe, Ticket } from "lucide-react";

// ─── Course analytics ───
// Lesson drop-off funnel, revenue by country, and unredeemed team seats for
// one course. Same access rule as the students roster: the owning instructor
// or any admin.

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData?.course?.title ?? "Course Analytics";
  return [
    { title: `Analytics: ${title} — Cadence` },
    { name: "description", content: `Course analytics for ${title}` },
  ];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const courseId = parseInt(params.courseId, 10);
  if (isNaN(courseId)) {
    throw data("Invalid course ID.", { status: 400 });
  }

  const access = await requireStaff(request, courseId);

  const course = getCourseById(courseId);
  if (!course) {
    throw data("Course not found.", { status: 404 });
  }

  return {
    course: { id: course.id, title: course.title },
    isAdmin: access.isAdmin,
    funnel: getLessonFunnel(courseId),
    revenueByCountry: getRevenueByCountry(courseId),
    unredeemedSeats: getUnredeemedSeatCount(courseId),
  };
}

const countryNames = new Intl.DisplayNames(["en"], { type: "region" });

function countryName(code: string | null) {
  if (code === null) return "Unknown";
  try {
    return countryNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export default function CourseAnalytics({ loaderData }: Route.ComponentProps) {
  const { course, funnel, revenueByCountry, unredeemedSeats } = loaderData;
  const totalRevenue = revenueByCountry.reduce((sum, r) => sum + r.revenue, 0);

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/instructor" className="hover:text-foreground">
          My Courses
        </Link>
        <span className="mx-2">/</span>
        <Link to={`/instructor/${course.id}`} className="hover:text-foreground">
          {course.title}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Analytics</span>
      </nav>

      <Link
        to={`/instructor/${course.id}`}
        className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 size-4" />
        Back to Course Editor
      </Link>

      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Course Analytics</h1>
          <p className="mt-1 text-muted-foreground">{course.title}</p>
        </div>
        <Link
          to={`/instructor/${course.id}/students`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          View student roster →
        </Link>
      </div>

      <LessonFunnelChart funnel={funnel} />

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="p-5">
            <div className="mb-4 flex items-baseline justify-between gap-4">
              <h2 className="font-semibold">Revenue by country</h2>
              <span className="text-xs text-muted-foreground">
                All time · by purchase country
              </span>
            </div>

            {revenueByCountry.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-10 text-center">
                <Globe className="mb-3 size-10 text-muted-foreground/50" />
                <p className="text-sm font-medium">No purchases yet</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b text-left text-muted-foreground">
                  <tr>
                    <th className="py-2 font-medium">Country</th>
                    <th className="py-2 text-right font-medium">Purchases</th>
                    <th className="py-2 text-right font-medium">Revenue</th>
                    <th className="py-2 text-right font-medium">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y tabular-nums">
                  {revenueByCountry.map((row) => (
                    <tr key={row.country ?? "unknown"}>
                      <td className="py-2">
                        {countryName(row.country)}
                        {row.country && (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            {row.country}
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        {row.purchaseCount.toLocaleString("en-US")}
                      </td>
                      <td className="py-2 text-right">
                        {usd.format(row.revenue / 100)}
                      </td>
                      <td className="py-2 text-right text-muted-foreground">
                        {totalRevenue === 0
                          ? "—"
                          : `${Math.round((row.revenue / totalRevenue) * 100)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <h2 className="mb-4 font-semibold">Unredeemed team seats</h2>
            <div className="flex items-center gap-3">
              <Ticket className="size-8 text-muted-foreground/60" />
              <span className="text-4xl font-bold tabular-nums">
                {unredeemedSeats.toLocaleString("en-US")}
              </span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              Seats bought through team purchases that no one has claimed yet.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading course analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      title = "Course not found";
      message =
        "The course you're looking for doesn't exist or may have been removed.";
    } else if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message = "You can only view analytics for your own courses.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/instructor">
            <Button variant="outline">My Courses</Button>
          </Link>
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
