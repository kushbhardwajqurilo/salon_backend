/**
 * Serializes user models into safe UserResponseDTO objects.
 * Removes sensitive authentication secrets like password, passwordHash, refreshToken,
 * OTP, email verification tokens, and password reset tokens.
 *
 * @param {Object} user - Mongoose User document or plain object
 * @returns {Object|null} Safe UserResponseDTO object
 */
export const toUserResponseDTO = (user) => {
  if (!user) return null;

  const rawUser =
    typeof user.toObject === "function"
      ? user.toObject({ depopulate: false })
      : user;

  const dto = {
    id: rawUser._id ? rawUser._id.toString() : rawUser.id,
    username: rawUser.username,
    name: rawUser.name,
    email: rawUser.email,
    phone: rawUser.phone,
    role: rawUser.role,
    organizationId: rawUser.organizationId
      ? rawUser.organizationId.toString()
      : rawUser.organizationId,
    hasOrgWideAccess: rawUser.hasOrgWideAccess || false,
    branchAccess: (rawUser.branchAccess || []).map((b) => ({
      branchId: b.branchId ? b.branchId.toString() : b.branchId,
      branchName: b.branchName,
      isActive: b.isActive,
    })),
    isVerified: rawUser.isVerified || false,
    isFirstLogin: rawUser.isFirstLogin || false,
    status: rawUser.status,
    createdAt: rawUser.createdAt,
    updatedAt: rawUser.updatedAt,
  };

  // Safe nested role serialization
  if (rawUser.role && typeof rawUser.role === "object") {
    dto.role = {
      id: rawUser.role._id ? rawUser.role._id.toString() : rawUser.role.id,
      name: rawUser.role.name,
      description: rawUser.role.description,
    };
  }

  return dto;
};
