export type GpsErrorKind =
  /** Options out of range, or a part that needs a host started without one. */
  | "CONFIG"
  /** Bad input from your own code, refused before anything happened: an IMEI that is not 15 digits... */
  | "INVALID"
  /** The TCP listener could not bind (port in use, no permission for a port below 1024). */
  | "LISTEN"
  /** Your host threw. The packet is not acknowledged, so the tracker sends it again. */
  | "HOST";

export class GpsError extends Error {
  constructor(
    readonly kind: GpsErrorKind,
    message: string,
    readonly details: {
      /** A finer reason, safe to log: EADDRINUSE, NOT_ALERT_HOST... */
      code?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "GpsError";
  }
}
