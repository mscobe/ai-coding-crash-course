import {
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  DollarSign,
  Star,
  Users,
} from "lucide-react";
import type {
  InstructorOverview,
  PeriodComparison,
} from "~/services/analyticsService";
import { Card, CardContent } from "~/components/ui/card";
import { cn } from "~/lib/utils";

// ─── Analytics headline tiles ───
// The four headline numbers (revenue, new enrollments, completion rate,
// average rating). Shared by the analytics overview and the KPI strip on
// "My Courses".

export const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatRating(averageRating: number | null) {
  return averageRating === null ? "—" : averageRating.toFixed(1);
}

export function OverviewTiles({ overview }: { overview: InstructorOverview }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        label="Revenue"
        icon={<DollarSign className="size-4" />}
        value={usd.format(overview.revenue.current / 100)}
        change={<Change comparison={overview.revenue} />}
      />
      <StatTile
        label="New enrollments"
        icon={<Users className="size-4" />}
        value={overview.newEnrollments.current.toLocaleString("en-US")}
        change={<Change comparison={overview.newEnrollments} />}
      />
      <StatTile
        label="Completion rate"
        icon={<CheckCircle2 className="size-4" />}
        value={`${Math.round(overview.completionRate * 100)}%`}
        change={<span>All time</span>}
      />
      <StatTile
        label="Average rating"
        icon={<Star className="size-4" />}
        value={formatRating(overview.averageRating)}
        change={
          <span>
            {overview.ratingCount === 0
              ? "No ratings yet"
              : `${overview.ratingCount} rating${overview.ratingCount === 1 ? "" : "s"}`}
          </span>
        }
      />
    </div>
  );
}

function StatTile({
  label,
  icon,
  value,
  change,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  change: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="space-y-2 p-5">
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{label}</span>
          {icon}
        </div>
        <div className="text-3xl font-bold tabular-nums">{value}</div>
        <div className="text-xs text-muted-foreground">{change}</div>
      </CardContent>
    </Card>
  );
}

export function Change({ comparison }: { comparison: PeriodComparison }) {
  const { current, previous } = comparison;
  // "All time" has nothing to compare against.
  if (previous === null) return <span>All time</span>;

  if (previous === 0) {
    return (
      <span>
        {current === 0 ? "No change" : "Up from none"} vs previous period
      </span>
    );
  }

  const percent = Math.round(((current - previous) / previous) * 100);
  if (percent === 0) return <span>No change vs previous period</span>;

  const up = percent > 0;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={cn(
          "inline-flex items-center font-medium",
          up ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
        )}
      >
        <Arrow className="size-3.5" />
        {Math.abs(percent)}%
      </span>
      vs previous period
    </span>
  );
}
