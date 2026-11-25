import { AsyncLocalStorage } from "node:async_hooks";

const auditStorage = new AsyncLocalStorage();

/**
 * Run a function within an isolated audit context (HTTP request, cron job, or worker).
 */
export const runWithAuditContext = (context, fn) => {
  return auditStorage.run({ audited: false, ...context }, fn);
};

/**
 * Get the current audit context store, or null if outside a tracked context.
 */
export const getAuditContext = () => {
  return auditStorage.getStore() || null;
};

/**
 * Mark the current request/job as having already recorded an explicit domain audit log,
 * preventing the global HTTP fallback middleware from creating a duplicate entry.
 */
export const markRequestAudited = () => {
  const store = auditStorage.getStore();
  if (store) {
    store.audited = true;
  }
};

/**
 * Check whether an explicit domain audit log was already recorded in the current context.
 */
export const isRequestAudited = () => {
  const store = auditStorage.getStore();
  return Boolean(store?.audited);
};
