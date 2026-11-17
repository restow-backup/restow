import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  billingKeys,
  type CreateCorrectionInput,
  createBillingCorrection,
  fetchBillingPeriod,
  fetchBillingPeriods,
} from "./api";

export function useBillingPeriods() {
  return useQuery({ queryKey: billingKeys.list(), queryFn: fetchBillingPeriods });
}

export function useBillingPeriod(period: string | null) {
  return useQuery({
    queryKey: billingKeys.period(period ?? ""),
    queryFn: () => fetchBillingPeriod(period ?? ""),
    enabled: period !== null,
  });
}

/** Add a correction; the month and the list are read again afterwards. */
export function useCreateCorrection(period: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCorrectionInput) => createBillingCorrection(period, input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: billingKeys.all }),
  });
}
