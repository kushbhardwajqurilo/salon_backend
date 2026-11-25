import express from "express";
import request from "supertest";
import settingsRouter from "../../routers/settings/settings.routes.js";

const app = express();
app.use(express.json());
app.use("/v1/settings", settingsRouter);

describe("Settings Export & Backup Router", () => {
  test("GET /v1/settings/exports rejects unauthenticated requests with 401", async () => {
    const res = await request(app).get("/v1/settings/exports");
    expect(res.status).toBe(401);
  });

  test("POST /v1/settings/exports rejects unauthenticated requests with 401", async () => {
    const res = await request(app)
      .post("/v1/settings/exports")
      .send({ domain: "staff", format: "json" });
    expect(res.status).toBe(401);
  });

  test("GET /v1/settings/backups/status rejects unauthenticated requests with 401", async () => {
    const res = await request(app).get("/v1/settings/backups/status");
    expect(res.status).toBe(401);
  });
});
