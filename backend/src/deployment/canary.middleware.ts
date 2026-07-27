/**
 * Canary Traffic-Splitting Middleware — Nova Launch
 * Issue: #1350
 *
 * Express-compatible middleware that routes a configurable percentage of
 * incoming requests to the canary version.  The split is decided per-request
 * using a uniform random draw so it matches the configured weight closely over
 * time without requiring sticky sessions.
 *
 * Usage:
 *   import { createCanaryMiddleware } from './canary.middleware';
 *   app.use(createCanaryMiddleware(canaryService));
 */

import type { Request, Response, NextFunction } from 'express';
import { CanaryDeploymentService } from './canary.service';

export interface CanaryMiddlewareOptions {
  /** Header to set when the request is routed to canary. Default: `x-canary`. */
  canaryHeader?: string;
  /** Value written to the canary header. Default: `true`. */
  canaryHeaderValue?: string;
}

/**
 * Returns an Express middleware that:
 *  1. Reads the current canary weight from `canaryService.getWeight()`.
 *  2. If the canary is not in the `observing` stage, passes through unchanged.
 *  3. Otherwise routes `weight%` of traffic to canary by setting a header that
 *     the upstream proxy / load-balancer uses to select the canary backend.
 */
export function createCanaryMiddleware(
  canaryService: CanaryDeploymentService,
  options: CanaryMiddlewareOptions = {},
) {
  const {
    canaryHeader      = 'x-canary',
    canaryHeaderValue = 'true',
  } = options;

  return function canaryMiddleware(req: Request, res: Response, next: NextFunction): void {
    const state = canaryService.getState();

    // Only split traffic while the canary is being observed
    if (state.stage !== 'observing') {
      next();
      return;
    }

    const weight = canaryService.getWeight();

    // weight === 0 means rollback has occurred — skip canary routing
    if (weight <= 0) {
      next();
      return;
    }

    const roll = Math.random() * 100;
    if (roll < weight) {
      req.headers[canaryHeader] = canaryHeaderValue;
      res.setHeader(canaryHeader, canaryHeaderValue);
    }

    next();
  };
}
