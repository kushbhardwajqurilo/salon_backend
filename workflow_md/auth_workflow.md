# Authentication & Session Management Workflow

This document details the step-by-step logic, validations, and database mutations that occur during each authentication event.

---

## 1. User Registration Flow
1. **Request Received**: The client sends a `POST` request to `/api/v1/auth/register` with `name`, `email`, `phone`, `password`, and optional `roleName`.
2. **Sanitization & Validation**:
   - The route validator (`validate(registerSchema)`) parses and validates inputs.
   - Password must satisfy the complexity rules: minimum 8 characters, uppercase, lowercase, number, and special character.
3. **Database Checks**:
   - Checks if the email or phone is already registered. If true, throws a `400 Bad Request` AppError.
   - Fetches the role ID corresponding to the requested `roleName` (defaults to "customer"). If not found, throws a `400 Bad Request` AppError.
4. **User Creation**:
   - Password is automatically hashed using `bcrypt` (10 rounds) in the pre-save schema hook.
   - Generates a crypto-secure email verification token and sets an expiration timestamp (10 minutes).
   - Writes the new User document.
5. **Asynchronous Notification**:
   - Adds a `sendVerificationEmail` job to `emailQueue` (BullMQ/Redis) so the main thread remains unblocked.
6. **Response**: Returns a success response: `201 Created` with the user summary.

---

## 2. Login Flow (Password-Based)
1. **Request Received**: The client sends a `POST` request to `/api/v1/auth/login` with `email` and `password`.
2. **Device / IP Tracking**:
   - The controller extracts the client's `ipAddress` (handling proxy headers) and `deviceInfo` (User-Agent header).
3. **Account State Check**:
   - Looks up the user by email. If the user does not exist, returns `401 Unauthorized`.
   - Checks if account status is `suspended` (throws `403 Forbidden`).
   - Checks if account status is `locked`. If locked and `lockUntil` is in the future, throws `403 Forbidden`. If lock has expired, unlocks the user.
4. **Password Verification**:
   - Calls `user.comparePassword(password)`.
   - **If incorrect**: Increments `failedLoginAttempts`. If it reaches 5, updates user status to `locked` and sets `lockUntil` to +15 minutes. Throws `401 Unauthorized`.
   - **If correct**: Resets `failedLoginAttempts` to 0 and updates user status to `active`.
5. **Token & Session Creation**:
   - Signs a short-lived **Access Token (JWT)** containing `{ id, email, role, branches }` expiring in 15 minutes.
   - Generates a long, random **Refresh Token** (80-character hex string).
   - Saves a new Session document in the database containing the hashed refresh token, user ID, IP address, browser metadata, and an expiration timestamp (7 days).
6. **Response**:
   - Attaches the refresh token to a secure, HTTP-only, SameSite=Strict cookie.
   - Returns the Access Token and User metadata in the response body (`200 OK`).

---

## 3. Refresh Token Rotation (RTR) & Breach Invalidation
1. **Request Received**: The client requests a new access token at `/api/v1/auth/refresh`, providing the refresh token via a cookie.
2. **Session Verification**:
   - Searches the database for an active, valid session containing that refresh token.
3. **Breach/Reuse Detection (Crucial Security Check)**:
   - If **no active session** is found, checks if this token exists in any *inactive* session.
   - If it does, a compromise is suspected (the token was stolen and used by an attacker, or already rotated).
   - **Action**: Immediately revokes and invalidates ALL active sessions for that user, logging them out of all devices, and returns a `401 Unauthorized` AppError.
4. **Rotation**:
   - If the session is active and valid, signs a new Access Token.
   - Generates a new Refresh Token.
   - Invalidates the old session (`isValid = false`).
   - Stores the new rotated session document in MongoDB.
5. **Response**: Sets the new Refresh Token in secure cookies and returns the new Access Token (`200 OK`).

---

## 4. Logout Flows
- **Single Device Logout (`POST /auth/logout`)**:
  - Extracts the refresh token from cookies.
  - Invalidates the current session (`isValid = false`).
  - Clears the cookie from the client's browser.
- **Multi-Device Logout (`POST /auth/logout-all`)**:
  - Requires active authorization.
  - Invalidates all sessions associated with `req.user.id` (`isValid = false` for all match records).
  - Clears cookies.

---

## 5. Password Reset & Verification Flows
- **Email Verification (`GET /auth/verify-email?token=...`)**:
  - Checks for a matching verification token that is still valid.
  - Updates the user's document setting `isVerified = true`.
- **Forgot Password (`POST /auth/forgot-password`)**:
  - Generates a password reset token and saves its expiration (10 minutes) on the user.
  - Queues a `sendPasswordResetEmail` job containing the token.
- **Reset Password (`POST /auth/reset-password/:token`)**:
  - Checks the token validity.
  - Hashes the new password, resets failed attempt counters, and clears reset tokens.
  - Invalidates **all active sessions** (forces global logout for safety).
