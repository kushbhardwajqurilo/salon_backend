# Backend API Integration Contract Requirements

This document outlines the API contracts and scoping expectations required by the frontend application. It distinguishes between confirmed APIs, proposed mechanisms, and pending clarifications.

---

## 1. User Session Initialization (`/auth/me`)
*   **Status**: Confirmed structure required by frontend
*   **Payload Requirements**:
    ```json
    {
      "success": true,
      "data": {
        "id": "usr_123",
        "name": "Jane Doe",
        "email": "jane@parlour.com",
        "role": "Manager", // Dynamic role string
        "permissions": [
          "customers.view",
          "customers.create",
          "appointments.view"
        ],
        "organizationId": "org_789",
        "hasOrgWideAccess": false, // Required to control org-wide (All Branches) scope access
        "branchAccess": [
          {
            "branchId": "br_001",
            "branchName": "Downtown Salon",
            "isActive": true
          }
        ]
      }
    }
    ```

---

## 2. Branch List API (`GET /branches`)
*   **Status**: Pending backend implementation
*   **Payload Requirements**: Returns the list of branches the user is authorized to interact with.
    ```json
    {
      "success": true,
      "data": {
        "organization": {
          "id": "org_789",
          "name": "Royal Unisex Parlours"
        },
        "branches": [
          {
            "id": "br_001",
            "name": "Downtown Salon",
            "organizationId": "org_789",
            "isActive": true
          }
        ]
      }
    }
    ```

---

## 3. Branch Scoping Mechanism (HTTP Headers)
*   **Status**: **Proposed branch-scope transport mechanism — requires backend confirmation.**
*   **Mechanism**: The frontend will transmit the active branch context using the `X-Branch-Id` header for branch-scoped requests.
*   **Expectations**:
    *   **Branch-scoped requests**: The backend must parse the `X-Branch-Id` header to scope database queries. If the header is missing for an endpoint that requires it, the backend should reject it with a `400 Bad Request` or `422 Unprocessable Entity` response.
    *   **Organization-scoped requests**: The backend must process the request across the organization context, ignoring the presence or absence of the `X-Branch-Id` header.
    *   **Authorization**: The backend must check if the authenticated user has access to the organization and the branch supplied in the `X-Branch-Id` header. The frontend's client settings must not be trusted as a security boundary.

---

## 4. Error Responses & Auth States
*   **Status**: Confirmed frontend routing logic
*   **401 Unauthorized**: If an access token expires or is invalid, the backend must return a `401 Unauthorized`. The frontend Axios client will automatically intercept this and trigger a token refresh flow. If the refresh fails, the user is redirected to `/login`.
*   **403 Forbidden**: If a user attempts to access a branch or resource they are not authorized for, the backend must return a `403 Forbidden`. The frontend will intercept this to display access-denied pages or alerts.
