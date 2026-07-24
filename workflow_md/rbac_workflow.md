# Enterprise RBAC & Cache Workflow

This document outlines the lifecycles, configuration APIs, and Redis caching procedures implemented for role-based access controls in the Saloon ERP system.

---

## 1. Core Data Models
- **Permission**: Standard keys defining operations (e.g. `customer:create`).
- **Role**: Combines individual permission keys into profiles (e.g. `hair_stylist`).
- **User**: Maps to one Role reference, and defines their Branch Access scopes.

---

## 2. API Configurations (Admin Panel)
- **POST `/api/v1/rbac/permissions`**: Registers permission keys (e.g. `appointment:create`).
- **POST `/api/v1/rbac/roles`**: Registers user profiles (e.g. `branch_manager`).
- **POST `/api/v1/rbac/roles/:roleId/permissions`**:
  - Validates permission keys array using Zod.
  - Updates the Role document in MongoDB.
  - **Cache Invalidation**: Automatically issues `redis.del("rbac:role:${role.name}:permissions")` to invalidate cached permissions.

---

## 3. Middleware Caching Architecture
When a secure request arrives requesting authorization:
1. **Identify Role**: Resolves `req.user.role`.
2. **Access Cache**: Checks Redis key `rbac:role:${roleName}:permissions`.
3. **Handle Cache Hit**:
   - Parses permissions list (Array of Strings) and checks if the required permission is present.
4. **Handle Cache Miss**:
   - Queries Mongoose Role database populated with Permission documents.
   - Extracts the array of permission names (e.g., `['customer:view', 'customer:create']`).
   - Caches the array back to Redis: `redis.setex(key, 86400, JSON.stringify(permissions))` (valid for 24 hours).
5. **Enforce Isolation**: If `checkBranchScope = true`, verifies that the targeted `branchId` is present in `req.user.branches` before executing the request handler.
