// Package procctl controls child processes on Windows (docs/WINDOWS-AGENT.md,
// section 12): every child (restic, a hook) goes into its own Job Object right
// after it started, so the agent can end it together with whatever it started,
// and Windows ends them when the agent dies (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).
// restic is asked to stop with CTRL_BREAK on its own process group, which
// needs a console the agent and restic share; the service allocates one
// (EnsureConsole). There is no suspended start (CREATE_SUSPENDED and
// ResumeThread): the short window between start and assignment is accepted.
//
// On Unix the package is empty; process groups and signals do that job there.
package procctl
