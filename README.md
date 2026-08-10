# Unisex Parlour ERP — Backend

A production-grade, multi-tenant Enterprise Resource Planning (ERP) backend for unisex parlour / salon businesses. Built with **Node.js, Express 5, MongoDB, Redis, BullMQ**, and a strict **layered architecture** with **organization-level and branch-level data isolation**.

---

## 📑 Table of Contents

- [Overview](#-overview)
- [System Architecture](#-system-architecture)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Multi-Tenancy & Data Scoping](#-multi-tenancy--data-scoping)
- [Authentication & Authorization](#-authentication--authorization)
- [Module Reference](#-module-reference)
- [API Convention](#-api-convention)
- [Background Jobs (BullMQ)](#-background-jobs-bullmq)
- [Database Models](#-database-models)
- [Getting Started](#-getting-started)
- [Environment Variables](#-environment-variables)
- [Scripts & Tooling](#-scripts--tooling)
- [Testing](#-testing)
- [Security Features](#-security-features)
- [Documentation](#-documentation)
- [Contributing / Development Workflow](#-contributing--development-workflow)

---

## 🧩 Overview

This is the **backend API** of the Unisex Parlour ERP. It provides RESTful endpoints for:

- **Authentication** — registration, login, refresh tokens, email/OTP verification, password reset, first-login activation flows
- **User Management** — create users, assign roles/branches, manage statuses (active/suspended/locked)
- **RBAC** — permissions, roles, permission-to-role assignment
- **Branches** — multi-location management
- **Customers** — full CRUD, customer notes, activity/audit timeline, soft-delete/reactivate
- **Services** — service catalog and categories, branch-scoped pricing, tax configuration
- **Staff** — staff profiles, auto-generated staff codes, branch assignments, service capability mapping, user-linkage, lifecycle (active/inactive/suspended), soft-delete/restore

The backend is the **final authority** for authentication, authorization, organization isolation, and branch data access. **Never trust the frontend for security.**

---

## 🏗 System Architecture

```
Browser / Frontend (Next.js)
        │
        │  HTTP / HTTPS
        ▼
┌──────────────────────────────┐
│        Express Backend        │
│                              │
│  Route → Middleware →        │
│  Controller → Validation →   │
│  Service → Repository →      │
│  Model / MongoDB             │
└──────────────────────────────┘
        │                     │
        ▼                     ▼
   MongoDB                   Redis
  (Primary DB)        (Cache + BullMQ queues)
```

### Request Flow (Protected Endpoint)

```
1. Authenticate user (JWT)          → Who are you?
2. Authorize permission (RBAC)      → What can you do?
3. Resolve organization scope       → Which tenant's data?
4. Validate branch scope            → Which branch's data?
5. Validate input (Zod)             → Is the payload valid?
6. Execute business logic (Service) → How should the operation work?
7. Persist / read (Repository/Model)
```

---

## 🛠 Tech Stack

| Layer          | Technology                                            |
|----------------|-------------------------------------------------------|
| Runtime        | Node.js ≥ 20                                          |
| Framework      | Express 5                                             |
| Database       | MongoDB (Mongoose 9)                                  |
| Cache / Queue  | Redis (ioredis)                                       |
| Job Queue      | BullMQ                                                |
| Auth           | JWT (Access + Refresh Tokens), bcryptjs               |
| Validation     | Zod 4                                                 |
| Security       | Helmet, CORS, express-rate-limit, express-slow-down, express-mongo-sanitize |
| Email          | Nodemailer (SMTP)                                     |
| SMS            | AutoBySMS REST API                                    |
| Logging        | Winston (console + file)                              |
| File Uploads   | Cloudinary (optional, dependency present)             |
| Real-time      | Socket.io (dependency present)                        |
| Testing        | Jest, Supertest                                       |
| Documentation  | Swagger (swagger-jsdoc / swagger-ui-express)          |

---

## 📁 Project Structure

```
saloon-erp/
├── app.mjs                          # Express app setup (security middleware, routes, error handler)
├── index.mjs                        # Server bootstrap (DB, Redis, BullMQ workers, graceful shutdown)
├── package.json
├── api_contracts.md                 # API contract & scoping rules
├── STAFF_BACKEND_CONTRACT.md        # Authoritative Staff module API contract
|
├── docs/
│   └── UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/
│       ├── ARCHITECTURE.md          # Parent architecture document
│       ├── BACKEND_ARCHITECTURE.md  # Backend engineering rules
│       ├── DATABASE_ARCHITECTURE.md # Data ownership & scoping
│       ├── API_CONTRACT.md          # Frontend/backend API conventions
│       ├── AUTHENTICATION.md        # Auth/session lifecycle
│       ├── PERMISSIONS.md           # Permission registry & RBAC
│       ├── FRONTEND_ARCHITECTURE.md # Frontend engineering rules
│       ├── TESTING_STRATEGY.md      # Testing requirements
│       └── DEVELOPMENT_WORKFLOW.md  # Domain implementation workflow
│
├── workflow_md/                     # Feature workflow documentation
│   ├── auth_workflow.md
│   ├── customer_workflow.md
│   ├── rbac_workflow.md
│   ├── backend_contract.md
│   └── data_scoping_note.md
│
├── logs/
│   ├── combined.log                 # Winston combined log
│   └── error.log                    # Winston error log
│
└── src/
    ├── config/
    │   ├── env.js                   # Zod-validated environment configuration
    │   ├── permissions.js           # Canonical permission registry
    │   └── redis.js                 # Redis connection (singleton)
    │
    ├── controllers/                 # HTTP layer (per domain)
    │   ├── auth/
    │   ├── branches/
    │   ├── customers/
    │   ├── rbac/
    │   ├── services/
    │   ├── staff/
    │   └── users/
    │
    ├── database/
    │   ├── db.js                    # MongoDB connection + global plugins
    │   └── plugins/
    │       └── audit.js             # Global Mongoose plugin (soft-delete, timestamps, optimistic concurrency)
    │
    ├── middleware/
    │   ├── auth.js                  # JWT authenticate
    │   ├── rbac.js                  # Permission-based authorize / requirePermission
    │   ├── branchScope.js           # Organization / branch scope enforcement
    │   ├── security.js              # Rate limiters, slow-down, mongo sanitize
    │   └── validate.js              # Zod request validation
    │
    ├── models/                      # Mongoose models (per domain)
    │   ├── audit/auditLog.model.js
    │   ├── auth/session.model.js
    │   ├── branches/branch.model.js
    │   ├── customers/customer.model.js
    │   ├── customers/customerNote.model.js
    │   ├── organizations/organization.model.js
    │   ├── permissions/permission.model.js
    │   ├── roles/role.model.js
    │   ├── sequence/sequence.model.js
    │   ├── services/service.model.js
    │   ├── services/serviceCategory.model.js
    │   ├── staff/staff.model.js
    │   ├── staff/staffBranch.model.js
    │   ├── staff/staffService.model.js
    │   └── users/user.model.js
    │
    ├── repositories/                # Data access layer (per domain)
    │   ├── audit/
    │   ├── auth/
    │   ├── customers/
    │   ├── permissions/
    │   ├── roles/
    │   ├── services/
    │   ├── staff/
    │   └── users/
    │
    ├── routers/                     # Express route definitions (per domain)
    │   ├── auth/auth.routes.js
    │   ├── branches/branch.routes.js
    │   ├── customers/customer.routes.js
    │   ├── rbac/rbac.routes.js
    │   ├── services/service.routes.js
    │   ├── staff/staff.routes.js
    │   └── users/user.routes.js
    │
    ├── scripts/                     # Standalone CLI scripts
    │   ├── syncPermissions.js       # Sync canonical permissions
    │   ├── migrateCustomers.js      # Legacy customer migration
    │   └── migrateUsernames.js      # Backfill usernames
    │
    ├── seed/seed.js                 # Seed organization, branches, roles, users
    │
    ├── services/                    # Business logic layer (per domain)
    │   ├── audit/
    │   ├── auth/
    │   ├── customers/
    │   ├── notifications/           # Email + SMS services
    │   ├── permissions/
    │   ├── roles/
    │   ├── services/
    │   ├── staff/
    │   └── users/
    │
    ├── shared/
    │   └── repositories/
    │       └── base.repository.js   # Reusable CRUD + pagination + search
    │
    ├── queues/
    │   └── client.js                # BullMQ queue definitions (email, sms, whatsapp, notification, reports)
    │
    ├── utils/
    │   ├── errors.js                # AppError, asyncHandler, global error handler
    │   ├── logger.js                # Winston logger
    │   ├── phone.js                 # Phone normalization
    │   ├── redis.js                 # Shared Redis client
    │   ├── response.js              # Standard API response envelope
    │   ├── userIdentity.js          # Username normalization/validation
    │   ├── userResponse.js          # User DTO serializer
    │   └── userValidation.js        # Privilege escalation guards
    │
    ├── validation/                  # Zod schemas (per domain)
    │   ├── auth/
    │   ├── customers/
    │   ├── rbac/
    │   ├── services/
    │   ├── staff/
    │   └── users/
    │
    ├── workers/
    │   └── notification.worker.js   # BullMQ workers (email + SMS)
    │
    └── tests/                       # Jest test suites
        ├── auth/
        ├── customers/
        ├── rbac/
        ├── services/
        ├── staff/
        └── security.integration.test.js
```

---

## 🏢 Multi-Tenancy & Data Scoping

### Organization as Tenant Boundary

- Every organization-owned record contains an `organizationId`.
- The authenticated user's `organizationId` (from JWT → user record) is the **only trusted source** for tenant scope.
- Client-supplied `organizationId` in the body/query is **never trusted**.

### Branch Architecture

Two concepts are kept strictly separate:

| Concept          | Meaning                                           |
|------------------|---------------------------------------------------|
| `branchAccess`   | Branches the user is *allowed* to access          |
| `X-Branch-Id`    | The branch the *current request* operates against |

### Branch Scoping Modes

| Mode                         | `hasOrgWideAccess` | `X-Branch-Id` header |
|------------------------------|--------------------|----------------------|
| Organization-wide (All)      | `true`             | Omitted              |
| Specific branch              | `true`             | Real branch ID       |
| Branch-limited user          | `false`            | **Required**         |
| Invalid state                | `false`            | `all` sentinel — **rejected** |

> ⚠️ `"all"` is a **frontend-only UI sentinel**. It must never be sent as a real `X-Branch-Id` header value. The backend explicitly rejects it with a `400 Bad Request`.

### Customer Visibility Rules (Reference Pattern)

For a branch-scoped customer request:

```
organizationId matches
AND (
  homeBranchId == activeBranchId
  OR visitedBranchIds contains activeBranchId
)
```

---

## 🔐 Authentication & Authorization

### Auth Flow

```
Register → Email verification
Login → Access Token (15 min) + Refresh Token (7 days, in httpOnly cookie)
/me → Session details (id, role, permissions, organizationId, branchAccess, hasOrgWideAccess)
Refresh → Token rotation with breach detection
Logout / Logout-All
```

### Security Features

- **bcrypt** password hashing (10 salt rounds)
- **Account lockout** after 5 failed login attempts (15-minute lock)
- **First-login activation flow** — user must verify OTP and set a permanent password
- **JWT scoped tokens** (`activation`, `password-change`, standard access)
- **Refresh token rotation** with reuse/breach detection
- **Sessions stored in MongoDB** (hashed refresh tokens, device info, IP, expiry)
- **Session invalidation** on password reset / user deactivation

### RBAC (Role-Based Access Control)

```
User ──► Role ──► Permissions
```

- **Permission keys** are canonical strings like `customers.view`, `services.create`, `employees.assign_branch`.
- Authorization is **permission-based**, **never role-name-based**.
- Role permissions are **cached in Redis** for 24 hours (`rbac:role:<role>:permissions`) and invalidated on updates.

### Canonical Permission Registry

~90+ permission keys are defined in `src/config/permissions.js`, covering:

- Dashboard, Users, Roles, Organizations
- Branches, Customers, Appointments
- Employees, Attendance, Payroll
- Services, Memberships, Coupons
- Billing/POS, Payments, Expenses
- Finance, Inventory, Procurement
- Loyalty, Reports, WhatsApp, Notifications, Campaigns
- Settings, Logs

Run `npm run permissions:sync` to upsert the canonical registry into the database and assign them to the `owner` role (and a default subset to `manager`).

---

## 📦 Module Reference

### 1. Auth

| Route                                  | Description                              |
|----------------------------------------|------------------------------------------|
| `POST /api/v1/auth/register`           | Register a new user (default role: `customer`) |
| `POST /api/v1/auth/login`              | Login with email + password              |
| `POST /api/v1/auth/refresh`            | Rotate refresh token → new access token  |
| `POST /api/v1/auth/logout`             | Invalidate current session               |
| `POST /api/v1/auth/logout-all`         | Invalidate all user sessions             |
| `GET /api/v1/auth/me`                  | Get current session details              |
| `GET /api/v1/auth/verify-email`        | Verify email via token                   |
| `POST /api/v1/auth/forgot-password`    | Send password reset link                 |
| `POST /api/v1/auth/reset-password/:token` | Reset password                        |
| `POST /api/v1/auth/otp/send`           | Send OTP to phone                        |
| `POST /api/v1/auth/otp/verify`         | Verify OTP → login                       |
| `POST /api/v1/auth/activate/otp/send`  | Send activation OTP (first login)        |
| `POST /api/v1/auth/activate/otp/verify`| Verify activation OTP                    |
| `POST /api/v1/auth/activate/change-password` | Set permanent password on activation |

### 2. Users

| Route                                    | Permission        | Description                          |
|------------------------------------------|-------------------|--------------------------------------|
| `POST /api/v1/users`                     | `users.create`    | Create user + send welcome credentials |
| `GET /api/v1/users`                      | `users.view`      | List users (paginated, searchable)   |
| `GET /api/v1/users/:id`                  | `users.view`      | Get user details                     |
| `PATCH /api/v1/users/:id`                | `users.update`    | Update user (name, username, phone, branches) |
| `PATCH /api/v1/users/:id/status`         | `users.update`    | Change user status (active/suspended/inactive) |

### 3. RBAC

| Route                                            | Permission      | Description                    |
|--------------------------------------------------|-----------------|--------------------------------|
| `POST /api/v1/rbac/permissions`                  | `roles.create`  | Create a permission key        |
| `GET /api/v1/rbac/permissions`                   | `roles.view`    | List permissions               |
| `POST /api/v1/rbac/roles`                        | `roles.create`  | Create a role                  |
| `GET /api/v1/rbac/roles`                         | `roles.view`    | List roles (with permissions)  |
| `POST /api/v1/rbac/roles/:roleId/permissions`    | `roles.update`  | Assign permissions to a role   |

### 4. Branches

| Route                          | Permission         | Description                        |
|--------------------------------|--------------------|------------------------------------|
| `GET /api/v1/branches`         | Authenticated      | List branches the user can access  |
| `GET /api/v1/branches/:id`     | Authenticated      | Get branch detail                  |
| `POST /api/v1/branches`        | `branches.manage`  | Create branch                      |
| `PATCH /api/v1/branches/:id`   | `branches.manage`  | Update branch                      |
| `DELETE /api/v1/branches/:id`  | `branches.manage`  | Deactivate branch                  |

### 5. Customers

| Route                               | Permission            | Description                              |
|-------------------------------------|-----------------------|------------------------------------------|
| `POST /api/v1/customers`            | `customers.create`    | Create customer (requires `X-Branch-Id`) |
| `GET /api/v1/customers`             | `customers.view`      | List customers (paginated, branch-scoped)|
| `GET /api/v1/customers/:id`         | `customers.view`      | Get customer detail                      |
| `PUT /api/v1/customers/:id`         | `customers.edit`      | Update customer profile                  |
| `DELETE /api/v1/customers/:id`      | `customers.delete`    | Soft-delete customer profile             |
| `PUT /api/v1/customers/:id/reactivate` | `customers.edit`    | Reactivate soft-deleted customer         |
| `GET /api/v1/customers/:id/notes`   | `customers.view`      | Get customer notes                       |
| `POST /api/v1/customers/:id/notes`  | `customers.edit`      | Add a note to a customer                 |
| `GET /api/v1/customers/:id/activity`| `customers.view`      | Get audit/activity timeline              |

> **Key invariants**: `organizationId`, `homeBranchId`, and `visitedBranchIds` are **immutable** through normal updates. `homeBranchId` is derived server-side from the active branch context at creation.

### 6. Services

| Route                                        | Permission              | Description                                  |
|----------------------------------------------|-------------------------|----------------------------------------------|
| `POST /api/v1/services/categories`           | `services.create`       | Create a service category (branch-scoped)    |
| `GET /api/v1/services/categories`            | `services.view`         | List categories (branch-scoped)              |
| `GET /api/v1/services/categories/:id`        | `services.view`         | Get category detail                          |
| `PUT /api/v1/services/categories/:id`        | `services.edit`         | Update category                              |
| `DELETE /api/v1/services/categories/:id`     | `services.delete`       | Soft-delete category (blocked if active services) |
| `PATCH /api/v1/services/categories/:id/reactivate` | `services.edit`   | Reactivate category                          |
| `POST /api/v1/services`                      | `services.create`       | Create service (requires `X-Branch-Id`)      |
| `GET /api/v1/services`                       | `services.view`         | List services (branch-scoped)                |
| `GET /api/v1/services/:id`                   | `services.view`         | Get service detail                           |
| `PUT /api/v1/services/:id`                   | `services.edit`         | Update service                               |
| `PATCH /api/v1/services/:id/reactivate`      | `services.edit`         | Reactivate service                           |
| `DELETE /api/v1/services/:id`                | `services.delete`       | Soft-delete service                          |

### 7. Staff

| Route                                       | Permission                    | Description                                    |
|---------------------------------------------|-------------------------------|------------------------------------------------|
| `POST /api/v1/staff`                        | `employees.create`            | Create staff profile (auto `STF-XXXX` code)    |
| `GET /api/v1/staff`                         | `employees.view`              | List staff (searchable, branch filterable)     |
| `GET /api/v1/staff/:id`                     | `employees.view`              | Get staff detail                               |
| `PUT /api/v1/staff/:id`                     | `employees.update`            | Update staff profile/status                    |
| `DELETE /api/v1/staff/:id`                  | `employees.delete`            | Soft-delete staff (cascades to linked user)    |
| `POST /api/v1/staff/:id/restore`            | `employees.update`            | Restore soft-deleted staff                     |
| `POST /api/v1/staff/:id/user`               | `employees.update`            | Link a User account to Staff                   |
| `DELETE /api/v1/staff/:id/user`             | `employees.update`            | Unlink User account from Staff                 |
| `POST /api/v1/staff/:id/branches`           | `employees.assign_branch`     | Assign branch to staff                         |
| `DELETE /api/v1/staff/:id/branches/:branchId`| `employees.assign_branch`     | Remove branch assignment                       |
| `POST /api/v1/staff/:id/services`           | `employees.assign_service`    | Assign service capability to staff             |
| `DELETE /api/v1/staff/:id/services/:serviceId` | `employees.assign_service` | Remove service capability mapping              |
| `GET /api/v1/staff/:id/branches`            | `employees.view`              | Get staff branch assignments                   |
| `GET /api/v1/staff/:id/services`            | `employees.view`              | Get staff service capabilities                 |

> **Staff branch invariant**: A staff member has exactly **one primary branch** among active branch assignments. The first assignment becomes primary automatically; removing the primary promotes the oldest remaining assignment. All transitions occur atomically in a **MongoDB transaction**.

---

## 📡 API Convention

### Response Envelope (Success)

```json
{
  "success": true,
  "status": "success",
  "message": "Human readable message",
  "data": { },
  "meta": { "total": 100, "page": 1, "limit": 10, "totalPages": 10 }
}
```

### Response Envelope (Error)

```json
{
  "success": false,
  "status": "fail" | "error",
  "message": "Error description",
  "errors": [ { "field": "body.phone", "message": "Invalid phone number format" } ]
}
```

### Standard HTTP Status Codes

| Code | Meaning                                             |
|------|-----------------------------------------------------|
| 200  | Success                                             |
| 201  | Created                                             |
| 400  | Invalid request / validation failure                |
| 401  | Unauthenticated / invalid or expired token          |
| 403  | Authenticated but not authorized / scoped denial    |
| 404  | Resource not found (or hidden by isolation)         |
| 409  | Business conflict (duplicate, invalid transition)   |
| 429  | Too many requests (rate limited)                    |
| 500  | Unexpected server error                             |

---

## ⚙️ Background Jobs (BullMQ)

BullMQ queues are defined in `src/queues/client.js`. Workers run in `src/workers/notification.worker.js`.

| Queue      | Jobs                                    | Purpose                              |
|------------|-----------------------------------------|--------------------------------------|
| `email`    | `sendWelcomeCredentialsEmail`, `sendVerificationEmail`, `sendPasswordResetEmail` | Transactional emails via Nodemailer |
| `sms`      | `sendOtpSMS`                            | OTP SMS via AutoBySMS REST API       |
| `whatsapp` | *(declared)*                            | Future WhatsApp notifications        |
| `notification` | *(declared)*                        | Future app notifications             |
| `reports`  | *(declared)*                            | Future report generation             |

**Behavior:**
- 3 attempts with exponential backoff (1s base)
- Completed jobs are auto-removed; failed jobs are retained for inspection
- Workers are skipped during Jest test runs
- Graceful shutdown closes workers before disconnecting Redis

---

## 🗄 Database Models

| Model              | Collection          | Key Fields & Purpose                                        |
|--------------------|---------------------|-------------------------------------------------------------|
| `Organization`     | `organizations`     | Name, logo, active flag — the tenant boundary                |
| `Branch`           | `branches`          | Name, address, phone — physical locations                   |
| `User`             | `users`             | Login credentials, role, organization, branch access, status, lockout, verification fields |
| `Role`             | `roles`             | Name, description, permission refs                          |
| `Permission`       | `permissions`       | Canonical permission keys (`name`, `module`, `action`, `description`) |
| `Session`          | `sessions`          | Hashed refresh token, device info, IP, expiry, validity     |
| `Customer`         | `customers`         | Profile, home branch, visited branches, preferences, marketing preferences, loyalty points, tags |
| `CustomerNote`     | `customernotes`     | Notes attached to a customer                                |
| `Staff`            | `staff`             | HR profile, staff code, linked user, designation, status    |
| `StaffBranch`      | `staffbranches`     | Branch assignment mapping for staff (primary flag)          |
| `StaffService`     | `staffservices`     | Service capability mapping for staff                        |
| `Service`          | `services`          | Catalog item — name, code, category, duration, pricing, tax, branch |
| `ServiceCategory`  | `servicecategories` | Category — name, description, display order, branch         |
| `AuditLog`         | `auditlogs`         | Immutable audit trail of business actions                   |
| `Sequence`         | `sequences`         | Atomic counters (e.g. staff code generation)                |

### Global Mongoose Plugin (`audit.js`)

Every model registered after the plugin is applied gets:

- `isDeleted` (Boolean) — soft-delete flag
- `deletedAt` (Date)
- `createdBy` / `updatedBy` / `deletedBy` (ObjectId refs)
- Timestamps
- **Optimistic concurrency** (`optimisticConcurrency: true`)
- **Automatic exclusion** of deleted records from `find`, `findOne`, `countDocuments`, and aggregation pipelines (unless `includeDeleted: true` is passed)

---

## 🚀 Getting Started

### Prerequisites

- **Node.js ≥ 20**
- **MongoDB** (local or Atlas; replica set recommended for transactions)
- **Redis** (local or managed)

### Installation

```bash
# 1. Clone the repository
git clone <repo-url>
cd saloon-erp

# 2. Install dependencies
npm install

# 3. Create .env file (see Environment Variables section)
cp .env.example .env   # or create manually

# 4. Seed the database (organization, branches, roles, users)
npm run seed

# 5. Start the dev server
npm start
```

### Verify It's Running

```bash
curl http://localhost:5000/health
```

Expected response:

```json
{
  "status": "OK",
  "uptime": 1.234,
  "timestamp": "2026-08-10T12:00:00.000Z"
}
```

### Default Seeded Users

| Role    | Email                | Password        | Access                     |
|---------|----------------------|-----------------|----------------------------|
| Owner   | `owner@parlour.com`  | `Admin@1234`    | Organization-wide          |
| Manager | `manager@parlour.com`| `Manager@1234`  | Single branch (Koramangala)|

---

## 🔧 Environment Variables

| Variable                    | Required | Default       | Description                                    |
|-----------------------------|----------|---------------|------------------------------------------------|
| `PORT`                      | No       | `5000`        | Server port                                    |
| `NODE_ENV`                  | No       | `development` | `development` / `production` / `test`          |
| `MONGO_URI`                 | **Yes**  | —             | MongoDB connection string                      |
| `REDIS_HOST`                | No       | `127.0.0.1`   | Redis host                                     |
| `REDIS_PORT`                | No       | `6379`        | Redis port                                     |
| `REDIS_URL`                 | No       | —             | Full Redis connection URL (takes precedence)   |
| `JWT_SECRET`                | **Yes**  | —             | Secret for access tokens (≥ 8 chars)           |
| `JWT_REFRESH_SECRET`        | **Yes**  | —             | Secret for refresh tokens (≥ 8 chars)          |
| `JWT_ACCESS_EXPIRATION`     | No       | `15m`         | Access token lifetime                          |
| `JWT_REFRESH_EXPIRATION`    | No       | `7d`          | Refresh token lifetime                         |
| `CLOUDINARY_CLOUD_NAME`     | No       | —             | Cloudinary credentials (for image uploads)     |
| `CLOUDINARY_API_KEY`        | No       | —             | Cloudinary API key                             |
| `CLOUDINARY_API_SECRET`     | No       | —             | Cloudinary API secret                          |
| `SMTP_HOST`                 | No       | —             | SMTP server host (email)                       |
| `SMTP_PORT`                 | No       | `587`         | SMTP port                                      |
| `SMTP_USER`                 | No       | —             | SMTP username                                  |
| `SMTP_PASS`                 | No       | —             | SMTP password                                  |
| `EMAIL_FROM`                | No       | `Saloon ERP <no-reply@saloonerp.com>` | Sender email address |
| `SMS_API_KEY`               | No       | —             | SMS API key (legacy)                           |
| `SMS_SENDER_ID`             | No       | `SALOON`      | SMS sender ID                                  |
| `AUTOBYSMS_API_KEY`         | No       | —             | AutoBySMS API key                              |
| `AUTOBYSMS_SENDER_ID`       | No       | `SALOON`      | AutoBySMS sender ID                            |
| `AUTOBYSMS_TEMPLATE_ID`     | No       | —             | AutoBySMS template ID                          |
| `APP_URL`                   | No       | `http://localhost:5000` | Base URL used in verification/reset emails |

---

## 📜 Scripts & Tooling

| Command                     | Description                                             |
|-----------------------------|---------------------------------------------------------|
| `npm start`                 | Start dev server with nodemon                           |
| `npm test`                  | Run the full Jest test suite                            |
| `npm run test:integration`  | Run manual integration test for permission sync         |
| `npm run seed`              | Seed organization, branches, owner/manager roles & users |
| `npm run permissions:sync`  | Upsert canonical permissions and assign to owner/manager roles |
| `npm run customers:migrate` | Migrate legacy customer data (notes, activity, dedupe by phone) |
| `npm run users:migrate-usernames` | Backfill missing usernames for existing users      |

---

## 🧪 Testing

Tests are written with **Jest** and **Supertest**. They are organized per domain under `src/tests/`.

```
src/tests/
├── auth/          # auth.service, userIdentity, userLifecycle, userActivation, userRbac, ...
├── customers/     # customer.service, customer.integration, customer.filters, customer.upgrade
├── rbac/          # rbac.test, permissionsSync.manual
├── services/      # service.test
├── staff/         # staff.test
└── security.integration.test.js
```

### Test Philosophy

Every protected domain is tested for **both** functional correctness **and** security correctness:

- **Functional**: CRUD, validation, business rules, status transitions
- **Security**: permission denial, organization isolation, branch isolation, cross-organization ID manipulation, `X-Branch-Id: all` rejection, immutable-field protection

> A feature is not complete until both functional and isolation behavior are verified.

---

## 🔒 Security Features

| Feature                         | Implementation                                    |
|---------------------------------|--------------------------------------------------|
| HTTP security headers           | Helmet                                           |
| CORS                            | Whitelisted origins, credentials support         |
| Rate limiting                   | 1000 req/15 min (API), 100 req/15 min (auth)     |
| Slow-down throttling            | 50 rapid requests → 100ms delay per additional   |
| NoSQL injection protection      | express-mongo-sanitize (available)               |
| `.env` path blocking            | Custom middleware returns 403 for `.env` URLs    |
| JWT access tokens               | Short-lived (15 min default)                     |
| Refresh token rotation          | Hashed in DB, reuse detection invalidates all    |
| Account lockout                 | 5 failed logins → 15 min lock                    |
| OTP rate limiting               | 60s resend cooldown, max 5 verify attempts       |
| Role delegation guard           | Users can only assign roles whose permissions they possess |
| Privilege escalation protection | `userValidation.js` — blocks org/branch/role escalations |
| Password policy                 | ≥ 8 chars, uppercase, lowercase, digit, special  |
| Soft deletion                   | All domain records are soft-deleted, never hard-deleted |
| Query exclusion                 | Deleted records excluded from all normal queries |

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| `docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md` | Parent architecture document — system design, tenant model, branch semantics, RBAC, frontend/backend rules |
| `docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/BACKEND_ARCHITECTURE.md` | Backend layered architecture & engineering rules |
| `docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/DATABASE_ARCHITECTURE.md` | Data ownership, organization/branch semantics, model design rules |
| `docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/API_CONTRACT.md` | Frontend↔Backend API conventions |
| `docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/AUTHENTICATION.md` | Auth/session lifecycle specification |
| `docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/PERMISSIONS.md` | Permission registry & RBAC specification |
| `docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/TESTING_STRATEGY.md` | Testing requirements & security matrix |
| `docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/DEVELOPMENT_WORKFLOW.md` | Standard domain implementation workflow |
| `api_contracts.md` | Verified API contracts & scoping decisions |
| `STAFF_BACKEND_CONTRACT.md` | Authoritative, backend-verified Staff module API contract |
| `workflow_md/*` | Feature-level workflow documentation (auth, customer, RBAC, scoping) |

---

## 🤝 Contributing / Development Workflow

Follow the canonical process defined in `DEVELOPMENT_WORKFLOW.md`:

1. **Understand the domain** — ownership, references, organization/branch semantics
2. **Define permissions** — canonical keys (never role-name logic)
3. **Define scope** — organization, branch, active-branch requirements
4. **Define data model** — fields, indexes, immutable fields, deletion semantics
5. **Define API contract** — routes, methods, validation, errors
6. **Implement backend** — Model → Validation → Service → Controller → Routes → Tests
7. **Verify** — functional + security tests (isolation, permissions, branch behavior)
8. **Implement frontend** (if applicable) — follow the established Axios/React Query patterns
9. **Document** — update architecture docs, permissions, API contracts

### Architectural Guardrails (Never Do)

- ❌ Use role names as authorization logic
- ❌ Trust frontend checks for security
- ❌ Trust client-supplied `organizationId`
- ❌ Treat `branchAccess` as the active branch scope
- ❌ Send or accept `X-Branch-Id: all`
- ❌ Allow normal updates to change immutable fields (`organizationId`, `homeBranchId`, `visitedBranchIds`)
- ❌ Mix unrelated domain business logic
- ❌ Skip security/isolation tests
- ❌ Create duplicate permission systems

---

## 📌 Current Status

| Module                      | Status   |
|-----------------------------|----------|
| Multi-Branch Foundation     | ✅ Done  |
| Authentication              | ✅ Done  |
| RBAC / Permissions          | ✅ Done  |
| Customers (Backend + Tests) | ✅ Done  |
| Services (Backend + Tests)  | ✅ Done  |
| Staff (Backend + Tests)     | ✅ Done  |
| Customer Frontend           | ⏳ Next  |
| Appointments, Billing, POS  | ⏳ Planned |
| Inventory, Finance, Reports | ⏳ Planned |