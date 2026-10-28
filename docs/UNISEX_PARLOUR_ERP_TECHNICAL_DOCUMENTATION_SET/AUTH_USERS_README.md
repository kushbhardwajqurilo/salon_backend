# Authentication & User Management Module — Specification & Status

```text
Module: Authentication, Session Lifecycle & User Management
Status: ✅ COMPLETED & TESTED (100% Passing)
Layer: Backend Core Security & Identity
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Related Specs: AUTHENTICATION.md, PERMISSIONS.md
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Responsibilities

The **Authentication & User Management** module is the foundational security boundary for the Unisex Parlour ERP. It handles user credentials, cryptographic sessions, token rotation, privilege escalation defense, first-login staff activation, and user account lifecycles.

### Key Responsibilities
- User account creation, authentication, and password security (`bcryptjs`).
- Dual-token architecture: Short-lived Access Tokens (JWT, 15m) + Long-lived Refresh Tokens (7d in `httpOnly` secure cookies).
- Stateful session tracking in MongoDB (`Session` collection) with breach detection.
- Multi-device login support and centralized session invalidation (`logout`, `logout-all`).
- First-login staff activation workflow via SMS OTP.
- User status management (`active`, `suspended`, `inactive`, `locked`) with automatic session revocation.
- Administrative user CRUD with branch access and role assignment.

---

## 2. Multi-Tenancy & Scoping Rules

- **Tenant Isolation**: Every `User` and `Session` contains `organizationId`. A user can only belong to one tenant organization.
- **Branch Access Control**:
  - `hasOrgWideAccess`: Boolean flag on user profile determining organization-wide visibility.
  - `branchAccess`: Explicit array of branch IDs and statuses that the user is permitted to access.
- **Root Owner Protection**: The initial `owner` user cannot be suspended, deactivated, or locked.

---

## 3. RBAC & Canonical Permissions

| Action / Capability | Permission Key | Description |
|:---|:---|:---|
| View User Directory | `users.view` | Access user list and detailed profiles |
| Create New User Account | `users.create` | Register staff users and trigger credential emails |
| Update Profile / Status | `users.update` | Edit user name, phone, branch access, or status |
| Delete User Account | `users.delete` | Soft-delete user authentication profile |
| Session Inspection | *Authenticated User* | Access own session details via `/me` |

---

## 4. Database Models & Schema Specifications

### User Model (`src/models/users/user.model.js`)
- `organizationId`: Ref `Organization` (Required, Immutable).
- `name`: String (Required, trimmed).
- `username`: String (Unique, lowercase, normalized).
- `email`: String (Optional/Unique per org, lowercase).
- `phone`: String (Required, unique per org, normalized E.164).
- `password`: String (Hashed with bcrypt 10 rounds, excluded by default from queries).
- `role`: Ref `Role` (Required).
- `hasOrgWideAccess`: Boolean (Default: `false`).
- `branchAccess`: Array of `{ branchId: ObjectId, branchName: String, isActive: Boolean }`.
- `status`: Enum (`active`, `suspended`, `inactive`, `locked`).
- `loginAttempts`: Number (Default: 0).
- `lockUntil`: Date (Lockout window).
- `isFirstLogin`: Boolean (Default: `true` for invited staff).
- Soft-delete plugin enabled (`isDeleted`, `deletedAt`).

### Session Model (`src/models/auth/session.model.js`)
- `userId`: Ref `User` (Required, Indexed).
- `organizationId`: Ref `Organization` (Required, Indexed).
- `refreshTokenHash`: String (SHA-256 hashed refresh token).
- `deviceInfo`: `{ userAgent: String, ipAddress: String }`.
- `isValid`: Boolean (Default: `true`).
- `expiresAt`: Date (TTL index enabled for automatic expiration).

---

## 5. API Endpoints & Request Contracts

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `POST` | `/api/v1/auth/register` | Public | Register customer account |
| `POST` | `/api/v1/auth/login` | Public (Rate-limited) | Login via email/username + password |
| `POST` | `/api/v1/auth/refresh` | Cookie (`refreshToken`) | Rotate refresh token and issue new access token |
| `POST` | `/api/v1/auth/logout` | Authenticated | Invalidate current session |
| `POST` | `/api/v1/auth/logout-all` | Authenticated | Revoke all sessions across all devices |
| `GET` | `/api/v1/auth/me` | Authenticated | Get current authenticated user session context |
| `POST` | `/api/v1/auth/activate/otp/send` | JWT (`scope: activation`) | Send first-login activation SMS OTP |
| `POST` | `/api/v1/auth/activate/otp/verify` | JWT (`scope: activation`) | Verify OTP & receive `password-change` token |
| `POST` | `/api/v1/auth/activate/change-password` | JWT (`scope: password-change`) | Set permanent password and activate account |
| `POST` | `/api/v1/users` | `users.create` | Admin user creation + welcome credentials email |
| `GET` | `/api/v1/users` | `users.view` | Paginated user directory with search and role filters |
| `GET` | `/api/v1/users/:id` | `users.view` | Get user details |
| `PATCH` | `/api/v1/users/:id` | `users.update` | Edit user contact details and branch access |
| `PATCH` | `/api/v1/users/:id/status` | `users.update` | Change status (`active`, `suspended`, `inactive`) |

---

## 6. Business Invariants & Security Rules

1. **Token Breach Detection**: If a rotated refresh token is reused, all sessions belonging to that user are immediately deleted from MongoDB to protect against token hijacking.
2. **Account Lockout Policy**: 5 consecutive failed login attempts lock the account for 15 minutes. Successful login resets `loginAttempts` to 0.
3. **Privilege Escalation Protection**: `userValidation.js` enforces that an administrative caller cannot assign a role with permissions exceeding their own.
4. **Session Cascade on Status Change**: Changing a user's status to `suspended` or `inactive` immediately deletes all active sessions from the database.

---

## 7. Testing & Verification

- **Test Files**:
  - `src/tests/auth/auth.service.test.js`
  - `src/tests/auth/e2eSecurityFixture.test.js`
  - `src/tests/auth/userActivation.test.js`
  - `src/tests/auth/userCrud.integration.test.js`
  - `src/tests/auth/userIdentity.test.js`
  - `src/tests/auth/userLifecycle.test.js`
  - `src/tests/auth/userRbac.test.js`
  - `src/tests/auth/userRepository.test.js`
- **Result**: ✅ 100% Passed.

