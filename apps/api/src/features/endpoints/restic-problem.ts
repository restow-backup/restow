import { ResticError } from "@restow/core";
import { ProblemError } from "../../problem.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";

/** Map a failed restic run to the problem an admin can act on. */
export function resticProblem(error: unknown): ProblemError {
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
          type: ENDPOINT_PROBLEMS.repositoryUnavailable,
          detail: "The repository of this endpoint was not found in the storage target.",
        });
      case "wrong_password":
        return new ProblemError(500, "Repository password rejected", {
          type: ENDPOINT_PROBLEMS.repositoryUnavailable,
          detail: "The stored password does not open the repository.",
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
  return new ProblemError(500, "Internal Server Error", {
    detail: "An unexpected error occurred.",
  });
}
