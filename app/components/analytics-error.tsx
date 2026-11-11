import { Link, isRouteErrorResponse } from "react-router";
import { AlertTriangle } from "lucide-react";
import { Button } from "~/components/ui/button";

// ─── Analytics error boundary ───
// The error page shared by the analytics routes: 401/403/404 get their own
// copy, anything else shows its status.

export function AnalyticsErrorBoundary({
  error,
  fallbackMessage,
  forbiddenMessage,
  showMyCourses = false,
}: {
  error: unknown;
  /** Shown for errors that aren't route responses. */
  fallbackMessage: string;
  /** Overrides the guard's own 403 message. */
  forbiddenMessage?: string;
  showMyCourses?: boolean;
}) {
  let title = "Something went wrong";
  let message = fallbackMessage;

  if (isRouteErrorResponse(error)) {
    const detail = typeof error.data === "string" ? error.data : null;
    if (error.status === 404) {
      title = "Course not found";
      message =
        "The course you're looking for doesn't exist or may have been removed.";
    } else if (error.status === 401) {
      title = "Sign in required";
      message = detail ?? "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        forbiddenMessage ?? detail ?? "You don't have access to this page.";
    } else {
      title = `Error ${error.status}`;
      message = detail ?? error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          {showMyCourses && (
            <Link to="/instructor">
              <Button variant="outline">My Courses</Button>
            </Link>
          )}
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
