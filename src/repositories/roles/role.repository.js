import { BaseRepository } from "../../shared/repositories/base.repository.js";
import { Role } from "../../models/roles/role.model.js";

export class RoleRepository extends BaseRepository {
  constructor() {
    super(Role);
  }

  async findByName(name) {
    return this.findOne({ name: name.toLowerCase() });
  }
}
