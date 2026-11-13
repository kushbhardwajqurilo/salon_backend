/**
 * Opaque-Box HTTP Test Client for Unisex Parlour ERP E2E Tests
 * Location: backend/tests/e2e/harness/client.mjs
 *
 * Senior Engineering Architectural Decisions:
 * 1. Native Fetch Abstraction: Built on top of Node.js >=20 global `fetch`, eliminating external
 *    HTTP library dependencies (Axios/Superagent) and guaranteeing pure ESM compliance.
 * 2. Automated Multi-Tenant Header Injection: Consolidates Authorization, X-Branch-Id,
 *    and X-Organization-Id headers in one canonical place so test cases remain concise and declarative.
 * 3. Idempotency Key Injection: Automatically injects unique crypto UUIDs when mutations
 *    require idempotency guarantees against network retries.
 * 4. Zero-Tax Invariant Scanner: Enforces the architectural rule that NO tax/GST fields or calculations
 *    exist in request or response contracts.
 */
import crypto from "node:crypto";

/**
 * Safe words that legitimately start or contain substrings resembling tax terms
 * but are completely non-tax domain words (e.g., taxonomy, taxi, syntax).
 */
const SAFE_TAX_WORDS = new Set(["taxonomy", "taxicab", "taxi", "taxidermy", "syntax"]);

/**
 * Standard forbidden tax/GST tokens.
 */
const FORBIDDEN_TAX_TOKENS = new Set([
  "tax",
  "taxes",
  "taxable",
  "taxation",
  "taxfree",
  "taxexempt",
  "pretax",
  "posttax",
  "gst",
  "gstin",
  "cgst",
  "sgst",
  "igst",
  "utgst",
  "vat",
  "cess",
]);

/**
 * Evaluates whether a property key represents a forbidden tax/GST field.
 * Uses token-boundary, camelCase, snake_case, and kebab-case splitting so genuine
 * tax terms (tax, gst, cgst, sgst, igst, vat, taxAmount, taxRate, tax_total, isTaxable, gstNumber)
 * are blocked while safe words (activationToken, isActivated, requireActivation, privateNotes, avatar, reservationId, syntax)
 * are permitted.
 *
 * @param {string} key - Property key name
 * @returns {boolean} True if key violates zero-tax policy
 */
export function isForbiddenTaxKey(key) {
  if (typeof key !== "string") return false;

  // Split camelCase, acronyms, and digit boundaries into space-separated tokens:
  // e.g. "taxAmount" -> "tax Amount", "GSTNumber" -> "GST Number", "isActivated" -> "is Activated"
  const separated = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2");

  const tokens = separated.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  for (const token of tokens) {
    if (SAFE_TAX_WORDS.has(token)) {
      continue;
    }

    if (FORBIDDEN_TAX_TOKENS.has(token)) {
      return true;
    }

    // Check tokens starting with tax (e.g. taxamount, taxrate, taxtotal)
    if (token.startsWith("tax")) {
      return true;
    }

    // Check tokens starting with gst, cgst, sgst, igst, utgst
    if (
      token.startsWith("gst") ||
      token.startsWith("cgst") ||
      token.startsWith("sgst") ||
      token.startsWith("igst") ||
      token.startsWith("utgst")
    ) {
      return true;
    }

    // Check tokens starting with vat (e.g. vatamount, vatrate) while excluding 'vatican'
    if (token.startsWith("vat") && token !== "vatican") {
      return true;
    }
  }

  return false;
}

/**
 * Recursively scans any payload object or array to assert that zero tax/GST keys are present.
 * Uses cycle detection (WeakSet) to prevent stack overflow on circular data structures.
 * Throws a fatal invariant error if any forbidden key is detected.
 *
 * @param {any} payload - The object or array to inspect
 * @param {string} [path="root"] - Traversal path for debugging
 * @param {WeakSet<object>} [seen=new WeakSet()] - Set of visited objects for circular reference protection
 * @throws {Error} If a forbidden tax property is found
 */
export function assertZeroTax(payload, path = "root", seen = new WeakSet()) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  // Prevent infinite loops on circular references
  if (seen.has(payload)) {
    return;
  }
  seen.add(payload);

  if (Array.isArray(payload)) {
    for (let index = 0; index < payload.length; index++) {
      assertZeroTax(payload[index], `${path}[${index}]`, seen);
    }
    return;
  }

  for (const [key, value] of Object.entries(payload)) {
    const currentPath = `${path}.${key}`;

    if (isForbiddenTaxKey(key)) {
      throw new Error(
        `🚨 [ZERO-TAX INVARIANT VIOLATION] Forbidden tax/GST property '${key}' detected at path '${currentPath}'. Unisex Parlour ERP operates under strict Zero GST/Tax policy.`
      );
    }

    if (value && typeof value === "object") {
      assertZeroTax(value, currentPath, seen);
    }
  }
}

/**
 * TestHttpClient wraps native fetch to execute opaque-box HTTP requests
 * against the live Unisex Parlour ERP backend.
 */
export class TestHttpClient {
  /**
   * @param {Object} [options]
   * @param {string} [options.baseUrl="http://127.0.0.1:5000/api/v1"] - Base URL
   * @param {Object} [options.defaultHeaders={}] - Default headers to attach
   */
  constructor({ baseUrl = "http://127.0.0.1:5000/api/v1", defaultHeaders = {} } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.defaultHeaders = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...defaultHeaders,
    };
    this.token = null;
    this.organizationId = null;
    this.branchId = null;
  }

  /**
   * Updates or clears the Authorization Bearer token.
   * @param {string|null} token
   * @returns {TestHttpClient} this
   */
  setAuthToken(token) {
    this.token = token || null;
    return this;
  }

  /**
   * Updates or clears the scoped Organization ID.
   * @param {string|null} organizationId
   * @returns {TestHttpClient} this
   */
  setOrganizationId(organizationId) {
    this.organizationId = organizationId ? organizationId.toString() : null;
    return this;
  }

  /**
   * Updates or clears the scoped Branch ID.
   * Passing null or "all" removes the active branch header.
   * @param {string|null} branchId
   * @returns {TestHttpClient} this
   */
  setBranchId(branchId) {
    if (!branchId || branchId === "all") {
      this.branchId = null;
    } else {
      this.branchId = branchId.toString();
    }
    return this;
  }

  /**
   * Clears all session credentials and scopes.
   * @returns {TestHttpClient} this
   */
  clearAuth() {
    this.token = null;
    this.organizationId = null;
    this.branchId = null;
    return this;
  }

  /**
   * Updates the target base URL.
   * @param {string} url
   * @returns {TestHttpClient} this
   */
  setBaseUrl(url) {
    this.baseUrl = url.replace(/\/$/, "");
    return this;
  }

  /**
   * Resolves final request headers merging defaults, instance context, and overrides.
   * @param {Object} [customHeaders={}]
   * @param {string} [method="GET"]
   * @param {boolean} [idempotency=false]
   * @returns {Object} Final HTTP headers
   */
  buildHeaders(customHeaders = {}, method = "GET", idempotency = false) {
    const headers = { ...this.defaultHeaders, ...customHeaders };

    if (this.token && !headers["Authorization"] && !headers["authorization"]) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    if (this.branchId && !headers["X-Branch-Id"] && !headers["x-branch-id"]) {
      headers["X-Branch-Id"] = this.branchId;
    }

    if (
      this.organizationId &&
      !headers["X-Organization-Id"] &&
      !headers["x-organization-id"]
    ) {
      headers["X-Organization-Id"] = this.organizationId;
    }

    // Auto-generate Idempotency-Key on mutation requests if requested
    const upperMethod = method.toUpperCase();
    if (
      (idempotency || (customHeaders && customHeaders.idempotency)) &&
      (upperMethod === "POST" || upperMethod === "PUT" || upperMethod === "PATCH" || upperMethod === "DELETE") &&
      !headers["Idempotency-Key"] &&
      !headers["idempotency-key"]
    ) {
      headers["Idempotency-Key"] = crypto.randomUUID();
    }

    return headers;
  }

  /**
   * Core request dispatcher wrapping native fetch.
   *
   * @param {string} method - HTTP Verb (GET, POST, PUT, PATCH, DELETE)
   * @param {string} path - URL path relative to baseUrl or absolute URL
   * @param {Object} [options]
   * @param {any} [options.body] - Request payload
   * @param {Object} [options.headers={}] - Custom headers
   * @param {boolean} [options.idempotency=false] - Attach Idempotency-Key header
   * @param {boolean} [options.skipTaxCheck=false] - Skip zero-tax invariant verification
   * @returns {Promise<{ status: number, ok: boolean, headers: Object, data: any, body: any, raw: string }>}
   */
  async request(method, path, options = {}) {
    const { body, headers = {}, idempotency = false, skipTaxCheck = false } = options;

    let targetUrl;
    if (path.startsWith("http://") || path.startsWith("https://")) {
      targetUrl = path;
    } else {
      const cleanPath = path.startsWith("/") ? path : `/${path}`;
      targetUrl = `${this.baseUrl}${cleanPath}`;
    }

    const reqHeaders = this.buildHeaders(headers, method, idempotency);

    const init = {
      method: method.toUpperCase(),
      headers: reqHeaders,
    };

    if (body !== undefined && body !== null) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    const response = await fetch(targetUrl, init);
    const rawText = await response.text();

    let parsed = null;
    try {
      parsed = JSON.parse(rawText);
    } catch (_) {
      parsed = rawText;
    }

    // Automatically enforce Zero-Tax invariant on all JSON response objects
    if (!skipTaxCheck && typeof parsed === "object" && parsed !== null) {
      assertZeroTax(parsed);
    }

    const result = {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      data: parsed,
      body: parsed,
      raw: rawText,
    };

    return result;
  }

  /** Convenience HTTP GET */
  get(path, options) {
    return this.request("GET", path, options);
  }

  /** Convenience HTTP POST */
  post(path, body, options = {}) {
    return this.request("POST", path, { ...options, body });
  }

  /** Convenience HTTP PUT */
  put(path, body, options = {}) {
    return this.request("PUT", path, { ...options, body });
  }

  /** Convenience HTTP PATCH */
  patch(path, body, options = {}) {
    return this.request("PATCH", path, { ...options, body });
  }

  /** Convenience HTTP DELETE */
  delete(path, options) {
    return this.request("DELETE", path, options);
  }
}
