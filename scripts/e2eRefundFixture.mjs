import dns from "dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { Organization } from "../src/models/organizations/organization.model.js";
import { Branch } from "../src/models/branches/branch.model.js";
import { Customer } from "../src/models/customers/customer.model.js";
import { Role } from "../src/models/roles/role.model.js";
import { Permission } from "../src/models/permissions/permission.model.js";
import { User } from "../src/models/users/user.model.js";
import { Invoice } from "../src/models/billing/invoice.model.js";
import { Payment } from "../src/models/billing/payment.model.js";
import { RefundCase } from "../src/models/billing/refundCase.model.js";

const [, , cmd, arg] = process.argv;

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set in backend/.env");
  await mongoose.connect(uri);

  if (cmd === "--seed") {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const email = `e2e_refund_${suffix}@example.com`;
    const password = "Password123!";

    const org = await Organization.create({
      name: `E2E Refund Salon ${suffix}`,
      ownerEmail: email,
      status: "active",
    });

    const branch = await Branch.create({
      organizationId: org._id,
      name: `E2E Branch ${suffix}`,
      code: `E2E${String(Date.now()).slice(-4)}`,
      isActive: true,
    });

    const permNames = ["payments.view", "payments.refund", "billing.view"];
    const permIds = [];
    for (const name of permNames) {
      let p = await Permission.findOne({ name });
      if (!p) {
        p = await Permission.create({
          name,
          module: name.startsWith("payments") ? "Payments" : "Billing & POS",
          action: name.split(".")[1],
          description: name,
        });
      }
      permIds.push(p._id);
    }

    const role = await Role.create({
      organizationId: org._id,
      name: "Owner",
      permissions: permIds,
    });

    const user = await User.create({
      organizationId: org._id,
      name: `E2E Refund Admin ${suffix}`,
      username: `e2e_refund_${suffix}`,
      email,
      phone: `9${String(Date.now()).slice(-9)}`,
      password,
      role: role._id,
      hasOrgWideAccess: true,
      isActive: true,
    });

    const customer = await Customer.create({
      organizationId: org._id,
      homeBranchId: branch._id,
      name: "E2E Refund Customer",
      phone: `8${String(Date.now()).slice(-9)}`,
      email: `cust_${suffix}@example.com`,
    });

    const invoiceNumber = `INV-E2E-${suffix}`;
    const invoice = await Invoice.create({
      organizationId: org._id,
      branchId: branch._id,
      customerId: customer._id,
      customerSnapshot: { name: customer.name, phone: customer.phone },
      invoiceNumber,
      invoiceType: "appointment",
      status: "finalized",
      paymentStatus: "paid",
      subtotal: 1000,
      grossPayable: 1000,
      payableAmount: 1000,
      amountPaid: 1000,
      amountDue: 0,
      subtotalPaise: 100000,
      discountTotalPaise: 0,
      taxTotalPaise: 0,
      totalPayablePaise: 100000,
      paidAmountPaise: 100000,
      dueAmountPaise: 0,
      lines: [
        {
          lineType: "service",
          serviceId: new mongoose.Types.ObjectId(),
          name: "E2E Haircut",
          quantity: 1,
          unitPrice: 1000,
          lineTotal: 1000,
          customerPayable: 1000,
          unitPricePaise: 100000,
          netTotalPaise: 100000,
        },
      ],
      createdBy: user._id,
    });

    const payment = await Payment.create({
      organizationId: org._id,
      branchId: branch._id,
      invoiceId: invoice._id,
      customerId: customer._id,
      paymentNumber: `PAY-E2E-${suffix}`,
      type: "payment",
      method: "cash",
      amount: 1000,
      amountPaise: 100000,
      status: "completed",
      recordedBy: user._id,
    });

    console.log(
      JSON.stringify({
        orgId: String(org._id),
        branchId: String(branch._id),
        userId: String(user._id),
        email,
        password,
        customerId: String(customer._id),
        invoiceId: String(invoice._id),
        invoiceNumber,
        paymentId: String(payment._id),
      })
    );
  } else if (cmd === "--verify") {
    const invoiceId = arg;
    const [refundCases, refundPayments, invoice, originalPayments] = await Promise.all([
      RefundCase.find({ invoiceId }).lean(),
      Payment.find({ invoiceId, type: "refund" }).lean(),
      Invoice.findById(invoiceId).lean(),
      Payment.find({ invoiceId, type: "payment" }).lean(),
    ]);
    console.log(
      JSON.stringify({
        refundCases,
        refundPayments,
        invoice,
        originalPayments,
      })
    );
  } else if (cmd === "--cleanup") {
    const orgId = arg;
    await Promise.all([
      RefundCase.deleteMany({ organizationId: orgId }),
      Payment.deleteMany({ organizationId: orgId }),
      Invoice.deleteMany({ organizationId: orgId }),
      Customer.deleteMany({ organizationId: orgId }),
      User.deleteMany({ organizationId: orgId }),
      Role.deleteMany({ organizationId: orgId }),
      Branch.deleteMany({ organizationId: orgId }),
      Organization.deleteMany({ _id: orgId }),
    ]);
    console.log(JSON.stringify({ cleaned: true, orgId }));
  } else {
    throw new Error(`Unknown command: ${cmd}`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
