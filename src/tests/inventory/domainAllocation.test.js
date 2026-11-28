import { describe, expect, it, beforeAll, afterAll, jest } from "@jest/globals";
import mongoose from "mongoose";
import { getIsolatedTestMongoUri } from "../testSetup.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { User } from "../../models/users/user.model.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { Product } from "../../models/inventory/product.model.js";
import { StockBalance } from "../../models/inventory/stockBalance.model.js";
import { StockMovement } from "../../models/inventory/stockMovement.model.js";
import { inventoryService } from "../../services/inventory/inventory.service.js";
import { generateStockDomainMigrationAudit } from "../../scripts/stockDomainMigrationAudit.js";

describe("Manager-Controlled Stock Domain Allocation & Legacy Stock Isolation Suite", () => {
  jest.setTimeout(45000);
  const syntheticTestPassword = `disposable-${new mongoose.Types.ObjectId()}`;
  let orgId, branchId, userId;
  let dualProduct, retailOnlyProduct, consumablesOnlyProduct;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("inventory_test");
    await mongoose.connect(testUri);

    const org = await Organization.create({
      name: "Domain Allocation Salon Org",
      ownerEmail: "domain_owner@test.com",
    });
    orgId = org._id;

    const branch = await Branch.create({
      name: "Central Branch",
      organizationId: orgId,
      address: "MG Road",
    });
    branchId = branch._id;

    const perm = await Permission.findOneAndUpdate(
      { name: "inventory.adjust" },
      { name: "inventory.adjust", module: "Inventory", action: "inventory.adjust", description: "Stock Adjustments" },
      { upsert: true, returnDocument: 'after' }
    );

    const role = await Role.create({
      name: `Inventory Manager ${Date.now()}`,
      organizationId: orgId,
      permissions: [perm._id],
    });

    const user = await User.create({
      name: "Inventory Manager",
      username: `inv_mgr_${Date.now()}`,
      email: `inv_mgr_${Date.now()}@test.com`,
      phone: "+919988776655",
      password: syntheticTestPassword,
      organizationId: orgId,
      branchIds: [branchId],
      role: role._id,
      branchAccess: [{ branchId, branchName: "Central Branch", isActive: true }],
      hasOrgWideAccess: true,
      status: "active",
    });
    userId = user._id;

    // 1. Dual-purpose product (usageType: "both")
    dualProduct = await Product.create({
      name: "Keratin Treatment Serum 100ml",
      sku: "KERATIN-SER-001",
      category: "Hair Care",
      usageType: "both",
      stockUnit: "bottle",
      costPrice: 500,
      sellingPrice: 1200,
      organizationId: orgId,
      createdBy: userId,
      updatedBy: userId,
    });

    // 2. Retail-only product
    retailOnlyProduct = await Product.create({
      name: "Styling Gel 150ml",
      sku: "STYL-GEL-001",
      category: "Styling",
      usageType: "retail_sale",
      stockUnit: "bottle",
      costPrice: 200,
      sellingPrice: 450,
      organizationId: orgId,
      createdBy: userId,
      updatedBy: userId,
    });

    // 3. Consumable-only product
    consumablesOnlyProduct = await Product.create({
      name: "Peroxide Developer 20 Vol 1000ml",
      sku: "PEROX-20V-001",
      category: "Color",
      usageType: "salon_consumption",
      stockUnit: "ml",
      costPrice: 300,
      sellingPrice: 0,
      organizationId: orgId,
      createdBy: userId,
      updatedBy: userId,
    });
  });

  afterAll(async () => {
    await Organization.deleteMany({ _id: orgId });
    await Branch.deleteMany({ organizationId: orgId });
    await Role.deleteMany({ organizationId: orgId });
    await User.deleteMany({ organizationId: orgId });
    await Product.deleteMany({ organizationId: orgId });
    await StockBalance.deleteMany({ organizationId: orgId });
    await StockMovement.deleteMany({ organizationId: orgId });
  });

  it("1. Verifies that legacy stock for a 'both' product starts unallocated and CANNOT be sold or consumed", async () => {
    // Seed legacy unallocated balance of 20 units
    const balance = await StockBalance.create({
      organizationId: orgId,
      branchId,
      productId: dualProduct._id,
      onHand: 20,
      onHandConsumables: 0,
      onHandRetail: 0,
      onHandUnallocated: 20,
      allocated: 0,
      allocatedConsumables: 0,
      allocatedRetail: 0,
    });

    expect(balance.onHandUnallocated).toBe(20);
    expect(balance.onHandRetail).toBe(0);
    expect(balance.onHandConsumables).toBe(0);

    // Attempting service consumption must fail
    await expect(
      inventoryService.recordManualConsumption(
        {
          branchId: branchId.toString(),
          productId: dualProduct._id.toString(),
          quantity: 2,
          notes: "Testing unallocated consumption",
        },
        orgId,
        userId
      )
    ).rejects.toThrow(/Insufficient stock/);

    // Attempting POS retail reservation must fail
    await expect(
      inventoryService.reserveStockForInvoice({
        organizationId: orgId,
        branchId: branchId.toString(),
        invoiceId: new mongoose.Types.ObjectId(),
        items: [{ productId: dualProduct._id.toString(), quantity: 2 }],
      })
    ).rejects.toThrow(/Insufficient available stock/);
  });

  it("2. Allows manager allocation to Retail, Consumables, and partial allocation leaving remainder unallocated", async () => {
    // Allocate 5 to Retail, 10 to Consumables out of 20 total unallocated (5 remainder unallocated)
    const idempotencyKey = `audit_alloc_${Date.now()}`;
    const result = await inventoryService.recordDomainAllocation(
      {
        branchId: branchId.toString(),
        productId: dualProduct._id.toString(),
        retailQuantity: 5,
        consumablesQuantity: 10,
        reason: "Initial physical inventory audit verification",
        notes: "Counted by Store Manager Alice",
        idempotencyKey,
      },
      orgId,
      userId
    );

    expect(result.balance.onHandRetail).toBe(5);
    expect(result.balance.onHandConsumables).toBe(10);
    expect(result.balance.onHandUnallocated).toBe(5);
    // Invariant: aggregate onHand remains exactly 20
    expect(result.balance.onHand).toBe(20);

    // Check movements recorded
    const movements = await StockMovement.find({
      organizationId: orgId,
      productId: dualProduct._id,
      movementType: "domain_allocation",
    });
    expect(movements).toHaveLength(2);

    const retailMv = movements.find((m) => m.stockDomain === "retail_products");
    expect(retailMv.quantityDelta).toBe(5);

    const consumableMv = movements.find((m) => m.stockDomain === "salon_consumables");
    expect(consumableMv.quantityDelta).toBe(10);

    const replay = await inventoryService.recordDomainAllocation(
      {
        branchId: branchId.toString(),
        productId: dualProduct._id.toString(),
        retailQuantity: 5,
        consumablesQuantity: 10,
        reason: "Initial physical inventory audit verification",
        notes: "Counted by Store Manager Alice",
        idempotencyKey,
      },
      orgId,
      userId
    );

    expect(replay.isIdempotentReplay).toBe(true);
    expect(replay.balance.onHandRetail).toBe(5);
    expect(replay.balance.onHandConsumables).toBe(10);
    expect(replay.balance.onHandUnallocated).toBe(5);
    await expect(
      inventoryService.recordDomainAllocation(
        {
          branchId: branchId.toString(),
          productId: dualProduct._id.toString(),
          retailQuantity: 4,
          consumablesQuantity: 10,
          reason: "Initial physical inventory audit verification",
          notes: "Counted by Store Manager Alice",
          idempotencyKey,
        },
        orgId,
        userId
      )
    ).rejects.toThrow("Idempotency key was already used for a different stock allocation");
    expect(
      await StockMovement.countDocuments({
        organizationId: orgId,
        productId: dualProduct._id,
        movementType: "domain_allocation",
      })
    ).toBe(2);
  });

  it("3. Successfully allows service consumption and POS reservation from the confirmed domain pools", async () => {
    // Consume 3 units from Consumables pool (10 -> 7)
    await inventoryService.recordManualConsumption(
      {
        branchId: branchId.toString(),
        productId: dualProduct._id.toString(),
        quantity: 3,
        notes: "VIP Hair Spa",
      },
      orgId,
      userId
    );

    let balance = await StockBalance.findOne({
      organizationId: orgId,
      branchId,
      productId: dualProduct._id,
    });

    expect(balance.onHandConsumables).toBe(7);
    expect(balance.onHandRetail).toBe(5);
    expect(balance.onHandUnallocated).toBe(5);
    expect(balance.onHand).toBe(17);

    // Reserve 2 units from Retail pool (5 -> 3 available)
    const mockInvoiceId = new mongoose.Types.ObjectId();
    await inventoryService.reserveStockForInvoice({
      organizationId: orgId,
      branchId: branchId.toString(),
      invoiceId: mockInvoiceId,
      items: [{ productId: dualProduct._id.toString(), quantity: 2 }],
    });

    balance = await StockBalance.findOne({
      organizationId: orgId,
      branchId,
      productId: dualProduct._id,
    });

    expect(balance.allocatedRetail).toBe(2);
    expect(balance.allocated).toBe(2);
  });

  it("4. Strictly rejects excessive allocation exceeding unallocated quantity", async () => {
    // Current unallocated is 5. Attempting to allocate 10 must be rejected
    await expect(
      inventoryService.recordDomainAllocation(
        {
          branchId: branchId.toString(),
          productId: dualProduct._id.toString(),
          retailQuantity: 10,
          consumablesQuantity: 0,
          reason: "Excessive allocation attempt",
        },
        orgId,
        userId
      )
    ).rejects.toThrow(/exceeds available unallocated stock/);
  });

  it("5. Rejects domain allocation on single-purpose products (retail_sale or salon_consumption only)", async () => {
    await expect(
      inventoryService.recordDomainAllocation(
        {
          branchId: branchId.toString(),
          productId: retailOnlyProduct._id.toString(),
          retailQuantity: 5,
          consumablesQuantity: 0,
          reason: "Invalid single-purpose product allocation",
        },
        orgId,
        userId
      )
    ).rejects.toThrow(/only applicable to products with usageType: 'both'/);
  });

  it("6. Runs the migration audit in dry-run mode and verifies no data is mutated", async () => {
    const beforeBalance = await StockBalance.findOne({
      organizationId: orgId,
      branchId,
      productId: dualProduct._id,
    }).lean();

    const audit = await generateStockDomainMigrationAudit({
      organizationId: orgId,
      dryRun: true,
    });

    expect(audit.dryRun).toBe(true);
    expect(audit.totalRecords).toBeGreaterThan(0);

    const record = audit.report.find((r) => r.productId.toString() === dualProduct._id.toString());
    expect(record).toBeDefined();
    expect(record.totalOnHand).toBe(17);
    expect(record.currentRetail).toBe(5);
    expect(record.currentConsumables).toBe(7);
    expect(record.unallocatedQuantity).toBe(5);
    expect(record.requiresManagerSignoff).toBe(true);

    const afterBalance = await StockBalance.findOne({
      organizationId: orgId,
      branchId,
      productId: dualProduct._id,
    }).lean();

    // Assert that the database document was completely unchanged by the dry-run audit
    expect(afterBalance.updatedAt).toEqual(beforeBalance.updatedAt);
    expect(afterBalance.onHand).toBe(beforeBalance.onHand);
    expect(afterBalance.onHandUnallocated).toBe(beforeBalance.onHandUnallocated);
    expect(afterBalance.onHandRetail).toBe(beforeBalance.onHandRetail);
    expect(afterBalance.onHandConsumables).toBe(beforeBalance.onHandConsumables);

    await expect(
      generateStockDomainMigrationAudit({ organizationId: orgId, dryRun: false })
    ).rejects.toThrow("Stock domain migration audit is read-only");
  });
});
