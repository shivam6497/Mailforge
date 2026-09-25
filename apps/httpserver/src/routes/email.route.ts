import { Router } from "express";
import { requireApiKey } from "../middleware/apiKeyAuth.middleware";
import { requireAuth } from "../middleware/auth.middleware";
import { rateLimitByApiKey } from "../middleware/rateLimiter.middleware";
import { sendEmail, listEmails, getEmail } from "../controllers/email.controller";

const router: Router = Router();

router.post("/", requireApiKey, rateLimitByApiKey, sendEmail);
router.get("/:id", (req, res, next) => {
    requireApiKey(req, res, (err) => {
        if(err) return requireAuth;
        next();
    });
}, getEmail);
router.get("/", requireAuth, listEmails);

export default router;