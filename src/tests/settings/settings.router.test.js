import { describe, expect, it } from "@jest/globals";
import request from "supertest";
import app from "../../../app.mjs";

describe("Settings Router Authentication & Validation Contracts", () => {
  it("rejects unauthenticated GET /api/v1/settings/organization with 401", async () => {
    const res = await request(app).get("/api/v1/settings/organization");
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated PUT /api/v1/settings/organization with 401", async () => {
    const res = await request(app).put("/api/v1/settings/organization").send({});
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated GET /api/v1/settings/branches/:branchId with 401", async () => {
    const res = await request(app).get("/api/v1/settings/branches/64abc1234567890123456789");
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated PUT /api/v1/settings/branches/:branchId with 401", async () => {
    const res = await request(app).put("/api/v1/settings/branches/64abc1234567890123456789").send({});
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated GET /api/v1/settings/effective with 401", async () => {
    const res = await request(app).get("/api/v1/settings/effective");
    expect(res.status).toBe(401);
  });
});
