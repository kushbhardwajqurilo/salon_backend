/**
 * Multi-Tenant Authentication & Session Management Harness for E2E Tests
 * Location: backend/tests/e2e/harness/auth.mjs
 *
 * Senior Engineering Architectural Decisions:
 * 1. Token Caching Against Rate Limiter Exhaustion: `authLimiter` enforces a max 100 requests / 15 min
 *    limit on `/api/v1/auth/*`. A 184+ test suite logging in per test breaches this threshold.
 *    Caching in memory by role guarantees minimal authentication calls.
 * 2. Direct In-Memory JWT Minting: Cryptographically signs access tokens with `env.JWT_SECRET`,
 *    allowing instant session synthesis without hitting the network or bcrypt password verification overhead.
 * 3. Dynamic Fixture Synthesis: Resolves seeded roles (owner, manager, staff, customer) or creates
 *    them on demand if missing from database.
 * 4. Ephemeral Multi-Tenant Factory (`createEphemeralTenant`): Dynamically provisions Tenant B
 *    (Organization B, Branch B, User B) to prove that multi-tenant isolation rejects cross-tenant reads/writes.
 */
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { env } from "../../../src/config/env.js";

// In-memory token cache to prevent hitting auth rate limits during test runs
const tokenCache = new Map();

/**
 * Standard Role Enum for E2E Tests
 */
export const TestRoles = Object.freeze({
  OWNER: "owner",
  SUPERADMIN: "owner",
  MANAGER: "manager",
  STAFF: "staff",
  CUSTOMER: "customer",
});

/**
 * Mints a cryptographically valid access token for any user ID and role.
 * Does NOT hit rate limiters or require password hashing.
 *
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.userId
 * @param {string} params.email
 * @param {string} [params.role="owner"]
 * @param {string} [params.expiresIn="2h"]
 * @returns {string} Bearer JWT string
 */
export function mintAccessToken({ userId, email, role = "owner", expiresIn = "2h" }) {
  if (!userId) {
    throw new Error("[E2E Auth Harness] userId is required to mint access token");
  }

  return jwt.sign(
    {
      id: userId.toString(),
      email,
      role: (role || "owner").toLowerCase(),
    },
    env.JWT_SECRET,
    { expiresIn }
  );
}

/**
 * Helper to ensure a Role document exists in the database.
 * @param {string} roleName
 * @param {string} [description=""]
 * @returns {Promise<import("mongoose").Document>}
 */
async function ensureRole(roleName, description = "") {
  const Role = mongoose.model("Role");
  let roleDoc = await Role.findOne({ name: roleName.toLowerCase() });
  if (!roleDoc) {
    roleDoc = await Role.create({
      name: roleName.toLowerCase(),
      description: description || `${roleName} role`,
      isSystem: true,
      permissions: [],
    });
  }
  return roleDoc;
}

/**
 * Generates or retrieves cached session credentials for seeded or synthetic test roles.
 *
 * @param {string} [role=TestRoles.OWNER] - One of TestRoles (owner, manager, staff, customer)
 * @param {Object} [options]
 * @param {boolean} [options.forceFresh=false] - Invalidate cache and fetch/mint fresh session
 * @returns {Promise<{ token: string, user: Object, headers: Object, expiresAt: number }>}
 */
export async function getTestSession(role = TestRoles.OWNER, { forceFresh = false } = {}) {
  const normalizedRole = (role || TestRoles.OWNER).toLowerCase();
  const cacheKey = `role:${normalizedRole}`;

  if (!forceFresh && tokenCache.has(cacheKey)) {
    const cached = tokenCache.get(cacheKey);
    // If still valid for at least 60 seconds, reuse (deep clone to prevent cross-test session pollution)
    if (cached.expiresAt > Date.now() + 60000) {
      return structuredClone(cached);
    }
  }

  const User = mongoose.model("User");
  const Organization = mongoose.model("Organization");
  const Branch = mongoose.model("Branch");

  // Ensure default organization exists
  let org = await Organization.findOne({ name: "Unisex Parlour" });
  if (!org) {
    org = await Organization.create({
      name: "Unisex Parlour",
      isActive: true,
    });
  }

  // Ensure primary test branch exists
  let branch = await Branch.findOne({ organizationId: org._id, name: "Koramangala" });
  if (!branch) {
    branch = await Branch.create({
      organizationId: org._id,
      name: "Koramangala",
      address: "5th Block, Koramangala, Bengaluru",
      phone: "+91 98765 43210",
      isActive: true,
    });
  }

  let user = null;

  if (normalizedRole === "owner" || normalizedRole === "superadmin") {
    user = await User.findOne({ email: "owner@parlour.com" }).populate("role");
    if (!user) {
      const ownerRole = await ensureRole("owner", "Organization administrator");
      user = await User.create({
        name: "Test Owner",
        email: "owner@parlour.com",
        phone: "+919999999999",
        password: "Admin@12345Password",
        role: ownerRole._id,
        organizationId: org._id,
        hasOrgWideAccess: true,
        isVerified: true,
        status: "active",
        branchAccess: [{ branchId: branch._id, branchName: branch.name, isActive: true }],
      });
      user = await User.findById(user._id).populate("role");
    }
  } else if (normalizedRole === "manager") {
    user = await User.findOne({ email: "manager@parlour.com" }).populate("role");
    if (!user) {
      const managerRole = await ensureRole("manager", "Branch manager");
      user = await User.create({
        name: "Test Manager",
        email: "manager@parlour.com",
        phone: "+918888888888",
        password: "Manager@12345Password",
        role: managerRole._id,
        organizationId: org._id,
        hasOrgWideAccess: false,
        isVerified: true,
        status: "active",
        branchAccess: [{ branchId: branch._id, branchName: branch.name, isActive: true }],
      });
      user = await User.findById(user._id).populate("role");
    }
  } else if (normalizedRole === "staff") {
    const staffRole = await ensureRole("staff", "Salon stylist/staff");
    user = await User.findOne({ role: staffRole._id, status: "active" }).populate("role");
    if (!user) {
      const staffUuid = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      user = await User.create({
        name: "Test Staff",
        email: `staff_${Date.now()}_${staffUuid}@parlour.com`,
        phone: `+9197${crypto.randomInt(10000000, 99999999)}`,
        password: "Staff@12345Password",
        role: staffRole._id,
        organizationId: org._id,
        hasOrgWideAccess: false,
        isVerified: true,
        status: "active",
        branchAccess: [{ branchId: branch._id, branchName: branch.name, isActive: true }],
      });
      user = await User.findById(user._id).populate("role");
    }
  } else if (normalizedRole === "customer") {
    const customerRole = await ensureRole("customer", "End customer");
    user = await User.findOne({ role: customerRole._id, status: "active" }).populate("role");
    if (!user) {
      const custUuid = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      user = await User.create({
        name: "Test Customer",
        email: `customer_${Date.now()}_${custUuid}@parlour.com`,
        phone: `+9196${crypto.randomInt(10000000, 99999999)}`,
        password: "Customer@12345Password",
        role: customerRole._id,
        organizationId: org._id,
        hasOrgWideAccess: false,
        isVerified: true,
        status: "active",
        branchAccess: [{ branchId: branch._id, branchName: branch.name, isActive: true }],
      });
      user = await User.findById(user._id).populate("role");
    }
  }

  if (!user) {
    throw new Error(`[E2E Auth Harness] Failed to resolve test user for role '${normalizedRole}'`);
  }

  const token = mintAccessToken({
    userId: user._id,
    email: user.email,
    role: user.role?.name || normalizedRole,
  });

  const session = {
    token,
    user: {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      role: user.role?.name || normalizedRole,
      organizationId: user.organizationId.toString(),
      hasOrgWideAccess: !!user.hasOrgWideAccess,
      branchAccess: user.branchAccess || [],
    },
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Organization-Id": user.organizationId.toString(),
    },
    expiresAt: Date.now() + 2 * 60 * 60 * 1000, // 2 hours
  };

  tokenCache.set(cacheKey, session);
  return structuredClone(session);
}

/**
 * Assembles complete multi-tenant HTTP headers for any test request.
 *
 * @param {Object} [params]
 * @param {string} [params.token] - Explicit token or auto-resolved from role
 * @param {string} [params.role=TestRoles.OWNER] - Role to resolve if token omitted
 * @param {string|mongoose.Types.ObjectId} [params.branchId] - Active branch ID (omitted for org-wide)
 * @param {string|mongoose.Types.ObjectId} [params.organizationId] - Active organization ID
 * @param {string} [params.idempotencyKey] - Optional idempotency key header
 * @returns {Promise<Object>} Request headers object
 */
export async function buildTestHeaders({
  token,
  role = TestRoles.OWNER,
  branchId,
  organizationId,
  idempotencyKey,
} = {}) {
  let authToken = token;
  let effectiveOrgId = organizationId;

  if (!authToken) {
    const session = await getTestSession(role);
    authToken = session.token;
    if (!effectiveOrgId) {
      effectiveOrgId = session.user.organizationId;
    }
  }

  const headers = {
    Authorization: `Bearer ${authToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (effectiveOrgId) {
    headers["X-Organization-Id"] = effectiveOrgId.toString();
  }

  // Only set X-Branch-Id if branchId is provided and not the UI sentinel "all"
  if (branchId && branchId !== "all") {
    headers["X-Branch-Id"] = branchId.toString();
  }

  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  return headers;
}

/**
 * Spawns an isolated secondary tenant environment (Tenant B) to verify cross-tenant isolation invariants.
 * Creates Organization B, Branch B, and an Admin User B in the database.
 *
 * @returns {Promise<{ organizationId: string, branchId: string, token: string, user: Object, branch: Object, organization: Object, headers: Object }>}
 */
export async function createEphemeralTenant() {
  const Organization = mongoose.model("Organization");
  const Branch = mongoose.model("Branch");
  const User = mongoose.model("User");

  const timestamp = Date.now();
  const uuidSnippet = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const randomSuffix = `${timestamp}_${uuidSnippet}`;

  const orgB = await Organization.create({
    name: `Tenant-B-${randomSuffix}`,
    isActive: true,
  });

  const branchPhoneDigits = crypto.randomInt(10000000, 99999999);
  const branchB = await Branch.create({
    organizationId: orgB._id,
    name: `Tenant B Main Branch ${uuidSnippet}`,
    address: "456 Isolation St, Branch B",
    phone: `+9198${branchPhoneDigits}`,
    isActive: true,
  });

  const ownerRole = await ensureRole("owner", "Organization administrator");

  const userPhoneDigits = crypto.randomInt(100000000, 999999999);
  const userB = await User.create({
    name: "Tenant B Admin",
    username: `admin_b_${randomSuffix}`,
    email: `admin_${randomSuffix}@tenantb.com`,
    phone: `+919${userPhoneDigits}`,
    password: "AdminB@Password123!",
    role: ownerRole._id,
    organizationId: orgB._id,
    hasOrgWideAccess: true,
    isVerified: true,
    status: "active",
    branchAccess: [{ branchId: branchB._id, branchName: branchB.name, isActive: true }],
  });

  const tokenB = mintAccessToken({
    userId: userB._id,
    email: userB.email,
    role: "owner",
  });

  const headers = {
    Authorization: `Bearer ${tokenB}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Organization-Id": orgB._id.toString(),
    "X-Branch-Id": branchB._id.toString(),
  };

  return {
    organizationId: orgB._id.toString(),
    branchId: branchB._id.toString(),
    token: tokenB,
    user: userB,
    branch: branchB,
    organization: orgB,
    headers,
  };
}

/**
 * Clears the in-memory token cache.
 */
export function clearTokenCache() {
  tokenCache.clear();
}
