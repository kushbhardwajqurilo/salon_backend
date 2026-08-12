import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { Leave } from "../../models/leaves/leave.model.js";

export class LeaveRepository extends BaseRepository {
    constructor() {
        super(Leave);
    }

    async create(data, organizationId, userId = null, session = null) {
        const doc = new this.model({ ...data, organizationId });
        if (userId) {
            doc.createdBy = userId;
            doc.updatedBy = userId;
        }
        return doc.save({ session });
    }

    async findById(id, organizationId, populate = [], select = null, session = null) {
        let query = this.model.findOne({ _id: id, organizationId });
        if (session) {
            query = query.session(session);
        }
        if (populate.length > 0) {
            query = query.populate(populate);
        }
        if (select) {
            query = query.select(select);
        }
        return query.exec();
    }

    async findByIdIncludeDeleted(id, organizationId, populate = [], select = null) {
        let query = this.model
            .findOne({ _id: id, organizationId })
            .setOptions({ includeDeleted: true });
        if (populate.length > 0) {
            query = query.populate(populate);
        }
        if (select) {
            query = query.select(select);
        }
        return query.exec();
    }

    async findOne(filter, organizationId, populate = [], select = null, session = null) {
        let query = this.model.findOne({ ...filter, organizationId });
        if (session) {
            query = query.session(session);
        }
        if (populate.length > 0) {
            query = query.populate(populate);
        }
        if (select) {
            query = query.select(select);
        }
        return query.exec();
    }

    async updateById(id, data, organizationId, userId = null, session = null) {
        const doc = await this.model.findOne({ _id: id, organizationId }).session(session);
        if (!doc) return null;

        Object.assign(doc, data);
        if (userId) {
            doc.updatedBy = userId;
        }

        return doc.save({ session });
    }

    async deleteById(id, organizationId, userId = null) {
        const doc = await this.model.findOne({ _id: id, organizationId });
        if (!doc) return null;
        return doc.softDelete(userId);
    }

    async find(filter = {}, options = {}, organizationId) {
        const queryFilter = { ...filter };

        // Clean non-schema query parameters from the database query filter
        const nonSchemaKeys = [
            "page",
            "limit",
            "sort",
            "search",
            "searchFields",
            "populate",
            "select",
        ];
        nonSchemaKeys.forEach((key) => delete queryFilter[key]);

        if (organizationId !== undefined) {
            queryFilter.organizationId = organizationId;
        }

        const queryOptions = { ...options };
        if (
            queryOptions.search &&
            (!queryOptions.searchFields || queryOptions.searchFields.length === 0)
        ) {
            queryOptions.searchFields = ["leaveCode", "leaveType", "reason"];
        }

        return super.find(queryFilter, queryOptions);
    }

    async count(filter = {}, organizationId) {
        const queryFilter = { ...filter };
        if (organizationId !== undefined) {
            queryFilter.organizationId = organizationId;
        }
        return super.count(queryFilter);
    }

    /**
     * Deterministic overlap lookup for LeaveService.
     * Finds a blocking (pending/approved, non-deleted) leave for the same
     * staff whose date range intersects the requested range.
     *
     * The `dates` unique multikey index is the authoritative concurrency guard;
     * this query provides a friendly, deterministic validation error path.
     *
     * @param {ObjectId} staffId
     * @param {Date} startDate - requested start (UTC midnight)
     * @param {Date} endDate - requested end (UTC midnight)
     * @param {ObjectId} organizationId
     * @param {ObjectId|null} excludeId - leave id to exclude (on update)
     * @param {Object|null} session - transaction session
     */
    async findOverlapping(
        staffId,
        startDate,
        endDate,
        organizationId,
        excludeId = null,
        session = null
    ) {
        const filter = {
            staffId,
            status: { $in: ["pending", "approved"] },
            startDate: { $lte: endDate },
            endDate: { $gte: startDate },
        };
        if (excludeId) {
            filter._id = { $ne: excludeId };
        }
        return this.findOne(filter, organizationId, [], null, session);
    }
}