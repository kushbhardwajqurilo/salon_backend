import { Appointment } from "../../models/appointments/appointment.model.js";

const subscriptionReferencePopulation = {
  path: "services.appliedSubscriptionId",
  select: "subscriptionCode status",
  transform: (subscription, id) => subscription || id,
};

const membershipReferencePopulation = {
  path: "services.appliedCustomerMembershipId",
  select: "membershipCode tier benefitSnapshot startDate endDate status",
  transform: (membership, id) => membership || id,
};

export class AppointmentRepository {
  async create(appointmentData) {
    const appointment = new Appointment(appointmentData);
    return await appointment.save();
  }

  async findById(id, organizationId) {
    return await Appointment.findOne({
      _id: id,
      organizationId,
      isDeleted: false,
    })
      .populate("branchId", "name")
      .populate("customerId", "name phone email")
      .populate("staffId", "name")
    .populate(subscriptionReferencePopulation)
    .populate(membershipReferencePopulation);
  }

  async findOne(filter, organizationId) {
    return await Appointment.findOne({
      ...filter,
      organizationId,
      isDeleted: false,
    })
      .populate("branchId", "name")
      .populate("customerId", "name phone email")
      .populate("staffId", "name")
    .populate(subscriptionReferencePopulation)
    .populate(membershipReferencePopulation);
  }

  async find(filter = {}, pagination = {}, organizationId, branchId = null) {
    const query = { ...filter, organizationId, isDeleted: false };
    if (branchId) {
      query.branchId = branchId;
    }

    const {
      page = 1,
      limit = 10,
      sortBy = "startAt",
      sortOrder = "desc",
    } = pagination;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      Appointment.find(query)
        .populate("branchId", "name")
        .populate("customerId", "name phone email")
        .populate("staffId", "name")
        .populate(subscriptionReferencePopulation)
        .populate(membershipReferencePopulation)
        .sort({ [sortBy]: sortOrder === "desc" ? -1 : 1 })
        .skip(skip)
        .limit(limit),
      Appointment.countDocuments(query),
    ]);

    return {
      data,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async update(id, updateData, organizationId, pushData = null) {
    const updateOp = { $set: updateData };
    if (pushData) {
      updateOp.$push = pushData;
    }
    return await Appointment.findOneAndUpdate(
      { _id: id, organizationId, isDeleted: false },
      updateOp,
      { new: true, runValidators: true },
    );
  }

  async softDelete(id, organizationId) {
    return await Appointment.findOneAndUpdate(
      { _id: id, organizationId, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: new Date(), slotMinutes: [] } },
      { new: true },
    );
  }
}
