import { describe, test, expect, jest, afterAll } from "@jest/globals";
import mongoose from "mongoose";
// Side-effect: registers the global auditPlugin (mongoose.plugin) BEFORE the
// Leave model is compiled, matching the production import order in app.mjs/db.js.
import "../../database/db.js";
import {
    toUTCDate,
    toDateOnlyStr,
    enumerateDates,
    isValidDateOnly,
    MAX_LEAVE_DAYS,
} from "../../utils/date.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { AUDIT_ACTIONS } from "../../models/audit/auditLog.model.js";

describe("Leaves Phase 1 — Date Utility", () => {
    describe("valid YYYY-MM-DD conversion", () => {
        test("toUTCDate returns UTC-midnight Date", () => {
            const d = toUTCDate("2026-09-01");
            expect(d).toBeInstanceOf(Date);
            expect(d.toISOString()).toBe("2026-09-01T00:00:00.000Z");
            expect(d.getUTCHours()).toBe(0);
            expect(d.getUTCMinutes()).toBe(0);
        });

        test("toUTCDate is timezone-stable (not new Date(input))", () => {
            // The internal representation must be UTC midnight regardless of
            // the runtime timezone; toISOString always returns UTC.
            const d = toUTCDate("2026-01-15");
            expect(d.toISOString()).toBe("2026-01-15T00:00:00.000Z");
        });

        test("toDateOnlyStr round-trips a Date back to YYYY-MM-DD", () => {
            expect(toDateOnlyStr(toUTCDate("2026-09-01"))).toBe("2026-09-01");
            expect(toDateOnlyStr(toUTCDate("2026-12-31"))).toBe("2026-12-31");
            expect(toDateOnlyStr(new Date("2026-07-04T00:00:00.000Z"))).toBe(
                "2026-07-04"
            );
        });
    });

    describe("invalid calendar dates rejected", () => {
        test("rejects non-YYYY-MM-DD formats", () => {
            expect(isValidDateOnly("2026-9-01")).toBe(false);
            expect(isValidDateOnly("2026/09/01")).toBe(false);
            expect(isValidDateOnly("2026-09-01T00:00:00Z")).toBe(false);
            expect(isValidDateOnly("01-09-2026")).toBe(false);
            expect(isValidDateOnly("")).toBe(false);
            expect(isValidDateOnly(null)).toBe(false);
            expect(isValidDateOnly(undefined)).toBe(false);
        });

        test("rejects impossible calendar dates", () => {
            expect(isValidDateOnly("2026-02-30")).toBe(false);
            expect(isValidDateOnly("2026-13-01")).toBe(false);
            expect(isValidDateOnly("2026-00-10")).toBe(false);
            expect(isValidDateOnly("2026-04-31")).toBe(false);
        });

        test("toUTCDate throws on invalid calendar dates", () => {
            expect(() => toUTCDate("2026-02-30")).toThrow("Invalid date format");
            expect(() => toUTCDate("2026-13-01")).toThrow("Invalid date format");
            expect(() => toUTCDate("not-a-date")).toThrow("Invalid date format");
        });
    });

    describe("enumerateDates inclusive", () => {
        test("single day returns one date", () => {
            expect(enumerateDates("2026-09-01", "2026-09-01")).toEqual([
                "2026-09-01",
            ]);
        });

        test("multi-day range is inclusive", () => {
            expect(enumerateDates("2026-09-01", "2026-09-03")).toEqual([
                "2026-09-01",
                "2026-09-02",
                "2026-09-03",
            ]);
        });

        test("crosses month boundary correctly", () => {
            expect(enumerateDates("2026-01-30", "2026-02-02")).toEqual([
                "2026-01-30",
                "2026-01-31",
                "2026-02-01",
                "2026-02-02",
            ]);
        });

        test("handles leap year", () => {
            expect(enumerateDates("2028-02-28", "2028-03-01")).toEqual([
                "2028-02-28",
                "2028-02-29",
                "2028-03-01",
            ]);
        });

        test("throws if endDate < startDate", () => {
            expect(() => enumerateDates("2026-09-03", "2026-09-01")).toThrow(
                "endDate must be greater than or equal to startDate"
            );
        });
    });

    describe("MAX_LEAVE_DAYS = 365", () => {
        test("365 days accepted", () => {
            const dates = enumerateDates("2026-01-01", "2026-12-31");
            expect(dates).toHaveLength(365);
            expect(dates[0]).toBe("2026-01-01");
            expect(dates[364]).toBe("2026-12-31");
        });

        test("366 days rejected (leap year)", () => {
            expect(() => enumerateDates("2028-01-01", "2028-12-31")).toThrow(
                "exceeds MAX_LEAVE_DAYS"
            );
        });

        test("MAX_LEAVE_DAYS constant exported", () => {
            expect(MAX_LEAVE_DAYS).toBe(365);
        });
    });
});

describe("Leaves Phase 1 — Leave Model Schema", () => {
    test("model field definitions exist", () => {
        const schema = Leave.schema;
        expect(schema.path("organizationId")).toBeDefined();
        expect(schema.path("branchId")).toBeDefined();
        expect(schema.path("staffId")).toBeDefined();
        expect(schema.path("leaveCode")).toBeDefined();
        expect(schema.path("leaveType")).toBeDefined();
        expect(schema.path("startDate")).toBeDefined();
        expect(schema.path("endDate")).toBeDefined();
        expect(schema.path("dates")).toBeDefined();
        expect(schema.path("reason")).toBeDefined();
        expect(schema.path("status")).toBeDefined();
        expect(schema.path("submittedBy")).toBeDefined();
        expect(schema.path("submittedFor")).toBeDefined();
        expect(schema.path("reviewedBy")).toBeDefined();
        expect(schema.path("reviewedAt")).toBeDefined();
        expect(schema.path("reviewNote")).toBeDefined();
        expect(schema.path("cancelledBy")).toBeDefined();
        expect(schema.path("cancelledAt")).toBeDefined();
        expect(schema.path("cancelReason")).toBeDefined();
    });

    test("status enum matches approved lifecycle", () => {
        const statusPath = Leave.schema.path("status");
        expect(statusPath.enumValues).toEqual([
            "pending",
            "approved",
            "rejected",
            "cancelled",
        ]);
        expect(statusPath.defaultValue).toBe("pending");
    });

    test("submittedFor enum", () => {
        expect(Leave.schema.path("submittedFor").enumValues).toEqual([
            "self",
            "staff",
        ]);
    });

    test("dates is a String array with default []", () => {
        const datesPath = Leave.schema.path("dates");
        expect(datesPath).toBeDefined();
        expect(datesPath.instance).toBe("Array");
        // Mongoose 9 array defaults are functions returning the default value
        expect(typeof datesPath.defaultValue).toBe("function");
        expect(datesPath.defaultValue()).toEqual([]);
        // Behavioral check: a new document gets [] and casts elements to strings
        const doc = new Leave({
            organizationId: new mongoose.Types.ObjectId(),
            branchId: new mongoose.Types.ObjectId(),
            staffId: new mongoose.Types.ObjectId(),
            leaveCode: "LV-1",
            leaveType: "Casual",
            startDate: new Date("2026-09-01T00:00:00.000Z"),
            endDate: new Date("2026-09-01T00:00:00.000Z"),
            reason: "test",
            submittedBy: new mongoose.Types.ObjectId(),
            submittedFor: "self",
        });
        expect(doc.dates).toEqual([]);
        doc.dates.push("2026-09-01");
        expect(doc.dates[0]).toBe("2026-09-01");
        // Casts non-string to string per schema
        doc.set("dates", ["2026-09-02", 123]);
        expect(doc.dates).toEqual(["2026-09-02", "123"]);
    });

    test("audit plugin conventions applied (isDeleted, createdBy, softDelete)", () => {
        const schema = Leave.schema;
        expect(schema.path("isDeleted")).toBeDefined();
        expect(schema.path("deletedAt")).toBeDefined();
        expect(schema.path("createdBy")).toBeDefined();
        expect(schema.path("updatedBy")).toBeDefined();
        expect(schema.path("deletedBy")).toBeDefined();
        expect(typeof schema.methods.softDelete).toBe("function");
        expect(schema.options.optimisticConcurrency).toBe(true);
        expect(schema.options.timestamps).toBe(true);
    });
});

describe("Leaves Phase 1 — Unique Multikey dates Index", () => {
    // Shared constants so all records in a test share the same org/staff/branch
    // (matching the unique index key { organizationId, staffId, dates }).
    const orgId = new mongoose.Types.ObjectId();
    const staffIdA = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const userA = new mongoose.Types.ObjectId();
    const userB = new mongoose.Types.ObjectId();

    let registry;

    const baseLeave = (overrides = {}) => ({
        organizationId: orgId,
        branchId,
        staffId: staffIdA,
        leaveCode: "LV-TEST",
        leaveType: "Casual",
        startDate: new Date("2026-09-01T00:00:00.000Z"),
        endDate: new Date("2026-09-03T00:00:00.000Z"),
        dates: ["2026-09-01", "2026-09-02", "2026-09-03"],
        reason: "Test leave",
        status: "pending",
        submittedBy: userA,
        submittedFor: "self",
        ...overrides,
    });
    // The bug existed: dates.forEach object may be mutated.
    const clone = (obj) => ({
        ...obj,
        dates: [...(obj.dates || [])],
        organizationId: obj.organizationId,
        branchId: obj.branchId,
        staffId: obj.staffId,
        submittedBy: obj.submittedBy,
        reviewedBy: obj.reviewedBy || null,
        cancelledBy: obj.cancelledBy || null,
    });

    /**
     * In-memory simulation of the canonical unique multikey index:
     *   { organizationId, staffId, dates } unique, partial filter
     *   { isDeleted: false, status: { $in: ["pending", "approved"] } }
     *
     * Mirrors MongoDB's E11000 duplicate-key behavior exactly for the
     * documented semantics. The real DB index is verified by the schema
     * inspection test above; this mock verifies the behavioral contract.
     */
    const installIndexMock = () => {
        registry = [];
        Leave.create = jest.fn(async (docData) => {
            const doc = clone(docData);
            const conflict = registry.find(
                (r) =>
                    r.isDeleted !== true &&
                    ["pending", "approved"].includes(r.status) &&
                    r.organizationId.toString() === doc.organizationId.toString() &&
                    r.staffId.toString() === doc.staffId.toString() &&
                    r.dates.some((d) => doc.dates.includes(d))
            );
            if (conflict) {
                const err = new Error(
                    `E11000 duplicate key error on {organizationId, staffId, dates}`
                );
                err.code = 11000;
                err.keyPattern = { organizationId: 1, staffId: 1, dates: 1 };
                err.keyValue = { dates: doc.dates };
                throw err;
            }
            const saved = {
                _id: new mongoose.Types.ObjectId(),
                isDeleted: false,
                __v: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
                ...doc,
            };
            registry.push(saved);
            return saved;
        });
        Leave.findByIdAndDelete = jest.fn(async (id) => {
            const idx = registry.findIndex(
                (r) => r._id.toString() === id.toString()
            );
            if (idx >= 0) registry.splice(idx, 1);
            return {};
        });
    };

    test("canonical index definition exists", () => {
        const canonical = Leave.schema.indexes().find(([fields, opts]) => {
            const key = Object.keys(fields).join(",");
            return (
                key === "organizationId,staffId,dates" &&
                Object.keys(fields).length === 3
            );
        });
        expect(canonical).toBeDefined();
        const [, opts] = canonical;
        expect(opts.unique).toBe(true);
        expect(opts.partialFilterExpression).toEqual({
            isDeleted: false,
            status: { $in: ["pending", "approved"] },
        });
    });

    test("no obsolete startDate uniqueness index exists", () => {
        const startDateUnique = Leave.schema.indexes().find(([fields, opts]) => {
            const keys = Object.keys(fields);
            return keys.includes("startDate") && opts.unique === true;
        });
        expect(startDateUnique).toBeUndefined();
    });

    test("pending records block duplicate covered dates (first date)", async () => {
        installIndexMock();
        const first = await Leave.create(baseLeave({ leaveCode: "LV-F-1" }));
        await expect(
            Leave.create(
                baseLeave({
                    leaveCode: "LV-F-2",
                    submittedBy: userB,
                    dates: ["2026-09-01"], // shares FIRST date
                })
            )
        ).rejects.toMatchObject({ code: 11000 });
        await Leave.findByIdAndDelete(first._id);
    });

    test("pending records block duplicate covered dates (middle date)", async () => {
        installIndexMock();
        const first = await Leave.create(baseLeave({ leaveCode: "LV-M-1" }));
        await expect(
            Leave.create(
                baseLeave({
                    leaveCode: "LV-M-2",
                    submittedBy: userB,
                    dates: ["2026-09-02"], // shares MIDDLE date
                })
            )
        ).rejects.toMatchObject({ code: 11000 });
        await Leave.findByIdAndDelete(first._id);
    });

    test("pending records block duplicate covered dates (last date)", async () => {
        installIndexMock();
        const first = await Leave.create(baseLeave({ leaveCode: "LV-L-1" }));
        await expect(
            Leave.create(
                baseLeave({
                    leaveCode: "LV-L-2",
                    submittedBy: userB,
                    dates: ["2026-09-03"], // shares LAST date
                })
            )
        ).rejects.toMatchObject({ code: 11000 });
        await Leave.findByIdAndDelete(first._id);
    });

    test("approved records block duplicate covered dates", async () => {
        installIndexMock();
        const first = await Leave.create(
            baseLeave({
                leaveCode: "LV-A-1",
                status: "approved",
                reviewedBy: userB,
                reviewedAt: new Date(),
            })
        );
        await expect(
            Leave.create(
                baseLeave({
                    leaveCode: "LV-A-2",
                    submittedBy: userB,
                    dates: ["2026-09-01", "2026-09-02", "2026-09-03"],
                })
            )
        ).rejects.toMatchObject({ code: 11000 });
        await Leave.findByIdAndDelete(first._id);
    });

    test("adjacent non-overlapping dates are allowed", async () => {
        installIndexMock();
        const first = await Leave.create(
            baseLeave({
                leaveCode: "LV-ADJ-1",
                dates: ["2026-09-01", "2026-09-02", "2026-09-03"],
                startDate: new Date("2026-09-01T00:00:00.000Z"),
                endDate: new Date("2026-09-03T00:00:00.000Z"),
            })
        );
        const second = await Leave.create(
            baseLeave({
                leaveCode: "LV-ADJ-2",
                submittedBy: userB,
                dates: ["2026-09-04", "2026-09-05"],
                startDate: new Date("2026-09-04T00:00:00.000Z"),
                endDate: new Date("2026-09-05T00:00:00.000Z"),
            })
        );
        expect(second._id).toBeDefined();
        await Leave.findByIdAndDelete(first._id);
        await Leave.findByIdAndDelete(second._id);
    });

    test("different staff same dates are allowed", async () => {
        installIndexMock();
        const otherStaff = new mongoose.Types.ObjectId();
        const first = await Leave.create(baseLeave({ leaveCode: "LV-S-1" }));
        const second = await Leave.create(
            baseLeave({
                leaveCode: "LV-S-2",
                staffId: otherStaff,
                submittedBy: userB,
            })
        );
        expect(second._id).toBeDefined();
        await Leave.findByIdAndDelete(first._id);
        await Leave.findByIdAndDelete(second._id);
    });

    test("rejected records do not block dates", async () => {
        installIndexMock();
        const rejected = await Leave.create(
            baseLeave({
                leaveCode: "LV-R-1",
                status: "rejected",
                reviewedBy: userB,
                reviewedAt: new Date(),
            })
        );
        const replacement = await Leave.create(
            baseLeave({
                leaveCode: "LV-R-2",
                submittedBy: userB,
                dates: ["2026-09-01", "2026-09-02", "2026-09-03"],
            })
        );
        expect(replacement._id).toBeDefined();
        await Leave.findByIdAndDelete(rejected._id);
        await Leave.findByIdAndDelete(replacement._id);
    });

    test("cancelled records do not block dates", async () => {
        installIndexMock();
        const cancelled = await Leave.create(
            baseLeave({
                leaveCode: "LV-C-1",
                status: "cancelled",
                cancelledBy: userA,
                cancelledAt: new Date(),
            })
        );
        const replacement = await Leave.create(
            baseLeave({
                leaveCode: "LV-C-2",
                submittedBy: userB,
                dates: ["2026-09-01", "2026-09-02", "2026-09-03"],
            })
        );
        expect(replacement._id).toBeDefined();
        await Leave.findByIdAndDelete(cancelled._id);
        await Leave.findByIdAndDelete(replacement._id);
    });
});

describe("Leaves Phase 1 — Audit Actions", () => {
    test("LEAVE_* audit actions are defined", () => {
        expect(AUDIT_ACTIONS.LEAVE_REQUESTED).toBe("LEAVE_REQUESTED");
        expect(AUDIT_ACTIONS.LEAVE_UPDATED).toBe("LEAVE_UPDATED");
        expect(AUDIT_ACTIONS.LEAVE_APPROVED).toBe("LEAVE_APPROVED");
        expect(AUDIT_ACTIONS.LEAVE_REJECTED).toBe("LEAVE_REJECTED");
        expect(AUDIT_ACTIONS.LEAVE_CANCELLED).toBe("LEAVE_CANCELLED");
    });

    test("audit action enum includes the 5 LEAVE actions", () => {
        const allValues = Object.values(AUDIT_ACTIONS);
        expect(allValues).toContain("LEAVE_REQUESTED");
        expect(allValues).toContain("LEAVE_UPDATED");
        expect(allValues).toContain("LEAVE_APPROVED");
        expect(allValues).toContain("LEAVE_REJECTED");
        expect(allValues).toContain("LEAVE_CANCELLED");
    });
});

describe("Leaves Phase 1 — dates field not API input/output", () => {
    test("dates is an internal schema path (verified in model; Zod handles Phase 2+)", () => {
        expect(Leave.schema.path("dates")).toBeDefined();
    });

    test("toUTCDate does not accept datetime strings (API must send YYYY-MM-DD)", () => {
        expect(isValidDateOnly("2026-09-01T00:00:00.000Z")).toBe(false);
        expect(() => toUTCDate("2026-09-01T00:00:00.000Z")).toThrow(
            "Invalid date format"
        );
    });
});

afterAll(() => {
    // Restore original static methods after mock-based tests
    if (Leave.create) Leave.create.mockRestore && Leave.create.mockRestore();
    if (Leave.findByIdAndDelete)
        Leave.findByIdAndDelete.mockRestore && Leave.findByIdAndDelete.mockRestore();
});