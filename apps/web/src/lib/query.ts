import { QueryCache, QueryClient } from "@tanstack/react-query";

import { ApiError } from "@/lib/api";

type UnauthorizedListener = () => void;

const unauthorizedListeners = new Set<UnauthorizedListener>();

/**
 * Subscribe to "the API answered 401" for any query. The app shell uses it to
 * drop the cached session and send the user to the login page, without the
 * query layer knowing about the router.
 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

/**
 * Shared TanStack Query client. It lives outside React so the router can carry
 * it in its context and loaders can prefetch through the same cache.
 */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) {
        for (const listener of unauthorizedListeners) {
          listener();
        }
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Client errors will not fix themselves on retry; transient ones might.
        if (error instanceof ApiError && error.status < 500) {
          return false;
        }
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
  },
});
