import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { Permission } from "../../models/permissions/permission.model.js";

export class PermissionRepository extends BaseRepository {
  constructor() {
    super(Permission);
  }

  async findByName(name) {
    return this.findOne({ name: name.toLowerCase() });
  }

  async findManyByNames(names) {
    return this.model.find({ name: { $in: names.map((n) => n.toLowerCase()) } });
  }
}
