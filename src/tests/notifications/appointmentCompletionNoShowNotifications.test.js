import { jest } from "@jest/globals";
import mongoose from "mongoose";

const mockCreateOutboxEvent = jest.fn();
const mockRunInTransaction = jest.fn();
const mockFindById = jest.fn();
const mockUpdate = jest.fn();
const mockAppointmentFindOneAndUpdate = jest.fn();
const mockAppointmentUpdateOne = jest.fn();
const mockHandlePhysicalFulfillmentCompleted = jest.fn();

jest.unstable_mockModule("../../services/notifications/outbox.service.js", () => ({
  createOutboxEvent: mockCreateOutboxEvent,
}));

jest.unstable_mockModule("../../utils/transaction.js", () => ({
  runInTransaction: mockRunInTransaction,
  isTransactionSupported: jest.fn().mockReturnValue(true),
}));

jest.unstable_mockModule("../../repositories/appointments/appointment.repository.js", () => ({
  appointmentRepo: {
    findById: mockFindById,
    update: mockUpdate,
  },
  AppointmentRepository: jest.fn().mockImplementation(() => ({
    findById: mockFindById,
    update: mockUpdate,
  })),
}));

jest.unstable_mockModule("../../models/appointments/appointment.model.js", () => ({
  Appointment: {
    findOneAndUpdate: mockAppointmentFindOneAndUpdate,
    updateOne: mockAppointmentUpdateOne,
  },
}));

jest.unstable_mockModule("../../services/incentives/settlementFulfillmentEvent.service.js", () => ({
  SettlementFulfillmentEventService: class {
    static rupeesToPaise = (r) => Math.round(Number(r || 0) * 100);
  },
  settlementFulfillmentEventService: {
    handlePhysicalFulfillmentCompleted: mockHandlePhysicalFulfillmentCompleted,
  },
}));

jest.unstable_mockModule("../../models/audit/auditLog.model.js", () => ({
  AuditLog: Object.assign(
    jest.fn().mockImplementation((doc) => ({
      ...doc,
      save: jest.fn().mockResolvedValue(true),
    })),
    { create: jest.fn().mockResolvedValue({}) },
  ),
  AUDIT_ACTIONS: { APPOINTMENT_STATUS_UPDATED: "APPOINTMENT_STATUS_UPDATED" },
}));

const { AppointmentService } = await import(
  "../../services/appointments/appointment.service.js"
);
const appointmentService = new AppointmentService();

describe("Appointment Completion & No-Show Notification Producers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const fakeSession = { id: "appt-complete-session" };
    mockRunInTransaction.mockImplementation(async (fn) => fn(fakeSession));
    mockHandlePhysicalFulfillmentCompleted.mockResolvedValue({});
    mockCreateOutboxEvent.mockResolvedValue({ _id: new mongoose.Types.ObjectId() });
    mockAppointmentUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it("transition to completed emits exactly one appointment.service_completed with active session", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const apptId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    mockFindById.mockResolvedValue({
      _id: apptId,
      organizationId: orgId,
      branchId,
      customerId,
      appointmentCode: "APT-101",
      status: "in_progress",
      services: [],
    });
    mockAppointmentFindOneAndUpdate.mockResolvedValue({
      _id: apptId,
      organizationId: orgId,
      branchId,
      customerId,
      appointmentCode: "APT-101",
      status: "completed",
      completedAt: new Date(),
    });

    await appointmentService.updateStatus(
      apptId,
      { branchId, status: "completed" },
      orgId,
      userId,
    );

    expect(mockCreateOutboxEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        branchId,
        eventType: "appointment.service_completed",
        idempotencyKey: `appointment-completed:${apptId}`,
        payload: {
          appointmentId: String(apptId),
          appointmentCode: "APT-101",
          customerId: String(customerId),
        },
        session: { id: "appt-complete-session" },
      }),
    );
  });

  it("transition to no_show stores pendingOutboxEvents atomically and flushes it", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const apptId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    mockFindById.mockResolvedValue({
      _id: apptId,
      organizationId: orgId,
      branchId,
      customerId,
      appointmentCode: "APT-102",
      status: "confirmed",
      services: [],
    });
    mockUpdate.mockResolvedValue({
      _id: apptId,
      status: "no_show",
    });
    jest.spyOn(appointmentService, "cancelReminders").mockResolvedValue({});

    await appointmentService.updateStatus(
      apptId,
      { branchId, status: "no_show" },
      orgId,
      userId,
    );

    expect(mockUpdate).toHaveBeenCalledWith(
      apptId,
      expect.objectContaining({ status: "no_show" }),
      orgId,
      expect.objectContaining({
        pendingOutboxEvents: expect.objectContaining({
          eventType: "appointment.no_show",
          idempotencyKey: `appointment-no-show:${apptId}`,
        }),
      }),
    );
    expect(mockCreateOutboxEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateOutboxEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        branchId,
        eventType: "appointment.no_show",
        idempotencyKey: `appointment-no-show:${apptId}`,
      }),
    );
    expect(mockAppointmentUpdateOne).toHaveBeenCalledTimes(1);
  });

  it("failed no_show outbox flush leaves pending intent recoverable without pulling it", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const apptId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    mockFindById.mockResolvedValue({
      _id: apptId,
      organizationId: orgId,
      branchId,
      customerId,
      appointmentCode: "APT-103",
      status: "confirmed",
      services: [],
    });
    mockUpdate.mockResolvedValue({
      _id: apptId,
      status: "no_show",
    });
    mockCreateOutboxEvent.mockRejectedValue(new Error("Outbox down"));
    jest.spyOn(appointmentService, "cancelReminders").mockResolvedValue({});

    const res = await appointmentService.updateStatus(
      apptId,
      { branchId, status: "no_show" },
      orgId,
      userId,
    );

    expect(res.status).toBe("no_show");
    expect(mockAppointmentUpdateOne).not.toHaveBeenCalled();
  });

  it("repeated status update from terminal state rejects without emitting duplicate events", async () => {
    const orgId = new mongoose.Types.ObjectId();
    const apptId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    const branchId = new mongoose.Types.ObjectId();
    mockFindById.mockResolvedValue({
      _id: apptId,
      organizationId: orgId,
      branchId,
      status: "completed",
      services: [],
    });

    await expect(
      appointmentService.updateStatus(apptId, { branchId, status: "completed" }, orgId, userId),
    ).rejects.toThrow();
    expect(mockCreateOutboxEvent).not.toHaveBeenCalled();
  });
});
