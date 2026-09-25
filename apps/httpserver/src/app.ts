import express, { Express } from "express";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth.route";
import { errorHandler } from "./middleware/error.middleware";
import apiRoutes from "./routes/apiKey.route";
import domainRoutes from "./routes/domain.route";
import emailRoutes from "./routes/email.route";

const app: Express = express();

app.use(express.json());
app.use(cookieParser());

app.use("/auth", authRoutes);
app.use("/api/keys", apiRoutes);
app.use("/api/domains", domainRoutes);
app.use("/api/emails", emailRoutes);

app.use(errorHandler);

export default app;
