/** Defaults to enabled — set VITE_ERROR_REPORTING_ENABLED=false to opt out (e.g. local dev). */
export const ERROR_REPORTING_ENABLED =
  (import.meta.env.VITE_ERROR_REPORTING_ENABLED ?? 'true') !== 'false';
