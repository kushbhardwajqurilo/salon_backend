import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import mongoose from 'mongoose';
import { StaffDeviceMapping } from '../../models/attendance/StaffDeviceMapping.model.js';
import { ProviderConfiguration } from '../../models/attendance/ProviderConfiguration.model.js';
import { Branch } from '../../models/branches/branch.model.js';
import { Staff } from '../../models/staff/staff.model.js';
import { StaffBranch } from '../../models/staff/staffBranch.model.js';
import { AuditLog } from '../../models/audit/auditLog.model.js';
import {
  createStaffDeviceMapping,
  deactivateStaffDeviceMapping,
  getStaffDeviceMappingById,
  listStaffDeviceMappings,
  updateStaffDeviceMapping,
} from '../../services/attendance/attendance.service.js';
import { AppError } from '../../utils/errors.js';

describe('StaffDeviceMapping Service & Lifecycle', () => {
  const organizationId = new mongoose.Types.ObjectId();
  const otherOrgId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  const otherBranchId = new mongoose.Types.ObjectId();
  const actorId = new mongoose.Types.ObjectId();
  const staffId = new mongoose.Types.ObjectId();
  const inactiveStaffId = new mongoose.Types.ObjectId();
  const unassignedStaffId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createStaffDeviceMapping', () => {
    it('successfully creates a mapping when all business rules are satisfied', async () => {
      jest.spyOn(Staff, 'findOne').mockResolvedValue({
        _id: staffId,
        organizationId,
        isActive: true,
        name: 'John Doe',
        staffCode: 'STF-001',
      });
      jest.spyOn(StaffBranch, 'findOne').mockResolvedValue({
        _id: new mongoose.Types.ObjectId(),
        staffId,
        branchId,
        organizationId,
        isActive: true,
      });
      jest.spyOn(ProviderConfiguration, 'findOne').mockResolvedValue({
        _id: new mongoose.Types.ObjectId(),
        organizationId,
        branchId,
        providerName: 'simulator',
        isActive: true,
        deviceMappings: { 'device-01': 'gate-1' },
      });
      jest.spyOn(StaffDeviceMapping, 'findOne').mockResolvedValue(null);

      const createdDoc = {
        _id: new mongoose.Types.ObjectId(),
        organizationId,
        branchId,
        provider: 'simulator',
        deviceId: 'device-01',
        externalEmployeeCode: 'EMP100',
        staffId,
        mappingStatus: 'mapped',
        mappingMethod: 'admin_overriden',
        isActive: true,
      };
      jest.spyOn(StaffDeviceMapping, 'create').mockResolvedValue(createdDoc);
      jest.spyOn(AuditLog, 'create').mockResolvedValue({});
      jest.spyOn(StaffDeviceMapping, 'findById').mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue({
              ...createdDoc,
              staffId: { _id: staffId, name: 'John Doe', staffCode: 'STF-001' },
            }),
          }),
        }),
      });

      const result = await createStaffDeviceMapping({
        organizationId,
        branchId,
        actorId,
        staffId,
        provider: 'simulator',
        deviceId: 'device-01',
        externalEmployeeCode: 'EMP100',
        notes: 'Assigned by HR',
      });

      expect(StaffDeviceMapping.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId,
          branchId,
          provider: 'simulator',
          deviceId: 'device-01',
          externalEmployeeCode: 'EMP100',
          staffId,
          mappingMethod: 'admin_overriden',
          isActive: true,
        })
      );
      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'STAFF_DEVICE_MAPPING_CREATED',
          entityType: 'StaffDeviceMapping',
          organizationId,
          branchId,
          actorId,
        })
      );
      expect(result.externalEmployeeCode).toBe('EMP100');
    });

    it('rejects mapping creation for an inactive staff member', async () => {
      jest.spyOn(Staff, 'findOne').mockResolvedValue({
        _id: inactiveStaffId,
        organizationId,
        isActive: false,
      });

      await expect(
        createStaffDeviceMapping({
          organizationId,
          branchId,
          actorId,
          staffId: inactiveStaffId,
          provider: 'simulator',
          deviceId: 'device-01',
          externalEmployeeCode: 'EMP100',
        })
      ).rejects.toThrow(new AppError('Cannot create mapping for an inactive staff member.', 400));
    });

    it('rejects mapping creation when staff member does not belong to the selected branch', async () => {
      jest.spyOn(Staff, 'findOne').mockResolvedValue({
        _id: unassignedStaffId,
        organizationId,
        isActive: true,
      });
      jest.spyOn(StaffBranch, 'findOne').mockResolvedValue(null);

      await expect(
        createStaffDeviceMapping({
          organizationId,
          branchId,
          actorId,
          staffId: unassignedStaffId,
          provider: 'simulator',
          deviceId: 'device-01',
          externalEmployeeCode: 'EMP100',
        })
      ).rejects.toThrow(new AppError('Staff member is not actively assigned to the selected branch.', 400));
    });

    it('rejects mapping creation when provider configuration is missing or inactive', async () => {
      jest.spyOn(Staff, 'findOne').mockResolvedValue({
        _id: staffId,
        organizationId,
        isActive: true,
      });
      jest.spyOn(StaffBranch, 'findOne').mockResolvedValue({
        staffId,
        branchId,
        organizationId,
        isActive: true,
      });
      jest.spyOn(ProviderConfiguration, 'findOne').mockResolvedValue(null);

      await expect(
        createStaffDeviceMapping({
          organizationId,
          branchId,
          actorId,
          staffId,
          provider: 'simulator',
          deviceId: 'device-01',
          externalEmployeeCode: 'EMP100',
        })
      ).rejects.toThrow(new AppError('No active configuration found for provider "simulator" at this branch.', 400));
    });

    it('rejects duplicate active mapping with 409 conflict', async () => {
      jest.spyOn(Staff, 'findOne').mockResolvedValue({
        _id: staffId,
        organizationId,
        isActive: true,
      });
      jest.spyOn(StaffBranch, 'findOne').mockResolvedValue({
        staffId,
        branchId,
        organizationId,
        isActive: true,
      });
      jest.spyOn(ProviderConfiguration, 'findOne').mockResolvedValue({
        organizationId,
        branchId,
        providerName: 'simulator',
        isActive: true,
      });
      jest.spyOn(StaffDeviceMapping, 'findOne').mockResolvedValue({
        _id: new mongoose.Types.ObjectId(),
        isActive: true,
      });

      await expect(
        createStaffDeviceMapping({
          organizationId,
          branchId,
          actorId,
          staffId,
          provider: 'simulator',
          deviceId: 'device-01',
          externalEmployeeCode: 'EMP100',
        })
      ).rejects.toThrow(expect.objectContaining({ statusCode: 409 }));
    });

    it('safeguards against race conditions by catching MongoDB E11000 duplicate key error and throwing 409', async () => {
      jest.spyOn(Staff, 'findOne').mockResolvedValue({
        _id: staffId,
        organizationId,
        isActive: true,
      });
      jest.spyOn(StaffBranch, 'findOne').mockResolvedValue({
        staffId,
        branchId,
        organizationId,
        isActive: true,
      });
      jest.spyOn(ProviderConfiguration, 'findOne').mockResolvedValue({
        organizationId,
        branchId,
        providerName: 'simulator',
        isActive: true,
      });
      jest.spyOn(StaffDeviceMapping, 'findOne').mockResolvedValue(null);

      const mongoError = new Error('E11000 duplicate key error collection');
      mongoError.code = 11000;
      jest.spyOn(StaffDeviceMapping, 'create').mockRejectedValue(mongoError);

      await expect(
        createStaffDeviceMapping({
          organizationId,
          branchId,
          actorId,
          staffId,
          provider: 'simulator',
          deviceId: 'device-01',
          externalEmployeeCode: 'EMP100',
        })
      ).rejects.toThrow(expect.objectContaining({ statusCode: 409 }));
    });
  });

  describe('deactivateStaffDeviceMapping', () => {
    it('soft-deactivates the mapping, sets effectiveTo, records audit, and preserves history', async () => {
      const mappingDoc = {
        _id: new mongoose.Types.ObjectId(),
        organizationId,
        branchId,
        provider: 'simulator',
        deviceId: 'device-01',
        externalEmployeeCode: 'EMP100',
        staffId,
        isActive: true,
        save: jest.fn().mockResolvedValue(true),
      };

      jest.spyOn(StaffDeviceMapping, 'findOne').mockResolvedValue(mappingDoc);
      jest.spyOn(AuditLog, 'create').mockResolvedValue({});
      jest.spyOn(StaffDeviceMapping, 'findById').mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          ...mappingDoc,
          isActive: false,
          effectiveTo: new Date(),
        }),
      });

      const result = await deactivateStaffDeviceMapping({
        id: mappingDoc._id,
        organizationId,
        branchId,
        actorId,
      });

      expect(mappingDoc.isActive).toBe(false);
      expect(mappingDoc.effectiveTo).toBeDefined();
      expect(mappingDoc.save).toHaveBeenCalled();
      expect(AuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'STAFF_DEVICE_MAPPING_DEACTIVATED',
          entityType: 'StaffDeviceMapping',
          organizationId,
          branchId,
        })
      );
      expect(result.isActive).toBe(false);
    });

    it('rejects deactivation if mapping is already inactive', async () => {
      const mappingDoc = {
        _id: new mongoose.Types.ObjectId(),
        organizationId,
        branchId,
        isActive: false,
      };

      jest.spyOn(StaffDeviceMapping, 'findOne').mockResolvedValue(mappingDoc);

      await expect(
        deactivateStaffDeviceMapping({
          id: mappingDoc._id,
          organizationId,
          branchId,
          actorId,
        })
      ).rejects.toThrow(new AppError('Staff device mapping is already inactive.', 400));
    });
  });

  describe('listStaffDeviceMappings', () => {
    it('scopes query to active branch and organization context', async () => {
      const mockFind = {
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          {
            _id: new mongoose.Types.ObjectId(),
            organizationId,
            branchId,
            externalEmployeeCode: 'EMP100',
          },
        ]),
      };

      jest.spyOn(StaffDeviceMapping, 'find').mockReturnValue(mockFind);
      jest.spyOn(StaffDeviceMapping, 'countDocuments').mockResolvedValue(1);

      const result = await listStaffDeviceMappings({
        organizationId,
        branchId,
        page: 1,
        limit: 10,
      });

      expect(StaffDeviceMapping.find).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId,
          branchId,
        })
      );
      expect(result.mappings).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
    });
  });
});
