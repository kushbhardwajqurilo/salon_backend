import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { Role } from "../../models/roles/role.model.js";

export class RoleRepository extends BaseRepository {
  constructor() {
    super(Role);
  }

  async findByName(name, organizationId = null) {
    const filter = { name: name.toLowerCase() };
    if (organizationId) {
      filter.$or = [{ isSystem: true }, { organizationId }];
    }
    return this.findOne(filter);
  }

  async findByNameInOrg(name, organizationId) {
    return this.findOne({
      name: name.toLowerCase(),
      $or: [{ isSystem: true }, { organizationId }],
    });
  }

  async findRolesForOrganization(organizationId, options = {}) {
    const filter = {
      $or: [{ isSystem: true }, { organizationId }],
    };
    return this.find(filter, options, ["permissions"]);
  }

  async findRoleByIdAndOrg(roleId, organizationId) {
    const filter = {
      _id: roleId,
    };
    if (organizationId) {
      filter.$or = [{ isSystem: true }, { organizationId }];
    }
    return this.findOne(filter, ["permissions"]);
  }
}
