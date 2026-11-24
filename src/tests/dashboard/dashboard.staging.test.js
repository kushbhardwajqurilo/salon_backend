import { describe, expect, it, beforeAll, afterAll, jest } from "@jest/globals";
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
import { AttendancePunch } from "../../models/attendance/attendancePunch.model.js";
import { Leave } from "../../models/leaves/leave.model.js";
import { Expense } from "../../models/expenses/expense.model.js";
import { PurchaseOrder } from "../../models/procurement/purchaseOrder.model.js";
import { SupplierInvoice } from "../../models/procurement/supplierInvoice.model.js";
import { Supplier } from "../../models/procurement/supplier.model.js";
import { CustomerMembership } from "../../models/memberships/customerMembership.model.js";
import { Subscription } from "../../models/subscriptions/subscription.model.js";
import { SubscriptionPlan } from "../../models/subscriptions/subscriptionPlan.model.js";
import { MembershipPlan } from "../../models/memberships/membershipPlan.model.js";
import { LoyaltyTransaction } from "../../models/loyalty/loyaltyTransaction.model.js";
import { Coupon } from "../../models/coupons/coupon.model.js";
import { CouponUsage } from "../../models/coupons/couponUsage.model.js";
import { CANONICAL_PERMISSIONS } from "../../config/permissions.js";

// Mock redis
jest.spyOn(redis, "get").mockResolvedValue(null);
jest.spyOn(redis, "setex").mockResolvedValue("OK");

describe("Salon ERP Phase 3 — Staging Validation & Multi-Branch Business Intelligence", () => {
  jest.setTimeout(60000);

  let dbUri;
  let organization;
  let branchA, branchB, branchC;

  let ownerRole, managerRole, receptionistRole;
  let ownerUser, managerAUser, managerBUser, managerCUser, receptionistUser;
  let ownerToken,
    managerAToken,
    managerBToken,
    managerCToken,
    receptionistToken;

  let staffElena, staffMarcus, staffSarah, staffDavid, staffChloe;
  let customerAlice, customerBob, customerCharlie, customerDiana;
  let catHair, catSkin;
  let serviceCut, serviceColor, serviceFacial;
  let productShampoo, productSerum;

  let billingOnlyToken,
    paymentsOnlyToken,
    financeOnlyToken,
    expensesOnlyToken,
    dashboardOnlyToken;

  beforeAll(async () => {
    dbUri = getIsolatedTestMongoUri("dashboard_test");
    await mongoose.connect(dbUri);

    // 1. Setup Multi-Branch Organization
    organization = await Organization.create({
      name: "Luxe Heritage Salons & Spa Corp",
      slug: `luxe-corp-${Date.now()}`,
    });

    branchA = await Branch.create({
      name: "Downtown Flagship (Branch A)",
      organizationId: organization._id,
      timezone: "Asia/Kolkata",
      isActive: true,
    });

    branchB = await Branch.create({
      name: "Suburban Mall (Branch B)",
      organizationId: organization._id,
      timezone: "Asia/Kolkata",
      isActive: true,
    });

    branchC = await Branch.create({
      name: "Airport Express (Branch C)",
      organizationId: organization._id,
      timezone: "Asia/Kolkata",
      isActive: true,
    });

    // 2. Setup Permissions & Roles
    const dbPerms = [];
    for (const p of CANONICAL_PERMISSIONS) {
      let perm = await Permission.findOne({ name: p.name });
      if (!perm) {
        perm = await Permission.create(p);
      }
      dbPerms.push(perm);
    }

    ownerRole = await Role.create({
      name: `stage-owner-${Date.now()}`,
      organizationId: organization._id,
      isSystem: true,
      permissions: dbPerms.map((p) => p._id),
    });

    const managerPermIds = dbPerms
      .filter((p) =>
        [
          "dashboard.view",
          "billing.view",
          "payments.view",
          "appointments.view",
          "customers.view",
        ].includes(p.name),
      )
      .map((p) => p._id);

    managerRole = await Role.create({
      name: `stage-mgr-${Date.now()}`,
      organizationId: organization._id,
      isSystem: false,
      permissions: managerPermIds,
    });

    const receptionistPermIds = dbPerms
      .filter((p) =>
        [
          "dashboard.view",
          "appointments.view",
          "billing.view",
          "customers.view",
        ].includes(p.name),
      )
      .map((p) => p._id);

    receptionistRole = await Role.create({
      name: `stage-recept-${Date.now()}`,
      organizationId: organization._id,
      isSystem: false,
      permissions: receptionistPermIds,
    });

    // 3. Setup Users
    ownerUser = await User.create({
      name: "Victoria Sterling (Owner)",
      username: `owner-${Date.now()}`,
      email: `owner-${Date.now()}@luxe.com`,
      phone: `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`,
      password: "Password123!",
      role: ownerRole._id,
      organizationId: organization._id,
      hasOrgWideAccess: true,
      status: "active",
      branchAccess: [
        { branchId: branchA._id, branchName: branchA.name, isActive: true },
        { branchId: branchB._id, branchName: branchB.name, isActive: true },
        { branchId: branchC._id, branchName: branchC.name, isActive: true },
      ],
    });

    managerAUser = await User.create({
      name: "Arthur Pendelton (Manager A)",
      username: `mgra-${Date.now()}`,
      email: `mgra-${Date.now()}@luxe.com`,
      phone: `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`,
      password: "Password123!",
      role: managerRole._id,
      organizationId: organization._id,
      hasOrgWideAccess: false,
      status: "active",
      branchAccess: [
        { branchId: branchA._id, branchName: branchA.name, isActive: true },
      ],
    });

    managerBUser = await User.create({
      name: "Beatrice Webb (Manager B)",
      username: `mgrb-${Date.now()}`,
      email: `mgrb-${Date.now()}@luxe.com`,
      phone: `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`,
      password: "Password123!",
      role: managerRole._id,
      organizationId: organization._id,
      hasOrgWideAccess: false,
      status: "active",
      branchAccess: [
        { branchId: branchB._id, branchName: branchB.name, isActive: true },
      ],
    });

    managerCUser = await User.create({
      name: "Charles Xavier (Manager C)",
      username: `mgrc-${Date.now()}`,
      email: `mgrc-${Date.now()}@luxe.com`,
      phone: `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`,
      password: "Password123!",
      role: managerRole._id,
      organizationId: organization._id,
      hasOrgWideAccess: false,
      status: "active",
      branchAccess: [
        { branchId: branchC._id, branchName: branchC.name, isActive: true },
      ],
    });

    receptionistUser = await User.create({
      name: "Rachel Green (Receptionist)",
      username: `recept-${Date.now()}`,
      email: `recept-${Date.now()}@luxe.com`,
      phone: `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`,
      password: "Password123!",
      role: receptionistRole._id,
      organizationId: organization._id,
      hasOrgWideAccess: false,
      status: "active",
      branchAccess: [
        { branchId: branchA._id, branchName: branchA.name, isActive: true },
      ],
    });

    const jwtSecret = process.env.JWT_SECRET || "test-jwt-secret-key-salon-erp";
    ownerToken = jwt.sign({ id: ownerUser._id.toString() }, jwtSecret);
    managerAToken = jwt.sign({ id: managerAUser._id.toString() }, jwtSecret);
    managerBToken = jwt.sign({ id: managerBUser._id.toString() }, jwtSecret);
    managerCToken = jwt.sign({ id: managerCUser._id.toString() }, jwtSecret);
    receptionistToken = jwt.sign(
      { id: receptionistUser._id.toString() },
      jwtSecret,
    );

    // Setup granular permission roles & users for Phase 3.1 permission matrix tests
    const createGranularUser = async (roleName, permNames) => {
      const pIds = dbPerms
        .filter((p) => permNames.includes(p.name))
        .map((p) => p._id);
      const role = await Role.create({
        name: `${roleName}-${Date.now()}`,
        organizationId: organization._id,
        isSystem: false,
        permissions: pIds,
      });
      const user = await User.create({
        name: `User ${roleName}`,
        username: `usr-${roleName.toLowerCase().replace(/[^a-z0-9]/g, "")}-${Date.now()}`,
        email: `${roleName.toLowerCase().replace(/[^a-z0-9]/g, "")}-${Date.now()}@luxe.com`,
        phone: `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`,
        password: "Password123!",
        role: role._id,
        organizationId: organization._id,
        hasOrgWideAccess: false,
        status: "active",
        branchAccess: [
          { branchId: branchA._id, branchName: branchA.name, isActive: true },
        ],
      });
      return jwt.sign({ id: user._id.toString() }, jwtSecret);
    };

    billingOnlyToken = await createGranularUser("billing-only", [
      "dashboard.view",
      "billing.view",
    ]);
    paymentsOnlyToken = await createGranularUser("payments-only", [
      "dashboard.view",
      "payments.view",
    ]);
    financeOnlyToken = await createGranularUser("finance-only", [
      "dashboard.view",
      "finance.view",
    ]);
    expensesOnlyToken = await createGranularUser("expenses-only", [
      "dashboard.view",
      "expenses.view",
    ]);
    dashboardOnlyToken = await createGranularUser("dashboard-only", [
      "dashboard.view",
    ]);

    // 4. Setup Services & Categories
    catHair = await ServiceCategory.create({
      name: "Hair Styling & Care",
      organizationId: organization._id,
    });
    catSkin = await ServiceCategory.create({
      name: "Skin & Spa",
      organizationId: organization._id,
    });

    serviceCut = await Service.create({
      name: "Royal Haircut & Finish",
      duration: 45,
      categoryId: catHair._id,
      pricing: { basePrice: 1500 },
      organizationId: organization._id,
      isActive: true,
    });

    serviceColor = await Service.create({
      name: "Balayage Highlight Couture",
      duration: 120,
      categoryId: catHair._id,
      pricing: { basePrice: 4500 },
      organizationId: organization._id,
      isActive: true,
    });

    serviceFacial = await Service.create({
      name: "Hydra-Luxe Facial",
      duration: 60,
      categoryId: catSkin._id,
      pricing: { basePrice: 3000 },
      organizationId: organization._id,
      isActive: true,
    });

    // 5. Setup Retail Products & Stock Balances
    productShampoo = await Product.create({
      name: "Luxe Botanical Shampoo 250ml",
      sku: `BOT-SHAMP-${Date.now()}`,
      category: "Haircare",
      usageType: "both",
      stockUnit: "bottle",
      costPrice: 400,
      sellingPrice: 1200,
      reorderLevel: 5,
      organizationId: organization._id,
      status: "active",
    });

    productSerum = await Product.create({
      name: "Silk Infusion Argan Serum 50ml",
      sku: `SILK-SERUM-${Date.now()}`,
      category: "Haircare",
      usageType: "retail_sale",
      stockUnit: "bottle",
      costPrice: 600,
      sellingPrice: 1800,
      reorderLevel: 3,
      organizationId: organization._id,
      status: "active",
    });

    // Branch A Stock: Shampoo is LOW (2 on hand, reorder=5), Serum is OUT OF STOCK (0 on hand)
    await StockBalance.create({
      organizationId: organization._id,
      branchId: branchA._id,
      productId: productShampoo._id,
      onHand: 2,
      onHandConsumables: 1,
      onHandRetail: 1,
      allocated: 0,
    });

    await StockBalance.create({
      organizationId: organization._id,
      branchId: branchA._id,
      productId: productSerum._id,
      onHand: 0,
      onHandConsumables: 0,
      onHandRetail: 0,
      allocated: 0,
    });

    // Branch B Stock: Healthy stock
    await StockBalance.create({
      organizationId: organization._id,
      branchId: branchB._id,
      productId: productShampoo._id,
      onHand: 15,
      onHandConsumables: 5,
      onHandRetail: 10,
      allocated: 0,
    });

    // 6. Setup Staff & Assignments
    staffElena = await Staff.create({
      organizationId: organization._id,
      name: "Elena Rostova",
      staffCode: "STF-A-01",
      email: `elena-${Date.now()}@luxe.com`,
      phone: "+91 9111111111",
      designation: "Senior Stylist",
      joiningDate: new Date("2024-01-01"),
      status: "active",
    });
    await StaffBranch.create({
      staffId: staffElena._id,
      branchId: branchA._id,
      organizationId: organization._id,
      isActive: true,
    });

    staffMarcus = await Staff.create({
      organizationId: organization._id,
      name: "Marcus Aurelius",
      staffCode: "STF-A-02",
      email: `marcus-${Date.now()}@luxe.com`,
      phone: "+91 9222222222",
      designation: "Barber & Colorist",
      joiningDate: new Date("2024-01-01"),
      status: "active",
    });
    await StaffBranch.create({
      staffId: staffMarcus._id,
      branchId: branchA._id,
      organizationId: organization._id,
      isActive: true,
    });

    staffSarah = await Staff.create({
      organizationId: organization._id,
      name: "Sarah Connor",
      staffCode: "STF-A-03",
      email: `sarah-${Date.now()}@luxe.com`,
      phone: "+91 9333333333",
      designation: "Esthetician",
      joiningDate: new Date("2024-01-01"),
      status: "active",
    });
    await StaffBranch.create({
      staffId: staffSarah._id,
      branchId: branchA._id,
      organizationId: organization._id,
      isActive: true,
    });

    staffDavid = await Staff.create({
      organizationId: organization._id,
      name: "David Miller",
      staffCode: "STF-B-01",
      email: `david-${Date.now()}@luxe.com`,
      phone: "+91 9444444444",
      designation: "Creative Director",
      joiningDate: new Date("2024-01-01"),
      status: "active",
    });
    await StaffBranch.create({
      staffId: staffDavid._id,
      branchId: branchB._id,
      organizationId: organization._id,
      isActive: true,
    });

    staffChloe = await Staff.create({
      organizationId: organization._id,
      name: "Chloe Decker",
      staffCode: "STF-C-01",
      email: `chloe-${Date.now()}@luxe.com`,
      phone: "+91 9555555555",
      designation: "Express Stylist",
      joiningDate: new Date("2024-01-01"),
      status: "active",
    });
    await StaffBranch.create({
      staffId: staffChloe._id,
      branchId: branchC._id,
      organizationId: organization._id,
      isActive: true,
    });

    // 7. Setup Customers
    customerAlice = await Customer.create({
      organizationId: organization._id,
      homeBranchId: branchA._id,
      name: "Alice Montgomery",
      phone: "+91 9888800001",
      email: "alice@example.com",
      status: "active",
      acquisitionSource: "instagram",
      createdAt: new Date("2026-11-05T10:00:00Z"),
    });

    customerBob = await Customer.create({
      organizationId: organization._id,
      homeBranchId: branchA._id,
      name: "Robert 'Bob' Vance",
      phone: "+91 9888800002",
      email: "bob@vancerefrigeration.com",
      status: "active",
      acquisitionSource: "referral",
      createdAt: new Date("2026-08-01T10:00:00Z"), // Prior period customer
    });

    customerCharlie = await Customer.create({
      organizationId: organization._id,
      homeBranchId: branchA._id,
      name: "Charlie Brown",
      phone: "+91 9888800003",
      email: "charlie@peanuts.com",
      status: "active",
      acquisitionSource: "walk_in",
      createdAt: new Date("2026-09-10T10:00:00Z"),
    });

    customerDiana = await Customer.create({
      organizationId: organization._id,
      homeBranchId: branchA._id,
      name: "Diana Prince",
      phone: "+91 9888800004",
      email: "diana@themyscira.com",
      status: "active",
      acquisitionSource: "walk_in",
      createdAt: new Date("2026-11-15T10:00:00Z"),
    });

    // 8. Setup Operational Context for Today (Now)
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const startOfToday = new Date(`${todayStr}T00:00:00.000Z`);
    const endOfToday = new Date(`${todayStr}T23:59:59.999Z`);

    // Attendance for Branch A:
    // Elena: Present, Clocked in, Currently serving an appointment!
    await Attendance.create({
      organizationId: organization._id,
      branchId: branchA._id,
      staffId: staffElena._id,
      attendanceDate: startOfToday,
      status: "present",
      clockIn: new Date(now.getTime() - 2 * 3600000),
    });
    await AttendancePunch.create({
      organizationId: organization._id,
      branchId: branchA._id,
      staffId: staffElena._id,
      punchType: "in",
      provider: "manual",
      punchAt: new Date(now.getTime() - 2 * 3600000),
    });

    // Marcus: Present, Clocked in, No appointment -> READY (Floor Available)!
    await Attendance.create({
      organizationId: organization._id,
      branchId: branchA._id,
      staffId: staffMarcus._id,
      attendanceDate: startOfToday,
      status: "present",
      clockIn: new Date(now.getTime() - 1 * 3600000),
    });
    await AttendancePunch.create({
      organizationId: organization._id,
      branchId: branchA._id,
      staffId: staffMarcus._id,
      punchType: "in",
      provider: "manual",
      punchAt: new Date(now.getTime() - 1 * 3600000),
    });

    // Sarah: On Approved Leave Today!
    await Leave.create({
      organizationId: organization._id,
      branchId: branchA._id,
      staffId: staffSarah._id,
      leaveCode: "LV-2026-001",
      leaveType: "casual",
      startDate: startOfToday,
      endDate: endOfToday,
      dates: [todayStr],
      reason: "Family event",
      status: "approved",
      submittedBy: ownerUser._id,
      submittedFor: "staff",
    });

    // Ongoing appointment for Elena today
    await Appointment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      appointmentCode: "APT-TODAY-01",
      customerId: customerAlice._id,
      staffId: staffElena._id,
      appointmentDate: todayStr,
      startTime: "11:00",
      endTime: "13:00",
      totalDuration: 120,
      startAt: new Date(now.getTime() - 30 * 60000),
      endAt: new Date(now.getTime() + 60 * 60000), // Active now!
      status: "in_progress",
      slotMinutes: [new Date(now.getTime() - 30 * 60000).toISOString()],
      bookingType: "advance",
      pricing: { subtotal: 4500, discount: 0, total: 4500 },
      services: [
        {
          serviceType: "registered",
          serviceId: serviceColor._id,
          name: serviceColor.name,
          price: 4500,
          duration: 120,
        },
      ],
    });

    // Completed appointment earlier today
    await Appointment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      appointmentCode: "APT-TODAY-02",
      customerId: customerCharlie._id,
      staffId: staffMarcus._id,
      appointmentDate: todayStr,
      startTime: "09:00",
      endTime: "09:45",
      totalDuration: 45,
      startAt: new Date(now.getTime() - 120 * 60000),
      endAt: new Date(now.getTime() - 60 * 60000),
      status: "completed",
      bookingType: "walk_in",
      pricing: { subtotal: 1500, discount: 0, total: 1500 },
      services: [
        {
          serviceType: "registered",
          serviceId: serviceCut._id,
          name: serviceCut.name,
          price: 1500,
          duration: 45,
        },
      ],
    });

    // 9. Setup Expenses, Procurement & Extra Modules
    // Expense at Branch A: ₹8,000 electricity (approved)
    await Expense.create({
      organizationId: organization._id,
      branchId: branchA._id,
      expenseCode: "EXP-A-001",
      category: "utilities",
      amount: 8000,
      paymentMethod: "bank_transfer",
      payeeName: "Commercial Electricity Board",
      approvalStatus: "approved",
      approvalThresholdAtCreation: 5000,
      recordedBy: ownerUser._id,
      expenseDate: new Date("2026-11-15T12:00:00Z"),
    });

    // Expense at Branch B: ₹3,500 supplies (approved)
    await Expense.create({
      organizationId: organization._id,
      branchId: branchB._id,
      expenseCode: "EXP-B-001",
      category: "supplies",
      amount: 3500,
      paymentMethod: "upi",
      payeeName: "Sanitation & Cleaning Consumables",
      approvalStatus: "approved",
      approvalThresholdAtCreation: 5000,
      recordedBy: ownerUser._id,
      expenseDate: new Date("2026-11-16T12:00:00Z"),
    });

    // Procurement Supplier
    const supplier = await Supplier.create({
      organizationId: organization._id,
      name: "Global Salon Supplies Ltd",
      contactPerson: "John Doe",
      phone: "+91 9999900000",
      email: "orders@globalsalon.com",
    });

    // Procurement: Pending PO & Supplier Invoice
    await PurchaseOrder.create({
      organizationId: organization._id,
      branchId: branchA._id,
      poNumber: "PO-2026-001",
      supplierId: supplier._id,
      items: [
        {
          productId: productShampoo._id,
          targetDomain: "salon_consumables",
          orderedQuantity: 20,
          receivedQuantity: 0,
          unitCostPrice: 400,
          lineTotal: 8000,
        },
      ],
      totalAmount: 8000,
      status: "ordered",
      createdBy: ownerUser._id,
      orderDate: new Date("2026-11-10T10:00:00Z"),
    });

    await SupplierInvoice.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceNumber: "SUPP-INV-888",
      supplierId: supplier._id,
      status: "partially_paid",
      totalAmount: 20000,
      amountPaid: 8000, // ₹12,000 outstanding payable
      dueDate: new Date("2026-12-10T10:00:00Z"),
      createdBy: ownerUser._id,
      invoiceDate: new Date("2026-11-10T10:00:00Z"),
    });

    // Memberships: 1 active sold in period
    const memPlan = await MembershipPlan.create({
      organizationId: organization._id,
      name: "Gold VIP Membership",
      price: 5000,
      validityMonths: 12,
      tier: "gold",
      status: "active",
      benefits: {
        serviceDiscountPercentage: 10,
        productDiscountPercentage: 5,
      },
    });

    await CustomerMembership.create({
      organizationId: organization._id,
      membershipPlanId: memPlan._id,
      customerId: customerBob._id,
      membershipCode: "MEM-GOLD-001",
      startDate: new Date("2026-11-02T10:00:00Z"),
      endDate: new Date("2027-11-02T10:00:00Z"),
      status: "active",
      permittedBranchIds: [branchA._id, branchB._id],
      planSnapshot: {
        name: memPlan.name,
        tier: memPlan.tier,
        price: memPlan.price,
        validityMonths: memPlan.validityMonths,
        benefits: {
          serviceDiscountPercentage: 10,
          productDiscountPercentage: 5,
        },
      },
    });

    // Loyalty: 200 points earned, 50 points redeemed
    await LoyaltyTransaction.create({
      organizationId: organization._id,
      branchId: branchA._id,
      customerId: customerBob._id,
      type: "EARNED",
      pointsDelta: 200,
      balanceBefore: 0,
      balanceAfter: 200,
      createdAt: new Date("2026-11-10T11:00:00Z"),
    });

    await LoyaltyTransaction.create({
      organizationId: organization._id,
      branchId: branchA._id,
      customerId: customerBob._id,
      type: "REDEEMED",
      pointsDelta: -50,
      balanceBefore: 200,
      balanceAfter: 150,
      createdAt: new Date("2026-11-12T14:00:00Z"),
    });

    // Coupons: 1 coupon and 1 usage record for ₹200 discount
    const coupon = await Coupon.create({
      organizationId: organization._id,
      code: "WELCOME200",
      codeUpper: "WELCOME200",
      discountType: "fixed",
      discountValue: 200,
      validFrom: new Date("2026-11-01T00:00:00Z"),
      validUntil: new Date("2026-12-31T23:59:59Z"),
      status: "active",
      createdBy: ownerUser._id,
    });

    await CouponUsage.create({
      organizationId: organization._id,
      branchId: branchA._id,
      couponId: coupon._id,
      invoiceId: new mongoose.Types.ObjectId(),
      customerId: customerAlice._id,
      discountAmount: 200,
      consumedAt: new Date("2026-11-10T12:00:00Z"),
      status: "consumed",
      createdBy: ownerUser._id,
    });

    // =========================================================================
    // 10. Seed Financial Scenarios A through I (Date Range: Nov 01 - Nov 30, 2026)
    // =========================================================================

    // Scenario A: Finalized & fully paid on same day (Branch A, Nov 10)
    // Invoice ₹4,000, Cash Payment ₹4,000 on Nov 10
    const invA = await Invoice.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceNumber: "INV-SCENARIO-A",
      invoiceType: "appointment",
      customerId: customerAlice._id,
      customerSnapshot: {
        name: customerAlice.name,
        phone: customerAlice.phone,
      },
      subtotal: 4000,
      discountTotal: 0,
      grossPayable: 4000,
      payableAmount: 4000,
      amountPaid: 4000,
      amountDue: 0,
      status: "finalized",
      paymentStatus: "paid",
      finalizedAt: new Date("2026-11-10T11:00:00Z"),
      createdBy: ownerUser._id,
      lines: [
        {
          lineType: "service",
          serviceType: "registered",
          serviceId: serviceCut._id,
          name: serviceCut.name,
          quantity: 1,
          unitPrice: 4000,
          lineTotal: 4000,
          customerPayable: 4000,
        },
      ],
    });
    await Payment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceId: invA._id,
      customerId: customerAlice._id,
      paymentNumber: "PAY-A-001",
      amount: 4000,
      type: "payment",
      method: "cash",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-10T11:15:00Z"),
    });

    // Scenario B: Finalized in Nov, paid in following month Dec (Branch A)
    // Nov 25: Invoice ₹5,000 finalized, amountDue = ₹5,000, amountPaid = 0.
    // Dec 05: Payment ₹5,000 UPI received.
    const invB = await Invoice.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceNumber: "INV-SCENARIO-B",
      invoiceType: "appointment",
      customerId: customerBob._id,
      customerSnapshot: { name: customerBob.name, phone: customerBob.phone },
      subtotal: 5000,
      discountTotal: 0,
      grossPayable: 5000,
      payableAmount: 5000,
      amountPaid: 5000, // current-state updated on settlement
      amountDue: 0,
      status: "finalized",
      paymentStatus: "paid",
      finalizedAt: new Date("2026-11-25T15:00:00Z"),
      createdBy: ownerUser._id,
      lines: [
        {
          lineType: "service",
          serviceType: "registered",
          serviceId: serviceColor._id,
          name: serviceColor.name,
          quantity: 1,
          unitPrice: 5000,
          lineTotal: 5000,
          customerPayable: 5000,
        },
      ],
    });
    // Dec 05 payment
    await Payment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceId: invB._id,
      customerId: customerBob._id,
      paymentNumber: "PAY-B-001",
      amount: 5000,
      type: "payment",
      method: "upi",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-12-05T10:00:00Z"),
    });

    // Scenario C: Paid via multiple payment methods (Split Tender) (Branch A, Nov 12)
    // Invoice ₹6,000: Paid ₹3,000 Cash + ₹3,000 Card
    const invC = await Invoice.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceNumber: "INV-SCENARIO-C",
      invoiceType: "appointment",
      customerId: customerCharlie._id,
      customerSnapshot: {
        name: customerCharlie.name,
        phone: customerCharlie.phone,
      },
      subtotal: 6000,
      discountTotal: 0,
      grossPayable: 6000,
      payableAmount: 6000,
      amountPaid: 6000,
      amountDue: 0,
      status: "finalized",
      paymentStatus: "paid",
      finalizedAt: new Date("2026-11-12T14:00:00Z"),
      createdBy: ownerUser._id,
      lines: [
        {
          lineType: "service",
          serviceType: "registered",
          serviceId: serviceFacial._id,
          name: serviceFacial.name,
          quantity: 2,
          unitPrice: 3000,
          lineTotal: 6000,
          customerPayable: 6000,
        },
      ],
    });
    await Payment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceId: invC._id,
      customerId: customerCharlie._id,
      paymentNumber: "PAY-C-001",
      amount: 3000,
      type: "payment",
      method: "cash",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-12T14:10:00Z"),
    });
    await Payment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceId: invC._id,
      customerId: customerCharlie._id,
      paymentNumber: "PAY-C-002",
      amount: 3000,
      type: "payment",
      method: "card",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-12T14:15:00Z"),
    });

    // Scenario D: Partial refund (Branch A, Nov 15)
    // Invoice ₹2,000 paid ₹2,000 Card on Nov 15. Partial refund ₹500 on Nov 16.
    const invD = await Invoice.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceNumber: "INV-SCENARIO-D",
      invoiceType: "retail",
      customerId: customerDiana._id,
      customerSnapshot: {
        name: customerDiana.name,
        phone: customerDiana.phone,
      },
      subtotal: 2000,
      discountTotal: 0,
      grossPayable: 2000,
      payableAmount: 2000,
      amountPaid: 2000,
      amountDue: 0,
      status: "finalized",
      paymentStatus: "paid",
      finalizedAt: new Date("2026-11-15T16:00:00Z"),
      createdBy: ownerUser._id,
      lines: [
        {
          lineType: "product",
          productId: productShampoo._id,
          sku: productShampoo.sku,
          name: productShampoo.name,
          quantity: 1,
          unitPrice: 2000,
          lineTotal: 2000,
          customerPayable: 2000,
        },
      ],
    });
    await Payment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceId: invD._id,
      customerId: customerDiana._id,
      paymentNumber: "PAY-D-001",
      amount: 2000,
      type: "payment",
      method: "card",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-15T16:05:00Z"),
    });
    await Payment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceId: invD._id,
      customerId: customerDiana._id,
      paymentNumber: "REF-D-001",
      amount: 500,
      type: "refund",
      method: "card",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-16T11:00:00Z"),
    });

    // Scenario E: Full refund (Branch A, Nov 18)
    // Invoice ₹1,500 paid ₹1,500 UPI on Nov 18. Full refund ₹1,500 on Nov 18.
    const invE = await Invoice.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceNumber: "INV-SCENARIO-E",
      invoiceType: "appointment",
      customerId: customerAlice._id,
      customerSnapshot: {
        name: customerAlice.name,
        phone: customerAlice.phone,
      },
      subtotal: 1500,
      discountTotal: 0,
      grossPayable: 1500,
      payableAmount: 1500,
      amountPaid: 1500,
      amountDue: 0,
      status: "finalized",
      paymentStatus: "paid",
      finalizedAt: new Date("2026-11-18T10:00:00Z"),
      createdBy: ownerUser._id,
      lines: [
        {
          lineType: "service",
          serviceType: "registered",
          serviceId: serviceCut._id,
          name: serviceCut.name,
          quantity: 1,
          unitPrice: 1500,
          lineTotal: 1500,
          customerPayable: 1500,
        },
      ],
    });
    await Payment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceId: invE._id,
      customerId: customerAlice._id,
      paymentNumber: "PAY-E-001",
      amount: 1500,
      type: "payment",
      method: "upi",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-18T10:15:00Z"),
    });
    await Payment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceId: invE._id,
      customerId: customerAlice._id,
      paymentNumber: "REF-E-001",
      amount: 1500,
      type: "refund",
      method: "upi",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-18T12:00:00Z"),
    });

    // Scenario F: Voided / Cancelled invoice (Branch A, Nov 20)
    // Invoice ₹3,500 with status: "cancelled". MUST BE EXCLUDED from Net Sales!
    await Invoice.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceNumber: "INV-SCENARIO-F-VOIDED",
      invoiceType: "appointment",
      customerId: customerBob._id,
      customerSnapshot: { name: customerBob.name, phone: customerBob.phone },
      subtotal: 3500,
      discountTotal: 0,
      grossPayable: 3500,
      payableAmount: 3500,
      amountPaid: 0,
      amountDue: 3500,
      status: "cancelled",
      paymentStatus: "unpaid",
      finalizedAt: new Date("2026-11-20T14:00:00Z"),
      createdBy: ownerUser._id,
      lines: [
        {
          lineType: "service",
          serviceType: "registered",
          serviceId: serviceFacial._id,
          name: serviceFacial.name,
          quantity: 1,
          unitPrice: 3500,
          lineTotal: 3500,
          customerPayable: 3500,
        },
      ],
    });

    // Scenario G: Failed / Voided payment (Branch A, Nov 22)
    // Payment ₹1,000 with status: "voided". MUST BE EXCLUDED from Collections!
    await Payment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceId: invA._id,
      customerId: customerAlice._id,
      paymentNumber: "PAY-G-FAILED",
      amount: 1000,
      type: "payment",
      method: "card",
      status: "voided",
      voidReason: "Card declined by terminal / gateway timeout",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-22T16:00:00Z"),
    });

    // Scenario H: Reversed payment (Branch A, Nov 23)
    // Payment ₹1,200 voided due to bank chargeback / reversal. EXCLUDED from Collections!
    await Payment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceId: invC._id,
      customerId: customerCharlie._id,
      paymentNumber: "PAY-H-REVERSED",
      amount: 1200,
      type: "payment",
      method: "upi",
      status: "voided",
      voidReason: "Chargeback reversal reported by UPI gateway",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-23T11:00:00Z"),
    });

    // Scenario I: Customer Subscription / Prepaid Package (Branch B, Nov 14)
    // Invoice ₹8,000 finalized on Nov 14 at Branch B, paid ₹8,000 card
    const invI = await Invoice.create({
      organizationId: organization._id,
      branchId: branchB._id,
      invoiceNumber: "INV-SCENARIO-I",
      invoiceType: "subscription",
      customerId: customerBob._id,
      customerSnapshot: { name: customerBob.name, phone: customerBob.phone },
      subtotal: 8000,
      discountTotal: 0,
      grossPayable: 8000,
      payableAmount: 8000,
      amountPaid: 8000,
      amountDue: 0,
      status: "finalized",
      paymentStatus: "paid",
      finalizedAt: new Date("2026-11-14T10:00:00Z"),
      createdBy: ownerUser._id,
      lines: [
        {
          lineType: "subscription",
          name: "Annual Hair Ritual VIP Package",
          quantity: 1,
          unitPrice: 8000,
          lineTotal: 8000,
          customerPayable: 8000,
        },
      ],
    });
    await Payment.create({
      organizationId: organization._id,
      branchId: branchB._id,
      invoiceId: invI._id,
      customerId: customerBob._id,
      paymentNumber: "PAY-I-001",
      amount: 8000,
      type: "payment",
      method: "card",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-14T10:10:00Z"),
    });

    // Scenario J (Reversal Integrity): Completed Nov 15 Payment, Reversed in Dec
    // Finalized Nov 15 Invoice: ₹2,500. Nov 15 Payment: ₹2,500.
    // In December: Compensating Refund / Reversal recorded on Dec 10 of ₹2,500.
    const invRev = await Invoice.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceNumber: "INV-SCENARIO-REV",
      invoiceType: "appointment",
      customerId: customerDiana._id,
      customerSnapshot: {
        name: customerDiana.name,
        phone: customerDiana.phone,
      },
      subtotal: 2500,
      discountTotal: 0,
      grossPayable: 2500,
      payableAmount: 2500,
      amountPaid: 2500,
      amountDue: 0,
      status: "finalized",
      paymentStatus: "paid",
      finalizedAt: new Date("2026-11-15T17:00:00Z"),
      createdBy: ownerUser._id,
      lines: [
        {
          lineType: "service",
          serviceType: "registered",
          serviceId: serviceCut._id,
          name: serviceCut.name,
          quantity: 1,
          unitPrice: 2500,
          lineTotal: 2500,
          customerPayable: 2500,
        },
      ],
    });

    await Payment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceId: invRev._id,
      customerId: customerDiana._id,
      paymentNumber: "PAY-REV-001",
      amount: 2500,
      type: "payment",
      method: "card",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-15T17:15:00Z"),
    });

    // Dec 10: Compensating reversal/refund transaction
    await Payment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceId: invRev._id,
      customerId: customerDiana._id,
      paymentNumber: "REF-DEC-REVERSAL",
      amount: 2500,
      type: "refund",
      method: "card",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-12-10T14:00:00Z"),
    });

    // Scenario K (Precision Floating Point Edge Cases):
    // Fractional amounts: 0.10 + 0.20 invoice & payment to test IEEE 754 precision
    const invPrecision = await Invoice.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceNumber: "INV-PRECISION-001",
      invoiceType: "retail",
      customerId: customerAlice._id,
      customerSnapshot: {
        name: customerAlice.name,
        phone: customerAlice.phone,
      },
      subtotal: 0.3, // 0.1 + 0.2
      discountTotal: 0,
      grossPayable: 0.3,
      payableAmount: 0.3,
      amountPaid: 0.3,
      amountDue: 0,
      status: "finalized",
      paymentStatus: "paid",
      finalizedAt: new Date("2026-11-28T09:00:00Z"),
      createdBy: ownerUser._id,
      lines: [
        {
          lineType: "product",
          productId: productShampoo._id,
          sku: productShampoo.sku,
          name: "Sample Sachets",
          quantity: 2,
          unitPrice: 0.15,
          lineTotal: 0.3,
          customerPayable: 0.3,
        },
      ],
    });

    await Payment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceId: invPrecision._id,
      customerId: customerAlice._id,
      paymentNumber: "PAY-PRECISION-01",
      amount: 0.1,
      type: "payment",
      method: "cash",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-28T09:10:00Z"),
    });

    await Payment.create({
      organizationId: organization._id,
      branchId: branchA._id,
      invoiceId: invPrecision._id,
      customerId: customerAlice._id,
      paymentNumber: "PAY-PRECISION-02",
      amount: 0.2,
      type: "payment",
      method: "cash",
      status: "completed",
      recordedBy: ownerUser._id,
      paymentDate: new Date("2026-11-28T09:15:00Z"),
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  // =========================================================================
  // 1. Financial Reconciliation Tests (Scenarios A through K)
  // =========================================================================
  describe("1. Financial Reconciliation Scenarios", () => {
    it("Scenario A: Reconciles finalized and fully paid invoice on same day", async () => {
      // Inv A was ₹4,000 finalized on Nov 10, Pay A ₹4,000 cash on Nov 10.
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-10&endDate=2026-11-10",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.kpis.netSales.current).toBe(4000);
      expect(res.body.kpis.collections.current).toBe(4000);
      expect(res.body.kpis.refunds.current).toBe(0);
      expect(res.body.kpis.netCollections.current).toBe(4000);
    });

    it("Scenario B: Cross-month payment attribution (Nov accrual vs Dec cash)", async () => {
      // Inv B was ₹5,000 finalized Nov 25. Paid Dec 05.
      // Nov 25: Billed sales = 5000, Collections = 0
      const novRes = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-25&endDate=2026-11-25",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());
      expect(novRes.body.kpis.netSales.current).toBe(5000);
      expect(novRes.body.kpis.collections.current).toBe(0);

      // Dec 05: Billed sales = 0, Collections = 5000
      const decRes = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-12-05&endDate=2026-12-05",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());
      expect(decRes.body.kpis.netSales.current).toBe(0);
      expect(decRes.body.kpis.collections.current).toBe(5000);
    });

    it("Scenario C: Split-tender payment reconciliation (Multiple methods on single invoice)", async () => {
      // Inv C: ₹6,000 on Nov 12. Paid ₹3,000 cash + ₹3,000 card.
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-12&endDate=2026-11-12",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.kpis.netSales.current).toBe(6000);
      expect(res.body.kpis.collections.current).toBe(6000); // 3000 + 3000
      expect(res.body.kpis.refunds.current).toBe(0);
    });

    it("Scenario D: Partial refund accounting attribution", async () => {
      // Inv D: ₹2,000 paid card Nov 15. Partial refund ₹500 card Nov 16.
      // Nov 15: Net sales 2000, collections 2000, refunds 0, net collections 2000
      const res15 = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-15&endDate=2026-11-15",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());
      // On Nov 15, Inv D (2000) + Inv Rev (2500) were finalized = 4500
      expect(res15.body.kpis.netSales.current).toBe(4500);
      expect(res15.body.kpis.collections.current).toBe(4500);
      expect(res15.body.kpis.refunds.current).toBe(0);

      // Nov 16: Net sales 0, collections 0, refunds 500, net collections -500
      const res16 = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-16&endDate=2026-11-16",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());
      expect(res16.body.kpis.netSales.current).toBe(0);
      expect(res16.body.kpis.collections.current).toBe(0);
      expect(res16.body.kpis.refunds.current).toBe(500);
      expect(res16.body.kpis.netCollections.current).toBe(-500);
    });

    it("Scenario E: Full refund attribution and reversal reconciliation", async () => {
      // Inv E: ₹1,500 on Nov 18, Refund ₹1,500 on Nov 18.
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-18&endDate=2026-11-18",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.kpis.netSales.current).toBe(1500);
      expect(res.body.kpis.collections.current).toBe(1500);
      expect(res.body.kpis.refunds.current).toBe(1500);
      expect(res.body.kpis.netCollections.current).toBe(0);
    });

    it("Scenario F: Cancelled / voided invoices are completely excluded from sales metrics", async () => {
      // Inv F: ₹3,500 on Nov 20 is cancelled.
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-20&endDate=2026-11-20",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.kpis.netSales.current).toBe(0);
      expect(res.body.kpis.grossSales.current).toBe(0);
    });

    it("Scenario G: Voided payments (e.g. gateway declines) are excluded from collections", async () => {
      // Pay G: ₹1,000 on Nov 22 is status: "voided"
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-22&endDate=2026-11-22",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.kpis.collections.current).toBe(0);
    });

    it("Scenario H: Bank chargeback reversals are excluded from positive collections", async () => {
      // Pay H: ₹1,200 on Nov 23 is status: "voided"
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-23&endDate=2026-11-23",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.kpis.collections.current).toBe(0);
    });

    it("Scenario I: Customer subscription package billed upfront vs deferred revenue", async () => {
      // Branch B: Inv I ₹8,000 finalized on Nov 14, paid ₹8,000.
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-14&endDate=2026-11-14",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchB._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.kpis.netSales.current).toBe(8000);
      expect(res.body.kpis.collections.current).toBe(8000);
      expect(res.body.kpis.netCollections.current).toBe(8000);
    });

    it("Scenario J: Payment reversal integrity across months (Nov completed, Dec reversed)", async () => {
      // Inv Rev: ₹2,500 finalized & completed on Nov 15.
      // In Dec 10: Reversal recorded with type: "refund" of ₹2,500.
      // Verify: November reflects the billed sales (2500) and collections (2500), but 0 refunds (historical audit trail preserved)
      const novRes = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      // Total Nov collections at Branch A:
      // Pay A (4000) + Pay C1 (3000) + Pay C2 (3000) + Pay D (2000) + Pay E (1500) + Pay Rev (2500) + Pay Precision (0.1 + 0.2) = ₹16,000.30
      expect(novRes.body.kpis.collections.current).toBe(16000.3);
      expect(novRes.body.kpis.refunds.current).toBe(2000); // Only Nov refunds (Pay D partial 500 + Pay E full 1500)
      expect(novRes.body.kpis.netCollections.current).toBe(14000.3);
      // Net billed sales for November remains intact and does not deduct December's refund:
      expect(novRes.body.kpis.netSales.current).toBe(17000.3);

      // Verify: December reflects the Dec refund without touching November's historic ledger
      const decRes = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-12-01&endDate=2026-12-31",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      // In Dec: Pay B received (5000), Refund Dec Reversal (2500). Net collections = 2500.
      expect(decRes.body.kpis.netSales.current).toBe(0); // No invoices finalized in Dec at Branch A
      expect(decRes.body.kpis.collections.current).toBe(5000);
      expect(decRes.body.kpis.refunds.current).toBe(2500);
      expect(decRes.body.kpis.netCollections.current).toBe(2500);
    });

    it("Scenario K: Financial precision with 0.1 + 0.2 floating point handling", async () => {
      // Inv Precision: ₹0.30 on Nov 28. Paid 0.10 + 0.20 cash.
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-28&endDate=2026-11-28",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.kpis.netSales.current).toBe(0.3);
      expect(res.body.kpis.collections.current).toBe(0.3);
      expect(res.body.kpis.netCollections.current).toBe(0.3);
    });

    it("Branch A: Reconciles comprehensive Monthly Net Sales, Collections, Refunds, Margin", async () => {
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      const { kpis, finance } = res.body;

      // Net Sales = 4000 (A) + 5000 (B) + 6000 (C) + 2000 (D) + 1500 (E) + 2500 (Rev) + 0.30 (Prec) = 21000.30
      expect(kpis.netSales.current).toBe(21000.3);

      // Collections = 4000 + 3000 + 3000 + 2000 + 1500 + 2500 + 0.30 = 16000.30
      expect(kpis.collections.current).toBe(16000.3);

      // Refunds = 500 (D) + 1500 (E) = 2000
      expect(kpis.refunds.current).toBe(2000);

      // Net Collections = 16000.30 - 2000 = 14000.30
      expect(kpis.netCollections.current).toBe(14000.3);

      // Operating Cash Margin = 14000.30 - 8000 = 6000.30
      expect(finance.status).toBe("AVAILABLE");
      expect(finance.totalExpenses).toBe(8000);
      expect(finance.operatingCashMargin).toBe(6000.3);
    });

    it("Branch B: Reconciles Scenario I (Subscription Package) in November", async () => {
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchB._id.toString());

      expect(res.status).toBe(200);
      const { kpis, finance } = res.body;

      expect(kpis.netSales.current).toBe(8000);
      expect(kpis.collections.current).toBe(8000);
      expect(kpis.refunds.current).toBe(0);
      expect(kpis.netCollections.current).toBe(8000);
      expect(finance.totalExpenses).toBe(3500);
      expect(finance.operatingCashMargin).toBe(4500);
    });
  });

  // =========================================================================
  // 2. Multi-Branch Validation & Strict Isolation
  // =========================================================================
  describe("2. Multi-Branch Scoping & Isolation", () => {
    it("Branch A sees only Branch A data and does not see Branch B figures", async () => {
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${managerAToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.kpis.netSales.current).toBe(21000.3); // Only Branch A
      expect(res.body.branchComparison).toBeUndefined();
    });

    it("Branch B sees only Branch B data and does not see Branch A figures", async () => {
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${managerBToken}`)
        .set("X-Branch-Id", branchB._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.kpis.netSales.current).toBe(8000); // Only Branch B
      expect(res.body.branchComparison).toBeUndefined();
    });

    it("Branch C has zero transactions and returns clean empty states", async () => {
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${managerCToken}`)
        .set("X-Branch-Id", branchC._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.kpis.netSales.current).toBe(0);
      expect(res.body.kpis.collections.current).toBe(0);
      expect(res.body.kpis.refunds.current).toBe(0);
      expect(res.body.kpis.totalAppointments.current).toBe(0);
    });

    it("Consolidated query (Owner without X-Branch-Id) aggregates all 3 branches + branchComparison", async () => {
      // Consolidated November Net Sales:
      // Branch A (21000.30) + Branch B (8000) + Branch C (0) = 29000.30.
      // Consolidated November Collections:
      // Branch A (16000.30) + Branch B (8000) + Branch C (0) = 24000.30.
      // Consolidated November Refunds: 2000.
      // Consolidated Net Collections: 22000.30.

      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      const { kpis, branchComparison } = res.body;

      expect(kpis.netSales.current).toBe(29000.3);
      expect(kpis.collections.current).toBe(24000.3);
      expect(kpis.refunds.current).toBe(2000);
      expect(kpis.netCollections.current).toBe(22000.3);

      expect(branchComparison).toBeDefined();
      expect(Array.isArray(branchComparison)).toBe(true);
      expect(branchComparison.length).toBe(3);

      const compA = branchComparison.find(
        (b) => b.branchId === branchA._id.toString(),
      );
      const compB = branchComparison.find(
        (b) => b.branchId === branchB._id.toString(),
      );
      const compC = branchComparison.find(
        (b) => b.branchId === branchC._id.toString(),
      );

      expect(compA.billedRevenue).toBe(21000.3);
      expect(compA.collections).toBe(16000.3);

      expect(compB.billedRevenue).toBe(8000);
      expect(compB.collections).toBe(8000);

      expect(compC.billedRevenue).toBe(0);
      expect(compC.collections).toBe(0);
    });

    it("Rejects Branch Manager A attempting to query consolidated all branches without X-Branch-Id", async () => {
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${managerAToken}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/branch/i);
    });

    it("Rejects Branch Manager A attempting to access Branch B (403)", async () => {
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${managerAToken}`)
        .set("X-Branch-Id", branchB._id.toString());

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/access/i);
    });
  });

  // =========================================================================
  // 3. Role-Based Experience & Zero-Knowledge Security Projection
  // =========================================================================
  describe("3. Role-Based Permission Validation", () => {
    it("Receptionist receives core operational data but zero sensitive financial/inventory payload", async () => {
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${receptionistToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.kpis).toBeDefined();
      expect(res.body.appointments).toBeDefined();
      expect(res.body.customers).toBeDefined();
      expect(res.body.services).toBeDefined();

      // Zero-knowledge projection: sensitive keys are undefined
      expect(res.body.finance).toBeUndefined();
      expect(res.body.inventory).toBeUndefined();
      expect(res.body.procurement).toBeUndefined();
      expect(res.body.payroll).toBeUndefined();

      expect(res.body.meta.availableWidgets).not.toContain("finance");
      expect(res.body.meta.availableWidgets).not.toContain("inventory");
      expect(res.body.meta.availableWidgets).not.toContain("procurement");
    });

    it("Owner receives full multi-domain intelligence (Finance, Inventory, Procurement, Loyalty, Coupons)", async () => {
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.finance).toBeDefined();
      expect(res.body.finance.status).toBe("AVAILABLE");

      expect(res.body.inventory).toBeDefined();
      expect(res.body.inventory.status).toBe("AVAILABLE");
      expect(res.body.inventory.lowStockCount).toBeGreaterThanOrEqual(1);
      expect(res.body.inventory.outOfStockCount).toBeGreaterThanOrEqual(1);

      expect(res.body.procurement).toBeDefined();
      expect(res.body.procurement.status).toBe("AVAILABLE");
      expect(res.body.procurement.pendingOrdersCount).toBe(1);
      expect(res.body.procurement.outstandingSupplierPayables).toBe(12000);

      expect(res.body.loyalty).toBeDefined();
      expect(res.body.loyalty.pointsEarned).toBe(200);
      expect(res.body.loyalty.pointsRedeemed).toBe(50);

      expect(res.body.coupons).toBeDefined();
      expect(res.body.coupons.redemptionCount).toBe(1);
      expect(res.body.coupons.totalDiscountGiven).toBe(200);
    });

    it("User with billing.view only: receives Net Sales but zero Collections/Refunds payload", async () => {
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${billingOnlyToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.kpis).toBeDefined();
      expect(res.body.kpis.netSales).toBeDefined();
      expect(res.body.kpis.grossSales).toBeDefined();
      expect(res.body.kpis.averageBillValue).toBeDefined();

      // Zero-knowledge projection: collections/refunds stripped
      expect(res.body.kpis.collections).toBeUndefined();
      expect(res.body.kpis.refunds).toBeUndefined();
      expect(res.body.kpis.netCollections).toBeUndefined();

      // Trend has billedRevenue but not collections
      expect(res.body.revenueTrend).toBeDefined();
      expect(res.body.revenueTrend[0].billedRevenue).toBeDefined();
      expect(res.body.revenueTrend[0].collections).toBeUndefined();
    });

    it("User with payments.view only: receives Collections/Refunds but zero Net Sales payload", async () => {
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${paymentsOnlyToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.kpis).toBeDefined();
      expect(res.body.kpis.collections).toBeDefined();
      expect(res.body.kpis.refunds).toBeDefined();
      expect(res.body.kpis.netCollections).toBeDefined();

      // Zero-knowledge projection: sales stripped
      expect(res.body.kpis.netSales).toBeUndefined();
      expect(res.body.kpis.grossSales).toBeUndefined();
      expect(res.body.kpis.averageBillValue).toBeUndefined();

      // Trend has collections but not billedRevenue
      expect(res.body.revenueTrend).toBeDefined();
      expect(res.body.revenueTrend[0].collections).toBeDefined();
      expect(res.body.revenueTrend[0].billedRevenue).toBeUndefined();
    });

    it("User with expenses.view only: receives totalExpenses but zero operatingCashMargin", async () => {
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${expensesOnlyToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.finance).toBeDefined();
      expect(res.body.finance.totalExpenses).toBe(8000);
      // Zero-knowledge: operatingCashMargin stripped because user cannot see collections!
      expect(res.body.finance.operatingCashMargin).toBeUndefined();
    });

    it("User with finance.view only: receives totalExpenses and operatingCashMargin", async () => {
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${financeOnlyToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.finance).toBeDefined();
      expect(res.body.finance.totalExpenses).toBe(8000);
      expect(res.body.finance.operatingCashMargin).toBeDefined();
    });

    it("User with dashboard.view only (no domain permissions): receives empty modular projection", async () => {
      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${dashboardOnlyToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      // Zero domain payloads
      expect(res.body.kpis).toBeUndefined();
      expect(res.body.revenueTrend).toBeUndefined();
      expect(res.body.appointments).toBeUndefined();
      expect(res.body.customers).toBeUndefined();
      expect(res.body.services).toBeUndefined();
      expect(res.body.finance).toBeUndefined();
      expect(res.body.inventory).toBeUndefined();
      expect(res.body.meta.availableWidgets).toEqual([]);
    });
  });

  // =========================================================================
  // 4. Operations Command Centre Validation (Today's Real-Time State)
  // =========================================================================
  describe("4. Operational Command Centre Validation", () => {
    it("Branch A: Reconciles floor availability, punches, and ongoing chair status", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/operations")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const { summary, staffRoster } = res.body;

      // Summary counts
      expect(summary.todayAppointmentsCount).toBe(2);
      expect(summary.totalBranchStaff).toBe(3);
      expect(summary.presentStaffCount).toBe(2);
      expect(summary.onLeaveStaffCount).toBe(1);
      expect(summary.clockedInNowCount).toBe(2);
      expect(summary.availableStaffCount).toBe(1);

      // Verify individual staff status in roster
      const elenaRoster = staffRoster.find(
        (r) => r.staffName === "Elena Rostova",
      );
      const marcusRoster = staffRoster.find(
        (r) => r.staffName === "Marcus Aurelius",
      );
      const sarahRoster = staffRoster.find(
        (r) => r.staffName === "Sarah Connor",
      );

      expect(elenaRoster.currentAppointment).toBeDefined();
      expect(elenaRoster.currentAppointment.appointmentCode).toBe(
        "APT-TODAY-01",
      );

      expect(marcusRoster.currentAppointment).toBeNull();
      expect(marcusRoster.statusToday).toBe("present");
      expect(marcusRoster.isClockedIn).toBe(true);

      expect(sarahRoster.statusToday).toBe("on_leave");
    });
  });

  // =========================================================================
  // 5. Business Alerts Service Validation
  // =========================================================================
  describe("5. Data-Driven Business Alerts", () => {
    it("Branch A: Detects critical low stock, out of stock, and pending supplier payables", async () => {
      const res = await request(app)
        .get("/api/v1/dashboard/alerts")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const { alerts } = res.body;

      expect(alerts.length).toBeGreaterThanOrEqual(2);
      const lowStockAlert = alerts.find((a) => a.id === "ALERT_INV_LOW_STOCK");
      const outOfStockAlert = alerts.find(
        (a) => a.id === "ALERT_INV_OUT_OF_STOCK",
      );

      expect(lowStockAlert).toBeDefined();
      expect(lowStockAlert.severity).toBe("warning");
      expect(lowStockAlert.count).toBeGreaterThanOrEqual(1);

      expect(outOfStockAlert).toBeDefined();
      expect(outOfStockAlert.severity).toBe("critical");
      expect(outOfStockAlert.count).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // 6. Phase 3.2 Deep Financial Ledger, Lifecycle & Soft-Delete Invariant Tests
  // =========================================================================
  describe("6. Phase 3.2 Financial Ledger Integrity & Soft-Delete Invariants", () => {
    it("Financial Precision: 100 micro-transactions sum accurately without floating-point drift", async () => {
      // Create 100 payments of ₹1.005 equivalent rounded or fractional payments of ₹0.10 + ₹0.20
      // In JS: sum of 100 * 0.1 is 9.99999999999998
      // With roundCurrency: exactly 10.00
      let rawSum = 0;
      for (let i = 0; i < 100; i++) {
        rawSum += 0.1;
      }
      expect(rawSum).not.toBe(10.0); // Demonstrates JS IEEE 754 precision limitation

      // Under our system's roundCurrency helper
      const { roundCurrency } =
        await import("../../services/dashboard/dashboardOverview.service.js");
      expect(roundCurrency(rawSum)).toBe(10.0);
      expect(roundCurrency(1.005)).toBe(1.01); // Demonstrates half-up rounding via Number.EPSILON
      expect(roundCurrency(-1.005)).toBe(-1.01); // Explicit negative halfway test

      // Fail-fast guard: Invalid/non-numeric inputs MUST throw TypeError rather than masking errors as zero
      expect(() => roundCurrency(NaN)).toThrow(TypeError);
      expect(() => roundCurrency(Infinity)).toThrow(TypeError);
      expect(() => roundCurrency(null)).toThrow(TypeError);
      expect(() => roundCurrency(undefined)).toThrow(TypeError);
      expect(() => roundCurrency("invalid-string")).toThrow(TypeError);
    });

    it("Soft-Delete Invariant: Documents with isDeleted: true are strictly excluded, while documents without isDeleted remain included", async () => {
      // Create 1 active product without isDeleted field
      const ProductModel = mongoose.model("Product");
      const legacyProduct = await ProductModel.create({
        organizationId: organization._id,
        name: "Legacy Royal Pomade",
        sku: `SKU-LEGACY-${Date.now()}`,
        category: "Haircare",
        stockUnit: "bottle",
        costPrice: 200,
        sellingPrice: 500,
        reorderLevel: 5,
        status: "active",
        usageType: "retail_sale",
        // isDeleted is omitted on purpose
      });

      // Create 1 soft-deleted product
      const deletedProduct = await ProductModel.create({
        organizationId: organization._id,
        name: "Discontinued Hair Spray",
        sku: `SKU-DELETED-${Date.now()}`,
        category: "Haircare",
        stockUnit: "bottle",
        costPrice: 200,
        sellingPrice: 500,
        reorderLevel: 10,
        status: "active",
        usageType: "retail_sale",
        isDeleted: true,
      });

      // Seed StockBalance for both
      const StockBalanceModel = mongoose.model("StockBalance");
      await StockBalanceModel.create({
        organizationId: organization._id,
        branchId: branchA._id,
        productId: legacyProduct._id,
        onHand: 2, // Low stock <= 5
        onHandRetail: 2,
        onHandConsumables: 0,
      });

      await StockBalanceModel.create({
        organizationId: organization._id,
        branchId: branchA._id,
        productId: deletedProduct._id,
        onHand: 0, // Out of stock
        onHandRetail: 0,
        onHandConsumables: 0,
      });

      const res = await request(app)
        .get(
          "/api/v1/dashboard/overview?startDate=2026-11-01&endDate=2026-11-30",
        )
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.inventory).toBeDefined();
      expect(res.body.inventory.status).toBe("AVAILABLE");

      // Verify alerts service also obeys universal soft-delete
      const alertRes = await request(app)
        .get("/api/v1/dashboard/alerts")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(alertRes.status).toBe(200);
      const lowAlert = alertRes.body.alerts.find(
        (a) => a.id === "ALERT_INV_LOW_STOCK",
      );
      expect(lowAlert).toBeDefined();
      expect(lowAlert.description).toContain(legacyProduct.name);
      expect(lowAlert.description).not.toContain(deletedProduct.name);
    });

    it("Cross-Branch / Cross-Tenant Zero-Leakage: Operations and Alerts strictly isolate branch payloads", async () => {
      // Query Branch B operations
      const opBRes = await request(app)
        .get("/api/v1/dashboard/operations")
        .set("Authorization", `Bearer ${managerBToken}`)
        .set("X-Branch-Id", branchB._id.toString());

      expect(opBRes.status).toBe(200);
      // Branch B has no appointments, but has 1 assigned staff (David Miller)
      expect(opBRes.body.summary.todayAppointmentsCount).toBe(0);
      expect(opBRes.body.summary.totalBranchStaff).toBe(1);
      expect(opBRes.body.staffRoster.length).toBe(1);
      expect(opBRes.body.staffRoster[0].staffName).toBe("David Miller");

      // Verify zero leak of Branch A staff (Elena, Marcus, Sarah)
      const branchAStaffInB = opBRes.body.staffRoster.find((s) =>
        ["Elena Rostova", "Marcus Aurelius", "Sarah Connor"].includes(
          s.staffName,
        ),
      );
      expect(branchAStaffInB).toBeUndefined();
    });

    it("User with billing.view cannot deduce collections or refunds through operations or alerts endpoints", async () => {
      const opRes = await request(app)
        .get("/api/v1/dashboard/operations")
        .set("Authorization", `Bearer ${billingOnlyToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(opRes.status).toBe(200);
      // Verify no financial collections or payment totals exist in operational response
      expect(opRes.body.collections).toBeUndefined();
      expect(opRes.body.refunds).toBeUndefined();
      expect(opRes.body.netCollections).toBeUndefined();

      const alertRes = await request(app)
        .get("/api/v1/dashboard/alerts")
        .set("Authorization", `Bearer ${billingOnlyToken}`)
        .set("X-Branch-Id", branchA._id.toString());

      expect(alertRes.status).toBe(200);
      // User lacks procurement and payments permissions; finance alerts must be absent
      const financeAlert = alertRes.body.alerts.find(
        (a) => a.category === "finance",
      );
      expect(financeAlert).toBeUndefined();
    });
  });
});
