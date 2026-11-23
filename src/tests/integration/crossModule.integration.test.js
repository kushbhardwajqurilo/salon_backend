import { describe, expect, it, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import mongoose from "mongoose";
import dns from "dns";
import { getIsolatedTestMongoUri } from "../testSetup.js";

try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (_) {}

import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { User } from "../../models/users/user.model.js";
import { Product } from "../../models/inventory/product.model.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { StockBatch } from "../../models/inventory/stockBatch.model.js";
import { StockMovement } from "../../models/inventory/stockMovement.model.js";
import { Supplier } from "../../models/procurement/supplier.model.js";
import { PurchaseOrder } from "../../models/procurement/purchaseOrder.model.js";
import { GoodsReceiptNote } from "../../models/procurement/goodsReceiptNote.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { Expense } from "../../models/expenses/expense.model.js";
import { Campaign } from "../../models/marketing/campaign.model.js";
import { FifoDepletionService } from "../../services/inventory/fifoDepletion.service.js";
import { FinanceService } from "../../services/finance/finance.service.js";
import { CampaignAttributionService } from "../../services/marketing/campaignAttribution.service.js";
import { ProcurementService } from "../../services/procurement/procurement.service.js";
import { runInTransaction } from "../../utils/transaction.js";

describe("Cross-Module Integration Verification Suite", () => {
  jest.setTimeout(45000);

  let orgAId, orgBId;
  let branchA1Id, branchA2Id, branchB1Id;
  let userA1, userB1;
  let customerAId;
  let retailProduct, consumableProduct;
  let supplier;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("xmod_test");
    await mongoose.connect(testUri);
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    orgAId = new mongoose.Types.ObjectId();
    orgBId = new mongoose.Types.ObjectId();
    branchA1Id = new mongoose.Types.ObjectId();
    branchA2Id = new mongoose.Types.ObjectId();
    branchB1Id = new mongoose.Types.ObjectId();
    userA1 = new mongoose.Types.ObjectId();
    userB1 = new mongoose.Types.ObjectId();
    customerAId = new mongoose.Types.ObjectId();

    await Promise.all([
      Product.deleteMany({ organizationId: { $in: [orgAId, orgBId] } }),
      StockBalance.deleteMany({ organizationId: { $in: [orgAId, orgBId] } }),
      StockBatch.deleteMany({ organizationId: { $in: [orgAId, orgBId] } }),
      StockMovement.deleteMany({ organizationId: { $in: [orgAId, orgBId] } }),
      Supplier.deleteMany({ organizationId: { $in: [orgAId, orgBId] } }),
      PurchaseOrder.deleteMany({ organizationId: { $in: [orgAId, orgBId] } }),
      GoodsReceiptNote.deleteMany({ organizationId: { $in: [orgAId, orgBId] } }),
      Invoice.deleteMany({ organizationId: { $in: [orgAId, orgBId] } }),
      Payment.deleteMany({ organizationId: { $in: [orgAId, orgBId] } }),
      Expense.deleteMany({ organizationId: { $in: [orgAId, orgBId] } }),
      Campaign.deleteMany({ organizationId: { $in: [orgAId, orgBId] } }),
    ]);

    // Setup base products and supplier
    retailProduct = await Product.create({
      organizationId: orgAId,
      name: "Organic Argan Oil",
      sku: "OIL-001",
      category: "Hair Care",
      usageType: "retail_sale",
      stockUnit: "bottle",
      minStockLevel: 5,
    });

    consumableProduct = await Product.create({
      organizationId: orgAId,
      name: "Keratin Treatment Tub 1000g",
      sku: "KER-1000",
      category: "Salon Professional",
      usageType: "salon_consumption",
      stockUnit: "piece",
      minStockLevel: 2,
    });

    supplier = await Supplier.create({
      organizationId: orgAId,
      name: "Salon Essentials Direct",
      phone: "+919123456789",
      email: "orders@salonessentials.test",
      paymentTerms: "net_30",
    });
  });

  // -------------------------------------------------------------------------
  // 1. GRN Receipt creates StockBatch and increments physical StockBalance
  // -------------------------------------------------------------------------
  it("1. GRN receipt creates verified StockBatch and updates physical StockBalance", async () => {
    const grnId = new mongoose.Types.ObjectId();

    const batch = await FifoDepletionService.createGrnBatch({
      organizationId: orgAId,
      branchId: branchA1Id,
      productId: consumableProduct._id,
      stockDomain: "salon_consumables",
      grnId,
      grnNumber: "GRN-2026-001",
      supplierId: supplier._id,
      receivedDate: new Date("2026-11-20T10:00:00Z"),
      receivedQuantity: 10, // 10 units
      unitCostPrice: 450,   // ₹450.00
      userId: userA1,
    });

    // Update stock balance as procurement service does upon GRN approval
    await StockBalance.findOneAndUpdate(
      {
        organizationId: orgAId,
        branchId: branchA1Id,
        productId: consumableProduct._id,
      },
      {
        $inc: { onHand: 10, onHandConsumables: 10 },
        $set: { lastMovementAt: new Date() },
      },
      { upsert: true, returnDocument: "after" }
    );

    expect(batch).toBeDefined();
    expect(batch.initialQuantityMilli).toBe(10000);
    expect(batch.remainingQuantityMilli).toBe(10000);
    expect(batch.unitCostPaise).toBe(45000); // 45000 paise = ₹450.00
    expect(batch.isValued).toBe(true);
    expect(batch.status).toBe("active");

    const balance = await StockBalance.findOne({
      organizationId: orgAId,
      branchId: branchA1Id,
      productId: consumableProduct._id,
    });
    expect(balance).toBeDefined();
    expect(balance.onHand).toBe(10);
    expect(balance.onHandConsumables).toBe(10);
  });

  // -------------------------------------------------------------------------
  // 2. FIFO consumption produces expected StockMovement and COGS
  // -------------------------------------------------------------------------
  it("2. FIFO consumption produces expected StockMovement and recognized COGS", async () => {
    // Create 2 lots in chronological order:
    // Lot 1: 5 tubs @ ₹400 = 40000 paise
    // Lot 2: 5 tubs @ ₹500 = 50000 paise
    const batch1 = await StockBatch.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      productId: consumableProduct._id,
      stockDomain: "salon_consumables",
      batchNumber: "LOT-001",
      sourceType: "procurement_grn",
      sourceReference: { entityType: "GRN", identifier: "GRN-01" },
      receivedDate: new Date("2026-11-01T10:00:00Z"),
      initialQuantityMilli: 5000,
      remainingQuantityMilli: 5000,
      isValued: true,
      unitCostPaise: 40000,
      totalCostPaise: 200000,
      status: "active",
      createdBy: userA1,
    });

    const batch2 = await StockBatch.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      productId: consumableProduct._id,
      stockDomain: "salon_consumables",
      batchNumber: "LOT-002",
      sourceType: "procurement_grn",
      sourceReference: { entityType: "GRN", identifier: "GRN-02" },
      receivedDate: new Date("2026-11-05T10:00:00Z"),
      initialQuantityMilli: 5000,
      remainingQuantityMilli: 5000,
      isValued: true,
      unitCostPaise: 50000,
      totalCostPaise: 250000,
      status: "active",
      createdBy: userA1,
    });

    await StockBalance.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      productId: consumableProduct._id,
      onHand: 10,
      onHandConsumables: 10,
      onHandRetail: 0,
    });

    // Deplete 7 tubs across FIFO: 5 from Lot 1 (5 * 400 = 2000) + 2 from Lot 2 (2 * 500 = 1000) = ₹3,000.00
    const depletion = await runInTransaction(async (session) => {
      return await FifoDepletionService.depleteFifo({
        organizationId: orgAId,
        branchId: branchA1Id,
        productId: consumableProduct._id,
        stockDomain: "salon_consumables",
        quantity: 7,
        movementType: "service_consumption",
        reference: { entityType: "Appointment", identifier: "APT-100" },
        actorId: userA1,
        notes: "Service consumption across 2 FIFO lots",
        accountingDate: new Date("2026-11-20T12:00:00Z"),
        session,
      });
    });

    expect(depletion.isFullyValued).toBe(true);
    expect(depletion.totalCostPaise).toBe(300000); // 300000 paise = ₹3,000.00 exactly
    expect(depletion.allocations).toHaveLength(2);
    expect(depletion.allocations[0].batchNumber).toBe("LOT-001");
    expect(depletion.allocations[0].quantityMilli).toBe(5000);
    expect(depletion.allocations[1].batchNumber).toBe("LOT-002");
    expect(depletion.allocations[1].quantityMilli).toBe(2000);

    // Verify Finance COGS via getOperatingProfit
    const profitReport = await FinanceService.getOperatingProfit(
      orgAId.toString(),
      branchA1Id.toString(),
      "2026-11-01",
      "2026-11-30"
    );

    expect(profitReport.inventoryCost.cogsPaise).toBe(300000);
    expect(profitReport.inventoryCost.cogs).toBe(3000);
    expect(profitReport.inventoryCost.isFullyValued).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. Invoice finalization and payments remain separate metrics
  // -------------------------------------------------------------------------
  it("3. Invoiced revenue and completed collections remain strictly separate financial dimensions", async () => {
    // Create finalized invoice for ₹5,000
    const invoice = await Invoice.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      customerId: customerAId,
      customerSnapshot: { name: "Priya Sharma", phone: "+919888877777" },
      invoiceNumber: "INV-SPLIT-01",
      invoiceDate: new Date("2026-11-15T10:00:00Z"),
      finalizedAt: new Date("2026-11-15T10:05:00Z"),
      status: "finalized",
      paymentStatus: "partially_paid",
      subtotal: 5000,
      grossPayable: 5000,
      totalAmount: 5000,
      payableAmount: 5000,
      amountPaid: 3000,
      amountDue: 2000,
      lines: [
        {
          serviceId: new mongoose.Types.ObjectId(),
          name: "Hair Spa",
          lineType: "service",
          quantity: 1,
          unitPrice: 5000,
          lineTotal: 5000,
          customerPayable: 5000,
        },
      ],
      createdBy: userA1,
    });

    // Record only ₹3,000 in completed collections
    await Payment.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      customerId: customerAId,
      invoiceId: invoice._id,
      paymentNumber: "PAY-PART-01",
      amount: 3000,
      method: "card",
      type: "payment",
      status: "completed",
      paymentDate: new Date("2026-11-15T10:06:00Z"),
      isDeleted: false,
      recordedBy: userA1,
    });

    const profitReport = await FinanceService.getOperatingProfit(
      orgAId.toString(),
      branchA1Id.toString(),
      "2026-11-01",
      "2026-11-30"
    );

    // Assert that Gross Invoiced Revenue is ₹5,000 while Collections is ₹3,000
    expect(profitReport.grossRevenue).toBe(5000); // Invoiced = ₹5,000.00
    expect(profitReport.collections.totalCollected).toBe(3000);   // Collections = ₹3,000.00
    expect(profitReport.grossRevenue).not.toBe(profitReport.collections.totalCollected);
  });

  // -------------------------------------------------------------------------
  // 4. Completed refund is deducted exactly once
  // -------------------------------------------------------------------------
  it("4. Completed refund is deducted exactly once and tied to refund paymentDate", async () => {
    const invoice = await Invoice.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      customerId: customerAId,
      customerSnapshot: { name: "Ananya Gupta", phone: "+919999988888" },
      invoiceNumber: "INV-REF-01",
      invoiceDate: new Date("2026-11-10T10:00:00Z"),
      finalizedAt: new Date("2026-11-10T10:05:00Z"),
      status: "finalized",
      paymentStatus: "paid",
      subtotal: 4000,
      grossPayable: 4000,
      totalAmount: 4000,
      payableAmount: 4000,
      amountPaid: 4000,
      amountDue: 0,
      lines: [
        {
          serviceId: new mongoose.Types.ObjectId(),
          name: "Bridal Makeup",
          lineType: "service",
          quantity: 1,
          unitPrice: 4000,
          lineTotal: 4000,
          customerPayable: 4000,
        },
      ],
      createdBy: userA1,
    });

    await Payment.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      customerId: customerAId,
      invoiceId: invoice._id,
      paymentNumber: "PAY-REF-01",
      amount: 4000,
      method: "upi",
      type: "payment",
      status: "completed",
      paymentDate: new Date("2026-11-10T10:06:00Z"),
      isDeleted: false,
      recordedBy: userA1,
    });

    // Refund of ₹1,000 on Nov 12
    await Payment.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      customerId: customerAId,
      invoiceId: invoice._id,
      paymentNumber: "REF-01",
      amount: 1000,
      method: "upi",
      type: "refund",
      status: "completed",
      paymentDate: new Date("2026-11-12T14:00:00Z"),
      isDeleted: false,
      recordedBy: userA1,
    });

    const profitReport = await FinanceService.getOperatingProfit(
      orgAId.toString(),
      branchA1Id.toString(),
      "2026-11-01",
      "2026-11-30"
    );

    expect(profitReport.grossRevenue).toBe(4000); // ₹4,000.00
    expect(profitReport.refunds).toBe(1000);      // -₹1,000.00
    expect(profitReport.netRevenue).toBe(3000);   // ₹3,000.00
    expect(profitReport.collections.netCollections).toBe(3000);  // 4000 collections - 1000 refund = ₹3,000.00
  });

  // -------------------------------------------------------------------------
  // 5. Approved expense reporting reconciles with settled and unpaid amounts
  // -------------------------------------------------------------------------
  it("5. Approved expense reporting satisfies: Approved Expenses == Settled + Unpaid (Rejected strictly excluded)", async () => {
    // Create 3 expenses:
    // EXP-1: Approved & Settled (₹2,000)
    // EXP-2: Approved & Unpaid (₹1,500)
    // EXP-3: Rejected & Unpaid (₹1,000)
    await Expense.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      expenseCode: "EXP-REC-001",
      category: "marketing",
      amount: 2000,
      paymentMethod: "bank_transfer",
      payeeName: "Vendor A",
      expenseDate: new Date("2026-11-10"),
      approvalStatus: "approved",
      paymentStatus: "settled",
      approvalThresholdAtCreation: 5000,
      recordedBy: userA1,
    });

    await Expense.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      expenseCode: "EXP-REC-002",
      category: "utilities",
      amount: 1500,
      paymentMethod: "bank_transfer",
      payeeName: "Vendor B",
      expenseDate: new Date("2026-11-15"),
      approvalStatus: "approved",
      paymentStatus: "unpaid",
      approvalThresholdAtCreation: 5000,
      recordedBy: userA1,
    });

    await Expense.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      expenseCode: "EXP-REC-003",
      category: "supplies",
      amount: 1000,
      paymentMethod: "bank_transfer",
      payeeName: "Vendor C",
      expenseDate: new Date("2026-11-20"),
      approvalStatus: "rejected",
      paymentStatus: "unpaid",
      rejectionReason: "Unnecessary purchase",
      approvalThresholdAtCreation: 5000,
      recordedBy: userA1,
    });

    // Query aggregation for branch A1 in November
    const approvedExpenses = await Expense.aggregate([
      {
        $match: {
          organizationId: orgAId,
          branchId: branchA1Id,
          approvalStatus: "approved",
          isDeleted: false,
        },
      },
      {
        $group: {
          _id: null,
          totalApprovedPaise: { $sum: { $round: [{ $multiply: ["$amount", 100] }, 0] } },
          totalSettledPaise: {
            $sum: {
              $cond: [
                { $eq: ["$paymentStatus", "settled"] },
                { $round: [{ $multiply: ["$amount", 100] }, 0] },
                0,
              ],
            },
          },
          totalUnpaidPaise: {
            $sum: {
              $cond: [
                { $eq: ["$paymentStatus", "unpaid"] },
                { $round: [{ $multiply: ["$amount", 100] }, 0] },
                0,
              ],
            },
          },
        },
      },
    ]);

    const result = approvedExpenses[0];
    expect(result.totalApprovedPaise).toBe(350000); // ₹3,500.00
    expect(result.totalSettledPaise).toBe(200000);  // ₹2,000.00
    expect(result.totalUnpaidPaise).toBe(150000);   // ₹1,500.00

    // Enforce Exact Accounting Identity:
    // Approved Expenses == Settled Expenses + Unpaid Approved Obligations
    expect(result.totalApprovedPaise).toBe(result.totalSettledPaise + result.totalUnpaidPaise);

    // Rejected expense (₹1,000) is completely excluded
    const rejectedExpenses = await Expense.countDocuments({
      organizationId: orgAId,
      branchId: branchA1Id,
      approvalStatus: "rejected",
    });
    expect(rejectedExpenses).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 6. Organization and branch isolation prevents unauthorized mutations
  // -------------------------------------------------------------------------
  it("6. Multi-tenant and branch boundaries prevent cross-organization & cross-branch mutations", async () => {
    // Org A batch
    const batchOrgA = await StockBatch.create({
      organizationId: orgAId,
      branchId: branchA1Id,
      productId: consumableProduct._id,
      stockDomain: "salon_consumables",
      batchNumber: "BAT-ORG-A",
      sourceType: "opening_stock",
      sourceReference: { entityType: "Opening", identifier: "OP-01" },
      receivedDate: new Date(),
      initialQuantityMilli: 5000,
      remainingQuantityMilli: 5000,
      isValued: false,
      unitCostPaise: null,
      status: "active",
      createdBy: userA1,
    });

    // Querying with Org B tenant scope must find 0 records
    const crossOrgQuery = await StockBatch.findOne({
      _id: batchOrgA._id,
      organizationId: orgBId,
    });
    expect(crossOrgQuery).toBeNull();

    // Querying with Branch A2 scope must find 0 records
    const crossBranchQuery = await StockBatch.findOne({
      _id: batchOrgA._id,
      organizationId: orgAId,
      branchId: branchA2Id,
    });
    expect(crossBranchQuery).toBeNull();
  });
});
