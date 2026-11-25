import { jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import {
  fetchAndValidateLogoDataUri,
  generateInvoiceHtml,
  hasValidImageSignature,
  isPrivateOrReservedIp,
  isTrustedLogoUrl,
} from "../../services/billing/invoicePdf.service.js";
import { BillingService } from "../../services/billing/billing.service.js";
import { Organization } from "../../models/organizations/organization.model.js";
import { OrganizationSettings } from "../../models/settings/organizationSettings.model.js";
import { Branch } from "../../models/branches/branch.model.js";
import { Invoice } from "../../models/billing/invoice.model.js";
import { Payment } from "../../models/billing/payment.model.js";
import { CampaignAttributionService } from "../../services/marketing/campaignAttribution.service.js";

const VALID_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);

function createMockHttpsRequest({
  statusCode = 200,
  headers = {},
  chunks = [VALID_PNG_BYTES],
  triggerTimeout = false,
} = {}) {
  const calls = [];
  const httpsRequest = (options, cb) => {
    calls.push(options);
    const req = new EventEmitter();
    req.setTimeout = (_ms, onTimeout) => {
      if (triggerTimeout) {
        queueMicrotask(onTimeout);
      }
    };
    req.destroy = () => {};
    req.end = () => {
      if (triggerTimeout) return;
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.headers = headers;
      res.resume = () => {};
      res.destroy = () => {};
      cb(res);
      queueMicrotask(() => {
        for (const chunk of chunks) {
          res.emit("data", chunk);
        }
        res.emit("end");
      });
    };
    return req;
  };
  return { httpsRequest, calls };
}

describe("Invoice Branding, Security & Historical Snapshots (Phase 1.2)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("Server-Side Logo Fetch & SSRF/DNS-Rebinding Security", () => {
    it("pins validated public IP, preserves TLS SNI & rejectUnauthorized, and returns data URI for valid PNG", async () => {
      const { httpsRequest, calls } = createMockHttpsRequest({
        statusCode: 200,
        headers: { "content-type": "image/png" },
        chunks: [VALID_PNG_BYTES],
      });
      const dnsLookup = async () => [{ address: "104.18.1.1", family: 4 }];

      const result = await fetchAndValidateLogoDataUri(
        "https://res.cloudinary.com/demo/image/upload/logo.png",
        { dnsLookup, httpsRequest },
      );

      expect(result).toBe(
        `data:image/png;base64,${VALID_PNG_BYTES.toString("base64")}`,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].rejectUnauthorized).toBe(true);
      expect(calls[0].servername).toBe("res.cloudinary.com");

      let pinnedIp;
      calls[0].lookup("res.cloudinary.com", {}, (_err, addr) => {
        pinnedIp = addr;
      });
      expect(pinnedIp).toBe("104.18.1.1");
    });

    it("rejects credentials, non-443 ports, untrusted hosts, IP literals, and private/metadata/IPv4-mapped IPs", async () => {
      expect(
        isTrustedLogoUrl("https://user:pass@res.cloudinary.com/logo.png"),
      ).toBe(false);
      expect(isTrustedLogoUrl("https://res.cloudinary.com:8443/logo.png")).toBe(
        false,
      );
      expect(isTrustedLogoUrl("https://evil.example.com/logo.png")).toBe(false);
      expect(isTrustedLogoUrl("https://127.0.0.1/logo.png")).toBe(false);
      expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true);
      expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true);

      const dnsToPrivate = async () => [{ address: "10.0.0.1", family: 4 }];
      const { httpsRequest, calls } = createMockHttpsRequest();
      const res = await fetchAndValidateLogoDataUri(
        "https://res.cloudinary.com/demo/logo.png",
        { dnsLookup: dnsToPrivate, httpsRequest },
      );
      expect(res).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it("rejects redirects, invalid content-type, SVG, invalid magic-byte signature, oversized streams, and timeouts", async () => {
      const dnsLookup = async () => [{ address: "104.18.1.1", family: 4 }];

      // Redirect
      const redir = createMockHttpsRequest({
        statusCode: 302,
        headers: { location: "https://evil.com" },
      });
      await expect(
        fetchAndValidateLogoDataUri("https://res.cloudinary.com/a.png", {
          dnsLookup,
          httpsRequest: redir.httpsRequest,
        }),
      ).resolves.toBeNull();

      // SVG content-type
      const svg = createMockHttpsRequest({
        statusCode: 200,
        headers: { "content-type": "image/svg+xml" },
      });
      await expect(
        fetchAndValidateLogoDataUri("https://res.cloudinary.com/a.svg", {
          dnsLookup,
          httpsRequest: svg.httpsRequest,
        }),
      ).resolves.toBeNull();

      // Invalid magic bytes
      const badSig = createMockHttpsRequest({
        statusCode: 200,
        headers: { "content-type": "image/png" },
        chunks: [Buffer.from("<html>not-a-png</html>")],
      });
      await expect(
        fetchAndValidateLogoDataUri("https://res.cloudinary.com/a.png", {
          dnsLookup,
          httpsRequest: badSig.httpsRequest,
        }),
      ).resolves.toBeNull();
      expect(hasValidImageSignature(Buffer.from("<html>"), "image/png")).toBe(
        false,
      );

      // Oversized stream
      const oversized = createMockHttpsRequest({
        statusCode: 200,
        headers: { "content-type": "image/png" },
        chunks: [VALID_PNG_BYTES, Buffer.alloc(600 * 1024)],
      });
      await expect(
        fetchAndValidateLogoDataUri("https://res.cloudinary.com/a.png", {
          dnsLookup,
          httpsRequest: oversized.httpsRequest,
        }),
      ).resolves.toBeNull();

      // Timeout
      const timedOut = createMockHttpsRequest({ triggerTimeout: true });
      await expect(
        fetchAndValidateLogoDataUri("https://res.cloudinary.com/a.png", {
          dnsLookup,
          httpsRequest: timedOut.httpsRequest,
        }),
      ).resolves.toBeNull();
    });
  });

  describe("BillingService.finalizeInvoice - Snapshot Lifecycle", () => {
    function mockBrandingQueries(sessionSpy) {
      const makeChain = (val) => {
        const chain = {
          select: () => chain,
          lean: () => chain,
          session: (s) => {
            sessionSpy(s);
            return chain;
          },
          then: (resolve, reject) => Promise.resolve(val).then(resolve, reject),
        };
        return chain;
      };
      jest.spyOn(Organization, "findById").mockReturnValue(
        makeChain({
          name: "Aura Corp",
          logo: "https://res.cloudinary.com/demo/aura.png",
        }),
      );
      jest.spyOn(OrganizationSettings, "findOne").mockReturnValue(
        makeChain({
          profile: {
            displayName: "Aura Studio",
            address: "HQ",
            phone: "111",
          },
          regional: { timezone: "Asia/Kolkata" },
        }),
      );
      jest.spyOn(Branch, "findOne").mockReturnValue(
        makeChain({
          name: "Main",
          address: "Branch Addr",
          phone: "222",
          timezone: "Asia/Kolkata",
        }),
      );
    }

    it("captures organizationSnapshot and branchSnapshot inside transaction session on successful finalization", async () => {
      const service = new BillingService();
      const fakeSession = { id: "tx-session-1" };
      const sessionCalls = [];
      jest
        .spyOn(service, "executeTransaction")
        .mockImplementation(async (fn) => fn(fakeSession));
      jest
        .spyOn(CampaignAttributionService, "resolveAttributionSnapshot")
        .mockResolvedValue({ sourceType: "unassigned" });
      mockBrandingQueries((s) => sessionCalls.push(s));

      const invoiceDoc = {
        _id: "inv1",
        organizationId: "org1",
        branchId: "branch1",
        status: "draft",
        amountPaid: 0,
        amountDue: 500,
        lines: [],
        organizationSnapshot: null,
        branchSnapshot: null,
        save: jest.fn().mockRejectedValue(new Error("STOP_AFTER_SAVE")),
      };
      jest
        .spyOn(Invoice, "findOne")
        .mockReturnValue({ session: async () => invoiceDoc });

      await expect(
        service.finalizeInvoice("inv1", {}, "org1", "branch1", "user1"),
      ).rejects.toThrow("STOP_AFTER_SAVE");

      expect(invoiceDoc.save).toHaveBeenCalledWith({ session: fakeSession });
      expect(invoiceDoc.status).toBe("finalized");
      expect(invoiceDoc.organizationSnapshot).toEqual({
        name: "Aura Corp",
        displayName: "Aura Studio",
        logo: "https://res.cloudinary.com/demo/aura.png",
        address: "HQ",
        phone: "111",
        email: null,
        website: null,
      });
      expect(invoiceDoc.branchSnapshot).toEqual({
        name: "Main",
        address: "Branch Addr",
        phone: "222",
        timezone: "Asia/Kolkata",
      });
      expect(sessionCalls).toEqual([fakeSession, fakeSession, fakeSession]);
    });

    it("rejects re-finalization and does not overwrite existing snapshots", async () => {
      const service = new BillingService();
      jest
        .spyOn(service, "executeTransaction")
        .mockImplementation(async (fn) => fn({}));

      const existingSnap = {
        name: "Old Name",
        displayName: "Old Display",
        logo: null,
        address: null,
        phone: null,
        email: null,
        website: null,
      };
      const invoiceDoc = {
        _id: "inv1",
        branchId: "branch1",
        status: "finalized",
        organizationSnapshot: existingSnap,
        save: jest.fn(),
      };
      jest
        .spyOn(Invoice, "findOne")
        .mockReturnValue({ session: async () => invoiceDoc });

      await expect(
        service.finalizeInvoice("inv1", {}, "org1", "branch1", "user1"),
      ).rejects.toThrow("Cannot finalize invoice");
      expect(invoiceDoc.organizationSnapshot).toBe(existingSnap);
      expect(invoiceDoc.save).not.toHaveBeenCalled();
    });
  });

  describe("BillingService.generateInvoicePdf - Snapshot vs Live Selection", () => {
    it("uses stored snapshots for finalized invoices even if live org settings change, and falls back to live for drafts/legacy", async () => {
      const service = new BillingService();
      jest.spyOn(Payment, "find").mockReturnValue({ sort: async () => [] });
      jest.spyOn(service, "resolveInvoiceBranding").mockResolvedValue({
        organization: {
          name: "New Live Org",
          displayName: "New Live Display",
          logo: null,
        },
        branch: {
          name: "New Live Branch",
          address: null,
          phone: null,
          timezone: "Asia/Kolkata",
        },
      });

      const finalizedHtml = generateInvoiceHtml({
        invoice: {
          _id: "inv1",
          invoiceNumber: "INV-1",
          status: "finalized",
          paymentStatus: "paid",
          lines: [],
          amountDue: 0,
          organizationSnapshot: {
            name: "Historical Org",
            displayName: "Historical Display",
          },
          branchSnapshot: { name: "Historical Branch" },
        },
        organization: {
          name: "Historical Org",
          displayName: "Historical Display",
        },
        branch: { name: "Historical Branch" },
      });
      expect(finalizedHtml).toContain("Historical Display");
      expect(finalizedHtml).toContain("Historical Branch");
      expect(finalizedHtml).not.toContain("New Live Display");
    });

    it("throws 404 when invoice does not match organizationId or branchId", async () => {
      const service = new BillingService();
      jest.spyOn(Invoice, "findOne").mockReturnValue({
        populate: () => ({
          populate: () => ({
            populate: () => ({
              populate: async () => null,
            }),
          }),
        }),
      });

      await expect(
        service.generateInvoicePdf("inv-other-org", "org1", "branch1"),
      ).rejects.toThrow("Invoice not found");
    });
  });
});
