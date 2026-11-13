import { ResticError } from "@restow/core";
import { ProblemError } from "../../problem.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";

/**
 * Map a failed restic run to the problem an admin can act on. Anything else (a database or
 * storage error, a bug) is answered as it is: the global error handler logs it with route and
 * stack and answers a generic 500. Wrapped into a ProblemError here, it left no trace at all
 * (an enrollment failing with a bare 500 and an empty log).
 */
export function resticProblem(error: unknown): unknown {
  if (error instanceof ProblemError) {
    return error;
  }
  if (error instanceof ResticError) {
    switch (error.failure) {
      case "locked":
        return new ProblemError(503, "Repository busy", {
          type: ENDPOINT_PROBLEMS.repositoryLocked,
          detail: "The repository is locked by a running backup or maintenance. Try again shortly.",
        });
      case "no_repository":
        return new ProblemError(409, "Repository not found", {
          type: ENDPOINT_PROBLEMS.repositoryNotFound,
          detail:
            "The repository of this endpoint was not found on any storage target of the tenant.",
          extensions: { category: ENDPOINT_PROBLEMS.repositoryUnavailable },
        });
      case "wrong_password":
        return new ProblemError(500, "Repository password rejected", {
          type: ENDPOINT_PROBLEMS.repositoryPasswordRejected,
          detail: "The stored password does not open the repository.",
          extensions: { category: ENDPOINT_PROBLEMS.repositoryUnavailable },
        });
      default:
        return new ProblemError(502, "restic failed", {
          type: ENDPOINT_PROBLEMS.resticFailed,
          detail: error.message.slice(0, 500),
        });
    }
  }
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return new ProblemError(503, "restic not available", {
      type: ENDPOINT_PROBLEMS.resticUnavailable,
      detail: "The restic binary is not available on this server.",
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}
