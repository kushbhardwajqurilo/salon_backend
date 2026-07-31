import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { ServiceService } from "../../services/services/service.service.js";
import { ServiceCategoryService } from "../../services/services/serviceCategory.service.js";
import { AppError } from "../../utils/errors.js";

// Mock the models
import { Service } from "../../models/services/service.model.js";
import { ServiceCategory } from "../../models/services/serviceCategory.model.js";
import { AuditLog } from "../../models/audit/auditLog.model.js";
import { Branch } from "../../models/branches/branch.model.js";

Branch.findOne = jest.fn();
Branch.find = jest.fn();
ServiceCategory.findOne = jest.fn();
ServiceCategory.findById = jest.fn();
ServiceCategory.findOneAndUpdate = jest.fn();
ServiceCategory.find = jest.fn();
ServiceCategory.countDocuments = jest.fn();
Service.findOne = jest.fn();
Service.findById = jest.fn();
Service.findOneAndUpdate = jest.fn();
Service.find = jest.fn();
Service.countDocuments = jest.fn();

AuditLog.create = jest.fn().mockResolvedValue({});

describe("Services Module Unit Tests", () => {
  let serviceService;
  let categoryService;
  let mockServiceRepo;
  let mockCategoryRepo;
  let mockAuditRepo;

  beforeEach(() => {
    jest.clearAllMocks();

    mockServiceRepo = {
      create: jest.fn(),
      findById: jest.fn(),
      updateById: jest.fn(),
      deleteById: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
    };

    mockCategoryRepo = {
      create: jest.fn(),
      findById: jest.fn(),
      updateById: jest.fn(),
      deleteById: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
    };

    mockAuditRepo = {
      create: jest.fn().mockResolvedValue({}),
      find: jest.fn().mockResolvedValue([]),
    };

    serviceService = new ServiceService(mockServiceRepo, mockCategoryRepo, mockAuditRepo);
    categoryService = new ServiceCategoryService(mockCategoryRepo, mockAuditRepo);

    // Mock Branch by default
    jest.spyOn(mongoose, "model").mockImplementation((modelName) => {
      if (modelName === "Branch") {
        return {
          findOne: jest.fn().mockResolvedValue({ _id: "branch-1", organizationId: "org-1", isActive: true }),
        };
      }
      if (modelName === "Service") {
        return {
          countDocuments: jest.fn().mockResolvedValue(0),
        };
      }
      return {};
    });
  });

  describe("ServiceCategory Operations", () => {
    it("should successfully create a service category", async () => {
      mockCategoryRepo.findOne.mockResolvedValue(null);
      const mockCategory = {
        _id: "cat-1",
        name: "Haircare",
        description: "Hair styling and cuts",
        displayOrder: 1,
        branchId: "branch-1",
        organizationId: "org-1",
        status: "active",
      };
      mockCategoryRepo.create.mockResolvedValue(mockCategory);

      const result = await categoryService.createCategory(
        { name: "Haircare", description: "Hair styling and cuts", displayOrder: 1, branchId: "branch-1" },
        "org-1",
        "user-1"
      );

      expect(result).toEqual(mockCategory);
      expect(mockCategoryRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Haircare" }),
        "org-1",
        "user-1"
      );
      expect(mockAuditRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: "SERVICE_CREATED", entityType: "ServiceCategory" }),
        "org-1",
        "user-1"
      );
    });

    it("should reject creation of category if name duplicate exists in branch", async () => {
      mockCategoryRepo.findOne.mockResolvedValue({ _id: "cat-1", name: "Haircare" });

      await expect(
        categoryService.createCategory(
          { name: "Haircare", branchId: "branch-1" },
          "org-1",
          "user-1"
        )
      ).rejects.toThrow("A category with this name already exists in this branch.");
    });

    it("should reject deactivation of category if it has active services", async () => {
      const mockCategory = {
        _id: "cat-1",
        name: "Haircare",
        branchId: "branch-1",
        status: "active",
      };
      mockCategoryRepo.findById.mockResolvedValue(mockCategory);

      // Mock Service.countDocuments to return > 0
      jest.spyOn(mongoose, "model").mockImplementation((modelName) => {
        if (modelName === "Service") {
          return {
            countDocuments: jest.fn().mockResolvedValue(2),
          };
        }
        return {};
      });

      await expect(
        categoryService.updateCategory(
          "cat-1",
          { status: "inactive" },
          "org-1",
          "user-1"
        )
      ).rejects.toThrow("Cannot deactivate category because it has active services associated with it.");
    });
  });

  describe("Service Operations", () => {
    it("should successfully create a service and generate code", async () => {
      mockCategoryRepo.findById.mockResolvedValue({
        _id: "cat-1",
        status: "active",
        branchId: "branch-1",
        organizationId: "org-1",
      });
      mockServiceRepo.findOne.mockResolvedValue(null);

      const mockService = {
        _id: "srv-1",
        name: "Haircut",
        serviceCode: "HAIRWXYZ",
        categoryId: "cat-1",
        pricing: { basePrice: 500 },
        duration: 30,
        branchId: "branch-1",
        organizationId: "org-1",
      };
      mockServiceRepo.create.mockResolvedValue(mockService);

      const result = await serviceService.createService(
        {
          name: "Haircut",
          categoryId: "cat-1",
          pricing: { basePrice: 500 },
          duration: 30,
          branchId: "branch-1",
        },
        "org-1",
        "user-1"
      );

      expect(result.name).toBe("Haircut");
      expect(mockServiceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Haircut",
          serviceCode: expect.any(String),
        }),
        "org-1",
        "user-1"
      );
    });

    it("should reject service creation if category branch mismatch occurs", async () => {
      mockCategoryRepo.findById.mockResolvedValue({
        _id: "cat-1",
        status: "active",
        branchId: "branch-2",
        organizationId: "org-1",
      });

      await expect(
        serviceService.createService(
          {
            name: "Haircut",
            categoryId: "cat-1",
            pricing: { basePrice: 500 },
            duration: 30,
            branchId: "branch-1",
          },
          "org-1",
          "user-1"
        )
      ).rejects.toThrow("Category branch must match service branch.");
    });

    it("should reject updates to immutable properties", async () => {
      const mockService = {
        _id: "srv-1",
        name: "Haircut",
        serviceCode: "HAIR1234",
        status: "active",
        branchId: "branch-1",
        organizationId: "org-1",
        categoryId: "cat-1",
      };
      mockServiceRepo.findById.mockResolvedValue(mockService);
      mockServiceRepo.updateById.mockResolvedValue({ ...mockService, name: "Haircut Premium" });

      const result = await serviceService.updateService(
        "srv-1",
        { name: "Haircut Premium", serviceCode: "NEWCODE" },
        "org-1",
        "user-1"
      );

      expect(result.name).toBe("Haircut Premium");
      // The updated call should omit the serviceCode
      expect(mockServiceRepo.updateById).toHaveBeenCalledWith(
        "srv-1",
        expect.not.objectContaining({ serviceCode: "NEWCODE" }),
        "org-1",
        "user-1"
      );
    });
  });
});
