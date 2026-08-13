import mongoose from "mongoose";

const appointmentServiceSnapshotSchema = new mongoose.Schema(
  {
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service", required: true },
    name: { type: String, required: true, trim: true },
    duration: { type: Number, required: true, min: 1 }, // positive integer in minutes
    price: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, required: true, min: 0, default: 0 },
    taxAmount: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const appointmentSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    appointmentCode: { type: String, required: true, trim: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null, index: true },
    services: { type: [appointmentServiceSnapshotSchema], required: true },

    // Authoritative Canonical UTC Instants
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, required: true, index: true },

    // Server-derived Denormalized Presentation Fields (interpreted in Branch Timezone)
    appointmentDate: { type: String, required: true }, // "YYYY-MM-DD"
    startTime: { type: String, required: true }, // "HH:mm"
    endTime: { type: String, required: true }, // "HH:mm"
    totalDuration: { type: Number, required: true }, // Sum of service durations (minutes)

    // Concurrency Serialization Buckets (1-minute ISO resolution)
    slotMinutes: { type: [String], default: [] },

    status: {
      type: String,
      enum: ["scheduled", "in_progress", "completed", "cancelled", "no_show"],
      default: "scheduled",
      required: true,
      index: true
    },
    completedAt: { type: Date, default: null },

    bookingType: { type: String, enum: ["advance", "walk_in"], required: true },
    pricing: {
      subtotal: { type: Number, required: true, min: 0 },
      discount: { type: Number, default: 0, min: 0 },
      tax: { type: Number, required: true, min: 0 },
      total: { type: Number, required: true, min: 0 }
    },
    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    cancellation: {
      cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      cancelledAt: { type: Date, default: null },
      reason: { type: String, trim: true, maxlength: 1000, default: null }
    },
    reminder: {
      enabled: { type: Boolean, default: true },
      channel: { type: String, enum: ["email", "sms", "both"], default: "sms" },
      offsetMinutes: { type: Number, default: 60, min: 5 }, // Default 60 mins before start
      sendAt: { type: Date, default: null }, // Calculated UTC Date instant
      status: {
        type: String,
        enum: ["pending", "scheduled", "sent", "partial_delivery", "failed", "cancelled"],
        default: "pending"
      },
      sentAt: { type: Date, default: null },
      failedAt: { type: Date, default: null },
      failureReason: { type: String, default: null },
      email: {
        status: { type: String, enum: ["pending", "scheduled", "processing", "sent", "failed", "cancelled"], default: "pending" },
        sentAt: { type: Date, default: null },
        failedAt: { type: Date, default: null },
        failureReason: { type: String, default: null }
      },
      sms: {
        status: { type: String, enum: ["pending", "scheduled", "processing", "sent", "failed", "cancelled"], default: "pending" },
        sentAt: { type: Date, default: null },
        failedAt: { type: Date, default: null },
        failureReason: { type: String, default: null }
      }
    },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// Indexes
appointmentSchema.index({ organizationId: 1, branchId: 1, startAt: 1 });
appointmentSchema.index(
  { organizationId: 1, appointmentCode: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

// Multikey Covered Minute Bucket Concurrency Index
appointmentSchema.index(
  { organizationId: 1, staffId: 1, slotMinutes: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      status: { $in: ["scheduled", "in_progress"] },
      staffId: { $type: "objectId" }
    }
  }
);

appointmentSchema.set("toJSON", {
  transform: (doc, ret) => {
    ret.id = ret._id.toString();
    delete ret.__v;
    return ret;
  },
});

export const Appointment = mongoose.model("Appointment", appointmentSchema);
