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
import { StockMovement } from "../../models/inventory/stockMovement.model.js";
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { Staff } from "../../models/staff/staff.model.js";
import { CANONICAL_PERMISSIONS } from "../../config/permissions.js";

jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Reports & Analytics Comprehensive Verification Suite", () => {
  jest.setTimeout(45000);

  let dbUri;
  let organization;
  let otherOrg;
  let branch1;
  let branch2;
  let otherOrgBranch;

  let ownerRole, managerRole, stylistRole, inventoryManagerRole;
  let ownerUser, managerUser, stylistUser, inventoryManagerUser;
  let ownerToken, managerToken, stylistToken, inventoryManagerToken;
  let stylistStaff1, stylistStaff2;
  let testCustomer;

  beforeAll(async () => {
    dbUri = getIsolatedTestMongoUri("reports_test");
    await mongoose.connect(dbUri);

    // 1. Setup Organizations
    organization = await Organization.create({
      name: "Glamour Salon Corp",
      slug: `glamour-corp-${Date.now()}`,
    });

    otherOrg = await Organization.create({
      name: "Rival Salon Corp",
      slug: `rival-corp-${Date.now()}`,
    });

    // 2. Setup Branches
    branch1 = await Branch.create({
      name: "Koramangala Branch",
      organizationId: organization._id,
      timezone: "Asia/Kolkata",
      isActive: true,
    });

    branch2 = await Branch.create({
      name: "Indiranagar Branch",
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
    stylistStaff1 = await Staff.create({
      organizationId: organization._id,
      name: "Alice Performer",
      staffCode: "STF-001",
      email: `alice-${Date.now()}@glamour.com`,
      phone: "+91 9876500001",
      designation: "Senior Stylist",
      joiningDate: new Date("2024-01-01"),
    });

    stylistStaff2 = await Staff.create({
      organizationId: organization._id,
      name: "Bob Seller",
      staffCode: "STF-002",
      email: `bob-${Date.now()}@glamour.com`,
      phone: "+91 9876500002",
      designation: "Hair Stylist",
      joiningDate: new Date("2024-01-01"),
    });

    // 4. Upsert canonical permissions in DB
    const dbPerms = [];
    for (const p of CANONICAL_PERMISSIONS) {
      let perm = await Permission.findOne({ name: p.name });
      if (!perm) {
        perm = await Permission.create(p);
      }
      dbPerms.push(perm);
    }

    const reportRevenuePerm = dbPerms.find((p) => p.name === "reports.revenue.view");
    const reportPerfPerm = dbPerms.find((p) => p.name === "reports.performance.view");
    const reportRetPerm = dbPerms.find((p) => p.name === "reports.retention.view");
    const reportSvcPerm = dbPerms.find((p) => p.name === "reports.services.view");
    const reportInvPerm = dbPerms.find((p) => p.name === "reports.inventory.view");
    const custViewPerm = dbPerms.find((p) => p.name === "customers.view");

    // 5. Setup Roles
    ownerRole = await Role.create({
      name: `owner-${Date.now()}`,
      organizationId: organization._id,
      isSystem: true,
      permissions: dbPerms.map((p) => p._id),
    });

    // Manager with reports permissions EXCEPT customers.view (tests phone masking)
    managerRole = await Role.create({
      name: `manager-${Date.now()}`,
      organizationId: organization._id,
      permissions: [
        reportRevenuePerm._id,
        reportPerfPerm._id,
        reportRetPerm._id,
        reportSvcPerm._id,
        reportInvPerm._id,
      ],
    });

    // Inventory manager with ONLY inventory report permission (tests overview partial authorization)
    inventoryManagerRole = await Role.create({
      name: `inv-mgr-${Date.now()}`,
      organizationId: organization._id,
      permissions: [reportInvPerm._id],
    });

    stylistRole = await Role.create({
      name: `stylist-${Date.now()}`,
      organizationId: organization._id,
      permissions: [], // zero report permissions
    });

    // 6. Setup Users
    ownerUser = await User.create({
      name: "Alice Owner",
      email: `owner-${Date.now()}@glamour.com`,
      phone: "+91 9111111111",
      password: "HashedPassword123!",
      organizationId: organization._id,
      role: ownerRole._id,
      hasOrgWideAccess: true,
      branchAccess: [
        { branchId: branch1._id, branchName: branch1.name, isActive: true },
        { branchId: branch2._id, branchName: branch2.name, isActive: true },
      ],
    });

    managerUser = await User.create({
      name: "Bob Manager",
      email: `manager-${Date.now()}@glamour.com`,
      phone: "+91 9222222222",
      password: "HashedPassword123!",
      organizationId: organization._id,
      role: managerRole._id,
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branch1._id, branchName: branch1.name, isActive: true }],
    });

    inventoryManagerUser = await User.create({
      name: "Ian Inventory",
      email: `ian-${Date.now()}@glamour.com`,
      phone: "+91 9333333333",
      password: "HashedPassword123!",
      organizationId: organization._id,
      role: inventoryManagerRole._id,
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branch1._id, branchName: branch1.name, isActive: true }],
    });

    stylistUser = await User.create({
      name: "Charlie Stylist",
      email: `stylist-${Date.now()}@glamour.com`,
      phone: "+91 9444444444",
      password: "HashedPassword123!",
      organizationId: organization._id,
      role: stylistRole._id,
      hasOrgWideAccess: false,
      branchAccess: [{ branchId: branch1._id, branchName: branch1.name, isActive: true }],
    });

    const jwtSecret = process.env.JWT_SECRET || "test-jwt-secret-key-32-bytes-minimum-security";
    ownerToken = jwt.sign(
      {
        id: ownerUser._id.toString(),
        organizationId: organization._id.toString(),
        role: ownerRole.name,
        permissions: ["customers.view", "reports.revenue.view", "reports.performance.view", "reports.retention.view", "reports.services.view", "reports.inventory.view"],
        hasOrgWideAccess: true,
        branchAccess: ownerUser.branchAccess,
      },
      jwtSecret
    );

    managerToken = jwt.sign(
      {
        id: managerUser._id.toString(),
        organizationId: organization._id.toString(),
        role: managerRole.name,
        permissions: ["reports.revenue.view", "reports.performance.view", "reports.retention.view", "reports.services.view", "reports.inventory.view"],
        hasOrgWideAccess: false,
        branchAccess: managerUser.branchAccess,
      },
      jwtSecret
    );

    inventoryManagerToken = jwt.sign(
      {
        id: inventoryManagerUser._id.toString(),
        organizationId: organization._id.toString(),
        role: inventoryManagerRole.name,
        permissions: ["reports.inventory.view"],
        hasOrgWideAccess: false,
        branchAccess: inventoryManagerUser.branchAccess,
      },
      jwtSecret
    );

    stylistToken = jwt.sign(
      {
        id: stylistUser._id.toString(),
        organizationId: organization._id.toString(),
        role: stylistRole.name,
        permissions: [],
        hasOrgWideAccess: false,
        branchAccess: stylistUser.branchAccess,
      },
      jwtSecret
    );

    testCustomer = await Customer.create({
      name: "Priya Sharma",
      phone: "+91 9876543210",
      organizationId: organization._id,
      homeBranchId: branch1._id,
    });
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  describe("1. Input Date Validation & Timezone Boundaries", () => {
    it("rejects impossible calendar dates like 2026-02-31 with 400", async () => {
      const res = await request(app)
        .get("/api/v1/reports/revenue?startDate=2026-02-31&endDate=2026-03-05")
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/valid calendar date/i);
    });

    it("rejects date range exceeding 366 days with 400", async () => {
      const res = await request(app)
        .get("/api/v1/reports/revenue?startDate=2025-01-01&endDate=2026-02-01")
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/cannot exceed 366 days/i);
    });

    it("computes exact consecutive previous_period dates without day gaps", async () => {
      const res = await request(app)
        .get("/api/v1/reports/revenue?startDate=2026-11-10&endDate=2026-11-20&compareWith=previous_period")
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.meta.comparisonStartDate).toBe("2026-10-30");
      expect(res.body.data.meta.comparisonEndDate).toBe("2026-11-09");
    });
  });

  describe("2. Staff Execution Deduplication Across Invoices & Appointments", () => {
    let sharedApptId;
    let sharedSvcId;

    beforeAll(async () => {
      sharedSvcId = new mongoose.Types.ObjectId();
      const unbilledSvcId = new mongoose.Types.ObjectId();

      // Appointment with 2 services performed by stylistStaff1
      const appt = await Appointment.create({
        organizationId: organization._id,
        branchId: branch1._id,
        appointmentCode: "APT-STAFF-001",
        customerId: testCustomer._id,
        staffId: stylistStaff1._id,
        status: "completed",
        bookingType: "advance",
        appointmentDate: "2026-11-12",
        startTime: "10:00",
        endTime: "11:00",
        totalDuration: 60,
        startAt: new Date("2026-11-12T04:30:00.000Z"),
        endAt: new Date("2026-11-12T05:30:00.000Z"),
        pricing: { subtotal: 3000, discount: 0, total: 3000 },
        services: [
          {
            _id: sharedSvcId,
            serviceType: "custom",
            name: "Hair Cut & Wash",
            duration: 30,
            price: 1500,
          },
          {
            _id: unbilledSvcId,
            serviceType: "custom",
            name: "Beard Trim & Sculpt",
            duration: 30,
            price: 1500,
          },
        ],
      });
      sharedApptId = appt._id;

      // Finalized Invoice billing ONLY service 1 (sharedSvcId), with retail sale credited to stylistStaff2
      await Invoice.create({
        organizationId: organization._id,
        branchId: branch1._id,
        invoiceNumber: "INV-STAFF-001",
        invoiceType: "combined",
        appointmentId: sharedApptId,
        customerId: testCustomer._id,
        customerSnapshot: { name: testCustomer.name, phone: testCustomer.phone },
        lines: [
          {
            lineType: "service",
            serviceType: "custom",
            appointmentServiceId: sharedSvcId,
            name: "Hair Cut & Wash",
            duration: 30,
            quantity: 1,
            unitPrice: 1500,
            lineTotal: 1500,
            discountAmount: 0,
            customerPayable: 1500,
            attribution: {
              performedBy: {
                staffId: stylistStaff1._id,
                name: stylistStaff1.name,
                staffCode: stylistStaff1.staffCode,
              },
            },
          },
          {
            lineType: "product",
            productId: new mongoose.Types.ObjectId(),
            sku: "SHAMPOO-01",
            name: "Hair Serum",
            quantity: 1,
            unitPrice: 800,
            lineTotal: 800,
            discountAmount: 0,
            customerPayable: 800,
            attribution: {
              soldBy: {
                staffId: stylistStaff2._id,
                name: stylistStaff2.name,
                staffCode: stylistStaff2.staffCode,
              },
            },
          },
        ],
        subtotal: 2300,
        discountTotal: 0,
        subscriptionCoveredAmount: 0,
        grossPayable: 2300,
        payableAmount: 2300,
        amountPaid: 2300,
        amountDue: 0,
        status: "finalized",
        paymentStatus: "paid",
        createdBy: ownerUser._id,
        finalizedAt: new Date("2026-11-12T06:00:00.000Z"),
      });

      const appt2 = await Appointment.create({
        organizationId: organization._id,
        branchId: branch1._id,
        appointmentCode: "APT-STAFF-002",
        customerId: testCustomer._id,
        staffId: stylistStaff1._id,
        status: "completed",
        bookingType: "advance",
        appointmentDate: "2026-11-13",
        startTime: "11:00",
        endTime: "11:30",
        totalDuration: 30,
        startAt: new Date("2026-11-13T05:30:00.000Z"),
        endAt: new Date("2026-11-13T06:00:00.000Z"),
        pricing: { subtotal: 1500, discount: 0, total: 1500 },
        services: [
          {
            _id: unbilledSvcId,
            serviceType: "custom",
            name: "Beard Trim & Sculpt",
            duration: 30,
            price: 1500,
          },
        ],
      });

      // Draft invoice for appt2 (should NOT suppress unbilled workload count)
      await Invoice.create({
        organizationId: organization._id,
        branchId: branch1._id,
        invoiceNumber: "INV-DRAFT-002",
        invoiceType: "appointment",
        appointmentId: appt2._id,
        customerId: testCustomer._id,
        customerSnapshot: { name: testCustomer.name, phone: testCustomer.phone },
        lines: [
          {
            lineType: "service",
            serviceType: "custom",
            appointmentServiceId: unbilledSvcId,
            name: "Beard Trim & Sculpt",
            duration: 30,
            quantity: 1,
            unitPrice: 1500,
            lineTotal: 1500,
            discountAmount: 0,
            customerPayable: 1500,
          },
        ],
        subtotal: 1500,
        discountTotal: 0,
        subscriptionCoveredAmount: 0,
        grossPayable: 1500,
        payableAmount: 1500,
        amountPaid: 0,
        amountDue: 1500,
        status: "draft", // DRAFT STATUS
        paymentStatus: "unpaid",
        createdBy: ownerUser._id,
      });
    });

    it("deduplicates billed execution while including completed unbilled appointment service", async () => {
      const res = await request(app)
        .get("/api/v1/reports/staff-performance?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      const rankings = res.body.data.rankings;

      // Stylist 1 has:
      // - 1 billed service from appt1 (sharedSvcId, ₹1500 revenue)
      // - 1 unbilled service from appt1 (unbilledSvcId, ₹0 revenue)
      // - 1 unbilled service from appt2 (unbilledSvcId2, ₹0 revenue)
      // Total services completed = 3
      const alice = rankings.find((r) => r.staffId === stylistStaff1._id.toString());
      expect(alice).toBeDefined();
      expect(alice.servicesCompletedCount).toBe(3);
      expect(alice.serviceRevenueCredit).toBe(1500);
      expect(alice.serviceHours).toBe(1.5); // 30m + 30m + 30m = 1.5 hr

      // Stylist 2 has retail credit of ₹800
      const bob = rankings.find((r) => r.staffId === stylistStaff2._id.toString());
      expect(bob).toBeDefined();
      expect(bob.retailSalesCredit).toBe(800);
    });
  });

  describe("3. Customer Retention & Phone Masking Privacy", () => {
    it("masks customer phone numbers for manager without customers.view permission", async () => {
      const res = await request(app)
        .get("/api/v1/reports/customer-retention?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(200);
      const client = res.body.data.clientDirectory.find((c) => c.name === testCustomer.name);
      expect(client).toBeDefined();
      expect(client.phone).toBe("+919****3210");
      expect(client.phone).not.toBe("+919876543210");
    });

    it("displays unmasked phone numbers for owner possessing customers.view permission", async () => {
      const res = await request(app)
        .get("/api/v1/reports/customer-retention?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      const client = res.body.data.clientDirectory.find((c) => c.name === testCustomer.name);
      expect(client).toBeDefined();
      expect(client.phone).toBe("+919876543210");
    });

    it("returns explicit truncated historyCompleteness indicator", async () => {
      const res = await request(app)
        .get("/api/v1/reports/customer-retention?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.summary.historyCompleteness).toBe("truncated");
      expect(res.body.data.summary.historyCompletenessNote).toBeDefined();
    });
  });

  describe("4. Service Demand Analytics", () => {
    it("ranks top services by execution volume and gross ticket revenue", async () => {
      const res = await request(app)
        .get("/api/v1/reports/service-analytics?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.topServices.length).toBeGreaterThan(0);
      const svc = res.body.data.topServices[0];
      expect(svc.name).toBe("Hair Cut & Wash");
      expect(svc.executionCount).toBe(1);
      expect(svc.totalGrossRevenue).toBe(1500);
      expect(res.body.data.summary.averageServiceTicket.current).toBe(1500);
    });
  });

  describe("5. Inventory Domain Separation & Movements", () => {
    let consumableProduct;
    let retailProduct;

    beforeAll(async () => {
      consumableProduct = await Product.create({
        organizationId: organization._id,
        name: "Bleach Powder 500g",
        sku: "BLEACH-01",
        category: "Hair Chemicals",
        usageType: "salon_consumption",
        stockUnit: "g",
        reorderLevel: 100,
      });

      retailProduct = await Product.create({
        organizationId: organization._id,
        name: "Argan Oil Serum 100ml",
        sku: "ARGAN-01",
        category: "Hair Care",
        usageType: "retail_sale",
        stockUnit: "bottle",
        reorderLevel: 10,
      });

      // Consumable has 50g on hand (<= 100 reorder level -> LOW STOCK)
      await StockBalance.create({
        organizationId: organization._id,
        branchId: branch1._id,
        productId: consumableProduct._id,
        onHand: 50,
        onHandConsumables: 50,
        onHandRetail: 0,
      });

      // Retail has 25 bottles on hand (> 10 reorder level -> HEALTHY)
      await StockBalance.create({
        organizationId: organization._id,
        branchId: branch1._id,
        productId: retailProduct._id,
        onHand: 25,
        onHandConsumables: 0,
        onHandRetail: 25,
      });

      // Stock movement: 1 consumption movement (-10g)
      await StockMovement.create({
        organizationId: organization._id,
        branchId: branch1._id,
        productId: consumableProduct._id,
        quantityDelta: -10,
        balanceAfter: 50,
        movementType: "service_consumption",
        stockDomain: "salon_consumables",
        reference: { entityType: "ServiceExecution" },
        actorId: ownerUser._id,
        createdAt: new Date("2026-11-12T10:00:00.000Z"),
      });

      // Stock movement: 1 stocktake discrepancy (+2 audit found)
      await StockMovement.create({
        organizationId: organization._id,
        branchId: branch1._id,
        productId: retailProduct._id,
        quantityDelta: 2,
        balanceAfter: 25,
        movementType: "stocktake",
        stockDomain: "retail_products",
        reference: { entityType: "Audit" },
        actorId: ownerUser._id,
        createdAt: new Date("2026-11-12T10:00:00.000Z"),
      });
    });

    it("verifies low stock alerts isolate consumables from retail without hiding shortages", async () => {
      const res = await request(app)
        .get("/api/v1/reports/inventory?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      const summary = res.body.data.summary;
      expect(summary.lowStockConsumablesCount).toBe(1);
      expect(summary.lowStockRetailCount).toBe(0);

      const alert = res.body.data.lowStockAlerts.find((a) => a.sku === "BLEACH-01");
      expect(alert).toBeDefined();
      expect(alert.onHandConsumables).toBe(50);
      expect(alert.reorderLevel).toBe(100);

      expect(summary.consumablesUsedInPeriod.current).toBe(10);
      expect(summary.auditNetDiscrepancyDelta).toBe(2);
    });
  });

  describe("6. Overview Partial Authorization", () => {
    it("returns only inventory metrics when user only has reports.inventory.view", async () => {
      const res = await request(app)
        .get("/api/v1/reports/overview?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${inventoryManagerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(200);
      const summary = res.body.data.summary;
      // Authorized inventory metrics are present
      expect(summary.lowStockItemCount).toBeDefined();
      // Unauthorized financial & client retention metrics are null
      expect(summary.netSalesBilled).toBeNull();
      expect(summary.moneyCollected).toBeNull();
      expect(summary.totalVisitingClients).toBeNull();
      expect(summary.repeatVisitRate).toBeNull();
    });
  });

  describe("7. Specific Report CSV Export Authorization", () => {
    it("rejects inventory manager attempting to export revenue CSV with 403", async () => {
      const res = await request(app)
        .get("/api/v1/reports/revenue/export?startDate=2026-11-01&endDate=2026-11-20&format=csv")
        .set("Authorization", `Bearer ${inventoryManagerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(403);
    });

    it("allows inventory manager to export inventory CSV with 200", async () => {
      const res = await request(app)
        .get("/api/v1/reports/inventory/export?startDate=2026-11-01&endDate=2026-11-20&format=csv")
        .set("Authorization", `Bearer ${inventoryManagerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.text).toContain("Product Name,SKU,Category,Usage Type,Consumables On-Hand,Retail On-Hand,Reorder Level,Urgency");
    });
  });
});
