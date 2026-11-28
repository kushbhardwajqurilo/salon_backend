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

describe("Historical Stock Record Acceptance Suite (Zero Domain Fields)", () => {
  jest.setTimeout(45000);
  const syntheticTestPassword = `disposable-${new mongoose.Types.ObjectId()}`;
  let orgId, branchId, userId;
  let dualProduct;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testUri = getIsolatedTestMongoUri("inventory_test");
    await mongoose.connect(testUri);

    const org = await Organization.create({
      name: "Historical Fixture Salon Org",
      ownerEmail: "historical_fixture@test.com",
    });
    orgId = org._id;

    const branch = await Branch.create({
      name: "South Branch",
      organizationId: orgId,
      address: "Indiranagar",
    });
    branchId = branch._id;

    const perm = await Permission.findOneAndUpdate(
      { name: "inventory.adjust" },
      {
        name: "inventory.adjust",
        module: "Inventory",
        action: "inventory.adjust",
        description: "Stock Adjustments",
      },
      { upsert: true, returnDocument: 'after' },
    );

    const role = await Role.create({
      name: `Manager ${Date.now()}`,
      organizationId: orgId,
      permissions: [perm._id],
    });

    const user = await User.create({
      name: "Inventory Manager",
      username: `inv_mgr_${Date.now()}`,
      email: `mgr_${Date.now()}@test.com`,
      phone: "+919988776655",
      password: syntheticTestPassword,
      organizationId: orgId,
      branchIds: [branchId],
      role: role._id,
      branchAccess: [{ branchId, branchName: "South Branch", isActive: true }],
      hasOrgWideAccess: true,
      status: "active",
    });
    userId = user._id;

    dualProduct = await Product.create({
      name: "Legacy Argan Oil Shampoo 500ml",
      sku: "LEGACY-ARGAN-500",
      category: "Haircare",
      usageType: "both",
      stockUnit: "bottle",
      costPrice: 600,
      sellingPrice: 1500,
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
    await mongoose.disconnect();
  });

  it("Demonstrates raw historical record handling, isolation, and manager partial allocation", async () => {
    // 1. Insert a raw disposable record directly bypassing Mongoose defaults to emulate
    // an authentic pre-existing database record without domain fields:
    // only organizationId, branchId, productId, onHand, allocated, lastMovementAt.
    const rawCollection = mongoose.connection.collection("stockbalances");
    const rawDocId = new mongoose.Types.ObjectId();

    await rawCollection.insertOne({
      _id: rawDocId,
      organizationId: orgId,
      branchId,
      productId: dualProduct._id,
      onHand: 50,
      allocated: 0,
      lastMovementAt: new Date(),
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
    });

    // Verify raw document in DB truly has NO domain fields
    const rawStored = await rawCollection.findOne({ _id: rawDocId });
    expect(rawStored.onHand).toBe(50);
    expect(rawStored.onHandRetail).toBeUndefined();
    expect(rawStored.onHandConsumables).toBeUndefined();
    expect(rawStored.onHandUnallocated).toBeUndefined();

    // 2. Demonstrate how inventoryService / repository listing interprets this record:
    const { balances } = await inventoryService.listBranchStock(
      orgId,
      branchId,
    );
    const balanceItem = balances.find(
      (b) => b._id.toString() === rawDocId.toString(),
    );
    expect(balanceItem).toBeDefined();
    expect(balanceItem.onHand).toBe(50);

    // Mongoose schema / repository reads uninitialized fields as default 0
    expect(balanceItem.onHandRetail).toBe(0);
    expect(balanceItem.onHandConsumables).toBe(0);
    expect(balanceItem.onHandUnallocated).toBe(50);

    // 3. Demonstrate that salon service consumption CANNOT consume any unallocated stock
    await expect(
      inventoryService.recordManualConsumption(
        {
          branchId,
          productId: dualProduct._id,
          quantity: 5,
          notes: "Attempt consumption of unallocated stock",
        },
        orgId,
        userId,
      ),
    ).rejects.toThrow(/Insufficient stock/);

    // 4. Demonstrate that POS / invoice checkout reservation CANNOT consume unallocated stock
    const testInvoiceId = new mongoose.Types.ObjectId();
    await expect(
      inventoryService.reserveStockForInvoice(
        testInvoiceId,
        orgId,
        branchId,
        [{ productId: dualProduct._id, quantity: 5 }],
        15,
      ),
    ).rejects.toThrow(/Insufficient available stock/);

    // 5. Demonstrate that an authorized manager partial allocation transitions historical stock
    // into confirmed domain pools while preserving the invariant:
    // onHand (50) = onHandRetail (20) + onHandConsumables (15) + onHandUnallocated (15)
    const allocationResult = await inventoryService.recordDomainAllocation(
      {
        branchId,
        productId: dualProduct._id,
        retailQuantity: 20,
        consumablesQuantity: 15,
        reason: "Manager historical reconciliation for legacy batch",
        notes: "Count verified by floor manager",
      },
      orgId,
      userId,
    );

    expect(allocationResult.balance.onHand).toBe(50);
    expect(allocationResult.balance.onHandRetail).toBe(20);
    expect(allocationResult.balance.onHandConsumables).toBe(15);
    expect(allocationResult.balance.onHandUnallocated).toBe(15);
    expect(allocationResult.allocation.remainingUnallocated).toBe(15);

    // 6. Demonstrate that AFTER allocation, POS can reserve from confirmed retail
    // and Salon Consumption can deduct from confirmed consumables:
    const reservations = await inventoryService.reserveStockForInvoice(
      testInvoiceId,
      orgId,
      branchId,
      [{ productId: dualProduct._id, quantity: 5 }],
      15,
    );
    expect(reservations).toHaveLength(1);
    expect(reservations[0].quantity).toBe(5);

    const consumptionResult = await inventoryService.recordManualConsumption(
      {
        branchId,
        productId: dualProduct._id,
        quantity: 5,
        notes: "Salon wash station consumption",
      },
      orgId,
      userId,
    );
    expect(consumptionResult.movement.quantityDelta).toBe(-5);
  });
});
