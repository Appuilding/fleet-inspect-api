import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import { meRouter } from "./routes/me.js";
import { authRouter } from "./routes/auth.js";
import { sitesRouter } from "./routes/sites.js";
import { assetsRouter } from "./routes/assets.js";
import { operatorsRouter } from "./routes/operators.js";
import { checklistsRouter } from "./routes/checklists.js";
import { sessionsRouter } from "./routes/sessions.js";
import { inspectionsRouter } from "./routes/inspections.js";
import { returnsRouter } from "./routes/returns.js";
import { safetyRouter } from "./routes/safety.js";
import { defectsRouter } from "./routes/defects.js";
import { workOrdersRouter } from "./routes/work_orders.js";
import { tempHoldsRouter } from "./routes/temperature_holds.js";
import { reportsRouter } from "./routes/reports.js";
import { historyRouter } from "./routes/history.js";
import { coachingRouter } from "./routes/coaching.js";
import { notificationsRouter } from "./routes/notifications.js";
import { helpRouter } from "./routes/help.js";
import { syncRouter } from "./routes/sync.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: "*", methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] }));
app.use(express.json({ limit: "10mb" }));
app.use(morgan("tiny"));

// Health check
app.get("/", (req, res) => res.json({
  service: "Feeding Westchester Fleet Inspect API",
  version: "1.0.0",
  status: "ok",
  timestamp: new Date().toISOString(),
}));
app.get("/healthz", (req, res) => res.json({ status: "ok" }));

// API routes (prefix /api/v1)
const api = express.Router();
api.use("/auth", authRouter);
api.use("/me", meRouter);
api.use("/sites", sitesRouter);
api.use("/assets", assetsRouter);
api.use("/operators", operatorsRouter);
api.use("/checklists", checklistsRouter);
api.use("/sessions", sessionsRouter);
api.use("/inspections", inspectionsRouter);
api.use("/returns", returnsRouter);
api.use("/safety-observations", safetyRouter);
api.use("/defects", defectsRouter);
api.use("/work-orders", workOrdersRouter);
api.use("/temperature-holds", tempHoldsRouter);
api.use("/reports", reportsRouter);
api.use("/history", historyRouter);
api.use("/coaching", coachingRouter);
api.use("/notifications", notificationsRouter);
api.use("/help", helpRouter);
api.use("/sync", syncRouter);
app.use("/api/v1", api);

// Error handler
app.use((err, req, res, next) => {
  console.error("❌ API error:", err);
  res.status(err.status || 500).json({
    error: { code: err.code || "internal_error", message: err.message || "Internal server error" },
  });
});

app.listen(PORT, () => {
  console.log(`🚛 Fleet Inspect API listening on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/healthz`);
  console.log(`   API: http://localhost:${PORT}/api/v1`);
});
