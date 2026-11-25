import { describe, expect, it } from "@jest/globals";
import request from "supertest";
import app from "../../../app.mjs";

describe("Holiday Calendar Router Authentication Contracts", () => {
  it("rejects unauthenticated GET /api/v1/settings/holidays with 401", async () => {
    const res = await request(app).get("/api/v1/settings/holidays");
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated POST /api/v1/settings/holidays with 401", async () => {
    const res = await request(app).post("/api/v1/settings/holidays").send({});
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated PUT /api/v1/settings/holidays/:id with 401", async () => {
    const res = await request(app).put("/api/v1/settings/holidays/64abc1234567890123456789").send({});
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated DELETE /api/v1/settings/holidays/:id with 401", async () => {
    const res = await request(app).delete("/api/v1/settings/holidays/64abc1234567890123456789");
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated GET /api/v1/settings/calendar/resolve with 401", async () => {
    const res = await request(app).get("/api/v1/settings/calendar/resolve");
    expect(res.status).toBe(401);
  });
});
