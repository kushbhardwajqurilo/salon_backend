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

    it("accepts report pagination and rejects unsupported inventory filters", async () => {
      const pageResponse = await request(app)
        .get("/api/v1/reports/staff-performance?startDate=2026-11-01&endDate=2026-11-20&page=1&limit=5")
        .set("Authorization", `Bearer ${ownerToken}`);
      const usageTypeResponse = await request(app)
        .get("/api/v1/reports/inventory?startDate=2026-11-01&endDate=2026-11-20&usageType=salon_consumption")
        .set("Authorization", `Bearer ${ownerToken}`);
      const stockStatusResponse = await request(app)
        .get("/api/v1/reports/inventory?startDate=2026-11-01&endDate=2026-11-20&stockStatus=low_stock")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(pageResponse.status).toBe(200);
      expect(pageResponse.body.data.pagination.rankings).toEqual(
        expect.objectContaining({ page: 1, limit: 5, total: 0, totalPages: 0 }),
      );
      expect(usageTypeResponse.status).toBe(400);
      expect(stockStatusResponse.status).toBe(400);
    });

    it("computes exact consecutive previous_period dates without day gaps", async () => {
      const res = await request(app)
        .get("/api/v1/reports/revenue?startDate=2026-11-10&endDate=2026-11-20&compareWith=previous_period")
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.meta.comparisonStartDate).toBe("2026-10-30");
      expect(res.body.data.meta.comparisonEndDate).toBe("2026-11-09");
    });

    it("does not include invoices from another organization", async () => {
      const before = await request(app)
        .get("/api/v1/reports/revenue?startDate=2026-11-01&endDate=2026-11-20&compareWith=none")
        .set("Authorization", `Bearer ${ownerToken}`);

      await Invoice.create({
        organizationId: otherOrg._id,
        branchId: otherOrgBranch._id,
        invoiceNumber: "INV-OTHER-REPORT-001",
        invoiceType: "retail",
        customerId: testCustomer._id,
        customerSnapshot: { name: "Other Organization Client", phone: "+91 9000000000" },
        lines: [],
        subtotal: 99000,
        discountTotal: 0,
        subscriptionCoveredAmount: 0,
        grossPayable: 99000,
        payableAmount: 99000,
        amountPaid: 99000,
        amountDue: 0,
        status: "finalized",
        paymentStatus: "paid",
        createdBy: ownerUser._id,
        finalizedAt: new Date("2026-11-12T06:00:00.000Z"),
      });

      const after = await request(app)
        .get("/api/v1/reports/revenue?startDate=2026-11-01&endDate=2026-11-20&compareWith=none")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(before.status).toBe(200);
      expect(after.status).toBe(200);
      expect(after.body.data.summary.grossBilled.current)
        .toBe(before.body.data.summary.grossBilled.current);
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
      expect(alice.totalRevenueCredit).toBe(1500);
      expect(alice.serviceHours).toBe(1.5); // 30m + 30m + 30m = 1.5 hr
      expect(res.body.data.summary.totalServicesDelivered.previous).toBe(0);

      // Stylist 2 has retail credit of ₹800
      const bob = rankings.find((r) => r.staffId === stylistStaff2._id.toString());
      expect(bob).toBeDefined();
      expect(bob.retailSalesCredit).toBe(800);
      expect(bob.totalRevenueCredit).toBe(800);

      const firstPage = await request(app)
        .get("/api/v1/reports/staff-performance?startDate=2026-11-01&endDate=2026-11-20&compareWith=none&page=1&limit=1")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());
      const secondPage = await request(app)
        .get("/api/v1/reports/staff-performance?startDate=2026-11-01&endDate=2026-11-20&compareWith=none&page=2&limit=1")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(firstPage.body.data.pagination.rankings).toEqual(
        expect.objectContaining({ page: 1, limit: 1, total: 2, totalPages: 2 }),
      );
      expect(secondPage.body.data.pagination.rankings).toEqual(
        expect.objectContaining({ page: 2, limit: 1, total: 2, totalPages: 2 }),
      );
      expect(firstPage.body.data.rankings[0].staffId).not.toBe(
        secondPage.body.data.rankings[0].staffId,
      );
      expect(firstPage.body.data.summary.totalServicesDelivered.current).toBe(
        secondPage.body.data.summary.totalServicesDelivered.current,
      );
    });
  });

  describe("3. Customer Retention & Phone Masking Privacy", () => {
    it("scopes prior visits to the active branch, deduplicates linked visits, and uses the API tier values", async () => {
      const branchHistoryCustomer = await Customer.create({
        name: "Branch History Customer",
        phone: "+91 9876500101",
        organizationId: organization._id,
        homeBranchId: branch1._id,
      });
      const unbilledHistoryCustomer = await Customer.create({
        name: "Unbilled History Customer",
        phone: "+91 9876500102",
        organizationId: organization._id,
        homeBranchId: branch1._id,
      });
      const dueCustomer = await Customer.create({
        name: "Due Customer",
        phone: "+91 9876500103",
        organizationId: organization._id,
        homeBranchId: branch1._id,
      });

      const createCompletedVisit = async ({ customer, branch, code, date }) => {
        const startAt = new Date(`${date}T05:00:00.000Z`);
        await Appointment.create({
          organizationId: organization._id,
          branchId: branch._id,
          appointmentCode: code,
          customerId: customer._id,
          staffId: stylistStaff1._id,
          status: "completed",
          bookingType: "advance",
          appointmentDate: date,
          startTime: "10:30",
          endTime: "11:00",
          totalDuration: 30,
          startAt,
          endAt: new Date(startAt.getTime() + 30 * 60 * 1000),
          pricing: { subtotal: 1000, discount: 0, total: 1000 },
          services: [{
            serviceType: "custom",
            name: "Historical Visit",
            duration: 30,
            price: 1000,
          }],
        });
      };

      await createCompletedVisit({
        customer: branchHistoryCustomer,
        branch: branch2,
        code: "APT-RET-BRANCH-OLD",
        date: "2026-10-15",
      });
      await createCompletedVisit({
        customer: branchHistoryCustomer,
        branch: branch1,
        code: "APT-RET-BRANCH-CURRENT",
        date: "2026-11-15",
      });
      await createCompletedVisit({
        customer: unbilledHistoryCustomer,
        branch: branch1,
        code: "APT-RET-UNBILLED-OLD",
        date: "2026-10-10",
      });
      await createCompletedVisit({
        customer: unbilledHistoryCustomer,
        branch: branch1,
        code: "APT-RET-UNBILLED-CURRENT",
        date: "2026-11-16",
      });
      await createCompletedVisit({
        customer: dueCustomer,
        branch: branch1,
        code: "APT-RET-DUE",
        date: "2026-10-01",
      });

      const res = await request(app)
        .get("/api/v1/reports/customer-retention?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${managerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.data.summary.totalVisitingClients.current).toBe(3);
      expect(res.body.data.summary.newClientsAcquired.current).toBe(2);
      expect(res.body.data.summary.returningClients.current).toBe(1);
      expect(res.body.data.summary.totalVisitingClients.previous).toBe(0);

      const clients = res.body.data.clientDirectory;
      expect(clients.find((client) => client.customerId === branchHistoryCustomer._id.toString())
        .totalLifetimeVisits).toBe(1);
      expect(clients.find((client) => client.customerId === unbilledHistoryCustomer._id.toString())
        .totalLifetimeVisits).toBe(2);
      expect(clients.find((client) => client.customerId === testCustomer._id.toString())
        .totalLifetimeVisits).toBe(2);
      expect(clients.find((client) => client.customerId === dueCustomer._id.toString())
        .statusTier).toBe("dueForService");

      const firstPage = await request(app)
        .get("/api/v1/reports/customer-retention?startDate=2026-11-01&endDate=2026-11-20&compareWith=none&page=1&limit=1")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());
      const secondPage = await request(app)
        .get("/api/v1/reports/customer-retention?startDate=2026-11-01&endDate=2026-11-20&compareWith=none&page=2&limit=1")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(firstPage.body.data.pagination.clientDirectory).toEqual(
        expect.objectContaining({ page: 1, limit: 1 }),
      );
      expect(firstPage.body.data.pagination.clientDirectory.total).toBeGreaterThan(1);
      expect(firstPage.body.data.pagination.clientDirectory.totalPages).toBe(
        firstPage.body.data.pagination.clientDirectory.total,
      );
      expect(secondPage.body.data.pagination.clientDirectory.page).toBe(2);
      expect(firstPage.body.data.clientDirectory[0].customerId).not.toBe(
        secondPage.body.data.clientDirectory[0].customerId,
      );
      expect(firstPage.body.data.summary.totalVisitingClients.current).toBe(
        secondPage.body.data.summary.totalVisitingClients.current,
      );
    });

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
      expect(res.body.data.summary.totalServicesCompleted.previous).toBe(0);
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
        accountingDate: new Date("2026-11-12T10:00:00.000Z"),
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
        accountingDate: new Date("2026-11-12T10:00:00.000Z"),
        createdAt: new Date("2026-11-12T10:00:00.000Z"),
      });
    });

    it("verifies low stock alerts isolate consumables from retail without hiding shortages", async () => {
      const res = await request(app)
        .get("/api/v1/reports/inventory?startDate=2026-11-01&endDate=2026-11-20&compareWith=none")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      const summary = res.body.data.summary;
      expect(summary.lowStockConsumablesCount).toBe(1);
      expect(summary.lowStockRetailCount).toBe(0);

      const alert = res.body.data.lowStockAlerts.find((a) => a.sku === "BLEACH-01");
      expect(alert).toBeDefined();
      expect(alert.usageType).toBe("salon_consumption");
      expect(alert.onHandConsumables).toBe(50);
      expect(alert.reorderLevel).toBe(100);
      expect(res.body.data.meta.branchId).toBeNull();
      expect(res.body.data.meta.comparisonStartDate).toBeNull();
      expect(res.body.data.meta.comparisonEndDate).toBeNull();
      expect(res.body.data.movementLogs.map((movement) => movement.stockDomain)).toEqual(
        expect.arrayContaining(["salon_consumables", "retail_products"]),
      );

      expect(summary.consumablesUsedInPeriod.current).toBe(10);
      expect(summary.auditNetDiscrepancyDelta).toBe(2);
      expect(summary.consumablesUsedInPeriod.previous).toBeNull();
    });

    it("uses accounting dates and nets partial movement reversals into period usage", async () => {
      const accountingDate = new Date("2026-11-12T10:00:00.000Z");
      const recordedAt = new Date("2026-11-25T10:00:00.000Z");
      const originalConsumption = await StockMovement.create({
        organizationId: organization._id,
        branchId: branch1._id,
        productId: consumableProduct._id,
        quantityDelta: -4,
        balanceAfter: 46,
        movementType: "service_consumption",
        stockDomain: "salon_consumables",
        reference: { entityType: "ServiceExecution" },
        actorId: ownerUser._id,
        accountingDate,
        createdAt: recordedAt,
      });
      await StockMovement.create({
        organizationId: organization._id,
        branchId: branch1._id,
        productId: consumableProduct._id,
        quantityDelta: 1,
        balanceAfter: 47,
        movementType: "movement_reversal",
        stockDomain: "salon_consumables",
        reference: { entityType: "StockMovement", entityId: originalConsumption._id },
        reversesMovementId: originalConsumption._id,
        actorId: ownerUser._id,
        accountingDate: new Date("2026-11-14T10:00:00.000Z"),
        createdAt: recordedAt,
      });

      const originalSale = await StockMovement.create({
        organizationId: organization._id,
        branchId: branch1._id,
        productId: retailProduct._id,
        quantityDelta: -3,
        balanceAfter: 22,
        movementType: "pos_sale",
        stockDomain: "retail_products",
        reference: { entityType: "Invoice" },
        actorId: ownerUser._id,
        accountingDate,
        createdAt: recordedAt,
      });
      const originalStocktake = await StockMovement.findOne({
        organizationId: organization._id,
        branchId: branch1._id,
        productId: retailProduct._id,
        movementType: "stocktake",
      });
      await StockMovement.create({
        organizationId: organization._id,
        branchId: branch1._id,
        productId: retailProduct._id,
        quantityDelta: 1,
        balanceAfter: 23,
        movementType: "movement_reversal",
        stockDomain: "retail_products",
        reference: { entityType: "StockMovement", entityId: originalSale._id },
        reversesMovementId: originalSale._id,
        actorId: ownerUser._id,
        accountingDate: new Date("2026-11-14T10:00:00.000Z"),
        createdAt: recordedAt,
      });
      await StockMovement.create({
        organizationId: organization._id,
        branchId: branch1._id,
        productId: retailProduct._id,
        quantityDelta: -1,
        balanceAfter: 24,
        movementType: "movement_reversal",
        stockDomain: "retail_products",
        reference: { entityType: "StockMovement", entityId: originalStocktake._id },
        reversesMovementId: originalStocktake._id,
        actorId: ownerUser._id,
        accountingDate: new Date("2026-11-14T10:00:00.000Z"),
        createdAt: recordedAt,
      });

      const res = await request(app)
        .get("/api/v1/reports/inventory?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.data.summary.consumablesUsedInPeriod.current).toBe(13);
      expect(res.body.data.summary.retailUnitsSoldInPeriod.current).toBe(2);
      expect(res.body.data.summary.auditNetDiscrepancyDelta).toBe(1);
      expect(res.body.data.movementLogs.some((movement) =>
        movement.timestamp.startsWith("2026-11-12T"))).toBe(true);
    });

    it("calculates period totals from all movements while limiting only the detail log", async () => {
      await StockMovement.insertMany(
        Array.from({ length: 51 }, (_, index) => ({
          organizationId: organization._id,
          branchId: branch1._id,
          productId: consumableProduct._id,
          quantityDelta: -1,
          balanceAfter: 1,
          movementType: "service_consumption",
          stockDomain: "salon_consumables",
          reference: { entityType: "ServiceExecution", identifier: `REPORT-LIMIT-${index}` },
          actorId: ownerUser._id,
          accountingDate: new Date("2026-11-15T10:00:00.000Z"),
          createdAt: new Date("2026-11-15T10:00:00.000Z"),
        })),
      );

      const res = await request(app)
        .get("/api/v1/reports/inventory?startDate=2026-11-01&endDate=2026-11-20&compareWith=none&lowStockPage=1&lowStockLimit=1&movementPage=1&movementLimit=1")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.data.summary.consumablesUsedInPeriod.current).toBe(64);
      expect(res.body.data.movementLogs).toHaveLength(1);

      const additionalProducts = await Product.create([
        {
          organizationId: organization._id,
          name: "Pagination Stock A",
          sku: "PAGINATION-STOCK-A",
          category: "Pagination Tests",
          usageType: "salon_consumption",
          stockUnit: "piece",
          reorderLevel: 5,
        },
        {
          organizationId: organization._id,
          name: "Pagination Stock B",
          sku: "PAGINATION-STOCK-B",
          category: "Pagination Tests",
          usageType: "salon_consumption",
          stockUnit: "piece",
          reorderLevel: 5,
        },
      ]);
      await StockBalance.create(
        additionalProducts.map((product) => ({
          organizationId: organization._id,
          branchId: branch1._id,
          productId: product._id,
          onHand: 0,
          onHandConsumables: 0,
          onHandRetail: 0,
        })),
      );

      const readInventoryPage = (lowStockPage, movementPage) =>
        request(app)
          .get(
            `/api/v1/reports/inventory?startDate=2026-11-01&endDate=2026-11-20&compareWith=none&lowStockPage=${lowStockPage}&lowStockLimit=1&movementPage=${movementPage}&movementLimit=1`,
          )
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("X-Branch-Id", branch1._id.toString());
      const [lowStockFirst, lowStockMiddle, lowStockFinal, movementsSecond] = await Promise.all([
        readInventoryPage(1, 1),
        readInventoryPage(2, 1),
        readInventoryPage(3, 1),
        readInventoryPage(1, 2),
      ]);

      expect(lowStockFirst.body.data.pagination.lowStockAlerts).toEqual(
        expect.objectContaining({ page: 1, limit: 1, total: 3, totalPages: 3 }),
      );
      expect(lowStockMiddle.body.data.pagination.lowStockAlerts.page).toBe(2);
      expect(lowStockFinal.body.data.pagination.lowStockAlerts.page).toBe(3);
      expect(new Set([
        lowStockFirst.body.data.lowStockAlerts[0].stockBalanceId,
        lowStockMiddle.body.data.lowStockAlerts[0].stockBalanceId,
        lowStockFinal.body.data.lowStockAlerts[0].stockBalanceId,
      ]).size).toBe(3);
      expect(lowStockFirst.body.data.pagination.movementLogs.total).toBeGreaterThan(1);
      expect(lowStockFirst.body.data.movementLogs[0].movementId).not.toBe(
        movementsSecond.body.data.movementLogs[0].movementId,
      );
      expect(lowStockFirst.body.data.summary.consumablesUsedInPeriod.current).toBe(
        lowStockMiddle.body.data.summary.consumablesUsedInPeriod.current,
      );
      expect(lowStockFirst.body.data.summary.consumablesUsedInPeriod.current).toBe(64);
    });
  });

  describe("Report table pagination contracts", () => {
    it("pages revenue and service rows without changing report totals and exports all filtered rows", async () => {
      const suffix = Date.now();
      const categoryA = await ServiceCategory.create({
        organizationId: organization._id,
        name: `Pagination Category A ${suffix}`,
      });
      const categoryB = await ServiceCategory.create({
        organizationId: organization._id,
        name: `Pagination Category B ${suffix}`,
      });
      const services = await Service.create([
        {
          organizationId: organization._id,
          name: `Pagination Service A ${suffix}`,
          categoryId: categoryA._id,
          duration: 30,
          pricing: { basePrice: 500 },
        },
        {
          organizationId: organization._id,
          name: `Pagination Service B ${suffix}`,
          categoryId: categoryA._id,
          duration: 45,
          pricing: { basePrice: 750 },
        },
        {
          organizationId: organization._id,
          name: `Pagination Service C ${suffix}`,
          categoryId: categoryB._id,
          duration: 60,
          pricing: { basePrice: 1000 },
        },
      ]);
      const finalizedAtValues = [
        new Date("2026-11-18T12:00:00.000Z"),
        new Date("2026-11-19T12:00:00.000Z"),
        new Date("2026-11-20T12:00:00.000Z"),
      ];
      const invoices = await Invoice.create(
        services.map((service, index) => {
          const amount = service.pricing.basePrice;
          return {
            organizationId: organization._id,
            branchId: branch1._id,
            invoiceNumber: `INV-PAGINATION-${suffix}-${index}`,
            invoiceType: "appointment",
            customerId: testCustomer._id,
            customerSnapshot: { name: testCustomer.name, phone: testCustomer.phone },
            lines: [
              {
                lineType: "service",
                serviceType: "registered",
                serviceId: service._id,
                name: service.name,
                duration: service.duration,
                quantity: 1,
                unitPrice: amount,
                lineTotal: amount,
                discountAmount: 0,
                customerPayable: amount,
                attribution: {
                  performedBy: {
                    staffId: stylistStaff1._id,
                    name: stylistStaff1.name,
                    staffCode: stylistStaff1.staffCode,
                  },
                },
              },
            ],
            subtotal: amount,
            discountTotal: 0,
            subscriptionCoveredAmount: 0,
            grossPayable: amount,
            payableAmount: amount,
            amountPaid: amount,
            amountDue: 0,
            status: "finalized",
            paymentStatus: "paid",
            createdBy: ownerUser._id,
            finalizedAt: finalizedAtValues[index],
          };
        }),
      );
      const expectedInvoiceIds = invoices
        .slice()
        .sort((a, b) => b.finalizedAt - a.finalizedAt || b._id.toString().localeCompare(a._id.toString()))
        .map((invoice) => invoice._id.toString());
      const getRevenuePage = (page) =>
        request(app)
          .get(
            `/api/v1/reports/revenue?startDate=2026-11-18&endDate=2026-11-20&compareWith=none&page=${page}&limit=1`,
          )
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("X-Branch-Id", branch1._id.toString());
      const [revenueFirst, revenueMiddle, revenueFinal] = await Promise.all([
        getRevenuePage(1),
        getRevenuePage(2),
        getRevenuePage(3),
      ]);

      expect(revenueFirst.body.data.pagination.recentTransactions).toEqual(
        expect.objectContaining({ page: 1, limit: 1, total: 3, totalPages: 3 }),
      );
      expect([
        revenueFirst.body.data.recentTransactions[0].invoiceId,
        revenueMiddle.body.data.recentTransactions[0].invoiceId,
        revenueFinal.body.data.recentTransactions[0].invoiceId,
      ]).toEqual(expectedInvoiceIds);
      expect(revenueFirst.body.data.summary.grossBilled.current).toBe(
        revenueFinal.body.data.summary.grossBilled.current,
      );

      const emptyPage = await request(app)
        .get("/api/v1/reports/revenue?startDate=2026-11-21&endDate=2026-11-21&compareWith=none&page=1&limit=1")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());
      expect(emptyPage.body.data.recentTransactions).toEqual([]);
      expect(emptyPage.body.data.pagination.recentTransactions).toEqual(
        expect.objectContaining({ page: 1, total: 0, totalPages: 0 }),
      );

      const getServicePage = (page, categoryPage) =>
        request(app)
          .get(
            `/api/v1/reports/service-analytics?startDate=2026-11-18&endDate=2026-11-20&compareWith=none&page=${page}&limit=1&categoryPage=${categoryPage}&categoryLimit=1`,
          )
          .set("Authorization", `Bearer ${ownerToken}`)
          .set("X-Branch-Id", branch1._id.toString());
      const [serviceFirst, serviceMiddle, serviceFinal] = await Promise.all([
        getServicePage(1, 1),
        getServicePage(2, 2),
        getServicePage(3, 2),
      ]);

      expect(serviceFirst.body.data.pagination.topServices).toEqual(
        expect.objectContaining({ page: 1, limit: 1, total: 3, totalPages: 3 }),
      );
      expect(serviceFirst.body.data.topServices[0].serviceId).not.toBe(
        serviceMiddle.body.data.topServices[0].serviceId,
      );
      expect(serviceMiddle.body.data.topServices[0].serviceId).not.toBe(
        serviceFinal.body.data.topServices[0].serviceId,
      );
      expect(serviceFirst.body.data.pagination.categoryShare.total).toBe(2);
      expect(serviceFirst.body.data.categoryShare[0].category).not.toBe(
        serviceMiddle.body.data.categoryShare[0].category,
      );
      expect(serviceFirst.body.data.summary.totalServicesCompleted.current).toBe(
        serviceFinal.body.data.summary.totalServicesCompleted.current,
      );

      const csvResponse = await request(app)
        .get("/api/v1/reports/revenue/export?startDate=2026-11-18&endDate=2026-11-20&compareWith=none&format=csv")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branch1._id.toString());
      expect(csvResponse.status).toBe(200);
      expect(csvResponse.text.split("\n")).toHaveLength(4);
      invoices.forEach((invoice) => expect(csvResponse.text).toContain(invoice.invoiceNumber));
    });
  });

  describe("6. Overview Partial Authorization", () => {
    it("denies report access when the authenticated user has no permissions", async () => {
      const res = await request(app)
        .get("/api/v1/reports/revenue?startDate=2026-11-01&endDate=2026-11-20")
        .set("Authorization", `Bearer ${stylistToken}`)
        .set("X-Branch-Id", branch1._id.toString());

      expect(res.status).toBe(403);
    });

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
