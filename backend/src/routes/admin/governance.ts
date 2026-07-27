/**
 * GET/PUT /api/admin/governance/timelock
 * Timelock configuration endpoints.
 */
import { Router, Request, Response } from 'express';
import { authenticateAdmin } from '../../middleware/auth';
import { successResponse, errorResponse } from '../../utils/response';

const router = Router();

// In-memory store — replace with DB persistence when ready
let timelockConfig = { minDelay: 3600, maxDelay: 86400 };

router.get('/', authenticateAdmin, (_req: Request, res: Response) => {
  res.json(successResponse({ ...timelockConfig, fetchedAt: new Date().toISOString() }));
});

router.put('/', authenticateAdmin, (req: Request, res: Response) => {
  const { minDelay, maxDelay } = req.body;

  if (typeof minDelay !== 'number' || typeof maxDelay !== 'number') {
    return res.status(400).json(
      errorResponse({ code: 'INVALID_REQUEST', message: 'minDelay and maxDelay must be numbers' }),
    );
  }

  if (minDelay < 0 || maxDelay < minDelay) {
    return res.status(400).json(
      errorResponse({ code: 'INVALID_REQUEST', message: 'maxDelay must be >= minDelay and both non-negative' }),
    );
  }

  timelockConfig = { minDelay, maxDelay };
  res.json(successResponse({ ...timelockConfig, updatedAt: new Date().toISOString() }));
});

export default router;
