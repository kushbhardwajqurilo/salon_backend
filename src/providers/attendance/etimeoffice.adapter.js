// eTimeOffice Adapter Boundary — Salon Project Unisex Parlour ERP
// 
// NOTE: This file defines the adapter BOUNDARY only.
// Live eTimeOffice integration requires official API documentation and account access.
// Do NOT invent API endpoints, authentication methods, payload fields, or response identifiers.
//
// Provider configuration is organization-scoped; credentials encrypted at rest.
// Provider auth is separate from user JWT/RBAC authentication.
//
// The adapter interface is defined in provider.interface.js.
// The Provider Registry maps provider names to adapter classes.
//
// Until eTimeOffice API documentation is available, the adapter is a stub
// that throws informative errors directing to official documentation.
//
// Integration stages (sequential, not simultaneous):
//  1. Provider configuration setup (org-scoped, credentials encrypted)
//  2. Raw provider delivery → ProviderDeliveryLog
//  3. Adapter normalization → RawProviderEvent
//  4. Server-side StaffDeviceMapping lookup → AttendancePunch
//  5. Unmapped events retained in RawProviderEvent until authorized resolution
//  5. Checkpoint advancement after durable processing

// eTimeAdapter — stub structure
export default class eTimeAdapter {
  constructor(config) {
    // config contains: providerName, endpointUrl (encrypted), integrationMethod
    // NOTE: endpointUrl and credentials are NOT used until official API docs available
    this.config = config;
    this.name = 'eTimeOffice';
  }

  // Validate provider request — throws error until API docs available
  validateRequestSource(req) {
    throw new Error(
      'eTimeOffice adapter: Official API documentation not yet available. ' +
      'Integration pending account access and documentation. ' +
      'See: eTimeOffice integration pending in Attendance design.'
    );
  }

  // Normalize payload — stub, will be implemented with official API docs
  normalizePayload(rawPayload) {
    throw new Error(
      'eTimeOffice adapter: Official API documentation not yet available. ' +
      'Integration pending account access and documentation.'
    );
  }

}

// Integration notes for developers:
// - Until official API documentation is available, the eTimeAdapter throws errors
// - Use the simulator adapter for testing
// - Provider configuration should be set up in ProviderConfiguration model
// - Staff mapping uses StaffDeviceMapping, same as all other providers
// - Live integration requires: eTimeOffice account, API endpoints, authentication method,
//   response field definitions, and synchronization specifications