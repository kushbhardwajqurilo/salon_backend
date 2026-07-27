# Unisex Parlour ERP — Authentication & Session Specification

**Status:** Living technical specification  
**Parent document:** `ARCHITECTURE.md`

## 1. Purpose

This document explains the identity/session architecture that the frontend and backend share.

## 2. Authentication vs Authorization

Authentication answers:

> Who is this user?

Authorization answers:

> What is this user allowed to do?

Authentication does not grant permission by itself.

## 3. Authenticated Session

The frontend session contract includes:

- `id`
- `name`
- `email`
- `phone`
- `role`
- `permissions`
- `organizationId`
- `branchAccess`
- `hasOrgWideAccess`

The backend is responsible for producing the authoritative session data.

## 4. `/api/v1/auth/me`

The `/me` endpoint is used to retrieve the current authenticated session.

The response provides the frontend with the context needed to initialize:

- User identity.
- Permissions.
- Organization.
- Branch access.
- Organization-wide capability.

The frontend must not infer missing permissions from role names.

## 5. Token Lifecycle

The exact token transport is owned by the project's established authentication implementation.

The intended lifecycle is:

```text
Login
  ↓
Authenticated Session
  ↓
API Requests
  ↓
Access Token Expiration
  ↓
Refresh Flow
  ↓
New Access Token
```

If refresh fails, the application must clear the authenticated session and return the user to the appropriate unauthenticated state.

## 6. Centralized Auth Handling

Authentication transport must be centralized.

Feature components should not:

- Read tokens directly.
- Implement refresh logic.
- Duplicate logout logic.
- Manually construct authorization headers.

Use the established auth/token utility and Axios layer.

## 7. `/me` as Session Contract

The frontend should treat `/me` as the authoritative source for current user context.

The frontend should not derive:

```text
Owner → all permissions
Admin → all permissions
```

Instead:

```text
permissions returned by backend
        ↓
frontend permission helpers
```

## 8. Session Initialization

A typical flow is:

```text
Application starts
    ↓
Restore authentication state
    ↓
Fetch /auth/me if authenticated
    ↓
Populate user session
    ↓
Initialize branch context
    ↓
Render protected application
```

The application must avoid rendering protected UI based on stale or incomplete user context.

## 9. Logout

Logout must clear the application's authentication state and local session data according to the established token strategy.

Branch context should also be reset when the authenticated organization changes.

## 10. Organization Changes

A user's organization context must never be selected from arbitrary client input.

It is derived from authenticated identity.

When the authenticated user changes:

- Clear previous user session.
- Clear or reset branch context.
- Clear/invalidate user-specific query caches.
- Initialize the new session.

## 11. Security Rules

Never:

- Trust role names for permission decisions.
- Trust client-supplied organization IDs.
- Store sensitive credentials in UI state unnecessarily.
- Expose refresh tokens to application code if the established architecture keeps them in secure cookies.
- Treat a valid token as proof of every permission.

## 12. Session Testing

Test:

- Successful login.
- Invalid credentials.
- `/me` response.
- Expired access token.
- Refresh flow.
- Refresh failure.
- Logout.
- Unauthorized API access.
- Permission denial.
- Organization isolation.
- Branch scope enforcement.
