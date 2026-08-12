import { describe, test, expect, jest, beforeAll, afterAll } from "@jest/globals";
import mongoose from "mongoose";
// Side-effect: registers the global auditPlugin BEFORE the Leave model compiles.
import "../../database/db.js";
import { LeaveRepository } from "../../repositories/leaves/leave.repository.js";
import { Leave } from "../../models/leaves/leave.model.js";

describe("Leaves Phase 2 — LeaveRepository", () => {
    let repo;
    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();
    const staffId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    const createQueryMock = (resolvedValue) => ({
        populate: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        session: jest.fn().mockReturnThis(),
        setOptions: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(resolvedValue),
        then: function (onResolve, onReject) {
            return Promise.resolve(resolvedValue).then(onResolve, onReject);
        },
    });

    beforeAll(() => {
        repo = new LeaveRepository();
    });

    afterAll(() => {
        jest.restoreAllMocks();
    });

    describe("tenant isolation", () => {
        test("create injects organizationId from server context, never from data", async () => {
            // save resolves `this` (the actual document) so the returned doc
            // carries the real schema state after construction.
            Leave.prototype.save = jest.fn(function () {
                return Promise.resolve(this);
            });
            const doc = await repo.create(
                { staffId, branchId, leaveCode: "LV-1", organizationId: orgB }, // client-supplied org ignored
                orgA,
                userId
            );
            expect(doc.organizationId.toString()).toBe(orgA.toString());
            expect(doc.organizationId.toString()).not.toBe(orgB.toString());
            expect(doc.createdBy.toString()).toBe(userId.toString());
            expect(doc.updatedBy.toString()).toBe(userId.toString());
            // Mongoose 9 normalizes a missing session option to `{ session: null }`.
            // The important contract is that no user-supplied organizationId is
            // present and the server-derived orgA was injected instead.
            expect(Leave.prototype.save.mock.calls[0][0]).toEqual({ session: null });
        });

        test("findById scopes query to organizationId", async () => {
            const id = new mongoose.Types.ObjectId();
            const query = createQueryMock({ _id: id });
            Leave.findOne = jest.fn().mockReturnValue(query);
            await repo.findById(id, orgA);
            expect(Leave.findOne).toHaveBeenCalledWith({ _id: id, organizationId: orgA });
        });

        test("findByIdIncludeDeleted scopes query to organizationId and includes deleted", async () => {
            const id = new mongoose.Types.ObjectId();
            const query = createQueryMock({ _id: id });
            Leave.findOne = jest.fn().mockReturnValue(query);
            await repo.findByIdIncludeDeleted(id, orgA);
            expect(Leave.findOne).toHaveBeenCalledWith({ _id: id, organizationId: orgA });
            expect(query.setOptions).toHaveBeenCalledWith({ includeDeleted: true });
        });

        test("findOne injects organizationId into filter", async () => {
            const query = createQueryMock({ _id: "leave-1" });
            Leave.findOne = jest.fn().mockReturnValue(query);
            await repo.findOne({ staffId, status: "pending" }, orgA);
            expect(Leave.findOne).toHaveBeenCalledWith({
                staffId,
                status: "pending",
                organizationId: orgA,
            });
        });

        test("updateById scopes query to organizationId", async () => {
            const id = new mongoose.Types.ObjectId();
            const doc = { save: jest.fn().mockResolvedValue({ _id: id }) };
            const query = createQueryMock(doc);
            Leave.findOne = jest.fn().mockReturnValue(query);
            await repo.updateById(id, { reason: "updated" }, orgA, userId);
            expect(Leave.findOne).toHaveBeenCalledWith({ _id: id, organizationId: orgA });
            expect(doc.reason).toBe("updated");
            expect(doc.updatedBy).toBe(userId);
        });

        test("deleteById scopes query to organizationId and soft-deletes", async () => {
            const id = new mongoose.Types.ObjectId();
            const softDelete = jest.fn().mockResolvedValue({ _id: id });
            const query = createQueryMock({ _id: id, softDelete });
            Leave.findOne = jest.fn().mockReturnValue(query);
            await repo.deleteById(id, orgA, userId);
            expect(Leave.findOne).toHaveBeenCalledWith({ _id: id, organizationId: orgA });
            expect(softDelete).toHaveBeenCalledWith(userId);
        });

        test("find injects organizationId and strips non-schema keys", async () => {
            const superFind = jest
                .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(repo)), "find")
                .mockResolvedValue({ data: [], meta: {} });
            await repo.find(
                { status: "pending", page: 2, limit: 5, sort: "-createdAt", search: "x" },
                { page: 2, limit: 5, sort: "-createdAt", search: "x" },
                orgA
            );
            const [filter, options] = superFind.mock.calls[0];
            expect(filter.organizationId).toBe(orgA);
            expect(filter.status).toBe("pending");
            // non-schema keys stripped from the DB filter
            expect(filter.page).toBeUndefined();
            expect(filter.limit).toBeUndefined();
            expect(filter.sort).toBeUndefined();
            expect(filter.search).toBeUndefined();
            // default searchFields applied when search present
            expect(options.searchFields).toEqual(["leaveCode", "leaveType", "reason"]);
            superFind.mockRestore();
        });

        test("count injects organizationId", async () => {
            const superCount = jest
                .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(repo)), "count")
                .mockResolvedValue(3);
            await repo.count({ status: "pending" }, orgA);
            expect(superCount).toHaveBeenCalledWith({
                status: "pending",
                organizationId: orgA,
            });
            superCount.mockRestore();
        });
    });

    describe("findOverlapping", () => {
        test("builds blocking-status date-range intersection filter", async () => {
            const start = new Date("2026-09-01T00:00:00.000Z");
            const end = new Date("2026-09-03T00:00:00.000Z");
            const query = createQueryMock({ _id: "overlap" });
            Leave.findOne = jest.fn().mockReturnValue(query);
            const result = await repo.findOverlapping(staffId, start, end, orgA);
            expect(Leave.findOne).toHaveBeenCalledWith({
                staffId,
                status: { $in: ["pending", "approved"] },
                startDate: { $lte: end },
                endDate: { $gte: start },
                organizationId: orgA,
            });
            expect(result._id).toBe("overlap");
        });

        test("excludes self on update via excludeId", async () => {
            const start = new Date("2026-09-01T00:00:00.000Z");
            const end = new Date("2026-09-03T00:00:00.000Z");
            const excludeId = new mongoose.Types.ObjectId();
            const query = createQueryMock(null);
            Leave.findOne = jest.fn().mockReturnValue(query);
            await repo.findOverlapping(staffId, start, end, orgA, excludeId);
            expect(Leave.findOne).toHaveBeenCalledWith({
                staffId,
                status: { $in: ["pending", "approved"] },
                startDate: { $lte: end },
                endDate: { $gte: start },
                _id: { $ne: excludeId },
                organizationId: orgA,
            });
        });

        test("passes session through to findOne", async () => {
            const start = new Date("2026-09-01T00:00:00.000Z");
            const end = new Date("2026-09-03T00:00:00.000Z");
            const session = { startTransaction: jest.fn() };
            const query = createQueryMock(null);
            Leave.findOne = jest.fn().mockReturnValue(query);
            await repo.findOverlapping(staffId, start, end, orgA, null, session);
            expect(query.session).toHaveBeenCalledWith(session);
        });
    });
});