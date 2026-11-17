import mongoose from "mongoose";

const staffSnapshotSchema = new mongoose.Schema(
  {
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    name: { type: String, required: true, trim: true },
    staffCode: { type: String, required: true, trim: true },
  },
  { _id: false },
);

export const sourceAttributionSchema = new mongoose.Schema(
  {
    performedBy: { type: staffSnapshotSchema, default: null },
    soldBy: { type: staffSnapshotSchema, default: null },
    renewalHandler: { type: staffSnapshotSchema, default: null },
  },
  { _id: false },
);
