import { jest } from "@jest/globals";
import mongoose from "mongoose";
import { RoleService } from "../../services/roles/role.service.js";
import { AppError } from "../../utils/errors.js";
import { Role } from "../../models/roles/role.model.js";
import { Permission } from "../../models/permissions/permission.model.js";
import { User } from "../../models/users/user.model.js";

describe("RoleService Unit & Contract Tests", () => {
  let roleService;

  beforeEach(() => {
    jest.clearAllMocks();
    roleService = new RoleService();
  });

  describe("createRole", () => {
    it("should create a custom role scoped to organization", async () => {
      const orgId = new mongoose.Types.ObjectId();
      const mockCreatedRole = {
        _id: new mongoose.Types.ObjectId(),
        name: "receptionist",
        description: "Front desk staff",
        organizationId: orgId,
        isSystem: false,
      };

      jest.spyOn(roleService.roleRepo, "findByNameInOrg").mockResolvedValue(null);
      jest.spyOn(roleService.roleRepo, "create").mockResolvedValue(mockCreatedRole);

      const result = await roleService.createRole(
        { name: "Receptionist", description: "Front desk staff" },
        orgId.toString()
      );

      expect(roleService.roleRepo.findByNameInOrg).toHaveBeenCalledWith("receptionist", orgId.toString());
      expect(roleService.roleRepo.create).toHaveBeenCalledWith(
        {
          name: "receptionist",
          description: "Front desk staff",
          organizationId: orgId.toString(),
          isSystem: false,
        },
        null
      );
      expect(result).toEqual(mockCreatedRole);
    });

    it("should throw 400 error if role name already exists in organization", async () => {
      const orgId = new mongoose.Types.ObjectId();
      jest.spyOn(roleService.roleRepo, "findByNameInOrg").mockResolvedValue({ name: "receptionist" });

      await expect(
        roleService.createRole({ name: "receptionist", description: "Front desk staff" }, orgId.toString())
      ).rejects.toThrow(new AppError("Role already exists", 400));
    });
  });

  describe("getRoleById", () => {
    it("should return role details if role belongs to org or is system role", async () => {
      const roleId = new mongoose.Types.ObjectId();
      const orgId = new mongoose.Types.ObjectId();
      const mockRole = { _id: roleId, name: "receptionist", organizationId: orgId };

      jest.spyOn(roleService.roleRepo, "findRoleByIdAndOrg").mockResolvedValue(mockRole);

      const result = await roleService.getRoleById(roleId.toString(), orgId.toString());
      expect(result).toEqual(mockRole);
    });

    it("should throw 404 if role not found or belongs to another org", async () => {
      const roleId = new mongoose.Types.ObjectId();
      const orgId = new mongoose.Types.ObjectId();

      jest.spyOn(roleService.roleRepo, "findRoleByIdAndOrg").mockResolvedValue(null);

      await expect(roleService.getRoleById(roleId.toString(), orgId.toString())).rejects.toThrow(
        new AppError("Role not found", 404)
      );
    });
  });

  describe("assignPermissionsToRole", () => {
    it("should assign permissions to custom role and return populated role", async () => {
      const roleId = new mongoose.Types.ObjectId();
      const orgId = new mongoose.Types.ObjectId();
      const mockRole = {
        _id: roleId,
        name: "receptionist",
        isSystem: false,
        permissions: [],
        save: jest.fn().mockResolvedValue(true),
      };
      const mockPerms = [{ _id: new mongoose.Types.ObjectId(), name: "customers.view" }];

      jest.spyOn(roleService.roleRepo, "findRoleByIdAndOrg").mockResolvedValue(mockRole);
      jest.spyOn(roleService.permissionRepo, "findManyByNames").mockResolvedValue(mockPerms);

      await roleService.assignPermissionsToRole(roleId.toString(), ["customers.view"], orgId.toString());

      expect(mockRole.permissions).toEqual([mockPerms[0]._id]);
      expect(mockRole.save).toHaveBeenCalled();
    });

    it("should prevent modifying permissions for system roles", async () => {
      const roleId = new mongoose.Types.ObjectId();
      const mockRole = { _id: roleId, name: "owner", isSystem: true };

      jest.spyOn(roleService.roleRepo, "findRoleByIdAndOrg").mockResolvedValue(mockRole);

      await expect(
        roleService.assignPermissionsToRole(roleId.toString(), ["customers.view"], null)
      ).rejects.toThrow(new AppError("Cannot modify permissions for system roles", 400));
    });

    it("should throw 400 if one or more permission names are invalid", async () => {
      const roleId = new mongoose.Types.ObjectId();
      const mockRole = { _id: roleId, name: "receptionist", isSystem: false };

      jest.spyOn(roleService.roleRepo, "findRoleByIdAndOrg").mockResolvedValue(mockRole);
      jest.spyOn(roleService.permissionRepo, "findManyByNames").mockResolvedValue([]);

      await expect(
        roleService.assignPermissionsToRole(roleId.toString(), ["invalid.permission"], null)
      ).rejects.toThrow(new AppError("One or more provided permission names are invalid", 400));
    });
  });

  describe("deleteRole", () => {
    it("should reject deleting system role", async () => {
      const roleId = new mongoose.Types.ObjectId();
      const mockRole = { _id: roleId, name: "manager", isSystem: true };

      jest.spyOn(roleService.roleRepo, "findRoleByIdAndOrg").mockResolvedValue(mockRole);

      await expect(roleService.deleteRole(roleId.toString(), null)).rejects.toThrow(
        new AppError("System roles cannot be deleted", 400)
      );
    });

    it("should reject deleting role when active users are assigned", async () => {
      const roleId = new mongoose.Types.ObjectId();
      const mockRole = { _id: roleId, name: "receptionist", isSystem: false };

      jest.spyOn(roleService.roleRepo, "findRoleByIdAndOrg").mockResolvedValue(mockRole);
      jest.spyOn(User, "countDocuments").mockResolvedValue(2);

      await expect(roleService.deleteRole(roleId.toString(), null)).rejects.toThrow(
        new AppError("Cannot delete role. Active users are currently assigned to this role.", 400)
      );
    });

    it("should delete custom role when no users are assigned", async () => {
      const roleId = new mongoose.Types.ObjectId();
      const orgId = new mongoose.Types.ObjectId();
      const mockRole = { _id: roleId, name: "receptionist", isSystem: false };

      jest.spyOn(roleService.roleRepo, "findRoleByIdAndOrg").mockResolvedValue(mockRole);
      jest.spyOn(User, "countDocuments").mockResolvedValue(0);
      jest.spyOn(roleService.roleRepo.model, "deleteOne").mockResolvedValue({ deletedCount: 1 });

      const result = await roleService.deleteRole(roleId.toString(), orgId.toString());

      expect(roleService.roleRepo.model.deleteOne).toHaveBeenCalledWith({ _id: roleId.toString() });
      expect(result).toEqual(mockRole);
    });
  });
});
