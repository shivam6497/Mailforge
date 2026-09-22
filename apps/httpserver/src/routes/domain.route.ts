import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import {
  addDomains,
  getDomain,
  listDomains,
  deleteDomain,
} from "../controllers/domain.controller";

const router: Router = Router();

router.use(requireAuth);

router.post("/", addDomains);
router.get("/", listDomains);
router.get("/:id", getDomain);
router.delete("/:id", deleteDomain);

export default router;
