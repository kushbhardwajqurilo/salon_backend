import mongoose from "mongoose";

const sequenceSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
    },
    seq: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

sequenceSchema.index({ key: 1 }, { unique: true });

export const Sequence = mongoose.model("Sequence", sequenceSchema);
