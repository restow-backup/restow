import { Info } from "lucide-react";
import type * as React from "react";

import { EmptyState } from "@/components/kit";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import type { Dataset, StatsDataset } from "../api.js";
import { useStatsFormat } from "../use-stats-format.js";
import { DatasetMenu } from "./chart-parts.js";

interface TableCardProps<T> {
  title: string;
  description: string;
  /** The dataset behind the table, for the CSV export; undefined while loading. */
  name: StatsDataset;
  data: Dataset<T> | undefined;
  /** The table itself, rendered unless the dataset is unavailable. */
  children: React.ReactNode;
}

/**
 * A statistics table in a card: title, description and the export menu,
 * then either the table or, when the server has no source for the dataset,
 * the reason why there is none.
 */
export function TableCard<T>({ title, description, name, data, children }: TableCardProps<T>) {
  const format = useStatsFormat();
  const { t } = format;
  return (
    <Card data-slot="stats-table" className="gap-4">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        {data?.status === "ok" ? (
          <CardAction>
            <DatasetMenu dataset={name} title={title} />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {data?.status === "unavailable" ? (
          <EmptyState
            icon={Info}
            title={t("unavailable.title")}
            description={format.reason(data.reason)}
            className="py-8"
          />
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

/** Rows of an ok dataset; undefined while loading or when unavailable. */
export function rowsOf<T>(data: Dataset<T> | undefined): T[] | undefined {
  return data?.status === "ok" ? data.rows : undefined;
}

/**
 * Column options for a value that may be missing (a time never recorded, a
 * rate without runs): plain comparison, missing values last in both
 * directions. The accessor must return `undefined` for a missing value.
 */
export const MISSING_LAST = {
  sortingFn: "basic",
  sortUndefined: "last",
} as const;
