import SimulatorAdapter from './simulator.adapter.js';
import eTimeOfficeAdapter from './etimeoffice.adapter.js';

// Provider Registry — Salon Project Unisex Parlour ERP
// Singleton registry that maps provider names to adapter classes.
// Enables vendor-agnostic Attendance engine — new providers require
// only an adapter implementation and registry registration.

class ProviderRegistry {
  constructor() {
    this.adapters = new Map(); // name → class
  }

  registerAdapter(name, AdapterClass) {
    this.adapters.set(name, AdapterClass);
  }

  getAdapter(name) {
    return this.adapters.get(name) || null;
  }

  listAdapters() {
    return [...this.adapters.keys()];
  }

  // Create adapter instance with config
  createAdapter(name, config) {
    const AdapterClass = this.adapters.get(name);
    if (!AdapterClass) {
      throw new Error(`Unknown provider adapter: ${name}`);
    }
    return new AdapterClass(config);
  }
}

// Global registry instance
const registry = new ProviderRegistry();
registry.registerAdapter('simulator', SimulatorAdapter);
registry.registerAdapter('eTimeOffice', eTimeOfficeAdapter);

export default registry;

// Example usage:
// import registry from './providers/attendance/provider.registry.js';
// const adapter = registry.createAdapter('simulator', config);

// Provider configuration management:
// - ProviderConfiguration model owns organization-scoped provider credentials
// - Credentials encrypted at rest; never exposed to frontend
// - ProviderConfiguration does NOT duplicate deviceMappings
// - deviceMappings handled exclusively by StaffDeviceMapping model