import { Router } from "express";
import statsRouter from "./stats";
import tokensRouter from "./tokens";
import usersRouter from "./users";
import auditRouter from "./audit";
import operationalRouter from "./operational";
import backupRouter from "./backup";
import ipfsRouter from "./ipfs";

const router = Router();

router.use("/stats", statsRouter);
router.use("/tokens", tokensRouter);
router.use("/users", usersRouter);
router.use("/audit", auditRouter);
router.use("/audit", auditArchiveRouter);
router.use("/operational", operationalRouter);
router.use("/backup", backupRouter);
router.use("/ipfs", ipfsRouter);

export default router;
