import {
  calculateAppointmentPricing,
  reconcileAppointmentPricing,
} from "../../utils/appointmentPricing.js";

describe("Appointment Pricing Contract", () => {
  test("Case 1: Subscription + Membership (APT-20261128-0014)", () => {
    const result = calculateAppointmentPricing({
      services: [
        {
          name: "D-Tan Face (O3+)",
          price: 1000,
          appliedSubscriptionId: "sub-1",
          isRedeemedViaSubscription: true,
        },
        {
          name: "Rica Wax Arms Full",
          price: 700,
          appliedSubscriptionId: "sub-1",
          isRedeemedViaSubscription: true,
        },
        {
          name: "Air Brush HD Party Make-up",
          price: 10000,
          appliedCustomerMembershipId: "mem-1",
          membershipCode: "MEM-20261125-0007-1",
          membershipDiscountPercentage: 20,
          membershipDiscountAmount: 2000,
        },
        {
          name: "Air Brush HD Engagement Make-up",
          price: 15000,
          appliedCustomerMembershipId: "mem-1",
          membershipCode: "MEM-20261125-0007-1",
          membershipDiscountPercentage: 20,
          membershipDiscountAmount: 3000,
        },
      ],
      manualDiscountAmount: 0,
    });

    expect(result.grossSubtotal).toBe(26700);
    expect(result.subscriptionWaivedAmount).toBe(1700);
    expect(result.membershipDiscountAmount).toBe(5000);
    expect(result.manualDiscountAmount).toBe(0);
    expect(result.totalPayable).toBe(20000);
    expect(result.total).toBe(20000);
  });

  test("Case 2: Membership only", () => {
    const result = calculateAppointmentPricing({
      services: [{ price: 10000, membershipDiscountAmount: 2000 }],
    });
    expect(result.grossSubtotal).toBe(10000);
    expect(result.membershipDiscountAmount).toBe(2000);
    expect(result.totalPayable).toBe(8000);
  });

  test("Case 3: Subscription only", () => {
    const result = calculateAppointmentPricing({
      services: [
        { price: 1000, isRedeemedViaSubscription: true },
        { price: 700, appliedSubscriptionId: "sub-1" },
      ],
    });
    expect(result.grossSubtotal).toBe(1700);
    expect(result.subscriptionWaivedAmount).toBe(1700);
    expect(result.totalPayable).toBe(0);
  });

  test("Case 4: Manual concession only", () => {
    const result = calculateAppointmentPricing({
      services: [{ price: 10000 }],
      manualDiscountAmount: 500,
    });
    expect(result.grossSubtotal).toBe(10000);
    expect(result.manualDiscountAmount).toBe(500);
    expect(result.totalPayable).toBe(9500);
  });

  test("Case 5: Membership + Manual concession", () => {
    const result = calculateAppointmentPricing({
      services: [{ price: 10000, membershipDiscountAmount: 2000 }],
      manualDiscountAmount: 500,
    });
    expect(result.grossSubtotal).toBe(10000);
    expect(result.membershipDiscountAmount).toBe(2000);
    expect(result.manualDiscountAmount).toBe(500);
    expect(result.totalPayable).toBe(7500);
  });

  test("Case 6: Subscription + Membership + Manual", () => {
    const result = calculateAppointmentPricing({
      services: [
        { price: 1000, isRedeemedViaSubscription: true },
        { price: 700, isRedeemedViaSubscription: true },
        { price: 10000, membershipDiscountAmount: 2000 },
        { price: 15000, membershipDiscountAmount: 3000 },
      ],
      manualDiscountAmount: 500,
    });
    expect(result.grossSubtotal).toBe(26700);
    expect(result.subscriptionWaivedAmount).toBe(1700);
    expect(result.membershipDiscountAmount).toBe(5000);
    expect(result.manualDiscountAmount).toBe(500);
    expect(result.totalPayable).toBe(19500);
  });

  test("Case 7: No discounts", () => {
    const result = calculateAppointmentPricing({
      services: [{ price: 5000 }],
    });
    expect(result.grossSubtotal).toBe(5000);
    expect(result.totalPayable).toBe(5000);
  });

  test("Case 9: Historical appointment reconciliation (legacy pricing without breakdown)", () => {
    const reconciled = reconcileAppointmentPricing({
      services: [
        { price: 1000, appliedSubscriptionId: "sub-1" },
        { price: 700, appliedSubscriptionId: "sub-1" },
        { price: 10000, membershipDiscountAmount: 2000 },
        { price: 15000, membershipDiscountAmount: 3000 },
      ],
      pricing: {
        subtotal: 26700,
        discount: 5000,
        total: 21700,
      },
    });
    expect(reconciled.grossSubtotal).toBe(26700);
    expect(reconciled.subscriptionWaivedAmount).toBe(1700);
    expect(reconciled.membershipDiscountAmount).toBe(5000);
    expect(reconciled.manualDiscountAmount).toBe(0);
    expect(reconciled.totalPayable).toBe(20000);
  });

  test("Prevents duplicate membership discount on subscription-redeemed services", () => {
    const result = calculateAppointmentPricing({
      services: [
        {
          price: 1000,
          isRedeemedViaSubscription: true,
          membershipDiscountAmount: 200,
        },
      ],
    });
    expect(result.subscriptionWaivedAmount).toBe(1000);
    expect(result.membershipDiscountAmount).toBe(0);
    expect(result.totalPayable).toBe(0);
  });

  test("Decimal precision handling", () => {
    const result = calculateAppointmentPricing({
      services: [{ price: 99.99, membershipDiscountAmount: 19.99 }],
      manualDiscountAmount: 10.01,
    });
    expect(result.grossSubtotal).toBe(99.99);
    expect(result.membershipDiscountAmount).toBe(19.99);
    expect(result.manualDiscountAmount).toBe(10.01);
    expect(result.totalPayable).toBe(69.99);
  });
});
