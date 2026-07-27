/**
 * GET/PUT /api/admin/treasury/policy
 * Treasury policy endpoints.
 */
import { Router, Request, Response } from 'express';
import { authenticateAdmin } from '../../middleware/auth';
import { successResponse, errorResponse } from '../../utils/response';

const router = Router();

// In-memory store — replace with DB persistence when ready
let treasuryPolicy = { dailyCap: '1000000000' }; // stroops as string (bigint-safe)

router.get('/', authenticateAdmin, (_req: Request, res: Response) => {
  res.json(successResponse({ ...treasuryPolicy, fetchedAt: new Date().toISOString() }));
});

router.put('/', authenticateAdmin, (req: Request, res: Response) => {
  const { dailyCap } = req.body;

  if (typeof dailyCap !== 'string' || !/^\d+$/.test(dailyCap)) {
    return res.status(400).json(
      errorResponse({ code: 'INVALID_REQUEST', message: 'dailyCap must be a non-negative integer string' }),
    );
  }

  treasuryPolicy = { dailyCap };
  res.json(successResponse({ ...treasuryPolicy, updatedAt: new Date().toISOString() }));
});

export default router;
