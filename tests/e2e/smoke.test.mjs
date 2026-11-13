/**
 * Smoke Verification Suite for Unisex Parlour ERP E2E Test Infrastructure
 * Location: backend/tests/e2e/smoke.test.mjs
 *
 * Verifies:
 * 1. Healthcheck `GET /health` returns status 200 and `{ status: "OK" }`.
 * 2. Auth token minting and validation against `GET /api/v1/auth/me`.
 * 3. Organization and branch header scoping behavior.
 * 4. Zero-tax invariant scanner passes clean payloads and throws on simulated tax payloads.
 * 5. Ephemeral Tenant B creation works and verifies strict cross-tenant isolation.
 */
import assert from "node:assert/strict";
import { TestHttpClient } from "./harness/client.mjs";
import { startTestServer } from "./harness/server.mjs";
import {
  getTestSession,
  mintAccessToken,
  createEphemeralTenant,
  buildTestHeaders,
  TestRoles,
} from "./harness/auth.mjs";
import {
  assertSuccess,
  assertError,
  assertZeroTax,
  assertNotFound,
} from "./harness/assertions.mjs";

/**
 * Executes all 5 smoke verification checks.
 *
 * @param {Object} [context]
 * @param {TestHttpClient} [context.client]
 * @param {Object} [context.serverHandle]
 * @returns {Promise<{ passed: number, failed: number }>}
 */
export async function runSmokeSuite({ client: injectedClient, serverHandle: injectedServer } = {}) {
  let passed = 0;
  let failed = 0;

  let serverHandle = injectedServer;
  let client = injectedClient;

  // If run standalone, spin up server and client
  const isStandalone = !injectedClient;
  if (isStandalone) {
    serverHandle = await startTestServer();
    client = new TestHttpClient({ baseUrl: serverHandle.apiUrl });
  }

  console.log("\n  [SMOKE SUITE] Starting 5-point infrastructure verification...\n");

  try {
    // -------------------------------------------------------------------------
    // Check 1: Healthcheck GET /health
    // -------------------------------------------------------------------------
    process.stdout.write("  [1/5] Testing GET /health endpoint... ");
    try {
      // /health is mounted at root, not under /api/v1
      const healthUrl = `${serverHandle.baseUrl}/health`;
      const res = await client.get(healthUrl);

      assert.equal(res.status, 200, `Expected status 200, got ${res.status}`);
      assert.equal(res.data?.status, "OK", `Expected status "OK", got ${res.data?.status}`);
      assert.ok(typeof res.data?.uptime === "number", "Expected uptime number");
      assertZeroTax(res.data);

      console.log("PASS ✅");
      passed++;
    } catch (err) {
      console.log("FAIL ❌");
      console.error("        Error:", err.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // Check 2: Auth Token Minting & Validation against GET /api/v1/auth/me
    // -------------------------------------------------------------------------
    process.stdout.write("  [2/5] Testing token minting & GET /api/v1/auth/me... ");
    let ownerSession = null;
    try {
      ownerSession = await getTestSession(TestRoles.OWNER);
      assert.ok(ownerSession.token, "Token must be minted");
      assert.ok(ownerSession.user.organizationId, "Organization ID must be present");

      client.setAuthToken(ownerSession.token);
      client.setOrganizationId(ownerSession.user.organizationId);

      const meRes = await client.get("/auth/me");
      const meData = assertSuccess(meRes, 200);

      assert.equal(meData.email, ownerSession.user.email, "Email must match test session");
      assert.equal(meData.role, "Owner", "Role must be Owner");
      assert.ok(Array.isArray(meData.permissions), "Permissions array must be returned");
      assert.ok(meData.permissions.length > 0, "Owner must possess permissions");

      console.log("PASS ✅");
      passed++;
    } catch (err) {
      console.log("FAIL ❌");
      console.error("        Error:", err.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // Check 3: Organization & Branch Header Scoping
    // -------------------------------------------------------------------------
    process.stdout.write("  [3/5] Testing organization & branch scoping headers... ");
    try {
      // 3a. Read branches with organization scope
      const branchesRes = await client.get("/branches");
      const branchList = assertSuccess(branchesRes, 200);
      assert.ok(Array.isArray(branchList), "Branches must be an array");
      assert.ok(branchList.length > 0, "At least one branch must exist");

      const activeBranch = branchList.find((b) => b.isActive) || branchList[0];
      const activeBranchId = activeBranch._id || activeBranch.id;

      // 3b. Read customers with active branch header
      client.setBranchId(activeBranchId);
      const custRes = await client.get("/customers");
      assertSuccess(custRes, 200);

      // 3c. Prohibit unauthorized or non-existent branch ID
      const fakeBranchId = "507f1f77bcf86cd799439011";
      client.setBranchId(fakeBranchId);
      const invalidBranchRes = await client.get("/customers");
      // branchScope throws 404 Resource not found when branch doesn't belong to org
      assertError(invalidBranchRes, 404);

      // Restore valid branch
      client.setBranchId(activeBranchId);

      console.log("PASS ✅");
      passed++;
    } catch (err) {
      console.log("FAIL ❌");
      console.error("        Error:", err.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // Check 4: Zero-Tax Invariant Scanner
    // -------------------------------------------------------------------------
    process.stdout.write("  [4/5] Testing Zero-Tax invariant enforcement... ");
    try {
      // 4a. Clean payload with safe keys containing 'vat' and 'tax' substrings:
      // Must pass without false positives
      const safePayload = {
        invoiceNumber: "INV-2026-001",
        subtotal: 1500,
        lineDiscountsTotal: 100,
        payableAmount: 1400,
        activationToken: "tok_secure_123",
        isActivated: true,
        requireActivation: false,
        privateNotes: "VIP customer notes",
        avatar: "https://avatar.url/img.png",
        reservationId: "res_987",
        syntax: "standard_syntax",
        taxonomy: "salon_services",
        items: [
          { name: "Haircut", price: 500 },
          { name: "Beard Trim", price: 1000 },
        ],
      };
      assertZeroTax(safePayload);

      // 4b. Circular data structure (must not cause stack overflow)
      const circularPayload = { name: "Service", safe: true };
      circularPayload.self = circularPayload;
      assertZeroTax(circularPayload);

      // 4c. Forbidden tax payloads - verify each genuine tax key is blocked
      const forbiddenSamples = [
        { key: "gst", payload: { subtotal: 1000, gst: 180, payableAmount: 1180 } },
        { key: "cgst", payload: { invoice: { items: [{ name: "Shampoo", cgst: 9 }] } } },
        { key: "sgst", payload: { invoice: { items: [{ name: "Shampoo", sgst: 9 }] } } },
        { key: "igst", payload: { invoice: { items: [{ name: "Shampoo", igst: 18 }] } } },
        { key: "vat", payload: { subtotal: 1000, vat: 50 } },
        { key: "taxAmount", payload: { total: 500, taxAmount: 50 } },
        { key: "taxRate", payload: { rate: 18, taxRate: 18 } },
        { key: "tax_total", payload: { total: 500, tax_total: 50 } },
        { key: "isTaxable", payload: { name: "Product", isTaxable: true } },
        { key: "gstNumber", payload: { profile: { gstNumber: "29AAAAA0000A1Z5" } } },
      ];

      for (const { key, payload } of forbiddenSamples) {
        assert.throws(
          () => assertZeroTax(payload),
          /ZERO-TAX INVARIANT VIOLATION/i,
          `assertZeroTax must throw when forbidden key '${key}' is present`
        );
      }

      console.log("PASS ✅");
      passed++;
    } catch (err) {
      console.log("FAIL ❌");
      console.error("        Error:", err.message);
      failed++;
    }

    // -------------------------------------------------------------------------
    // Check 5: Ephemeral Tenant B Creation & Cross-Tenant Isolation
    // -------------------------------------------------------------------------
    process.stdout.write("  [5/5] Testing Ephemeral Tenant B & cross-tenant isolation... ");
    try {
      // Provision Tenant B
      const tenantB = await createEphemeralTenant();
      assert.ok(tenantB.organizationId, "Tenant B organizationId required");
      assert.ok(tenantB.branchId, "Tenant B branchId required");
      assert.ok(tenantB.token, "Tenant B token required");

      // Verify Tenant B can read its own profile
      const clientB = new TestHttpClient({ baseUrl: serverHandle.apiUrl });
      clientB.setAuthToken(tenantB.token);
      clientB.setOrganizationId(tenantB.organizationId);

      const meBRes = await clientB.get("/auth/me");
      const meBData = assertSuccess(meBRes, 200);
      assert.equal(
        meBData.organizationId.toString(),
        tenantB.organizationId,
        "Tenant B profile must reflect Tenant B organization"
      );

      // Cross-Tenant Invariant:
      // Tenant B attempts to access Tenant A's primary branch
      const tenantABranchId = ownerSession.user.branchAccess[0]?.branchId;
      if (tenantABranchId) {
        clientB.setBranchId(tenantABranchId);
        const crossTenantRes = await clientB.get("/customers");
        // branchScope queries Branch with { _id: branchId, organizationId: req.user.organizationId }
        // Because Tenant A's branch belongs to Org A, Tenant B receives 404 Not Found
        assertNotFound(crossTenantRes);
      }

      console.log("PASS ✅");
      passed++;
    } catch (err) {
      console.log("FAIL ❌");
      console.error("        Error:", err.message);
      failed++;
    }
  } finally {
    if (isStandalone && serverHandle) {
      await serverHandle.close();
    }
  }

  console.log(`\n  [SMOKE SUITE] Completed: ${passed} passed, ${failed} failed.\n`);
  return { passed, failed };
}

// Standalone execution support
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runSmokeSuite()
    .then(({ failed }) => {
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error("Fatal Smoke Suite Error:", err);
      process.exit(1);
    });
}
