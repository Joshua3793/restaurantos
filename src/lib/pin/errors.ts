// Pure — safe to import from routes and tests (no server-only, no I/O).

export type PinErrorStatus = 400 | 401 | 403 | 404 | 409 | 429

/** A PIN sign-in failure the route turns into `{ error }` with this status. */
export class PinError extends Error {
  constructor(
    public readonly status: PinErrorStatus,
    message: string,
  ) {
    super(message)
    this.name = 'PinError'
  }
}
