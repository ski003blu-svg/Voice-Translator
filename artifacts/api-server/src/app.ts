import path from "path";
import fs from "fs";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API routes
app.use("/api", router);

// In production, serve the built React frontend from the same server.
// The frontend is built to artifacts/missu/dist/public.
// process.cwd() when running via pnpm --filter @workspace/api-server is artifacts/api-server/.
if (process.env.NODE_ENV === "production") {
  const frontendDist =
    process.env.FRONTEND_DIST ??
    path.join(process.cwd(), "..", "missu", "dist", "public");

  if (fs.existsSync(frontendDist)) {
    logger.info({ frontendDist }, "Serving static frontend");
    app.use(express.static(frontendDist));

    // Catch-all: serve index.html for any non-API route (React Router)
    app.get("*", (_req, res) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
  } else {
    logger.warn({ frontendDist }, "Frontend dist not found — skipping static serving");
  }
}

export default app;
