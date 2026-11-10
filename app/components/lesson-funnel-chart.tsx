import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { BarChart3, TrendingDown } from "lucide-react";
import { Card, CardContent } from "~/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "~/components/ui/chart";
import type { FunnelLesson, LessonFunnel } from "~/services/analyticsService";

// ─── Lesson drop-off funnel ───
// One bar per lesson in course order: the share of enrolled students who
// completed it. Module starts are marked; the biggest drop is highlighted.

const chartConfig = {
  percent: { label: "Completed", color: "var(--chart-2)" },
  drop: { label: "Biggest drop-off", color: "var(--chart-1)" },
} satisfies ChartConfig;

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

type FunnelBar = FunnelLesson & {
  /** "module.lesson" numbering, e.g. "2.3". */
  label: string;
  percent: number;
  moduleStart: boolean;
};

function toBars(lessons: FunnelLesson[]): FunnelBar[] {
  let moduleIndex = 0;
  let lessonIndex = 0;
  return lessons.map((lesson, i) => {
    const moduleStart = i === 0 || lesson.moduleId !== lessons[i - 1].moduleId;
    if (moduleStart) {
      moduleIndex++;
      lessonIndex = 0;
    }
    lessonIndex++;
    return {
      ...lesson,
      label: `${moduleIndex}.${lessonIndex}`,
      percent: Math.round(lesson.completionRate * 1000) / 10,
      moduleStart,
    };
  });
}

export function LessonFunnelChart({ funnel }: { funnel: LessonFunnel }) {
  const bars = toBars(funnel.lessons);
  const { biggestDrop, enrolledCount } = funnel;
  const empty = bars.length === 0 || enrolledCount === 0;

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-1 flex items-baseline justify-between gap-4">
          <h2 className="font-semibold">Lesson drop-off</h2>
          <span className="text-xs text-muted-foreground">
            % of {enrolledCount.toLocaleString("en-US")} enrolled{" "}
            {enrolledCount === 1 ? "student" : "students"} · all time
          </span>
        </div>

        {!empty && (
          <p className="mb-4 flex items-center gap-1.5 text-sm">
            <TrendingDown className="size-4 text-[var(--chart-1)]" />
            {biggestDrop ? (
              <span>
                Biggest drop-off:{" "}
                <span className="font-medium">{biggestDrop.title}</span>{" "}
                <span className="text-muted-foreground">
                  (−{Math.round(biggestDrop.drop * 100)} points from the
                  previous lesson)
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">
                No lesson falls below the one before it.
              </span>
            )}
          </p>
        )}

        {empty ? (
          <div className="mt-4 flex h-64 flex-col items-center justify-center rounded-md border border-dashed text-center">
            <BarChart3 className="mb-3 size-10 text-muted-foreground/50" />
            <p className="text-sm font-medium">
              {bars.length === 0
                ? "This course has no lessons yet"
                : "No students enrolled yet"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              The funnel appears once students start working through lessons.
            </p>
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-72 w-full">
            <BarChart data={bars} margin={{ left: 0, right: 8, top: 24 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                interval="preserveStartEnd"
              />
              <YAxis
                domain={[0, 100]}
                tickLine={false}
                axisLine={false}
                width={40}
                tickFormatter={(value: number) => `${value}%`}
              />
              {bars
                .filter((bar) => bar.moduleStart)
                .map((bar) => (
                  <ReferenceLine
                    key={bar.moduleId}
                    x={bar.label}
                    position="start"
                    stroke="var(--border)"
                    strokeDasharray="4 4"
                    label={{
                      value: bar.moduleTitle,
                      position: "insideTopLeft",
                      dy: -20,
                      fontSize: 11,
                      fill: "var(--muted-foreground)",
                    }}
                  />
                ))}
              <ChartTooltip
                cursor={{ fill: "var(--muted)", opacity: 0.5 }}
                content={({ active, payload }) => {
                  const bar = payload?.[0]?.payload as FunnelBar | undefined;
                  if (!active || !bar) return null;
                  return (
                    <div className="rounded-lg border bg-background px-3 py-2 text-xs shadow-xl">
                      <p className="text-muted-foreground">
                        {bar.label} · {bar.moduleTitle}
                      </p>
                      <p className="font-medium">{bar.title}</p>
                      <p className="mt-1 tabular-nums">
                        {bar.completedCount.toLocaleString("en-US")} of{" "}
                        {enrolledCount.toLocaleString("en-US")} completed (
                        {percent(bar.completionRate)})
                      </p>
                    </div>
                  );
                }}
              />
              <Bar dataKey="percent" radius={[3, 3, 0, 0]}>
                {bars.map((bar) => (
                  <Cell
                    key={bar.lessonId}
                    fill={
                      bar.lessonId === biggestDrop?.lessonId
                        ? "var(--color-drop)"
                        : "var(--color-percent)"
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
