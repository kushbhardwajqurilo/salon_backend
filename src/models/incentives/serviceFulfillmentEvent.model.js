import mongoose from "mongoose";

const serviceFulfillmentEventSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      immutable: true,
      index: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      immutable: true,
      index: true,
    },
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      required: true,
      immutable: true,
      index: true,
    },
    lineItemId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    confirmedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 1000,
      immutable: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      immutable: true,
    },
    eventTimestamp: {
      type: Date,
      required: true,
      immutable: true,
      default: Date.now,
    },
  },
  { timestamps: true },
);

serviceFulfillmentEventSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true },
);
serviceFulfillmentEventSchema.index(
  { organizationId: 1, invoiceId: 1, lineItemId: 1 },
  { unique: true },
);

export const ServiceFulfillmentEvent = mongoose.model(
  "ServiceFulfillmentEvent",
  serviceFulfillmentEventSchema,
);
