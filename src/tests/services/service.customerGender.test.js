import { describe, expect, it, jest } from "@jest/globals";
import { listServices } from "../../controllers/services/service.controller.js";
import { ServiceService } from "../../services/services/service.service.js";

describe("Service Controller - customerGender listServices Tests", () => {
  const mockOrgId = "60c72b2f9b1d8b2bad123456";

  const setupMockReqRes = (query = {}) => {
    const req = {
      organizationId: mockOrgId,
      query,
      user: { id: "user-123" },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    return { req, res };
  };

  it("should filter for ['male', 'unisex'] when customerGender=male", async () => {
    const { req, res } = setupMockReqRes({ customerGender: "male" });
    const listSpy = jest.spyOn(ServiceService.prototype, "listServices").mockResolvedValue({
      data: [],
      meta: { total: 0 },
    });

    await listServices(req, res);

    expect(listSpy).toHaveBeenCalledWith(
      {
        isDeleted: false,
        $and: [{ gender: { $in: ["male", "unisex"] } }],
      },
      expect.anything(),
      mockOrgId
    );
    listSpy.mockRestore();
  });

  it("should filter for ['female', 'unisex'] when customerGender=female", async () => {
    const { req, res } = setupMockReqRes({ customerGender: "female" });
    const listSpy = jest.spyOn(ServiceService.prototype, "listServices").mockResolvedValue({
      data: [],
      meta: { total: 0 },
    });

    await listServices(req, res);

    expect(listSpy).toHaveBeenCalledWith(
      {
        isDeleted: false,
        $and: [{ gender: { $in: ["female", "unisex"] } }],
      },
      expect.anything(),
      mockOrgId
    );
    listSpy.mockRestore();
  });

  it("should not apply gender restriction when customerGender=other", async () => {
    const { req, res } = setupMockReqRes({ customerGender: "other" });
    const listSpy = jest.spyOn(ServiceService.prototype, "listServices").mockResolvedValue({
      data: [],
      meta: { total: 0 },
    });

    await listServices(req, res);

    expect(listSpy).toHaveBeenCalledWith(
      { isDeleted: false },
      expect.anything(),
      mockOrgId
    );
    listSpy.mockRestore();
  });

  it("should not apply gender restriction when customerGender=prefer_not_to_say", async () => {
    const { req, res } = setupMockReqRes({ customerGender: "prefer_not_to_say" });
    const listSpy = jest.spyOn(ServiceService.prototype, "listServices").mockResolvedValue({
      data: [],
      meta: { total: 0 },
    });

    await listServices(req, res);

    expect(listSpy).toHaveBeenCalledWith(
      { isDeleted: false },
      expect.anything(),
      mockOrgId
    );
    listSpy.mockRestore();
  });

  it("should preserve existing behavior when customerGender is omitted", async () => {
    const { req, res } = setupMockReqRes({});
    const listSpy = jest.spyOn(ServiceService.prototype, "listServices").mockResolvedValue({
      data: [],
      meta: { total: 0 },
    });

    await listServices(req, res);

    expect(listSpy).toHaveBeenCalledWith(
      { isDeleted: false },
      expect.anything(),
      mockOrgId
    );
    listSpy.mockRestore();
  });

  it("should preserve exact gender filter when gender is provided without customerGender", async () => {
    const { req, res } = setupMockReqRes({ gender: "female" });
    const listSpy = jest.spyOn(ServiceService.prototype, "listServices").mockResolvedValue({
      data: [],
      meta: { total: 0 },
    });

    await listServices(req, res);

    expect(listSpy).toHaveBeenCalledWith(
      {
        isDeleted: false,
        $and: [{ gender: "female" }],
      },
      expect.anything(),
      mockOrgId
    );
    listSpy.mockRestore();
  });
});
