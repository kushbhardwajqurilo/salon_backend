import mongoose from "mongoose";

const leaveSchema = new mongoose.Schema(
    {
        organizationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Organization",
            required: true,
        },
        branchId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Branch",
            required: true,
        },
        staffId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Staff",
            required: true,
        },
        leaveCode: {
            type: String,
            required: true,
        },
        leaveType: {
            type: String,
            required: true,
            trim: true,
        },
        startDate: {
            type: Date,
            required: true,
        },
        endDate: {
            type: Date,
            required: true,
        },
        dates: {
            type: [String],
            default: [],
        },
        reason: {
            type: String,
            required: true,
            trim: true,
            maxlength: 1000,
        },
        status: {
            type: String,
            enum: ["pending", "approved", "rejected", "cancelled"],
            default: "pending",
            required: true,
        },
        submittedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        submittedFor: {
            type: String,
            enum: ["self", "staff"],
            required: true,
        },
        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        reviewedAt: {
            type: Date,
            default: null,
        },
        reviewNote: {
            type: String,
            trim: true,
            maxlength: 1000,
            default: null,
        },
        cancelledBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        cancelledAt: {
            type: Date,
            default: null,
        },
        cancelReason: {
            type: String,
            trim: true,
            maxlength: 1000,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

// Indexes
leaveSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });
leaveSchema.index({ organizationId: 1, staffId: 1, startDate: 1, endDate: 1 });
leaveSchema.index({ organizationId: 1, branchId: 1, status: 1, createdAt: -1 });
leaveSchema.index(
    { organizationId: 1, leaveCode: 1 },
    { unique: true, partialFilterExpression: { isDeleted: false } }
);
// Canonical concurrency serialization — unique multikey index on covered dates
leaveSchema.index(
    { organizationId: 1, staffId: 1, dates: 1 },
    {
        unique: true,
        partialFilterExpression: {
            isDeleted: false,
            status: { $in: ["pending", "approved"] },
        },
    }
);

export const Leave = mongoose.model("Leave", leaveSchema);