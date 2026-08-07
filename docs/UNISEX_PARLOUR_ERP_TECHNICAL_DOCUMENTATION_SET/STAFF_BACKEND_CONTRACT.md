# Authoritative Staff Backend API Contract

This document represents the authoritative, verified API contract for the Staff module. It is compiled directly from the implemented backend source code (routes, controllers, services, models, repositories, validators, and middlewares) and is the sole source of truth for Staff integration.

---

## 1. Module-Wide Middleware & Security

All routes under `/api/v1/staff` require the following middlewares (in order):

1. **Authentication (`authenticate`)**:
   - Requires a valid JWT token in the `Authorization` header (`Bearer <token>`) or the `accessToken` cookie.
   - Attaches `req.user` (containing `id`, `email`, `role`, `organizationId`, `branchAccess`, `hasOrgWideAccess`) to the request.
   - Throws `401 Unauthorized` if token is missing or expired, or user is not found. Throws `403 Forbidden` if the user status is not `active`.
2. **Organization Scoping (`requireOrganizationScope`)**:
   - Strictly enforces tenant isolation at the organization level.
   - Extracts the `organizationId` from `req.user.organizationId` and binds it to `req.organizationId`.
   - Never allows organization ID overriding via request headers, query parameters, or body parameters.
3. **Role-Based Access Control (`authorize`)**:
   - Restricts route execution to users possessing the specific permission associated with the action.
   - Permission names map to the backend canonical definitions.
4. **Request Validation (`validate`)**:
   - Executes Zod schemas against request components (`req.body` or `req.query`).
   - Throws `400 Bad Request` on schema violations with a structured error details payload.

---

## 2. Primary Branch Integrity Invariant

For every Staff member, the backend strictly enforces the following branch assignment rules:
- **Zero active branch assignments**: Permitted (e.g. newly created profile or offboarded staff).
- **One or more active branch assignments**: Exactly one active primary branch assignment (`isPrimary: true`) is required at all times.
- **First assignment rule**: The first branch assigned to a staff member is automatically set to `isPrimary = true` (regardless of client input).
- **Primary reassignment rule**: Assigning a new branch with `isPrimary: true` demotes the previous primary assignment to `isPrimary = false`.
- **Primary promotion rule**: Removing/deactivating the active primary branch assignment (`isActive = false`) automatically promotes the oldest remaining active branch assignment (sorted by `createdAt` ascending) to `isPrimary = true`.
- **All-branch removal rule**: If the final active branch assignment is removed, no primary assignment is maintained or required.
- **Transactional integrity**: All state modifications and demotions/promotions occur within a single database transaction.

---

## 3. API Endpoints Reference

### 3.1. Create Staff Profile
- **Method**: `POST`
- **Route**: `/api/v1/staff/`
- **Permission Required**: `employees.create`
- **Request Payload (`validate(createStaffSchema)`)**:
  ```json
  {
    "name": "John Doe",             // string, min 2 chars, trimmed
    "email": "john.doe@salon.com",   // string, valid email, trimmed, lowercase
    "phone": "+919876543210",       // string, E.164 format (regex: /^\+?[1-9]\d{1,14}$/)
    "designation": "Stylist",       // string, min 1 char, trimmed
    "joiningDate": "2026-08-01",     // Date string or ISO date format (preprocessed)
    "avatarUrl": "https://..."      // string, valid URL, nullable, optional
  }
  ```
  *Note: Request body validation is `strict()`; unrecognized fields will trigger a validation error.*

- **Backend Internal Behavior**:
  - Validates email and phone uniqueness within the scope of the current organization. Throws `400 Bad Request` if duplicate email (`Duplicate email address. Please use another value!`) or duplicate phone (`Duplicate phone number. Please use another value!`) exists.
  - Automatically generates an incremental code with format `STF-XXXX` (e.g. `STF-0001`) via atomic sequence counter collection `Sequence` scoped to the organization (`staffCode:${organizationId}`).
  - Initiates a transactional session to save the staff document and write an audit log entry.
  - Generates audit log: Action `STAFF_CREATED`.
- **Response Shape (201 Created)**:
  ```json
  {
    "success": true,
    "status": "success",
    "message": "Staff created successfully",
    "data": {
      "_id": "64b0f9c2d15b2c001f3e7a01",
      "name": "John Doe",
      "email": "john.doe@salon.com",
      "phone": "+919876543210",
      "designation": "Stylist",
      "joiningDate": "2026-08-01T00:00:00.000Z",
      "avatarUrl": "https://...",
      "status": "active",
      "staffCode": "STF-0001",
      "organizationId": "64b0f9c2d15b2c001f3e7a00",
      "userId": null,
      "isDeleted": false,
      "deletedAt": null,
      "createdBy": "64b0f9c2d15b2c001f3e79ff",
      "updatedBy": "64b0f9c2d15b2c001f3e79ff",
      "createdAt": "2026-08-05T12:00:00.000Z",
      "updatedAt": "2026-08-05T12:00:00.000Z",
      "__v": 0
    },
    "meta": null
  }
  ```

---

### 3.2. Query & List Staff
- **Method**: `GET`
- **Route**: `/api/v1/staff/`
- **Permission Required**: `employees.view`
- **Query Parameters (`validate(queryStaffSchema)`)**:
  - `page`: positive integer (default `1`, coerced from string)
  - `limit`: positive integer (default `10`, coerced from string)
  - `sort`: string (default `-createdAt`). Allowed fields: `name`, `staffCode`, `joiningDate`, `createdAt`, `updatedAt` (optionally prefixed with `-` for descending).
  - `search`: string, optional.
  - `status`: enum `["active", "inactive", "suspended"]`, optional.
  - `branchId`: string, valid 24-character hex ObjectId, optional.

- **Backend Internal Behavior**:
  - **Scoping**: Strictly filters results by the authenticated user's `organizationId`.
  - **Branch Filter**: If `branchId` query param is provided, the backend first queries the `StaffBranch` collection to find active assignments (`branchId` matched, `isActive: true`, `organizationId` matched). It extracts the matched `staffId` array and injects it into the primary staff query filter (`_id: { $in: staffIds }`).
  - **Search Implementation**: Performs keyword searches matching on `name`, `email`, `phone`, `staffCode`, or `designation` using MongoDB case-insensitive regex. The repository strips non-schema query parameters (`page`, `limit`, `sort`, `search`, `branchId`) from the main database find filter to ensure correct query execution.
  - Excludes soft-deleted records (`isDeleted: true`) automatically.
- **Response Shape (200 OK)**:
  ```json
  {
    "success": true,
    "status": "success",
    "message": "Staff listed successfully",
    "data": [
      {
        "_id": "64b0f9c2d15b2c001f3e7a01",
        "name": "John Doe",
        "email": "john.doe@salon.com",
        "phone": "+919876543210",
        "designation": "Stylist",
        "joiningDate": "2026-08-01T00:00:00.000Z",
        "avatarUrl": "https://...",
        "status": "active",
        "staffCode": "STF-0001",
        "organizationId": "64b0f9c2d15b2c001f3e7a00",
        "userId": null,
        "isDeleted": false,
        "createdAt": "2026-08-05T12:00:00.000Z",
        "updatedAt": "2026-08-05T12:00:00.000Z"
      }
    ],
    "meta": {
      "total": 1,
      "page": 1,
      "limit": 10,
      "totalPages": 1
    }
  }
  ```

---

### 3.3. Get Staff Detail
- **Method**: `GET`
- **Route**: `/api/v1/staff/:id`
- **Permission Required**: `employees.view`
- **Backend Internal Behavior**:
  - Queries Staff document matching `:id` and `organizationId`.
  - Throws `404 Not Found` (`Staff not found`) if the record is missing, soft-deleted, or belongs to another organization.
- **Response Shape (200 OK)**:
  ```json
  {
    "success": true,
    "status": "success",
    "message": "Staff retrieved successfully",
    "data": {
      "_id": "64b0f9c2d15b2c001f3e7a01",
      "name": "John Doe",
      ...
    },
    "meta": null
  }
  ```

---

### 3.4. Retrieve Staff Branches
- **Method**: `GET`
- **Route**: `/api/v1/staff/:id/branches`
- **Permission Required**: `employees.view`
- **Backend Internal Behavior**:
  - Verifies the staff member exists and belongs to the authenticated user's organization.
  - Queries `StaffBranch` assignments matching `staffId = :id`, `organizationId` and `isActive = true`.
  - Populates full branch details referencing `branchId`.
- **Response Shape (200 OK)**:
  ```json
  {
    "success": true,
    "status": "success",
    "message": "Staff branch assignments retrieved successfully",
    "data": [
      {
        "_id": "64b0f9c2d15b2c001f3e7a03",
        "staffId": "64b0f9c2d15b2c001f3e7a01",
        "branchId": {
          "_id": "64b0f9c2d15b2c001f3e7a02",
          "name": "Koramangala",
          "address": "123 Main Rd",
          "phone": "+919999999999",
          "isActive": true
        },
        "organizationId": "64b0f9c2d15b2c001f3e7a00",
        "isPrimary": true,
        "isActive": true,
        "createdAt": "2026-08-05T12:00:00.000Z",
        "updatedAt": "2026-08-05T12:00:00.000Z"
      }
    ],
    "meta": null
  }
  ```

---

### 3.5. Retrieve Staff Services
- **Method**: `GET`
- **Route**: `/api/v1/staff/:id/services`
- **Permission Required**: `employees.view`
- **Backend Internal Behavior**:
  - Verifies the staff member exists and belongs to the authenticated user's organization.
  - Queries `StaffService` mappings matching `staffId = :id`, `organizationId` and `isActive = true`.
  - Populates full service details referencing `serviceId`.
- **Response Shape (200 OK)**:
  ```json
  {
    "success": true,
    "status": "success",
    "message": "Staff service capabilities retrieved successfully",
    "data": [
      {
        "_id": "64b0f9c2d15b2c001f3e7a05",
        "staffId": "64b0f9c2d15b2c001f3e7a01",
        "serviceId": {
          "_id": "64b0f9c2d15b2c001f3e7a04",
          "name": "Haircut",
          "duration": 30,
          "pricing": {
            "basePrice": 500
          },
          "status": "active"
        },
        "organizationId": "64b0f9c2d15b2c001f3e7a00",
        "isActive": true,
        "createdAt": "2026-08-05T12:00:00.000Z",
        "updatedAt": "2026-08-05T12:00:00.000Z"
      }
    ],
    "meta": null
  }
  ```

---

### 3.6. Update Staff Profile
- **Method**: `PUT`
- **Route**: `/api/v1/staff/:id`
- **Permission Required**: `employees.update`
- **Request Payload (`validate(updateStaffSchema)`)**:
  ```json
  {
    "name": "John Doe Jr",
    "email": "john.jr@salon.com",
    "phone": "+919876543211",
    "designation": "Senior Stylist",
    "joiningDate": "2026-08-01",
    "avatarUrl": "https://...",
    "status": "inactive"          // enum ["active", "inactive", "suspended"]
  }
  ```
  *Note: Request body validation is `strict()`; unrecognized fields will trigger a validation error.*

- **Backend Internal Behavior**:
  - Verifies the staff member exists within the user's organization. Throws `404 Not Found` (`Staff not found`) if missing.
  - If `email` or `phone` is provided, enforces uniqueness check across other active staff profiles in the same organization. Throws `400 Bad Request` if duplicate.
  - **Lifecycle Status transitions**:
    - If `status` changes, the following rule is enforced:
      - Current status `inactive` -> target `suspended` is **prohibited** (throws `400 Bad Request` with `Invalid lifecycle transition`).
    - If status updates successfully and the staff profile is linked to an authentication user (`userId`), the user account status is automatically cascaded:
      - Transitioning staff to `inactive` sets the linked user's status to `inactive`.
      - Transitioning staff to `suspended` sets the linked user's status to `suspended`.
  - Creates Audit Log:
    - Status change action: `STAFF_STATUS_UPDATED` (includes metadata `oldStatus` and `newStatus`).
    - Regular profile details update action: `STAFF_UPDATED` (includes metadata `updatedFields`).
- **Response Shape (200 OK)**:
  ```json
  {
    "success": true,
    "status": "success",
    "message": "Staff updated successfully",
    "data": {
      "_id": "64b0f9c2d15b2c001f3e7a01",
      "status": "inactive",
      ...
    },
    "meta": null
  }
  ```

---

### 3.7. Soft Delete Staff
- **Method**: `DELETE`
- **Route**: `/api/v1/staff/:id`
- **Permission Required**: `employees.delete`
- **Backend Internal Behavior**:
  - Verifies the staff exists in the user's organization. Throws `404 Not Found` (`Staff not found`) if missing.
  - Marks staff document as deleted: calls `softDelete` (plugin sets `isDeleted: true`, `deletedAt: new Date()`, `deletedBy: actorId`).
  - Sets the staff document's `status` to `"inactive"` in the database.
  - If linked to a user account (`userId`), cascades status by marking the linked user's `status` as `"inactive"`.
  - Deactivates staff relationship mappings by setting `isActive: false` in `StaffBranch` and `StaffService` collections for all matching assignments.
  - Generates audit log: Action `STAFF_DELETED`.
- **Response Shape (200 OK)**:
  ```json
  {
    "success": true,
    "status": "success",
    "message": "Staff soft deleted successfully",
    "data": null,
    "meta": null
  }
  ```

---

### 3.8. Restore Staff Profile
- **Method**: `POST`
- **Route**: `/api/v1/staff/:id/restore`
- **Permission Required**: `employees.update`
- **Backend Internal Behavior**:
  - Queries the Staff document bypassing soft-delete filters (`findByIdIncludeDeleted`). Throws `404 Not Found` (`Staff not found`) if missing.
  - Verifies that restoring the document won't violate unique constraints for `email`, `phone`, or `staffCode` with other active profiles. Throws `400 Bad Request` if conflicts occur:
    - Email conflict: `Email is already in use by another active record`
    - Phone conflict: `Phone is already in use by another active record`
    - Code conflict: `StaffCode is already in use by another active record`
  - Restores the document: clears `isDeleted` to `false`, sets `deletedAt` to `null`, updates `status` to `"active"`.
  - Generates audit log: Action `STAFF_REACTIVATED`.
- **Response Shape (200 OK)**:
  ```json
  {
    "success": true,
    "status": "success",
    "message": "Staff reactivated successfully",
    "data": {
      "_id": "64b0f9c2d15b2c001f3e7a01",
      "status": "active",
      "isDeleted": false,
      ...
    },
    "meta": null
  }
  ```

---

### 3.9. Link User Account
- **Method**: `POST`
- **Route**: `/api/v1/staff/:id/user`
- **Permission Required**: `employees.update`
- **Request Payload (`validate(linkUserSchema)`)**:
  ```json
  {
    "userId": "64b0f9c2d15b2c001f3e79ff" // string, valid 24-character ObjectId
  }
  ```
  *Note: Request body validation is `strict()`.*

- **Backend Internal Behavior**:
  - Verifies Staff exists. Throws `404 Not Found` (`Staff not found`) if missing.
  - Verifies User exists. Throws `404 Not Found` (`User not found`) if missing.
  - Enforces tenant boundary: User's `organizationId` must match Staff's `organizationId`. Throws `400 Bad Request` (`Cross-organization linkage is prohibited`) on mismatch.
  - Verifies that the target User is not already linked to another active (non-deleted) Staff profile. Throws `400 Bad Request` (`User is already linked to another active Staff`) if conflicted.
  - Sets `userId` reference on the Staff document.
  - Generates audit log: Action `USER_LINKED`.
- **Response Shape (200 OK)**:
  ```json
  {
    "success": true,
    "status": "success",
    "message": "User linked successfully",
    "data": {
      "_id": "64b0f9c2d15b2c001f3e7a01",
      "userId": "64b0f9c2d15b2c001f3e79ff",
      ...
    },
    "meta": null
  }
  ```

---

### 3.10. Unlink User Account
- **Method**: `DELETE`
- **Route**: `/api/v1/staff/:id/user`
- **Permission Required**: `employees.update`
- **Backend Internal Behavior**:
  - Verifies Staff exists. Throws `404 Not Found` (`Staff not found`) if missing.
  - Verifies Staff has an active User linkage. Throws `400 Bad Request` (`Staff is not linked to any User`) if `userId` is already null.
  - Sets `userId` reference on the Staff document to `null`.
  - Generates audit log: Action `USER_UNLINKED`.
- **Response Shape (200 OK)**:
  ```json
  {
    "success": true,
    "status": "success",
    "message": "User unlinked successfully",
    "data": {
      "_id": "64b0f9c2d15b2c001f3e7a01",
      "userId": null,
      ...
    },
    "meta": null
  }
  ```

---

### 3.11. Assign Branch
- **Method**: `POST`
- **Route**: `/api/v1/staff/:id/branches`
- **Permission Required**: `employees.assign_branch`
- **Request Payload (`validate(assignBranchSchema)`)**:
  ```json
  {
    "branchId": "64b0f9c2d15b2c001f3e7a02", // string, valid 24-character ObjectId
    "isPrimary": true                       // boolean, optional, default false
  }
  ```
  *Note: Request body validation is `strict()`.*

- **Backend Internal Behavior**:
  - Verifies Staff exists. Throws `404 Not Found` (`Staff not found`) if missing.
  - Verifies Branch exists and belongs to the staff member's organization. Throws `404 Not Found` (`Branch not found`) if missing or scoped to a different organization.
  - Verifies the Branch is not already assigned and active (`isActive: true`) for this staff member. Throws `400 Bad Request` (`Branch is already assigned to Staff`) if duplicate.
  - If `isPrimary` is set to `true` (or forced to `true` on the first branch assignment), automatically demotes all other active branch assignments for this staff member by setting their `isPrimary` to `false` first.
  - Creates and saves a new `StaffBranch` document.
  - Generates audit log: Action `BRANCH_ASSIGNED`.
- **Response Shape (201 Created)**:
  ```json
  {
    "success": true,
    "status": "success",
    "message": "Branch assigned successfully",
    "data": {
      "_id": "64b0f9c2d15b2c001f3e7a03",
      "staffId": "64b0f9c2d15b2c001f3e7a01",
      "branchId": "64b0f9c2d15b2c001f3e7a02",
      "organizationId": "64b0f9c2d15b2c001f3e7a00",
      "isPrimary": true,
      "isActive": true,
      "createdAt": "2026-08-05T12:00:00.000Z",
      "updatedAt": "2026-08-05T12:00:00.000Z"
    },
    "meta": null
  }
  ```

---

### 3.12. Remove Branch Assignment
- **Method**: `DELETE`
- **Route**: `/api/v1/staff/:id/branches/:branchId`
- **Permission Required**: `employees.assign_branch`
- **Backend Internal Behavior**:
  - Verifies Staff exists. Throws `404 Not Found` (`Staff not found`) if missing.
  - Queries active assignment in `StaffBranch` collection matching `staffId`, `branchId`, and `isActive: true`. Throws `404 Not Found` (`Branch assignment not found`) if missing.
  - Performs soft deletion of relationship: updates `isActive = false` on the assignment.
  - If the removed assignment was primary, automatically promotes the oldest remaining active branch assignment for this staff member to `isPrimary = true`.
  - Generates audit log: Action `BRANCH_REMOVED`.
- **Response Shape (200 OK)**:
  ```json
  {
    "success": true,
    "status": "success",
    "message": "Branch assignment removed successfully",
    "data": null,
    "meta": null
  }
  ```

---

### 3.13. Assign Service Capability
- **Method**: `POST`
- **Route**: `/api/v1/staff/:id/services`
- **Permission Required**: `employees.assign_service`
- **Request Payload (`validate(assignServiceSchema)`)**:
  ```json
  {
    "serviceId": "64b0f9c2d15b2c001f3e7a04" // string, valid 24-character ObjectId
  }
  ```
  *Note: Request body validation is `strict()`.*

- **Backend Internal Behavior**:
  - Verifies Staff exists. Throws `404 Not Found` (`Staff not found`) if missing.
  - Verifies Service exists and belongs to the staff member's organization. Throws `404 Not Found` (`Service not found`) if missing.
  - Checks if the service capability is already assigned and active (`isActive: true`). Throws `400 Bad Request` (`Service capability already assigned`) if duplicate.
  - Creates and saves a new `StaffService` document.
  - Generates audit log: Action `SERVICE_ASSIGNED`.
- **Response Shape (201 Created)**:
  ```json
  {
    "success": true,
    "status": "success",
    "message": "Service capability assigned successfully",
    "data": {
      "_id": "64b0f9c2d15b2c001f3e7a05",
      "staffId": "64b0f9c2d15b2c001f3e7a01",
      "serviceId": "64b0f9c2d15b2c001f3e7a04",
      "organizationId": "64b0f9c2d15b2c001f3e7a00",
      "isActive": true,
      "createdAt": "2026-08-05T12:00:00.000Z",
      "updatedAt": "2026-08-05T12:00:00.000Z"
    },
    "meta": null
  }
  ```

---

### 3.14. Remove Service Capability Mapping
- **Method**: `DELETE`
- **Route**: `/api/v1/staff/:id/services/:serviceId`
- **Permission Required**: `employees.assign_service`
- **Backend Internal Behavior**:
  - Verifies Staff exists. Throws `404 Not Found` (`Staff not found`) if missing.
  - Queries active mapping in `StaffService` collection matching `staffId`, `serviceId`, and `isActive: true`. Throws `404 Not Found` (`Service capability mapping not found`) if missing.
  - Performs soft deletion of relationship: updates `isActive = false` on the mapping.
  - Generates audit log: Action `SERVICE_REMOVED`.
- **Response Shape (200 OK)**:
  ```json
  {
    "success": true,
    "status": "success",
    "message": "Service capability mapping removed successfully",
    "data": null,
    "meta": null
  }
  ```

---

## 4. Standard Response & Error Handling

### 4.1. Successful Response Shape
All successful API operations return the following JSON envelope format:
```json
{
  "success": true,
  "status": "success",
  "message": "Human readable summary of action success",
  "data": { ... } | [ ... ] | null,
  "meta": { ... } | null
}
```

### 4.2. Error Response Shape
All operational failures (unauthorized access, validation errors, duplicate values, invalid status transitions) are caught by the `globalErrorHandler` middleware and return the following envelope in **Production**:
```json
{
  "success": false,
  "status": "fail",
  "message": "Specific error message description"
}
```
*Note: In `development` mode, the error response includes extra `stack` and `errors` fields.*

#### Validation Error Format Example
For Zod validation errors, the `message` contains a serialized string describing the target validation fields:
```json
{
  "success": false,
  "status": "fail",
  "message": "Validation failed: [{\"field\":\"body.phone\",\"message\":\"Invalid phone number format (E.164)\"}]"
}
```

---

## 5. Summary of Database Schemas & Relations

### 5.1. Staff Document (`Staff`)
- `name` (String, required, trimmed)
- `phone` (String, required, trimmed)
- `email` (String, required, lowercase, trimmed)
- `organizationId` (ObjectId referencing `Organization`, required)
- `userId` (ObjectId referencing `User`, default `null`)
- `designation` (String, required, trimmed)
- `status` (String, enum `["active", "inactive", "suspended"]`, default `"active"`)
- `staffCode` (String, auto-generated unique identifier per organization)
- `avatarUrl` (String, default `null`)
- `joiningDate` (Date, required)
- `isDeleted` (Boolean, default `false`, injected by audit plugin)
- `deletedAt` (Date, default `null`, injected by audit plugin)
- `createdBy` (ObjectId referencing `User`, injected by audit plugin)
- `updatedBy` (ObjectId referencing `User`, injected by audit plugin)
- `deletedBy` (ObjectId referencing `User`, injected by audit plugin)

### 5.2. Staff Branch Assignment (`StaffBranch`)
- `staffId` (ObjectId referencing `Staff`, required)
- `branchId` (ObjectId referencing `Branch`, required)
- `organizationId` (ObjectId referencing `Organization`, required)
- `isPrimary` (Boolean, default `false`)
- `isActive` (Boolean, default `true`)

### 5.3. Staff Service Capability Mapping (`StaffService`)
- `staffId` (ObjectId referencing `Staff`, required)
- `serviceId` (ObjectId referencing `Service`, required)
- `organizationId` (ObjectId referencing `Organization`, required)
- `isActive` (Boolean, default `true`)

---

## 6. Non-Implemented Behaviors & Discrepancies

- **Cascading User Reactivation**: Restoring a soft-deleted staff member reactivates the staff document (`status: "active"`), but it **does not** automatically reactivate the associated `User` document. If the user account was deactivated during soft deletion, it must be reactivated manually.
- **Roster & Leave Management**: The CANONICAL_PERMISSIONS lists `employees.leaves.view` and `employees.leaves.manage`, but roster and leave entities/routes are **not implemented** in the Staff backend codebase.

STAFF BACKEND CONTRACT — BACKEND VERIFIED
