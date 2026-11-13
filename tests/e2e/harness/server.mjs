/**
 * Ephemeral Test Server Lifecycle Manager for Unisex Parlour ERP E2E Tests
 * Location: backend/tests/e2e/harness/server.mjs
 *
 * Senior Engineering Architectural Decisions:
 * 1. Port 0 Ephemeral Binding: Binds Express to OS port 0 (`app.listen(0)`). The OS dynamically
 *    allocates a free port from the dynamic/private port range, completely eliminating port collision
 *    issues with running servers or concurrent test processes.
 * 2. Real TCP Socket Fidelity: Unlike Supertest which mocks the HTTP socket layer in-process,
 *    a live server validates real TCP network behavior, real CORS preflight, real HTTP parser headers,
 *    and exact connection behavior.
 * 3. Graceful Lifecycle Cleanup: Encapsulates server.close() and mongoose.connection.close()
 *    to guarantee zero connection leaks or lingering event loops upon test suite completion.
 */
import mongoose from "mongoose";
import app from "../../../app.mjs";
import { connectDB } from "../../../src/database/db.js";

let activeServerHandle = null;

/**
 * Starts an ephemeral live Express test server on port 0 with MongoDB Atlas connection.
 * If already started, returns the existing server handle.
 *
 * @param {Object} [options]
 * @param {string} [options.targetUrl] - Optional external base URL (e.g. for staging testing)
 * @param {boolean} [options.forceNew=false] - Force new server instantiation
 * @returns {Promise<{ server: import("http").Server|null, port: number, baseUrl: string, apiUrl: string, close: () => Promise<void> }>}
 */
export async function startTestServer({ targetUrl, forceNew = false } = {}) {
  // If an external URL is targeted via parameter or environment variable
  const externalUrl = targetUrl || process.env.E2E_BASE_URL;
  if (externalUrl) {
    const cleanUrl = externalUrl.replace(/\/$/, "");
    return {
      server: null,
      port: 0,
      baseUrl: cleanUrl,
      apiUrl: `${cleanUrl}/api/v1`,
      close: async () => {},
    };
  }

  if (activeServerHandle && !forceNew) {
    return activeServerHandle;
  }

  // 1. Connect to MongoDB Atlas if not already connected
  if (mongoose.connection.readyState !== 1) {
    await connectDB();
  }

  // 2. Bind Express app to ephemeral OS port (0)
  return new Promise((resolve, reject) => {
    try {
      const server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
        const baseUrl = `http://127.0.0.1:${port}`;
        const apiUrl = `${baseUrl}/api/v1`;

        activeServerHandle = {
          server,
          port,
          baseUrl,
          apiUrl,
          close: async () => {
            if (activeServerHandle?.server) {
              if (typeof activeServerHandle.server.closeAllConnections === "function") {
                activeServerHandle.server.closeAllConnections();
              }
              await new Promise((res) => {
                activeServerHandle.server.close((err) => {
                  if (err) console.error("Error closing test server:", err);
                  res();
                });
              });
            }
            if (mongoose.connection.readyState !== 0) {
              await mongoose.connection.close();
            }
            activeServerHandle = null;
          },
        };

        resolve(activeServerHandle);
      });

      server.on("error", (err) => {
        activeServerHandle = null;
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Convenience helper to stop the active test server and teardown database connections.
 * Explicitly terminates all HTTP/1.1 keep-alive sockets before closing the server.
 */
export async function stopTestServer() {
  if (activeServerHandle) {
    if (activeServerHandle.server && typeof activeServerHandle.server.closeAllConnections === "function") {
      activeServerHandle.server.closeAllConnections();
    }
    await activeServerHandle.close();
  }
}
