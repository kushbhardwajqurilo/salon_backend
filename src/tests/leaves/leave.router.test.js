import { describe, expect, it, jest } from "@jest/globals";

const authenticate = Object.assign(
  (req, res, next) => next(),
  { _tag: "authenticate" }
);
const requireBranchScope = Object.assign(
  (req, res, next) => next(),
  { _tag: "requireBranchScope" }
);
const requireOnBehalfManage = Object.assign(
  (req, res, next) => next(),
  { _tag: "requireOnBehalfManage" }
);

const authorize = jest.fn((permission) =>
  Object.assign((req, res, next) => next(), { _tag: `authorize:${permission}` })
);
const validate = jest.fn(() =>
  Object.assign((req, res, next) => next(), { _tag: "validate" })
);

const createLeave = Object.assign((req, res) => res.end(), { _tag: "createLeave" });
const listLeaves = Object.assign((req, res) => res.end(), { _tag: "listLeaves" });
const getLeaveById = Object.assign((req, res) => res.end(), { _tag: "getLeaveById" });
const updateLeave = Object.assign((req, res) => res.end(), { _tag: "updateLeave" });
const approveLeave = Object.assign((req, res) => res.end(), { _tag: "approveLeave" });
const rejectLeave = Object.assign((req, res) => res.end(), { _tag: "rejectLeave" });
const cancelLeave = Object.assign((req, res) => res.end(), { _tag: "cancelLeave" });

jest.unstable_mockModule("../../middleware/auth.js", () => ({ authenticate }));
jest.unstable_mockModule("../../middleware/branchScope.js", () => ({ requireBranchScope }));
jest.unstable_mockModule("../../middleware/rbac.js", () => ({ authorize }));
jest.unstable_mockModule("../../middleware/validate.js", () => ({ validate }));
jest.unstable_mockModule("../../middleware/leaveScope.js", () => ({ requireOnBehalfManage }));
jest.unstable_mockModule("../../controllers/leaves/leave.controller.js", () => ({
  createLeave,
  listLeaves,
  getLeaveById,
  updateLeave,
  approveLeave,
  rejectLeave,
  cancelLeave,
}));

const router = (await import("../../routers/leaves/leave.router.js")).default;

const getRouteLayer = (path, method) =>
  router.stack.find(
    (layer) =>
      layer.route &&
      layer.route.path === path &&
      layer.route.methods[method]
  );

const routeTags = (layer) => layer.route.stack.map((stackLayer) => stackLayer.handle._tag);

describe("Leave router registration and middleware ordering", () => {
  it("registers the FINAL route table", () => {
    const registered = router.stack
      .filter((layer) => layer.route)
      .map((layer) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods).sort(),
      }));

    expect(registered).toEqual(
      expect.arrayContaining([
        { path: "/", methods: ["post"] },
        { path: "/", methods: ["get"] },
        { path: "/:id", methods: ["get"] },
        { path: "/:id", methods: ["put"] },
        { path: "/:id/approve", methods: ["post"] },
        { path: "/:id/reject", methods: ["post"] },
        { path: "/:id/cancel", methods: ["post"] },
      ])
    );
  });

  it("uses the correct middleware order for create", () => {
    const layer = getRouteLayer("/", "post");

    expect(routeTags(layer)).toEqual([
      "authenticate",
      "requireBranchScope",
      "authorize:employees.leaves.view",
      "validate",
      "requireOnBehalfManage",
      "createLeave",
    ]);
  });

  it("uses the correct middleware order for list/detail", () => {
    expect(routeTags(getRouteLayer("/", "get"))).toEqual([
      "authenticate",
      "requireBranchScope",
      "authorize:employees.leaves.view",
      "validate",
      "listLeaves",
    ]);

    expect(routeTags(getRouteLayer("/:id", "get"))).toEqual([
      "authenticate",
      "requireBranchScope",
      "authorize:employees.leaves.view",
      "validate",
      "getLeaveById",
    ]);
  });

  it("uses view permission for update/cancel and manage for approval routes", () => {
    expect(routeTags(getRouteLayer("/:id", "put"))).toEqual([
      "authenticate",
      "requireBranchScope",
      "authorize:employees.leaves.view",
      "validate",
      "updateLeave",
    ]);
    expect(routeTags(getRouteLayer("/:id/approve", "post"))).toEqual([
      "authenticate",
      "requireBranchScope",
      "authorize:employees.leaves.manage",
      "validate",
      "approveLeave",
    ]);
    expect(routeTags(getRouteLayer("/:id/reject", "post"))).toEqual([
      "authenticate",
      "requireBranchScope",
      "authorize:employees.leaves.manage",
      "validate",
      "rejectLeave",
    ]);
    expect(routeTags(getRouteLayer("/:id/cancel", "post"))).toEqual([
      "authenticate",
      "requireBranchScope",
      "authorize:employees.leaves.view",
      "validate",
      "cancelLeave",
    ]);
  });

  it("executes validation before requireOnBehalfManage on create", () => {
    const layer = getRouteLayer("/", "post");
    const order = routeTags(layer);

    expect(order.indexOf("validate")).toBeLessThan(order.indexOf("requireOnBehalfManage"));
  });

  it("does not invent new permission names", () => {
    expect(authorize.mock.calls.map(([permission]) => permission)).toEqual([
      "employees.leaves.view",
      "employees.leaves.view",
      "employees.leaves.view",
      "employees.leaves.view",
      "employees.leaves.manage",
      "employees.leaves.manage",
      "employees.leaves.view",
    ]);
  });
});
