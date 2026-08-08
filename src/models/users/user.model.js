import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { normalizeUsername } from "../../utils/userIdentity.js";

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    username: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
    },
    role: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
      required: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    hasOrgWideAccess: {
      type: Boolean,
      default: false,
    },
    branchAccess: [
      {
        branchId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Branch",
          required: true,
        },
        branchName: {
          type: String,
          required: true,
        },
        isActive: {
          type: Boolean,
          default: true,
        },
      },
    ],
    isVerified: {
      type: Boolean,
      default: false,
    },
    isFirstLogin: {
      type: Boolean,
      default: false,
    },
    emailVerificationToken: {
      type: String,
      default: null,
    },
    emailVerificationExpires: {
      type: Date,
      default: null,
    },
    otp: {
      type: String,
      default: null,
    },
    otpExpires: {
      type: Date,
      default: null,
    },
    otpAttempts: {
      type: Number,
      default: 0,
    },
    otpResendUntil: {
      type: Date,
      default: null,
    },
    passwordResetToken: {
      type: String,
      default: null,
    },
    passwordResetExpires: {
      type: Date,
      default: null,
    },
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },
    lockUntil: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["active", "suspended", "locked", "inactive"],
      default: "active",
    },
    refreshToken: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

userSchema.index({ email: 1 }, { unique: true, sparse: true });
userSchema.index({ phone: 1 }, { unique: true, sparse: true });
userSchema.index(
  { organizationId: 1, username: 1 },
  {
    unique: true,
    partialFilterExpression: {
      username: { $type: "string" },
    },
  },
);

userSchema.pre("save", async function () {
  if (!this.username && this.name) {
    this.username = normalizeUsername(this.name);
  }

  if (this.username) {
    this.username = normalizeUsername(this.username);
  }

  if (!this.isModified("password")) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

export const User = mongoose.model("User", userSchema);
