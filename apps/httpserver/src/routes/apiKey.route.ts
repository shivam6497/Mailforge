import { Router } from "express";
import { requireAuth } from "../middleware/auth.middleware";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "../controllers/apiKey.controller";

const router: Router = Router();

router.use(requireAuth);

router.post("/", createApiKey);
router.get("/", listApiKeys);
router.delete("/:id", revokeApiKey);

export default router;
