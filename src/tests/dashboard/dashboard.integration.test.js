import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import app from "../../../app.mjs";
import { redis } from "../../utils/redis.js";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { User } from "../../models/users/user.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { Appointment } from "../../models/appointments/appointment.model.js";
import { Customer } from "../../models/customers/customer.model.js";
import { Product } from "../../models/inventory/product.model.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { StaffBranch } from "../../models/staff/staffBranch.model.js";
import { Attendance } from "../../models/attendance/attendance.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { CANONICAL_PERMISSIONS } from "../../config/permissions.js";

// Mock redis get/setex to eliminate redis dependency in tests
jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Dashboard Module Integration Test Suite", () => {
  jest.setTimeout(45000);

  let dbUri;
  let organization;
  let otherOrg;
  let branch1;
  let branch2;
  let otherOrgBranch;

  let ownerRole, managerRole, restrictedRole, receptionistRole;
  let ownerUser, managerUser, restrictedUser, receptionistUser;
  let ownerToken, managerToken, restrictedToken, receptionistToken;

  let stylistStaff;
  let testCustomer;
  let testService;
  let testProduct;

  beforeAll(async () => {
    dbUri = getIsolatedTestMongoUri("dashboard_test");
    await mongoose.connect(dbUri);

    // 1. Setup Organizations
    organization = await Organization.create({
      name: "Salon Premium Corp",
      slug: `salon-corp-${Date.now()}`,
    });

    otherOrg = await Organization.create({
      name: "Other Salon Corp",
      slug: `other-corp-${Date.now()}`,
    });

    // 2. Setup Branches
    branch1 = await Branch.create({
      name: "Downtown Branch",
      organizationId: organization._id,
      timezone: "Asia/Kolkata",
      isActive: true,
    });

    branch2 = await Branch.create({
      name: "Uptown Branch",
      organizationId: organization._id,
      timezone: "Asia/Kolkata",
      isActive: true,
    });

    otherOrgBranch = await Branch.create({
      name: "Rival Branch",
      organizationId: otherOrg._id,
      timezone: "Asia/Kolkata",
      isActive: true,
    });

    // 3. Setup Staff Profiles
    stylistStaff = await Staff.create({
      organizationId: organization._id,
      name: "Elena Master Stylist",
      staffCode: "STF-DASH-1",
      email: `elena-${Date.now()}@salon.com`,
      phone: "+91 9876543210",
      designation: "Master Stylist",
      joiningDate: new Date("2024-01-01"),
      status: "active",
    });

    await StaffBranch.create({
      staffId: stylistStaff._id,
      branchId: branch1._id,
      organizationId: organization._id,
      isActive: true,
      isPrimary: true,
    });

    // 4. Setup Test Customer
    testCustomer = await Customer.create({
      name: "Sophia Client",
      email: `sophia-${Date.now()}@client.com`,
      phone: "+91 9123456789",
      organizationId: organization._id,
      homeBranchId: branch1._id,
      status: "active",
    });

    // 5. Setup Test Service Category & Service
    const testCategory = await mongoose.model("ServiceCategory").create({
      name: "Hair Treatments",
      organizationId: organization._id,
    });

    testService = await Service.create({
      name: "Signature Balayage",
      duration: 90,
      categoryId: testCategory._id,
      pricing: {
        basePrice: 3500,
      },
      organizationId: organization._id,
      isActive: true,
    });

    // 6. Setup Test Product & Stock Balance
    testProduct = await Product.create({
      name: "Luxury Keratin Shampoo",
      sku: `SHAMP-${Date.now()}`,
      category: "Haircare",
      usageType: "both",
      stockUnit: "bottle",
      costPrice: 500,
      sellingPrice: 1200,
      reorderLevel: 5,
      organizationId: organization._id,
      status: "active",
    });

    await StockBalance.create({
      organizationId: organization._id,
      branchId: branch1._id,
      productId: testProduct._id,
      onHand: 2, // Below reorder level (5) -> triggers low stock alert!
      onHandConsumables: 1,
      onHandRetail: 1,
      allocated: 0,
    });

    // 7. Canonical Permissions
    const dbPerms = [];
    for (const p of CANONICAL_PERMISSIONS) {
      let perm = await Permission.findOne({ name: p.name });
      if (!perm) {
        perm = await Permission.create(p);
      }
      dbPerms.push(perm);
    }

    // 8. Setup Roles
    // Owner: All permissions
    ownerRole = await Role.create({
      name: `dash-owner-${Date.now()}`,
      organizationId: organization._id,
      isSystem: true,
      permissions: dbPerms.map((p) => p._id),
    });

    // Manager: dashboard.view, billing.view, appointments.view, customers.view (NO finance.view, NO inventory.view)
    const managerPermIds = dbPerms
      .filter((p) =>
        ["dashboard.view", "billing.view", "payments.view", "appointments.view", "customers.view"].includes(
          p.name
        )
      )
      .map((p) => p._id);

    managerRole = await Role.create({
      name: `dash-mgr-${Date.now()}`,
      organizationId: organization._id,
      isSystem: false,
      permissions: managerPermIds,
    });

    // Restricted Role: NO dashboard.view
    const restrictedPermIds = dbPerms
      .filter((p) => ["appointments.view"].includes(p.name))
      .map((p) => p._id);

    restrictedRole = await Role.create({
      name: `dash-restr-${Date.now()}`,
      organizationId: organization._id,
      isSystem: false,
      permissions: restrictedPermIds,
    });

    // 9. Setup Users & Tokens
    ownerUser = await User.create({
      name: "Owner User",
      username: `owner-${Date.now()}`,
      email: `owner-${Date.now()}@salon.com`,
      phone: `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`,
      password: "Password123!",
      role: ownerRole._id,
      organizationId: organization._id,
      hasOrgWideAccess: true,
      status: "active",
      branchAccess: [
        { branchId: branch1._id, branchName: branch1.name, isActive: true },
        { branchId: branch2._id, branchName: branch2.name, isActive: true },
      ],
    });

    managerUser = await User.create({
      name: "Manager User",
      username: `mgr-${Date.now()}`,
      email: `mgr-${Date.now()}@salon.com`,
      phone: `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`,
      password: "Password123!",
      role: managerRole._id,
      organizationId: organization._id,
      hasOrgWideAccess: false,
      status: "active",
      branchAccess: [{ branchId: branch1._id, branchName: branch1.name, isActive: true }],
    });

    restrictedUser = await User.create({
      name: "Restricted Stylist",
      username: `stylist-${Date.now()}`,
      email: `stylist-${Date.now()}@salon.com`,
      phone: `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`,
      password: "Password123!",
      role: restrictedRole._id,
      organizationId: organization._id,
      hasOrgWideAccess: false,
      status: "active",
      branchAccess: [{ branchId: branch1._id, branchName: branch1.name, isActive: true }],
    });

    // Receptionist Role: dashboard.view, appointments.view, billing.view, customers.view (NO finance, NO inventory, NO payroll, NO procurement)
    const receptionistPermIds = dbPerms
      .filter((p) =>
        ["dashboard.view", "appointments.view", "billing.view", "customers.view"].includes(p.name)
      )
      .map((p) => p._id);

    receptionistRole = await Role.create({
      name: `dash-recept-${Date.now()}`,
      organizationId: organization._id,
      isSystem: false,
      permissions: receptionistPermIds,
    });

    receptionistUser = await User.create({
      name: "Front Desk Receptionist",
      username: `recept-${Date.now()}`,
      email: `recept-${Date.now()}@salon.com`,
      phone: `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`,
      password: "Password123!",
      role: receptionistRole._id,
      organizationId: organization._id,
      hasOrgWideAccess: false,
      status: "active",
      branchAccess: [{ branchId: branch1._id, branchName: branch1.name, isActive: true }],
    });

    const jwtSecret = process.env.JWT_SECRET || "test-jwt-secret-key-salon-erp";
    ownerToken = jwt.sign({ id: ownerUser._id.toString() }, jwtSecret);
    managerToken = jwt.sign({ id: managerUser._id.toString() }, jwtSecret);
    restrictedToken = jwt.sign({ id: restrictedUser._id.toString() }, jwtSecret);
    receptionistToken = jwt.sign({ id: receptionistUser._id.toString() }, jwtSecret);

    // 10. Seed Core Financial & Appointment Data
    // A. Finalized Invoice: ₹3,500 payable, paid ₹2,000, due ₹1,500
    const invoice1 = await Invoice.create({
      organizationId: organization._id,
      branchId: branch1._id,
      invoiceNumber: `INV-DASH-${Date.now()}-1`,
      invoiceType: "appointment",
      customerId: testCustomer._id,
      customerSnapshot: {
        name: testCustomer.name,
        phone: testCustomer.phone,
        email: testCustomer.email,
      },
      lines: [
        {
          lineType: "service",
          serviceType: "registered",
          serviceId: testService._id,
          name: testService.name,
          quantity: 1,
          unitPrice: 3500,
          lineTotal: 3500,
          customerPayable: 3500,
          discountAmount: 0,
        },
      ],
      subtotal: 3500,
      discountTotal: 0,
      grossPayable: 3500,
      payableAmount: 3500,
      amountPaid: 2000,
      amountDue: 1500,
      status: "finalized",
      paymentStatus: "partially_paid",
      finalizedAt: new Date("2026-11-15T10:00:00.000Z"),
      createdBy: ownerUser._id,
    });

    // Completed payment for invoice 1
    await Payment.create({
      organizationId: organization._id,
      branchId: branch1._id,
      invoiceId: invoice1._id,
      customerId: testCustomer._id,
      paymentNumber: `PAY-DASH-${Date.now()}-1`,
      amount: 2000,
      type: "payment",
      method: "upi",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-15T10:05:00.000Z"),
    });

    // B. Finalized Invoice 2 with a refund: ₹1,000 paid, then ₹200 refunded
    const invoice2 = await Invoice.create({
      organizationId: organization._id,
      branchId: branch1._id,
      invoiceNumber: `INV-DASH-${Date.now()}-2`,
      invoiceType: "retail",
      customerId: testCustomer._id,
      customerSnapshot: {
        name: testCustomer.name,
        phone: testCustomer.phone,
      },
      lines: [
        {
          lineType: "product",
          productId: testProduct._id,
          sku: testProduct.sku,
          name: testProduct.name,
          quantity: 1,
          unitPrice: 1000,
          lineTotal: 1000,
          customerPayable: 1000,
          discountAmount: 0,
        },
      ],
      subtotal: 1000,
      discountTotal: 0,
      grossPayable: 1000,
      payableAmount: 1000,
      amountPaid: 1000,
      amountDue: 0,
      status: "finalized",
      paymentStatus: "paid",
      finalizedAt: new Date("2026-11-16T11:00:00.000Z"),
      createdBy: ownerUser._id,
    });

    await Payment.create({
      organizationId: organization._id,
      branchId: branch1._id,
      invoiceId: invoice2._id,
      customerId: testCustomer._id,
      paymentNumber: `PAY-DASH-${Date.now()}-2`,
      amount: 1000,
      type: "payment",
      method: "cash",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-16T11:05:00.000Z"),
    });

    await Payment.create({
      organizationId: organization._id,
      branchId: branch1._id,
      invoiceId: invoice2._id,
      customerId: testCustomer._id,
      paymentNumber: `REF-DASH-${Date.now()}-1`,
      amount: 200,
      type: "refund",
      method: "cash",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-16T14:00:00.000Z"),
    });

    // C. Seed Appointment
    await Appointment.create({
      organizationId: organization._id,
      branchId: branch1._id,
      appointmentCode: `APT-DASH-${Date.now()}`,
      customerId: testCustomer._id,
      staffId: stylistStaff._id,
      services: [
        {
          serviceType: "registered",
          serviceId: testService._id,
          name: testService.name,
          duration: 90,
          price: 3500,
        },
      ],
      startAt: new Date("2026-11-15T12:00:00.000Z"),
      endAt: new Date("2026-11-15T13:30:00.000Z"),
      appointmentDate: "2026-11-15",
      startTime: "12:00",
      endTime: "13:30",
      totalDuration: 90,
      status: "completed",
      bookingType: "advance",
      pricing: { subtotal: 3500, discount: 0, total: 3500 },
    });
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  // =========================================================================
  // 1. Authorization, Security & Tenant Isolation Tests
  // =========================================================================
  describe("1. Authorization, Security & Scoping", () => {
    it("rejects unauthenticated request with 401", async () => {
      const res = await request(app).get("/api/v1/dashboard/overview");
      expect(res.status).toBe(401);
    });

    it("rejects user without dashboard.view permission with 403", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${restrictedToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/permissions/i);
    });

    it("rejects branch sentinel 'all' with 400", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", "all");

      expect(res.status).toBe(400);
    });

    it("rejects branch-limited user attempting to access unauthorized branch with 403", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branch2._id.toString()); // Manager only has branch1 access

      expect(res.status).toBe(403);
    });

    it("returns 404 if branch belongs to a different organization", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", otherOrgBranch._id.toString());

      expect(res.status).toBe(404);
    });

    it("allows org-wide user to query without X-Branch-Id and receive branchComparison", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.meta.branchId).toBeNull();
      expect(res.body.meta.branchName).toBe("All Branches");
      expect(Array.isArray(res.body.branchComparison)).toBe(true);
      expect(res.body.branchComparison.length).toBeGreaterThanOrEqual(2);
    });

    it("allows receptionist to access dashboard and receive only authorized core modules", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${receptionistToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.kpis).toBeDefined();
      expect(res.body.appointments).toBeDefined();
      expect(res.body.customers).toBeDefined();
      expect(res.body.services).toBeDefined();

      // Unauthorized sensitive modules must NOT be returned in payload or metadata
      expect(res.body.finance).toBeUndefined();
      expect(res.body.inventory).toBeUndefined();
      expect(res.body.payroll).toBeUndefined();
      expect(res.body.procurement).toBeUndefined();
      expect(res.body.meta.availableWidgets).not.toContain("finance");
      expect(res.body.meta.availableWidgets).not.toContain("inventory");
      expect(res.body.meta.availableWidgets).not.toContain("payroll");
      expect(res.body.meta.availableWidgets).not.toContain("procurement");
    });

    it("rejects branch manager from querying consolidated all branches without X-Branch-Id", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${managerToken}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/branch/i);
    });

    it("rejects branch manager from querying an unauthorized branch (403)", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branch2._id.toString());

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/access/i);
    });
  });

  // =========================================================================
  // 2. Financial Metrics & Accuracy Verification
  // =========================================================================
  describe("2. Financial Metrics & Integrity", () => {
    it("accurately computes gross sales, collections, refunds, net collections, and receivables", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(200);
      const { kpis } = res.body;

      // Invoices: 3500 + 1000 = 4500 gross sales
      expect(kpis.grossSales.current).toBe(4500);
      expect(kpis.netSales.current).toBe(4500);

      // Collections: 2000 (Inv1) + 1000 (Inv2) = 3000
      expect(kpis.collections.current).toBe(3000);

      // Refunds: 200 (Inv2)
      expect(kpis.refunds.current).toBe(200);

      // Net Collections: 3000 - 200 = 2800
      expect(kpis.netCollections.current).toBe(2800);

      // Outstanding Receivables: 1500 (Inv1 unpaid due)
      expect(kpis.outstandingReceivables.current).toBe(1500);

      // Average Bill Value: 4500 / 2 = 2250
      expect(kpis.averageBillValue.current).toBe(2250);

      // Total Appointments: 1
      expect(kpis.totalAppointments.current).toBe(1);
    });

    it("accurately handles cross-period partial payment: Nov 28 billed sales and payment vs Dec 02 second payment", async () => {
      // 1. Create ₹3,000 invoice finalized on Nov 28
      const splitInvoice = await Invoice.create({
        organizationId: organization._id,
        branchId: branch1._id,
        invoiceNumber: `INV-SPLIT-${Date.now()}`,
        invoiceType: "retail",
        customerId: testCustomer._id,
        customerSnapshot: {
          name: testCustomer.name,
          phone: testCustomer.phone,
        },
        lines: [
          {
            lineType: "product",
            productId: testProduct._id,
            sku: testProduct.sku,
            name: testProduct.name,
            quantity: 1,
            unitPrice: 3000,
            lineTotal: 3000,
            customerPayable: 3000,
            discountAmount: 0,
          },
        ],
        subtotal: 3000,
        discountTotal: 0,
        grossPayable: 3000,
        payableAmount: 3000,
        amountPaid: 3000,
        amountDue: 0,
        status: "finalized",
        paymentStatus: "paid",
        finalizedAt: new Date("2026-11-28T14:00:00.000Z"),
        createdBy: ownerUser._id,
      });

      // 2. Payment 1: ₹1,500 received on Nov 28
      await Payment.create({
        organizationId: organization._id,
        branchId: branch1._id,
        invoiceId: splitInvoice._id,
        customerId: testCustomer._id,
        paymentNumber: `PAY-SPLIT-1-${Date.now()}`,
        amount: 1500,
        type: "payment",
        method: "upi",
        status: "completed",
        recordedBy: ownerUser._id,
        paymentDate: new Date("2026-11-28T14:05:00.000Z"),
      });

      // 3. Payment 2: ₹1,500 received on Dec 02
      await Payment.create({
        organizationId: organization._id,
        branchId: branch1._id,
        invoiceId: splitInvoice._id,
        customerId: testCustomer._id,
        paymentNumber: `PAY-SPLIT-2-${Date.now()}`,
        amount: 1500,
        type: "payment",
        method: "cash",
        status: "completed",
        recordedBy: ownerUser._id,
        paymentDate: new Date("2026-12-02T10:00:00.000Z"),
      });

      // 4. Query November (2026-11-01 to 2026-11-30)
      const novRes = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(novRes.status).toBe(200);
      // Net Sales includes: 4500 (prior) + 3000 (Nov 28 invoice) = 7500
      expect(novRes.body.kpis.netSales.current).toBe(7500);
      // Collections in November includes: 3000 (prior) + 1500 (Nov 28 payment) = 4500
      expect(novRes.body.kpis.collections.current).toBe(4500);
      // Net Collections: 4500 - 200 (refund) = 4300
      expect(novRes.body.kpis.netCollections.current).toBe(4300);

      // 5. Query December (2026-12-01 to 2026-12-10)
      const decRes = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2026-12-01&endDate=2026-12-10")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(decRes.status).toBe(200);
      // Net Sales in December is 0 (no invoices finalized in December)
      expect(decRes.body.kpis.netSales.current).toBe(0);
      // Collections in December is 1500 (from the Dec 02 cash payment)
      expect(decRes.body.kpis.collections.current).toBe(1500);
      expect(decRes.body.kpis.netCollections.current).toBe(1500);
    });
  });

  // =========================================================================
  // 3. Input Date Validation
  // =========================================================================
  describe("3. Input Date & Timezone Validation", () => {
    it("rejects impossible calendar dates like 2026-02-31 with 400", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2026-02-31&endDate=2026-03-05")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/valid calendar date/i);
    });

    it("rejects date range exceeding 366 days with 400", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2025-01-01&endDate=2026-02-01")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/366 days/i);
    });

    it("rejects startDate after endDate with 400", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2026-11-20&endDate=2026-11-10")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/startDate cannot be after endDate/i);
    });
  });

  // =========================================================================
  // 4. Permission-Aware Data Shaping
  // =========================================================================
  describe("4. Permission-Aware Response Projection", () => {
    it("omits finance and inventory modules when manager lacks permissions", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(200);

      // Core widgets are present
      expect(res.body.kpis).toBeDefined();
      expect(res.body.revenueTrend).toBeDefined();
      expect(res.body.appointments).toBeDefined();

      // Restricted sections are omitted from payload and availableWidgets
      expect(res.body.finance).toBeUndefined();
      expect(res.body.inventory).toBeUndefined();
      expect(res.body.meta.availableWidgets).not.toContain("finance");
      expect(res.body.meta.availableWidgets).not.toContain("inventory");
    });

    it("includes finance and inventory modules for owner with full permissions", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.finance).toBeDefined();
      expect(res.body.inventory).toBeDefined();
      expect(res.body.meta.availableWidgets).toContain("finance");
      expect(res.body.meta.availableWidgets).toContain("inventory");
    });
  });

  // =========================================================================
  // 5. Operations & Alerts Endpoints
  // =========================================================================
  describe("5. Operations & Alerts Services", () => {
    it("returns today's operational summary and staff roster", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/operations")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.summary).toBeDefined();
      expect(res.body.summary.totalBranchStaff).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(res.body.staffRoster)).toBe(true);
      expect(Array.isArray(res.body.appointmentsTimeline)).toBeDefined();
    });

    it("generates data-driven business alerts including low stock", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/alerts")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.alerts)).toBe(true);

      // Low stock alert should be present because testProduct has onHand: 2 <= reorderLevel: 5
      const lowStockAlert = res.body.alerts.find((a) => a.id === "ALERT_INV_LOW_STOCK");
      expect(lowStockAlert).toBeDefined();
      expect(lowStockAlert.severity).toBe("warning");
      expect(lowStockAlert.targetUrl).toBe("/inventory");
    });
  });
});
