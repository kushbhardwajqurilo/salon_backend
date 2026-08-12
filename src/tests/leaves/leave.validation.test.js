import { describe, test, expect } from "@jest/globals";
import {
    createLeaveSchema,
    updateLeaveSchema,
    queryLeaveSchema,
    approveLeaveSchema,
    rejectLeaveSchema,
    cancelLeaveSchema,
} from "../../validation/leaves/leave.validation.js";

const validObjectId = "64b000000000000000000001";

const validCreateBody = {
    leaveType: "Casual",
    startDate: "2026-09-01",
    endDate: "2026-09-03",
    reason: "Family function",
};

const parse = async (schema, input) => {
    try {
        const result = await schema.parseAsync(input);
        return { ok: true, data: result };
    } catch (err) {
        return { ok: false, error: err };
    }
};

describe("Leaves Phase 3 — createLeaveSchema", () => {
    test("valid request passes (self-service, no staffId)", async () => {
        const { ok, data } = await parse(createLeaveSchema, { body: validCreateBody });
        expect(ok).toBe(true);
        expect(data.body.leaveType).toBe("Casual");
        expect(data.body.startDate).toBe("2026-09-01");
        expect(data.body.endDate).toBe("2026-09-03");
        expect(data.body.staffId).toBeUndefined();
    });

    test("valid request with staffId passes (on-behalf)", async () => {
        const { ok } = await parse(createLeaveSchema, {
            body: { ...validCreateBody, staffId: validObjectId },
        });
        expect(ok).toBe(true);
    });

    test("missing required fields rejected", async () => {
        const { ok, error } = await parse(createLeaveSchema, { body: {} });
        expect(ok).toBe(false);
        expect(error.issues.some((i) => i.path.includes("leaveType"))).toBe(true);
        expect(error.issues.some((i) => i.path.includes("startDate"))).toBe(true);
        expect(error.issues.some((i) => i.path.includes("endDate"))).toBe(true);
        expect(error.issues.some((i) => i.path.includes("reason"))).toBe(true);
    });

    test("invalid ObjectId for staffId rejected", async () => {
        const { ok } = await parse(createLeaveSchema, {
            body: { ...validCreateBody, staffId: "not-an-objectid" },
        });
        expect(ok).toBe(false);
    });

    test("invalid calendar date rejected (2026-02-30)", async () => {
        const { ok } = await parse(createLeaveSchema, {
            body: { ...validCreateBody, startDate: "2026-02-30" },
        });
        expect(ok).toBe(false);
    });

    test("datetime string rejected", async () => {
        const { ok } = await parse(createLeaveSchema, {
            body: { ...validCreateBody, startDate: "2026-09-01T00:00:00.000Z" },
        });
        expect(ok).toBe(false);
    });

    test("reversed dates rejected (endDate < startDate)", async () => {
        const { ok } = await parse(createLeaveSchema, {
            body: { ...validCreateBody, startDate: "2026-09-03", endDate: "2026-09-01" },
        });
        expect(ok).toBe(false);
    });

    test("365-day boundary accepted", async () => {
        const { ok } = await parse(createLeaveSchema, {
            body: { ...validCreateBody, startDate: "2026-01-01", endDate: "2026-12-31" },
        });
        expect(ok).toBe(true);
    });

    test("366-day range rejected (leap year)", async () => {
        const { ok } = await parse(createLeaveSchema, {
            body: { ...validCreateBody, startDate: "2028-01-01", endDate: "2028-12-31" },
        });
        expect(ok).toBe(false);
    });

    test("server-owned fields rejected", async () => {
        const serverOwned = [
            "organizationId",
            "branchId",
            "leaveCode",
            "status",
            "submittedBy",
            "submittedFor",
            "reviewedBy",
            "reviewedAt",
            "reviewNote",
            "cancelledBy",
            "cancelledAt",
            "cancelReason",
        ];
        for (const field of serverOwned) {
            const { ok } = await parse(createLeaveSchema, {
                body: { ...validCreateBody, [field]: "anything" },
            });
            expect(ok).toBe(false);
        }
    });

    test("dates field rejected", async () => {
        const { ok } = await parse(createLeaveSchema, {
            body: { ...validCreateBody, dates: ["2026-09-01"] },
        });
        expect(ok).toBe(false);
    });
});

describe("Leaves Phase 3 — updateLeaveSchema", () => {
    test("valid partial update passes", async () => {
        const { ok } = await parse(updateLeaveSchema, {
            body: { reason: "Updated reason" },
        });
        expect(ok).toBe(true);
    });

    test("status rejected from generic update", async () => {
        const { ok } = await parse(updateLeaveSchema, {
            body: { status: "approved" },
        });
        expect(ok).toBe(false);
    });

    test("staffId rejected from generic update", async () => {
        const { ok } = await parse(updateLeaveSchema, {
            body: { staffId: validObjectId },
        });
        expect(ok).toBe(false);
    });

    test("server-owned fields rejected", async () => {
        const { ok } = await parse(updateLeaveSchema, {
            body: { reviewedBy: validObjectId },
        });
        expect(ok).toBe(false);
    });

    test("dates rejected from update", async () => {
        const { ok } = await parse(updateLeaveSchema, {
            body: { dates: ["2026-09-01"] },
        });
        expect(ok).toBe(false);
    });

    test("reversed dates rejected on update", async () => {
        const { ok } = await parse(updateLeaveSchema, {
            body: { startDate: "2026-09-03", endDate: "2026-09-01" },
        });
        expect(ok).toBe(false);
    });

    test("366-day range rejected on update", async () => {
        const { ok } = await parse(updateLeaveSchema, {
            body: { startDate: "2028-01-01", endDate: "2028-12-31" },
        });
        expect(ok).toBe(false);
    });
});

describe("Leaves Phase 3 — queryLeaveSchema", () => {
    test("valid query passes with defaults", async () => {
        const { ok, data } = await parse(queryLeaveSchema, { query: {} });
        expect(ok).toBe(true);
        expect(data.query.page).toBe(1);
        expect(data.query.limit).toBe(10);
        expect(data.query.sort).toBe("-createdAt");
    });

    test("valid filters pass", async () => {
        const { ok } = await parse(queryLeaveSchema, {
            query: {
                page: 2,
                limit: 25,
                sort: "startDate",
                search: "casual",
                status: "pending",
                staffId: validObjectId,
                startDate: "2026-09-01",
                endDate: "2026-09-30",
            },
        });
        expect(ok).toBe(true);
    });

    test("branchId rejected from query", async () => {
        const { ok } = await parse(queryLeaveSchema, {
            query: { branchId: validObjectId },
        });
        expect(ok).toBe(false);
    });

    test("invalid sort field rejected", async () => {
        const { ok } = await parse(queryLeaveSchema, {
            query: { sort: "hacked" },
        });
        expect(ok).toBe(false);
    });

    test("valid sort with '-' prefix passes", async () => {
        const { ok } = await parse(queryLeaveSchema, {
            query: { sort: "-endDate" },
        });
        expect(ok).toBe(true);
    });

    test("invalid status rejected", async () => {
        const { ok } = await parse(queryLeaveSchema, {
            query: { status: "deleted" },
        });
        expect(ok).toBe(false);
    });

    test("invalid calendar date in query rejected", async () => {
        const { ok } = await parse(queryLeaveSchema, {
            query: { startDate: "2026-02-30" },
        });
        expect(ok).toBe(false);
    });
});

describe("Leaves Phase 3 — approveLeaveSchema", () => {
    test("empty body passes (reviewNote optional)", async () => {
        const { ok } = await parse(approveLeaveSchema, { body: {} });
        expect(ok).toBe(true);
    });

    test("reviewNote passes", async () => {
        const { ok } = await parse(approveLeaveSchema, {
            body: { reviewNote: "Approved" },
        });
        expect(ok).toBe(true);
    });

    test("server-owned fields rejected", async () => {
        const { ok } = await parse(approveLeaveSchema, {
            body: { status: "approved" },
        });
        expect(ok).toBe(false);
    });
});

describe("Leaves Phase 3 — rejectLeaveSchema", () => {
    test("reviewNote required", async () => {
        const { ok } = await parse(rejectLeaveSchema, { body: {} });
        expect(ok).toBe(false);
    });

    test("valid reviewNote passes", async () => {
        const { ok } = await parse(rejectLeaveSchema, {
            body: { reviewNote: "Insufficient coverage" },
        });
        expect(ok).toBe(true);
    });

    test("server-owned fields rejected", async () => {
        const { ok } = await parse(rejectLeaveSchema, {
            body: { reviewNote: "x", reviewedBy: validObjectId },
        });
        expect(ok).toBe(false);
    });
});

describe("Leaves Phase 3 — cancelLeaveSchema", () => {
    test("cancelReason required", async () => {
        const { ok } = await parse(cancelLeaveSchema, { body: {} });
        expect(ok).toBe(false);
    });

    test("valid cancelReason passes", async () => {
        const { ok } = await parse(cancelLeaveSchema, {
            body: { cancelReason: "Plans changed" },
        });
        expect(ok).toBe(true);
    });

    test("server-owned fields rejected", async () => {
        const { ok } = await parse(cancelLeaveSchema, {
            body: { cancelReason: "x", cancelledBy: validObjectId },
        });
        expect(ok).toBe(false);
    });
});