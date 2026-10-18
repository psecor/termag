/** Exit codes are part of the CLI's contract with scripts and agents (PRD "Behavior"). */
export const EXIT = {
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  AUTH: 4,
  TIMEOUT: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type ErrorCode =
  | 'failed'
  | 'usage'
  | 'not_found'
  | 'auth_required'
  | 'timeout'
  | 'unreachable'
  | 'not_cli_enabled'
  | 'edge_auth'
  | 'conflict'
  | 'forbidden'
  | 'precondition';

const EXIT_FOR: Record<ErrorCode, ExitCode> = {
  failed: EXIT.FAILED,
  usage: EXIT.USAGE,
  not_found: EXIT.NOT_FOUND,
  auth_required: EXIT.AUTH,
  timeout: EXIT.TIMEOUT,
  unreachable: EXIT.FAILED,
  not_cli_enabled: EXIT.FAILED,
  edge_auth: EXIT.FAILED,
  conflict: EXIT.FAILED,
  forbidden: EXIT.FAILED,
  precondition: EXIT.FAILED,
};

/** A failure with a one-line, user-facing reason. Never put a token in `message`. */
export class CliError extends Error {
  /**
   * `status` is the HTTP status when the orchestrator (or the edge in front of it) answered;
   * `body` its decoded JSON error, for callers that read more than the message.
   */
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status?: number,
    public readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }

  get exitCode(): ExitCode {
    return EXIT_FOR[this.code];
  }
}

export const usage = (message: string) => new CliError('usage', message);
