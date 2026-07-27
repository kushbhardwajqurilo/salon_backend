import mongoose from "mongoose";

export const auditPlugin = (schema) => {
  // Add fields
  schema.add({
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  });

  // Enable timestamps if not already present
  if (!schema.options.timestamps) {
    schema.options.timestamps = true;
  }

  // Enable optimistic concurrency (optimistic locking)
  schema.options.optimisticConcurrency = true;

  // Middleware to exclude deleted records from queries
  const queryMethods = [
    "find",
    "findOne",
    "findOneAndUpdate",
    "updateMany",
    "countDocuments",
    "aggregate",
  ];

  function excludeDeleted(next) {
    // If explicitly querying for deleted records or soft delete check is bypassed
    if (this.getFilter && this.getFilter().includeDeleted) {
      delete this.getFilter().includeDeleted;
      if (typeof next === "function") return next();
      return;
    }
    this.where({ isDeleted: { $ne: true } });
    if (typeof next === "function") next();
  }

  queryMethods.forEach((method) => {
    if (method === "aggregate") {
      schema.pre(method, function (next) {
        // Exclude deleted in aggregation pipelines
        this.pipeline().unshift({ $match: { isDeleted: { $ne: true } } });
        if (typeof next === "function") next();
      });
    } else {
      schema.pre(method, excludeDeleted);
    }
  });

  // Instance method for soft delete
  schema.methods.softDelete = async function (userId) {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = userId;
    return this.save();
  };
};
