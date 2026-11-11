import { describe, it, expect, vi } from "vitest";
import {
  buildOrder,
  chooseInvoice,
  customerLocale,
  pushOrder,
  getSignatureKey,
  hasSeparateOrderSchedule,
  isCanceledOrder,
  isTestOrder,
  splitAddress,
  toPythonJson,
  verifySignature,
  withSubscriptionPlans,
} from "../../functions/lib/sendcloud";
import { SETTINGS, hmacHex, jsonResponse, makeOrder } from "../helpers/fixtures";

describe("splitAddress", () => {
  it.each([
    ["417 Montgomery St", { address_line_1: "Montgomery St", house_number: "417" }],
    ["Stationsstraat 12A", { address_line_1: "Stationsstraat", house_number: "12A" }],
    ["417 Main St Apt 5", { address_line_1: "Main St Apt 5", house_number: "417" }],
    ["Baker Street", { address_line_1: "Baker Street" }],
  ])("%s", (input, expected) => {
    expect(splitAddress(input)).toEqual(expected);
  });
});

describe("buildOrder", () => {
  it("maps a Swell order to a Sendcloud v3 order", () => {
    const result: any = buildOrder(makeOrder(), SETTINGS as any, "lb");

    expect(result.order_id).toBe("order_1");
    expect(result.order_number).toBe("100003");
    expect(result.order_details.integration).toEqual({ id: 626842 });
    expect(result.order_details.order_items).toEqual([
      expect.objectContaining({
        item_id: "item_1",
        name: "Mug",
        quantity: 2,
        sku: "MUG",
        unit_price: { value: 19.95, currency: "EUR" },
        total_price: { value: 39.9, currency: "EUR" },
        // 3 lb line total / 2 units, in kg
        measurement: { weight: { value: 0.68, unit: "kg" } },
      }),
    ]);
    expect(result.payment_details.status.code).toBe("paid");
    expect(result.shipping_address).toMatchObject({
      name: "Jan Jansen",
      address_line_1: "Stationsstraat",
      house_number: "12A",
      country_code: "NL",
    });
    expect(result.shipping_details.measurement.weight).toEqual({ value: 1.361, unit: "kg" });
    expect(result.shipping_details.ship_with).toBeUndefined();
  });

  it("uses the default weight when items have no weight", () => {
    const order = makeOrder();
    order.items[0].shipment_weight = 0;
    const result: any = buildOrder(order, { ...SETTINGS, default_weight: 2.5 } as any, "kg");

    expect(result.shipping_details.measurement.weight.value).toBe(2.5);
    expect(result.order_details.order_items[0].measurement).toBeUndefined();
  });

  it("skips non-shippable items and sets the shipping option code", () => {
    const order = makeOrder();
    order.items.push({ id: "item_2", delivery: null, quantity: 1, price: 5, price_total: 5 } as any);
    const result: any = buildOrder(
      order,
      { ...SETTINGS, shipping_option_code: " postnl:standard " } as any,
      "kg",
    );

    expect(result.order_details.order_items).toHaveLength(1);
    expect(result.shipping_details.ship_with).toEqual({
      type: "shipping_option_code",
      properties: { shipping_option_code: "postnl:standard" },
    });
  });
});

describe("isTestOrder", () => {
  it("accepts only a boolean true on the order or its metadata", () => {
    expect(isTestOrder({ test: true })).toBe(true);
    expect(isTestOrder({ metadata: { test: true } })).toBe(true);
    expect(isTestOrder({ test: false, metadata: { test: "true" } })).toBe(false);
    expect(isTestOrder({})).toBe(false);
  });
});

describe("isCanceledOrder", () => {
  it("matches status canceled or the canceled flag", () => {
    expect(isCanceledOrder({ status: "canceled" })).toBe(true);
    expect(isCanceledOrder({ canceled: true })).toBe(true);
    expect(isCanceledOrder({ status: "delivery_pending", canceled: false, paid: true })).toBe(false);
  });
});

describe("hasSeparateOrderSchedule", () => {
  it("is true only when order_schedule is set and differs from billing", () => {
    expect(
      hasSeparateOrderSchedule({
        billing_schedule: { interval: "monthly", interval_count: 1 },
        order_schedule: { interval: "monthly", interval_count: 3 },
      }),
    ).toBe(true);
    expect(
      hasSeparateOrderSchedule({
        billing_schedule: { interval: "yearly", interval_count: 1 },
        order_schedule: null,
      }),
    ).toBe(false);
    expect(
      hasSeparateOrderSchedule({
        billing_schedule: { interval: "monthly", interval_count: 3 },
      }),
    ).toBe(false);
    expect(
      hasSeparateOrderSchedule({
        billing_schedule: { interval: "monthly" },
        order_schedule: { interval: "monthly" },
      }),
    ).toBe(false);
  });
});

function subscriptionItem(overrides: Record<string, any> = {}) {
  return {
    id: "item_1",
    delivery: "shipment",
    quantity: 1,
    shipment_weight: 1,
    price: 35,
    price_total: 35,
    product_id: "prod_1",
    product: { name: "SMPL72", sku: "SMPL72" },
    purchase_option: { type: "standard", subscription: { plan_id: "plan_1" } },
    ...overrides,
  };
}

async function slipName(order: any, plan: any) {
  const get = vi.fn(async (url: string) => (String(url).startsWith("/subscription-plans/") ? plan : null));
  const named = await withSubscriptionPlans({ get } as any, order);
  const result: any = buildOrder(named, SETTINGS as any, "kg");
  return { name: result.order_details.order_items.map((item: any) => item.name), description: result.order_details.order_items.map((item: any) => item.description), get };
}

describe("subscription plan on the packing slip", () => {
  it("uses the Dutch plan description", async () => {
    const order = makeOrder({
      account: { locale: "nl" },
      items: [subscriptionItem({ variant: { name: "Black" } })],
    });
    const { name, description, get } = await slipName(order, {
      description: "Kwartaalabonnement",
      name: "Monthly",
    });

    expect(name).toEqual(["SMPL72 (Kwartaalabonnement)"]);
    expect(description).toEqual(["Black"]);
    expect(get).toHaveBeenCalledWith("/subscription-plans/plan_1", { $locale: "nl" });
  });

  it("uses the English plan description", async () => {
    const order = makeOrder({
      account: { locale: "en" },
      items: [subscriptionItem()],
    });
    const { name, get } = await slipName(order, { description: "Quarterly subscription", name: "Monthly" });

    expect(name).toEqual(["SMPL72 (Quarterly subscription)"]);
    expect(get).toHaveBeenCalledWith("/subscription-plans/plan_1", { $locale: "en" });
  });

  it("keeps the base plan text when German has no translation", async () => {
    const order = makeOrder({
      account: { locale: "de" },
      items: [subscriptionItem()],
    });
    const { name, get } = await slipName(order, { description: "Quarterly subscription", name: "Monthly" });

    expect(name).toEqual(["SMPL72 (Quarterly subscription)"]);
    expect(get).toHaveBeenCalledWith("/subscription-plans/plan_1", { $locale: "de" });
  });

  it("removes soft hyphens and other invisible characters", async () => {
    const order = makeOrder({
      account: { locale: "nl" },
      items: [subscriptionItem({ product: { name: "SMPL\u00AD72\u200B" } })],
    });
    const { name } = await slipName(order, { description: "Kwartaal\u00ADabonnement", name: "Monthly" });

    expect(name).toEqual(["SMPL72 (Kwartaalabonnement)"]);
  });

  it("reads the plan from the bundle parent and prefers it to the English plan name", async () => {
    const order = makeOrder({
      account: { locale: "nl" },
      items: [
        {
          id: "parent",
          delivery: null,
          product: { name: "Family Pack" },
          purchase_option: {
            type: "subscription",
            plan_id: "plan_1",
            plan_name: "Monthly",
            plan_description: "Kwartaalabonnement",
          },
          bundle_items: [{ id: "child" }],
        },
        subscriptionItem({
          id: "child",
          product_id: "bottle",
          product: { name: "SMPL72" },
          purchase_option: undefined,
        }),
      ],
    });
    const { name, get } = await slipName(order, {});

    expect(name).toEqual(["SMPL72 (Kwartaalabonnement)"]);
    expect(get).toHaveBeenCalledWith("/subscription-plans/plan_1", { $locale: "nl" });
  });

  it("does not add a plan to a one-off item", async () => {
    const order = makeOrder({
      account: { locale: "nl" },
      items: [
        subscriptionItem(),
        {
          id: "once",
          delivery: "shipment",
          quantity: 1,
          price: 120,
          price_total: 120,
          product_id: "prod_2",
          product: { name: "SMPL72" },
          purchase_option: { type: "standard" },
        },
      ],
    });
    const { name, get } = await slipName(order, { description: "Kwartaalabonnement" });

    expect(name).toEqual(["SMPL72 (Kwartaalabonnement)", "SMPL72"]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("leaves the name unchanged when the setting is off", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ data: [{ id: 1 }] }));
    const order = makeOrder({
      account: { locale: "nl", email: "jan@example.com" },
      items: [
        subscriptionItem({
          product: { name: "SMPL\u00AD72", sku: "SMPL72" },
          purchase_option: {
            type: "subscription",
            plan_id: "plan_1",
            plan_description: "Kwartaalabonnement",
          },
        }),
      ],
    });
    const get = vi.fn(async (url: string) => {
      if (url === "/settings/shipments") return { weight_unit: "kg" };
      if (url === "/products/prod_1") return { name: "SMPL\u00AD72" };
      return { description: "should-not-be-used" };
    });

    await pushOrder({ get, put: vi.fn().mockResolvedValue({}) } as any, SETTINGS as any, order, (data) => data);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body[0].order_details.order_items[0].name).toBe("SMPL72");
    expect(get.mock.calls.map((call) => call[0])).not.toContain("/subscription-plans/plan_1");
    fetchMock.mockRestore();
  });

  it("uses the account locale when the dashboard order has none", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ data: [{ id: 1 }] }));
    const order = makeOrder({
      account: { id: "acc_1" },
      items: [
        subscriptionItem({
          purchase_option: {
            type: "subscription",
            plan_id: "plan_1",
            plan_name: "Daily",
            plan_description: "Jaarabonnement",
          },
        }),
      ],
    });
    const get = vi.fn(async (url: string) => {
      if (url === "/settings/shipments") return { weight_unit: "kg" };
      if (url === "/accounts/acc_1") return { id: "acc_1", locale: "en" };
      if (url === "/products/prod_1") {
        return {
          name: "SMPL72 (en)",
          purchase_options: {
            subscription: { plans: [{ id: "plan_1", name: "Daily", description: "Yearly subscription" }] },
          },
        };
      }
      throw new Error("Resource not found /subscription-plans/plan_1");
    });

    await pushOrder(
      { get, put: vi.fn().mockResolvedValue({}) } as any,
      { ...SETTINGS, show_subscription_plan: true } as any,
      order,
      (data) => data,
    );

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body[0].order_details.order_items[0].name).toBe("SMPL72 (en) (Yearly subscription)");
    expect(get).toHaveBeenCalledWith("/accounts/acc_1");
    expect(get).toHaveBeenCalledWith("/products/prod_1", { $locale: "en", expand: ["variants"] });
    fetchMock.mockRestore();
  });
});

describe("customerLocale", () => {
  it("uses account.locale, then the order, then the account display locale", () => {
    expect(customerLocale({ account: { locale: "en, nl" }, display_locale: "de" })).toBe("en");
    expect(customerLocale({ display_locale: "de", account: { display_locale: "fr" } })).toBe("de");
    expect(customerLocale({ account: { display_locale: "fr" } })).toBe("fr");
    expect(customerLocale({ account: {} })).toBeUndefined();
  });
});

describe("chooseInvoice", () => {
  const order = { id: "order_2", date_created: "2026-11-06T10:00:00.000Z" };
  const earlier = { id: "order_1", date_created: "2026-08-06T10:00:00.000Z" };

  it("picks the invoice a second before the order", () => {
    const invoice = { id: "inv_1", status: "paid", date_created: "2026-11-06T09:59:59.000Z" };
    expect(chooseInvoice(order, [invoice], [earlier, order])?.id).toBe("inv_1");
  });

  it("ignores an invoice outside 26 hours", () => {
    const invoice = { id: "inv_old", status: "paid", date_created: "2026-10-06T10:00:00.000Z" };
    expect(chooseInvoice(order, [invoice], [earlier, order])).toBeNull();
  });

  it("does not claim an invoice that is closer to an earlier order", () => {
    const invoice = { id: "inv_1", status: "pending", date_created: "2026-11-06T09:00:00.000Z" };
    const neighbor = { id: "order_9", date_created: "2026-11-06T09:00:00.000Z" };
    expect(chooseInvoice(order, [invoice], [order, neighbor])).toBeNull();
    expect(chooseInvoice(neighbor, [invoice], [order, neighbor])?.id).toBe("inv_1");
  });
});

describe("verifySignature", () => {
  it("accepts a valid signature and rejects others", async () => {
    const body = '{"action":"parcel_status_changed"}';
    const signature = await hmacHex(body, "sk");

    expect(await verifySignature(body, signature, "sk")).toBe(true);
    expect(await verifySignature(body, signature, "other")).toBe(false);
    expect(await verifySignature(body, null, "sk")).toBe(false);
    expect(await verifySignature(body, signature, "")).toBe(false);
  });
});

describe("getSignatureKey", () => {
  it("prefers the webhook signature key over the secret key", () => {
    expect(getSignatureKey({ secret_key: "sk" })).toBe("sk");
    expect(getSignatureKey({ secret_key: "sk", webhook_signature_key: " wsk " })).toBe("wsk");
  });
});

describe("toPythonJson", () => {
  it("matches Python json.dumps() output byte for byte", () => {
    const payload = {
      action: "parcel_status_changed",
      timestamp: 1790325265134,
      parcel: {
        id: 5001,
        name: "J\u00fcrgen M\u00fcller",
        weight: "1.000",
        tags: [],
        ok: true,
        none: null,
        url: "https://x.y/a/b",
        emoji: "\u{1F4E6}",
      },
    };
    // reference: python3 -c "import json; print(json.dumps(payload))"
    expect(toPythonJson(payload)).toBe(
      '{"action": "parcel_status_changed", "timestamp": 1790325265134, "parcel": {"id": 5001, ' +
        '"name": "J\\u00fcrgen M\\u00fcller", "weight": "1.000", "tags": [], "ok": true, "none": null, ' +
        '"url": "https://x.y/a/b", "emoji": "\\ud83d\\udce6"}}',
    );
  });
});
