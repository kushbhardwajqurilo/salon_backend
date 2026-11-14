// Simulator Adapter — Exercises the provider-independent ingestion pipeline.
export default class SimulatorAdapter {
  constructor(config = {}) {
    this.config = config;
  }

  validateRequestSource() {
    return null;
  }

  normalizePayload(rawPayload) {
    return {
      externalEmployeeCode: rawPayload?.employeeCode,
      punchType: rawPayload?.punchType || 'in',
      punchAt: rawPayload?.punchAt || new Date(),
      externalEventId: rawPayload?.externalEventId,
      deviceId: rawPayload?.deviceId || 'SIM-DEV-001',
      deviceSource: rawPayload?.deviceSource || 'simulator',
      rawEvent: { ...rawPayload, simulated: true },
    };
  }
}
