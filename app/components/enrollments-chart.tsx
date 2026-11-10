import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { LineChart as LineChartIcon } from "lucide-react";
import { Card, CardContent } from "~/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart";
import type {
  EnrollmentsOverTime,
  TimeGranularity,
} from "~/services/analyticsService";

// ─── Enrollments over time ───
// New enrollments per day / week / month for the selected range (UTC).

const chartConfig = {
  count: { label: "Enrollments", color: "var(--chart-1)" },
} satisfies ChartConfig;

const GRANULARITY_LABEL: Record<TimeGranularity, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

/** Bucket starts are `YYYY-MM-DD` in UTC, so format in UTC too. */
function formatAxis(start: string, granularity: TimeGranularity) {
  const date = new Date(`${start}T00:00:00Z`);
  return granularity === "month"
    ? date.toLocaleDateString("en-US", {
        month: "short",
        year: "2-digit",
        timeZone: "UTC",
      })
    : date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
}

function formatTooltip(start: string, granularity: TimeGranularity) {
  const date = new Date(`${start}T00:00:00Z`);
  if (granularity === "month") {
    return date.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return granularity === "week" ? `Week of ${day}` : day;
}

export function EnrollmentsChart({ series }: { series: EnrollmentsOverTime }) {
  const { granularity, buckets } = series;
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="font-semibold">Enrollments over time</h2>
          <span className="text-xs text-muted-foreground">
            {GRANULARITY_LABEL[granularity]} · UTC
          </span>
        </div>

        {total === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center rounded-md border border-dashed text-center">
            <LineChartIcon className="mb-3 size-10 text-muted-foreground/50" />
            <p className="text-sm font-medium">No enrollments in this period</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Try a longer range to see how enrollments have trended.
            </p>
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-64 w-full">
            <AreaChart data={buckets} margin={{ left: 0, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="start"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={(value: string) =>
                  formatAxis(value, granularity)
                }
              />
              <YAxis
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                width={32}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    indicator="line"
                    labelFormatter={(value) =>
                      formatTooltip(String(value), granularity)
                    }
                  />
                }
              />
              <Area
                dataKey="count"
                type="monotone"
                stroke="var(--color-count)"
                strokeWidth={2}
                fill="var(--color-count)"
                fillOpacity={0.15}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
