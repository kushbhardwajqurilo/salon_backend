/**
 * Reusable Domain & HTTP Assertions for Unisex Parlour ERP E2E Tests
 * Location: backend/tests/e2e/harness/assertions.mjs
 *
 * Senior Engineering Architectural Decisions:
 * 1. Declarative Contract Verification: Unifies status code, response envelope, and error
 *    messaging checks so tests remain readable, expressive, and uniform.
 * 2. Automated Zero-Tax Invariant: Guarantees that every successful payload is verified to contain
 *    zero GST, tax, or cess fields.
 * 3. Descriptive Failure Messaging: When an assertion fails, formats actual vs. expected
 *    status, payload, and headers to speed up root-cause diagnosis.
 */
import assert from "node:assert/strict";
import { assertZeroTax, isForbiddenTaxKey } from "./client.mjs";

export { assertZeroTax, isForbiddenTaxKey };

/**
 * Asserts that an HTTP response represents a successful operation.
 *
 * @param {Object} res - HTTP response object from TestHttpClient
 * @param {number} [expectedStatus=200] - Expected HTTP status code (default 200)
 * @param {string} [customMessage] - Optional custom failure message
 * @returns {any} Returns res.data.data or res.data for convenient chaining
 */
export function assertSuccess(res, expectedStatus = 200, customMessage = "") {
  assert.ok(res, `[assertSuccess] Response object must be defined. ${customMessage}`);

  const statusMsg = `Expected HTTP status ${expectedStatus}, received ${res.status}. Body: ${JSON.stringify(res.data)}`;
  assert.equal(res.status, expectedStatus, customMessage ? `${customMessage}: ${statusMsg}` : statusMsg);

  if (res.data && typeof res.data === "object") {
    // Check Unisex Parlour ERP standard JSend envelope
    if ("success" in res.data) {
      assert.equal(
        res.data.success,
        true,
        `Expected res.data.success to be true, got ${res.data.success}. Message: ${res.data.message || ""}`
      );
    }

    // Verify Zero-Tax invariant
    assertZeroTax(res.data);
  }

  return res.data?.data !== undefined ? res.data.data : res.data;
}

/**
 * Asserts that an HTTP response represents a failed operation matching expected status and message.
 *
 * @param {Object} res - HTTP response object from TestHttpClient
 * @param {number} expectedStatus - Expected HTTP status code (e.g. 400, 401, 403, 404, 409)
 * @param {string|RegExp} [expectedMessage] - Optional substring or regex to check in error message
 * @param {string} [customMessage] - Optional custom failure message
 */
export function assertError(res, expectedStatus, expectedMessage = null, customMessage = "") {
  assert.ok(res, `[assertError] Response object must be defined. ${customMessage}`);

  const statusMsg = `Expected error HTTP status ${expectedStatus}, received ${res.status}. Body: ${JSON.stringify(res.data)}`;
  assert.equal(res.status, expectedStatus, customMessage ? `${customMessage}: ${statusMsg}` : statusMsg);

  if (res.data && typeof res.data === "object") {
    if ("success" in res.data) {
      assert.equal(
        res.data.success,
        false,
        `Expected res.data.success to be false on error response, got true.`
      );
    }

    if (expectedMessage) {
      const actualMessage = res.data.message || (typeof res.data === "string" ? res.data : "");
      if (expectedMessage instanceof RegExp) {
        assert.match(
          actualMessage,
          expectedMessage,
          `Expected error message to match ${expectedMessage}, received '${actualMessage}'`
        );
      } else {
        assert.ok(
          actualMessage.toLowerCase().includes(expectedMessage.toLowerCase()),
          `Expected error message to contain '${expectedMessage}', received '${actualMessage}'`
        );
      }
    }
  }
}

/**
 * Asserts that an HTTP response is a 409 Conflict.
 * Commonly used for leave conflicts, concurrency locks, and idempotency conflicts.
 *
 * @param {Object} res - HTTP response object from TestHttpClient
 * @param {string|RegExp} [expectedMessage] - Optional substring or regex in conflict message
 */
export function assertConflict(res, expectedMessage = null) {
  assertError(res, 409, expectedMessage, "[assertConflict]");
}

/**
 * Asserts that an HTTP response is a 404 Not Found.
 * Used for tenant isolation and missing entity verification.
 *
 * @param {Object} res - HTTP response object from TestHttpClient
 * @param {string|RegExp} [expectedMessage] - Optional substring or regex in not found message
 */
export function assertNotFound(res, expectedMessage = null) {
  assertError(res, 404, expectedMessage, "[assertNotFound]");
}

/**
 * Asserts that an HTTP response is a 403 Forbidden.
 * Used for RBAC and unauthorized branch access verification.
 *
 * @param {Object} res - HTTP response object from TestHttpClient
 * @param {string|RegExp} [expectedMessage] - Optional substring or regex
 */
export function assertForbidden(res, expectedMessage = null) {
  assertError(res, 403, expectedMessage, "[assertForbidden]");
}

/**
 * Asserts that an HTTP response is a 401 Unauthorized.
 * Used for token expiration, bad signatures, or missing auth headers.
 *
 * @param {Object} res - HTTP response object from TestHttpClient
 * @param {string|RegExp} [expectedMessage] - Optional substring or regex
 */
export function assertUnauthorized(res, expectedMessage = null) {
  assertError(res, 401, expectedMessage, "[assertUnauthorized]");
}

/**
 * Asserts that an HTTP response is a 400 Bad Request.
 * Used for Zod validation errors, invalid parameters, and missing required mutation headers.
 *
 * @param {Object} res - HTTP response object from TestHttpClient
 * @param {string|RegExp} [expectedMessage] - Optional substring or regex
 */
export function assertBadRequest(res, expectedMessage = null) {
  assertError(res, 400, expectedMessage, "[assertBadRequest]");
}
