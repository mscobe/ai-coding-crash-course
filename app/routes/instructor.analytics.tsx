import { Link, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/instructor.analytics";
import { requireInstructor } from "~/lib/access.server";
import {
  getCourseSummaries,
  getInstructorOverview,
  parseAnalyticsRange,
  type AnalyticsRange,
} from "~/services/analyticsService";
import { Button } from "~/components/ui/button";
import { OverviewTiles } from "~/components/analytics-tiles";
import { CourseSummaryTable } from "~/components/course-summary-table";
import { cn } from "~/lib/utils";
import { AlertTriangle, BarChart3 } from "lucide-react";

// ─── Instructor Analytics Overview ───
// Headline numbers across the signed-in instructor's own (non-draft) courses.
// The range lives in `?range=` so views are bookmarkable and back works.

const RANGE_OPTIONS: { value: AnalyticsRange; label: string }[] = [
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "12m", label: "Last 12 months" },
  { value: "all", label: "All time" },
];

export function meta() {
  return [{ title: "Analytics — Cadence" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { userId } = await requireInstructor(request);
  const range = parseAnalyticsRange(
    new URL(request.url).searchParams.get("range")
  );

  return {
    range,
    overview: getInstructorOverview(userId, range),
    courses: getCourseSummaries(userId, range),
  };
}

export default function InstructorAnalytics({
  loaderData,
}: Route.ComponentProps) {
  const { range, overview, courses } = loaderData;
  const isEmpty =
    overview.revenue.current === 0 && overview.newEnrollments.current === 0;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <Link to="/instructor" className="hover:text-foreground">
          My Courses
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Analytics</span>
      </nav>

      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Analytics</h1>
          <p className="mt-1 text-muted-foreground">
            How your courses are doing
          </p>
        </div>
        <RangeSelector selected={range} />
      </div>

      <OverviewTiles overview={overview} />

      {isEmpty && (
        <div className="mt-10 flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
          <BarChart3 className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">
            No sales or enrollments in this period
          </h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Numbers will appear here as students buy and enroll in your
            published courses. Try a longer range, or check on your courses.
          </p>
          <Link to="/instructor" className="mt-4">
            <Button variant="outline">Go to My Courses</Button>
          </Link>
        </div>
      )}

      <CourseSummaryTable
        courses={courses}
        rangeLabel={
          RANGE_OPTIONS.find((option) => option.value === range)!.label
        }
      />
    </div>
  );
}

function RangeSelector({ selected }: { selected: AnalyticsRange }) {
  return (
    <div
      role="group"
      aria-label="Date range"
      className="inline-flex rounded-md border bg-muted p-1"
    >
      {RANGE_OPTIONS.map((option) => (
        <Link
          key={option.value}
          to={`?range=${option.value}`}
          preventScrollReset
          aria-current={option.value === selected ? "page" : undefined}
          className={cn(
            "rounded px-3 py-1.5 text-sm font-medium transition-colors",
            option.value === selected
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </Link>
      ))}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading your analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Not allowed";
      message =
        typeof error.data === "string"
          ? error.data
          : "You don't have access to this page.";
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
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
