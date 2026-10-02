import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CauseLine } from "@/features/failures";
import type { JobDetail } from "@/features/jobs/api";
import type { JobFormat } from "@/features/jobs/use-format";

/**
 * The items a mail run could not process, one per row with the cause, how often they failed in
 * a row and when they were last tried. The run's own page shows it below its numbers; the
 * server caps the list (the count above it is exact).
 */
export function FailuresCard({ job, format }: { job: JobDetail; format: JobFormat }) {
  const { t } = format;
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-base">{t("failures.title")}</CardTitle>
        <CardDescription>{t("failures.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {job.failures.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("failures.empty")}</p>
        ) : (
          <div className="space-y-3">
            {job.failureCount > job.failures.length ? (
              <p className="text-xs text-muted-foreground">
                {t("failures.capped", {
                  shown: format.integer(job.failures.length),
                  total: format.integer(job.failureCount),
                })}
              </p>
            ) : null}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("failures.item")}</TableHead>
                  <TableHead>{t("failures.reason")}</TableHead>
                  <TableHead className="text-right">{t("failures.attempts")}</TableHead>
                  <TableHead className="text-right">{t("failures.lastAttempt")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {job.failures.map((failure) => (
                  <TableRow key={failure.id}>
                    <TableCell className="max-w-72 break-all font-mono text-xs">
                      {failure.itemRef}
                    </TableCell>
                    <TableCell className="max-w-96 break-words text-sm">
                      {failure.failure ? (
                        <div className="space-y-0.5">
                          <CauseLine
                            failure={failure.failure}
                            className="text-sm text-foreground"
                          />
                          <p className="text-xs text-muted-foreground">{failure.reason}</p>
                        </div>
                      ) : (
                        failure.reason
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {failure.attempts >= 3 ? (
                        <Badge variant="destructive">
                          {t("failures.repeated", { count: failure.attempts })}
                        </Badge>
                      ) : (
                        <span className="tabular-nums">{format.integer(failure.attempts)}</span>
                      )}
                    </TableCell>
                    <TableCell
                      className="text-right text-muted-foreground"
                      title={format.dateTime(failure.lastAttemptAt) ?? undefined}
                    >
                      {format.relative(failure.lastAttemptAt) ?? "–"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
