import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../functions/order-events";
import { sendcloudSyncHash } from "../../functions/lib/shipments";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, jsonResponse, makeOrder, routeGet } from "../helpers/fixtures";

function setup({
  settings = SETTINGS as Record<string, any>,
  order = makeOrder() as Record<string, any> | null,
  eventType = "order.paid",
} = {}) {
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    data: { id: "order_1", $event: { type: eventType } } as any,
    appId: "sendcloud",
    swell: {
      settings: vi.fn().mockResolvedValue({ sendcloud: settings }),
      get: routeGet({ "/orders/order_1": order, "/settings/shipments": { weight_unit: "lb" } }),
      put,
    },
  });
  return { req, put };
}

const logs: string[] = [];

describe("order-events", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  function postedOrder() {
    return JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))[0];
  }

  beforeEach(() => {
    logs.length = 0;
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a paid order to Sendcloud and stores the Sendcloud order id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 669, order_id: "order_1", order_number: "100003" }] }),
    );
    const { req, put } = setup();

    await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://panel.sendcloud.sc/api/v3/orders");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("pk:sk")}`);
    const body = JSON.parse(init.body as string);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ order_id: "order_1", order_number: "100003" });

    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: {
        sendcloud: {
          sendcloud_order_id: 669,
          sendcloud_status: "Sent to Sendcloud",
          sendcloud_error: null,
          sendcloud_sync_hash: await sendcloudSyncHash(makeOrder()),
        },
      },
    });
  });

  it("does nothing when the app is disabled", async () => {
    const { req, put } = setup({ settings: { ...SETTINGS, enabled: false } });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("does nothing without credentials or integration id", async () => {
    const { req, put } = setup({ settings: { ...SETTINGS, integration_id: undefined } });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("ignores the event that doesn't match the sync_on setting", async () => {
    const { req } = setup({ settings: { ...SETTINGS, sync_on: "submitted" }, eventType: "order.paid" });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends on order.submitted when sync_on is submitted", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 1 }] }));
    const { req } = setup({ settings: { ...SETTINGS, sync_on: "submitted" }, eventType: "order.submitted" });
    await handler(req);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips orders that were already sent", async () => {
    const { req } = setup({ order: makeOrder({ $app: { sendcloud: { sendcloud_order_id: 669 } } }) });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips orders without shippable items", async () => {
    const order = makeOrder();
    order.items[0].delivery = null;
    const { req } = setup({ order });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves an error when the shipping address is missing", async () => {
    const { req, put } = setup({ order: makeOrder({ shipping: {} }) });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: { sendcloud: { sendcloud_error: "Missing shipping address" } },
    });
  });

  it("saves Sendcloud 4xx errors without retrying", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ errors: [{ detail: "Invalid country", source: { pointer: "/0/shipping_address" } }] }, 400),
    );
    const { req, put } = setup();

    await expect(handler(req)).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: { sendcloud: { sendcloud_error: "Sendcloud 400: /0/shipping_address Invalid country" } },
    });
  });

  it("rethrows Sendcloud 5xx errors so the platform retries", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "down" }, 503));
    const { req, put } = setup();

    await expect(handler(req)).rejects.toThrow("Sendcloud 503: down");
    expect(put).toHaveBeenCalled();
  });

  it("deletes the Sendcloud order when the Swell order is canceled", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { req, put } = setup({
      eventType: "order.canceled",
      order: makeOrder({ $app: { sendcloud: { sendcloud_order_id: 669 } } }),
    });

    await handler(req);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://panel.sendcloud.sc/api/v3/orders/669");
    expect(init.method).toBe("DELETE");
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: { sendcloud: { sendcloud_status: "Removed from Sendcloud", sendcloud_error: null } },
    });
  });

  it("keeps the parcel status when a canceled order already has a parcel", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { req, put } = setup({
      eventType: "order.canceled",
      order: makeOrder({ $app: { sendcloud: { sendcloud_order_id: 669, sendcloud_parcel_id: 5001 } } }),
    });

    await handler(req);

    expect(put).toHaveBeenCalledWith("/orders/order_1", { $app: { sendcloud: { sendcloud_error: null } } });
  });

  it("shows a refused removal on the order without retrying", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Forbidden" }, 403));
    const { req, put } = setup({
      eventType: "order.canceled",
      order: makeOrder({ $app: { sendcloud: { sendcloud_order_id: 669 } } }),
    });

    await expect(handler(req)).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: { sendcloud: { sendcloud_error: "Couldn't remove the canceled order from Sendcloud: Sendcloud 403: Forbidden" } },
    });
  });

  it("saves the error and retries when Sendcloud is down during removal", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "down" }, 503));
    const { req, put } = setup({
      eventType: "order.canceled",
      order: makeOrder({ $app: { sendcloud: { sendcloud_order_id: 669 } } }),
    });

    await expect(handler(req)).rejects.toThrow("Sendcloud 503: down");
    expect(put.mock.calls[0][1].$app.sendcloud.sendcloud_error).toContain("Sendcloud 503: down");
  });

  it("ignores 404 when deleting an order that is already gone", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Not found" }, 404));
    const { req } = setup({
      eventType: "order.canceled",
      order: makeOrder({ $app: { sendcloud: { sendcloud_order_id: 669 } } }),
    });

    await expect(handler(req)).resolves.toBeUndefined();
  });

  it("still sends a test order and a subscription renewal when the new settings are off", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 669 }] }));
    const order = makeOrder({
      test: true,
      subscription_id: "sub_1",
      metadata: { test: true },
    });
    const get = vi.fn(routeGet({ "/orders/order_1": order, "/settings/shipments": { weight_unit: "lb" } }));
    const { req } = setup({ order });
    req.swell.get = get;

    await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(get.mock.calls.some(([url]) => String(url).includes("subscription"))).toBe(false);
  });

  it("skips a test order only when skip_test_orders is on", async () => {
    const { req } = setup({
      settings: { ...SETTINGS, skip_test_orders: true },
      order: makeOrder({ metadata: { test: true } }),
    });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs).toContain("Sendcloud: order 100003 is a test order, skipping");
  });

  it("does not send a canceled order", async () => {
    const { req } = setup({
      order: makeOrder({ status: "canceled", canceled: true }),
    });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs).toContain("Sendcloud: order 100003 is canceled, skipping");
  });

  it("does not treat a string test flag as a test order", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 1 }] }));
    const { req } = setup({
      settings: { ...SETTINGS, skip_test_orders: true },
      order: makeOrder({ test: "true", metadata: { test: "true" } }),
    });
    await handler(req);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends product and variant names in the customer's locale", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 1 }] }));
    const order = makeOrder({
      account: { email: "jan@example.com", locale: "en" },
    });
    const item = order.items[0] as Record<string, any>;
    item.variant_id = "var_1";
    item.variant = { name: "Rood" };
    item.product = { name: "Mok", sku: "MUG" };
    const get = vi.fn(async (url: string) => {
      if (url === "/orders/order_1") return order;
      if (url === "/settings/shipments") return { weight_unit: "kg" };
      if (url === "/products/prod_1") return { name: "Mug", variants: [{ id: "var_1", name: "Red" }] };
      return null;
    });
    const { req } = setup({ order });
    req.swell.get = get;

    await handler(req);

    expect(get).toHaveBeenCalledWith("/products/prod_1", { $locale: "en", expand: ["variants"] });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body[0].order_details.order_items[0]).toMatchObject({ name: "Mug", description: "Red" });
  });

  it("holds a renewal on a separate schedule until its invoice is paid", async () => {
    const order = renewalOrder();
    const { req, put } = setup({
      settings: { ...SETTINGS, hold_separate_order_schedule: true },
      order,
    });
    req.swell.get = renewalGet(order, {
      invoices: [{ id: "inv_1", status: "pending", date_created: "2026-11-06T10:29:50.000Z" }],
    });

    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: {
        sendcloud: {
          sendcloud_status: "Waiting for invoice payment",
          sendcloud_invoice_id: "inv_1",
          sendcloud_error: null,
        },
      },
    });
  });

  it("sends the renewal when that invoice is paid", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 670 }] }));
    const order = renewalOrder();
    const { req, put } = setup({
      settings: { ...SETTINGS, hold_separate_order_schedule: true },
      order,
    });
    req.swell.get = renewalGet(order, {
      invoices: [{ id: "inv_1", status: "paid", date_created: "2026-11-06T10:29:50.000Z" }],
    });

    await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: {
        sendcloud: {
          sendcloud_order_id: 670,
          sendcloud_status: "Sent to Sendcloud",
          sendcloud_error: null,
          sendcloud_invoice_id: "inv_1",
          sendcloud_sync_hash: await sendcloudSyncHash(order),
        },
      },
    });
  });

  it("keeps waiting when the invoice is void, and does not claim one already linked", async () => {
    const order = renewalOrder();
    const { req, put } = setup({
      settings: { ...SETTINGS, hold_separate_order_schedule: true },
      order,
    });
    req.swell.get = renewalGet(order, {
      invoices: [{ id: "inv_1", status: "void", date_created: "2026-11-06T11:21:00.000Z" }],
      holders: [{ id: "order_9", date_created: "2026-08-06T10:00:00.000Z" }],
    });

    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: {
        sendcloud: {
          sendcloud_status: "Waiting for invoice payment",
          sendcloud_error: null,
        },
      },
    });
  });

  it("holds the first zero-total order of a dashboard subscription", async () => {
    const order = renewalOrder({ grand_total: 0, paid: true });
    const { req, put } = setup({
      settings: { ...SETTINGS, hold_separate_order_schedule: true },
      order,
    });
    req.swell.get = renewalGet(order, {
      invoices: [{ id: "inv_1", status: "pending", date_created: "2026-11-06T10:29:50.000Z" }],
    });

    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: {
        sendcloud: {
          sendcloud_status: "Waiting for invoice payment",
          sendcloud_invoice_id: "inv_1",
          sendcloud_error: null,
        },
      },
    });
  });

  it("holds a renewal when the checkout order is a different order", async () => {
    const order = renewalOrder({ grand_total: 0, paid: true });
    const { req, put } = setup({
      settings: { ...SETTINGS, hold_separate_order_schedule: true },
      order,
    });
    req.swell.get = renewalGet(order, {
      subscription: { ...SEPARATE, order_id: "checkout_1" },
      invoices: [{ id: "inv_1", status: "pending", date_created: "2026-11-06T10:29:50.000Z" }],
    });

    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith(
      "/orders/order_1",
      expect.objectContaining({
        $app: { sendcloud: expect.objectContaining({ sendcloud_invoice_id: "inv_1" }) },
      }),
    );
  });

  it("sends the order that created the subscription, and a yearly renewal, without waiting", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ data: [{ id: 1 }] }));
    const checkout = renewalOrder({ grand_total: 35, subscription_id: "sub_1" });
    const { req } = setup({
      settings: { ...SETTINGS, hold_separate_order_schedule: true },
      order: checkout,
    });
    req.swell.get = renewalGet(checkout, {
      subscription: { ...SEPARATE, order_id: "order_1" },
      invoices: [{ id: "inv_1", status: "pending", date_created: checkout.date_created }],
    });
    await handler(req);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    const yearly = renewalOrder({ grand_total: 360 });
    const second = setup({
      settings: { ...SETTINGS, hold_separate_order_schedule: true },
      order: yearly,
    });
    second.req.swell.get = vi.fn(async (url: string) => {
      if (url === "/orders/order_1") return yearly;
      if (url === "/subscriptions/sub_1") return { billing_schedule: { interval: "yearly", interval_count: 1 }, order_id: "order_1" };
      if (url === "/settings/shipments") return { weight_unit: "kg" };
      return null;
    });
    await handler(second.req);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("links a renewal when its invoice is created later, and sends it once that invoice is paid", async () => {
    const pending = renewalOrder();
    const created = createMockRequest({
      data: { id: "inv_1", $event: { type: "invoice.created" } } as any,
      appId: "sendcloud",
      swell: {
        settings: vi.fn().mockResolvedValue({ sendcloud: { ...SETTINGS, hold_separate_order_schedule: true } }),
        get: renewalGet(pending, {
          invoices: [{ id: "inv_1", status: "pending", subscription_id: "sub_1", date_created: pending.date_created }],
        }),
        put: vi.fn().mockResolvedValue({}),
      },
    });
    (created.swell.get as any).mockImplementation(async (url: string, query?: any) => {
      if (url === "/invoices/inv_1") {
        return { id: "inv_1", status: "pending", subscription_id: "sub_1", date_created: pending.date_created };
      }
      return renewalGet(pending)(url, query);
    });

    await handler(created);

    expect(created.swell.put).toHaveBeenCalledWith("/orders/order_1", {
      $app: {
        sendcloud: {
          sendcloud_status: "Waiting for invoice payment",
          sendcloud_invoice_id: "inv_1",
          sendcloud_error: null,
        },
      },
    });

    const order = renewalOrder({
      $app: { sendcloud: { sendcloud_status: "Waiting for invoice payment", sendcloud_invoice_id: "inv_1" } },
    });
    const put = vi.fn().mockResolvedValue({});
    const paid = createMockRequest({
      data: { id: "inv_1", $event: { type: "invoice.payment_succeeded" } } as any,
      appId: "sendcloud",
      swell: {
        settings: vi.fn().mockResolvedValue({ sendcloud: { ...SETTINGS, hold_separate_order_schedule: true } }),
        get: vi.fn(async (url: string, query?: any) => {
          if (url === "/invoices/inv_1") {
            return { id: "inv_1", status: "paid", subscription_id: "sub_1", date_created: order.date_created };
          }
          if (query?.where?.["$app.sendcloud.sendcloud_invoice_id"]) return { results: [order] };
          if (url === "/settings/shipments") return { weight_unit: "kg" };
          return null;
        }),
        put,
      },
    });
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 671 }] }));

    await handler(paid);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      "/orders/order_1",
      expect.objectContaining({
        $app: { sendcloud: expect.objectContaining({ sendcloud_order_id: 671, sendcloud_invoice_id: "inv_1" }) },
      }),
    );
  });

  it("does not send a renewal when its invoice is paid after the order was canceled", async () => {
    const order = renewalOrder({
      status: "canceled",
      canceled: true,
      paid: false,
      grand_total: 0,
      $app: { sendcloud: { sendcloud_status: "Waiting for invoice payment", sendcloud_invoice_id: "inv_1" } },
    });
    const put = vi.fn().mockResolvedValue({});
    const req = createMockRequest({
      data: { id: "inv_1", $event: { type: "invoice.payment_succeeded" } } as any,
      appId: "sendcloud",
      swell: {
        settings: vi.fn().mockResolvedValue({ sendcloud: { ...SETTINGS, hold_separate_order_schedule: true } }),
        get: vi.fn(async (url: string, query?: any) => {
          if (url === "/invoices/inv_1") {
            return { id: "inv_1", status: "paid", subscription_id: "sub_1", date_created: order.date_created };
          }
          if (query?.where?.["$app.sendcloud.sendcloud_invoice_id"]) return { results: [order] };
          return null;
        }),
        put,
      },
    });

    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(logs).toContain("Sendcloud: order 100996 is canceled, skipping");
  });

  it("holds a paid shipment while the subscription is past due", async () => {
    const order = renewalOrder();
    const { req, put } = setup({
      settings: { ...SETTINGS, hold_separate_order_schedule: true },
      order,
    });
    req.swell.get = renewalGet(order, {
      subscription: { ...SEPARATE, status: "pastdue" },
      invoices: [
        { id: "inv_old", status: "unpaid", date_created: "2026-08-06T10:00:00.000Z" },
        { id: "inv_1", status: "paid", date_created: "2026-11-06T10:29:50.000Z" },
      ],
    });

    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(req.swell.get).toHaveBeenCalledWith("/invoices", {
      where: {
        subscription_id: "sub_1",
        status: { $in: ["pending", "unpaid"] },
      },
    });
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: {
        sendcloud: {
          sendcloud_status: "Waiting for overdue payments",
          sendcloud_invoice_id: "inv_1",
          sendcloud_error: null,
        },
      },
    });
  });

  it("sends waiting shipments when an older invoice is paid and the subscription is active", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 672 }] }));
    const order = renewalOrder({
      $app: { sendcloud: { sendcloud_status: "Waiting for overdue payments", sendcloud_invoice_id: "inv_new" } },
    });
    const invoices = [
      { id: "inv_old", status: "paid", subscription_id: "sub_1", date_created: "2026-08-06T10:00:00.000Z" },
      { id: "inv_new", status: "paid", subscription_id: "sub_1", date_created: order.date_created },
    ];
    const put = vi.fn().mockResolvedValue({});
    const req = createMockRequest({
      data: { id: "inv_old", $event: { type: "invoice.payment_succeeded" } } as any,
      appId: "sendcloud",
      swell: {
        settings: vi.fn().mockResolvedValue({ sendcloud: { ...SETTINGS, hold_separate_order_schedule: true } }),
        get: vi.fn(async (url: string) => {
          if (url === "/invoices/inv_old") return invoices[0];
          if (url === "/subscriptions/sub_1") return { ...SEPARATE, status: "active" };
          if (url === "/invoices") return { results: invoices };
          if (url === "/orders") return { results: [order] };
          if (url === "/settings/shipments") return { weight_unit: "kg" };
          return null;
        }),
        put,
      },
    });

    await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      "/orders/order_1",
      expect.objectContaining({
        $app: { sendcloud: expect.objectContaining({ sendcloud_order_id: 672, sendcloud_invoice_id: "inv_new" }) },
      }),
    );
  });

  it("sends waiting shipments when the subscription update clears the arrears", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 673 }] }));
    const order = renewalOrder({
      $app: { sendcloud: { sendcloud_status: "Waiting for overdue payments", sendcloud_invoice_id: "inv_new" } },
    });
    const put = vi.fn().mockResolvedValue({});
    const req = createMockRequest({
      data: { id: "sub_1", $event: { type: "subscription.updated" } } as any,
      appId: "sendcloud",
      swell: {
        settings: vi.fn().mockResolvedValue({ sendcloud: { ...SETTINGS, hold_separate_order_schedule: true } }),
        get: vi.fn(async (url: string) => {
          if (url === "/subscriptions/sub_1") return { ...SEPARATE, status: "active" };
          if (url === "/invoices") {
            return {
              results: [
                { id: "inv_old", status: "paid", date_created: "2026-08-06T10:00:00.000Z" },
                { id: "inv_new", status: "paid", date_created: order.date_created },
              ],
            };
          }
          if (url === "/orders") return { results: [order] };
          if (url === "/settings/shipments") return { weight_unit: "kg" };
          return null;
        }),
        put,
      },
    });

    await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      "/orders/order_1",
      expect.objectContaining({
        $app: { sendcloud: expect.objectContaining({ sendcloud_order_id: 673, sendcloud_invoice_id: "inv_new" }) },
      }),
    );
  });

  it("sends the shipment when the only earlier invoice is void", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 674 }] }));
    const order = renewalOrder();
    const { req, put } = setup({
      settings: { ...SETTINGS, hold_separate_order_schedule: true },
      order,
    });
    req.swell.get = renewalGet(order, {
      subscription: { ...SEPARATE, status: "active" },
      invoices: [
        { id: "inv_old", status: "void", void: true, paid: true, date_created: "2026-08-06T10:00:00.000Z" },
        { id: "inv_1", status: "paid", date_created: "2026-11-06T10:29:50.000Z" },
      ],
    });

    await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      "/orders/order_1",
      expect.objectContaining({
        $app: { sendcloud: expect.objectContaining({ sendcloud_order_id: 674, sendcloud_invoice_id: "inv_1" }) },
      }),
    );
  });

  it("does not release an unpaid order when its invoice is paid", async () => {
    const order = renewalOrder({
      paid: false,
      grand_total: 15,
      $app: { sendcloud: { sendcloud_status: "Waiting for invoice payment", sendcloud_invoice_id: "inv_1" } },
    });
    const put = vi.fn().mockResolvedValue({});
    const req = createMockRequest({
      data: { id: "inv_1", $event: { type: "invoice.payment_succeeded" } } as any,
      appId: "sendcloud",
      swell: {
        settings: vi.fn().mockResolvedValue({ sendcloud: { ...SETTINGS, hold_separate_order_schedule: true } }),
        get: vi.fn(async (url: string) => {
          if (url === "/invoices/inv_1") {
            return { id: "inv_1", status: "paid", subscription_id: "sub_1", date_created: order.date_created };
          }
          if (url === "/subscriptions/sub_1") return { ...SEPARATE, status: "active" };
          if (url === "/invoices") return { results: [{ id: "inv_1", status: "paid", date_created: order.date_created }] };
          if (url === "/orders") return { results: [order] };
          return null;
        }),
        put,
      },
    });

    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(logs).toContain("Sendcloud: order 100996 is not paid, skipping");
  });

  it("does not release an unpaid order when the subscription is updated", async () => {
    const order = renewalOrder({
      paid: false,
      grand_total: 15,
      $app: { sendcloud: { sendcloud_status: "Waiting for invoice payment", sendcloud_invoice_id: "inv_1" } },
    });
    const put = vi.fn().mockResolvedValue({});
    const req = createMockRequest({
      data: { id: "sub_1", $event: { type: "subscription.updated" } } as any,
      appId: "sendcloud",
      swell: {
        settings: vi.fn().mockResolvedValue({ sendcloud: { ...SETTINGS, hold_separate_order_schedule: true } }),
        get: vi.fn(async (url: string) => {
          if (url === "/subscriptions/sub_1") return { ...SEPARATE, status: "active" };
          if (url === "/invoices") return { results: [{ id: "inv_1", status: "paid", date_created: order.date_created }] };
          if (url === "/orders") return { results: [order] };
          return null;
        }),
        put,
      },
    });

    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(logs).toContain("Sendcloud: order 100996 is not paid, skipping");
  });

  it("does not send a shipment when the subscription is canceled", async () => {
    const paid = renewalOrder();
    const { req, put } = setup({
      settings: { ...SETTINGS, hold_separate_order_schedule: true },
      order: paid,
    });
    req.swell.get = renewalGet(paid, {
      subscription: { ...SEPARATE, status: "canceled", canceled: true },
      invoices: [{ id: "inv_1", status: "paid", date_created: paid.date_created }],
    });

    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: {
        sendcloud: {
          sendcloud_status: "Not sent: subscription canceled",
          sendcloud_error: null,
        },
      },
    });
    expect(logs).toContain("Sendcloud: order 100996 not sent, subscription is canceled");

    fetchMock.mockClear();
    logs.length = 0;
    const waiting = renewalOrder({
      $app: { sendcloud: { sendcloud_status: "Waiting for overdue payments", sendcloud_invoice_id: "inv_new" } },
    });
    const updated = createMockRequest({
      data: { id: "sub_1", $event: { type: "subscription.updated" } } as any,
      appId: "sendcloud",
      swell: {
        settings: vi.fn().mockResolvedValue({ sendcloud: { ...SETTINGS, hold_separate_order_schedule: true } }),
        get: vi.fn(async (url: string) => {
          if (url === "/subscriptions/sub_1") return { ...SEPARATE, status: "canceled", canceled: true };
          if (url === "/invoices") {
            return { results: [{ id: "inv_new", status: "paid", date_created: waiting.date_created }] };
          }
          if (url === "/orders") return { results: [waiting] };
          return null;
        }),
        put: vi.fn().mockResolvedValue({}),
      },
    });

    await handler(updated);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(updated.swell.put).toHaveBeenCalledWith("/orders/order_1", {
      $app: {
        sendcloud: {
          sendcloud_status: "Not sent: subscription canceled",
          sendcloud_error: null,
        },
      },
    });
    expect(logs).toContain("Sendcloud: order 100996 not sent, subscription is canceled");
  });

  it("removes a fully shipped order from Sendcloud when the shipment is not this app's", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { req, put } = shipmentRequest(finishedOrder());

    await handler(req);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://panel.sendcloud.sc/api/v3/orders/669");
    expect(init.method).toBe("DELETE");
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: {
        sendcloud: {
          sendcloud_status: "Removed from Sendcloud: shipped outside Sendcloud",
          sendcloud_error: null,
        },
      },
    });
    expect(put.mock.calls[0][1].$app.sendcloud.sendcloud_order_id).toBeUndefined();
  });

  it("updates the Sendcloud order to the quantity still to ship", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 669 }] }));
    const item = makeOrder().items[0];
    const { req, put } = shipmentRequest(
      makeOrder({
        $app: { sendcloud: { sendcloud_order_id: 669, sendcloud_order_suffix: 2 } },
        items: [{ ...item, quantity: 2, quantity_shipment_deliverable: 1, price_total: 39.9 }],
      }),
    );

    await handler(req);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://panel.sendcloud.sc/api/v3/orders");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(String(init.body))[0];
    expect(sent.order_id).toBe("order_1-2");
    expect(sent.order_details.order_items).toEqual([
      expect.objectContaining({ item_id: "item_1", quantity: 1, total_price: { value: 19.95, currency: "EUR" } }),
    ]);
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: {
        sendcloud: {
          sendcloud_sync_hash: await sendcloudSyncHash(
            makeOrder({
              $app: { sendcloud: { sendcloud_order_id: 669, sendcloud_order_suffix: 2 } },
              items: [{ ...item, quantity: 2, quantity_shipment_deliverable: 1, price_total: 39.9 }],
            }),
          ),
          sendcloud_error: null,
        },
      },
    });
  });

  it("updates a bundle to the component quantity still to ship", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 669 }] }));
    const order = makeOrder({
      $app: { sendcloud: { sendcloud_order_id: 669 } },
      items: [
        {
          id: "pack",
          delivery: "shipment",
          quantity: 1,
          price_total: 20,
          product_id: "bundle_prod",
          product: { name: "Bundle" },
          bundle_items: [
            {
              id: "pouch",
              product_id: "pouch_prod",
              quantity: 4,
              quantity_total: 4,
              quantity_shipment_deliverable: 2,
              price: 5,
              product: { name: "Pouch", sku: "POUCH" },
            },
            {
              id: "card",
              product_id: "card_prod",
              quantity: 1,
              quantity_total: 1,
              quantity_shipment_deliverable: 0,
              product: { name: "Card" },
            },
          ],
        },
      ],
    });
    const { req, put } = shipmentRequest(order, {}, { ...SYNC, show_bundle_components: true });

    await handler(req);

    const sent = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))[0];
    expect(sent.order_id).toBe("order_1");
    expect(sent.order_details.order_items).toEqual([
      expect.objectContaining({ item_id: "pouch", quantity: 2, name: "Bundle → Pouch" }),
    ]);
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: { sendcloud: { sendcloud_sync_hash: await sendcloudSyncHash(order), sendcloud_error: null } },
    });
  });

  it("leaves the order when a parcel already exists", async () => {
    const item = makeOrder().items[0];
    const { req, put } = shipmentRequest(
      makeOrder({
        $app: { sendcloud: { sendcloud_order_id: 669, sendcloud_parcel_id: 5001 } },
        items: [{ ...item, quantity: 4, quantity_shipment_deliverable: 2 }],
      }),
    );

    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: {
        sendcloud: {
          sendcloud_note: "Order changed after the label was created; update the parcel in Sendcloud.",
        },
      },
    });
  });

  it("leaves the order when it was never sent to Sendcloud", async () => {
    const { req, put } = shipmentRequest(finishedOrder({ $app: undefined }));

    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("leaves the order when the shipment was created by this app", async () => {
    const byNote = shipmentRequest(finishedOrder(), { notes: "Sendcloud parcel 99: https://tracking.example/x" });
    await handler(byNote.req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(byNote.put).not.toHaveBeenCalled();

    const byId = shipmentRequest(
      finishedOrder({ $app: { sendcloud: { sendcloud_order_id: 669, sendcloud_shipment_id: "ship_1" } } }),
    );
    await handler(byId.req);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(byId.put).not.toHaveBeenCalled();
  });

  it("marks the order removed when Sendcloud already deleted it", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Not found" }, 404));
    const { req, put } = shipmentRequest(finishedOrder());

    await expect(handler(req)).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: {
        sendcloud: {
          sendcloud_status: "Removed from Sendcloud: shipped outside Sendcloud",
          sendcloud_error: null,
        },
      },
    });
  });

  it("does not remove an order shipped outside Sendcloud when the setting is off", async () => {
    const { req, put } = shipmentRequest(finishedOrder(), {}, SETTINGS);

    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("adds an item to the Sendcloud order", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 669 }] }));
    const before = makeOrder({ $app: { sendcloud: { sendcloud_order_id: 669 } } });
    const added = lineItem({
      id: "item_2",
      product_id: "prod_2",
      quantity: 1,
      quantity_shipment_deliverable: 1,
      price: 5,
      price_total: 5,
      shipment_weight: 1,
      product: { name: "Cup", sku: "CUP" },
    });
    const order = makeOrder({
      $app: { sendcloud: { sendcloud_order_id: 669, sendcloud_sync_hash: await sendcloudSyncHash(before) } },
      items: [...before.items, added],
    });
    const { req, put } = orderUpdatedRequest(order);

    await handler(req);

    const sent = postedOrder();
    expect(sent.order_id).toBe("order_1");
    expect(sent.order_details.order_items.map((item: any) => [item.item_id, item.quantity])).toEqual([
      ["item_1", 2],
      ["item_2", 1],
    ]);
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: { sendcloud: { sendcloud_sync_hash: await sendcloudSyncHash(order), sendcloud_error: null } },
    });
  });

  it("removes an item from the Sendcloud order", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 669 }] }));
    const before = makeOrder({
      $app: { sendcloud: { sendcloud_order_id: 669 } },
      items: [...makeOrder().items, lineItem({ id: "item_2", product_id: "prod_2", quantity: 1, quantity_shipment_deliverable: 1, price: 5, price_total: 5, product: { name: "Cup" } })],
    });
    const order = makeOrder({
      $app: { sendcloud: { sendcloud_order_id: 669, sendcloud_sync_hash: await sendcloudSyncHash(before) } },
    });
    const { req } = orderUpdatedRequest(order);

    await handler(req);

    const sent = postedOrder();
    expect(sent.order_details.order_items.map((item: any) => [item.item_id, item.quantity])).toEqual([["item_1", 2]]);
  });

  it("raises the quantity on the Sendcloud order", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 669 }] }));
    const before = makeOrder({ $app: { sendcloud: { sendcloud_order_id: 669 } } });
    const order = makeOrder({
      $app: { sendcloud: { sendcloud_order_id: 669, sendcloud_sync_hash: await sendcloudSyncHash(before) } },
      items: [lineItem({ quantity: 3, quantity_shipment_deliverable: 3, price_total: 59.85 })],
    });
    const { req } = orderUpdatedRequest(order);

    await handler(req);

    expect(postedOrder().order_details.order_items[0].quantity).toBe(3);
  });

  it("lowers the quantity on the Sendcloud order", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 669 }] }));
    const before = makeOrder({ $app: { sendcloud: { sendcloud_order_id: 669 } } });
    const order = makeOrder({
      $app: { sendcloud: { sendcloud_order_id: 669, sendcloud_sync_hash: await sendcloudSyncHash(before) } },
      items: [lineItem({ quantity: 1, quantity_shipment_deliverable: 1, price_total: 19.95 })],
    });
    const { req } = orderUpdatedRequest(order);

    await handler(req);

    expect(postedOrder().order_details.order_items[0].quantity).toBe(1);
  });

  it("updates the shipping address on the Sendcloud order", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 669 }] }));
    const before = makeOrder({ $app: { sendcloud: { sendcloud_order_id: 669 } } });
    const order = makeOrder({
      $app: { sendcloud: { sendcloud_order_id: 669, sendcloud_sync_hash: await sendcloudSyncHash(before) } },
      shipping: { ...before.shipping, address1: "Kerkstraat 8", city: "Utrecht", zip: "3511 AB" },
    });
    const { req } = orderUpdatedRequest(order);

    await handler(req);

    expect(postedOrder().shipping_address).toMatchObject({ address_line_1: "Kerkstraat", house_number: "8", city: "Utrecht" });
  });

  it("removes the Sendcloud order when nothing is left to ship", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const before = makeOrder({ $app: { sendcloud: { sendcloud_order_id: 669 } } });
    const order = makeOrder({
      $app: { sendcloud: { sendcloud_order_id: 669, sendcloud_sync_hash: await sendcloudSyncHash(before) } },
      items: [lineItem({ quantity_shipment_deliverable: 0 })],
    });
    const { req, put } = orderUpdatedRequest(order);

    await handler(req);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://panel.sendcloud.sc/api/v3/orders/669");
    expect(init.method).toBe("DELETE");
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: { sendcloud: { sendcloud_status: "Removed from Sendcloud", sendcloud_error: null } },
    });
    expect(put.mock.calls[0][1].$app.sendcloud.sendcloud_order_id).toBeUndefined();
  });

  it("does not call Sendcloud when the lines and address are unchanged", async () => {
    const before = makeOrder({ $app: { sendcloud: { sendcloud_order_id: 669 } } });
    const order = makeOrder({
      comments: "gift wrap",
      $app: { sendcloud: { sendcloud_order_id: 669, sendcloud_sync_hash: await sendcloudSyncHash(before) } },
    });
    const { req, put } = orderUpdatedRequest(order, { data: { comments: "gift wrap" } });

    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("does not call Sendcloud for the app's own order write", async () => {
    const order = makeOrder({
      $app: { sendcloud: { sendcloud_order_id: 669 } },
      shipping: { ...makeOrder().shipping, city: "Utrecht" },
    });
    const { req, put } = orderUpdatedRequest(order, {
      app_id: "sendcloud",
      data: { $app: { sendcloud: { sendcloud_sync_hash: "abc" } } },
    });

    await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("notes a change once when a label already exists", async () => {
    const before = makeOrder({
      $app: { sendcloud: { sendcloud_order_id: 669, sendcloud_parcel_id: 5001, sendcloud_status_id: 1000 } },
    });
    const changed = {
      $app: {
        sendcloud: {
          sendcloud_order_id: 669,
          sendcloud_parcel_id: 5001,
          sendcloud_status_id: 1000,
          sendcloud_sync_hash: await sendcloudSyncHash(before),
        },
      },
      shipping: { ...before.shipping, city: "Utrecht" },
    };
    const first = orderUpdatedRequest(makeOrder(changed));

    await handler(first.req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(first.put).toHaveBeenCalledWith("/orders/order_1", {
      $app: { sendcloud: { sendcloud_note: LABEL_NOTE } },
    });

    const second = orderUpdatedRequest(
      makeOrder({
        ...changed,
        $app: { sendcloud: { ...changed.$app.sendcloud, sendcloud_note: LABEL_NOTE } },
      }),
    );
    await handler(second.req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(second.put).not.toHaveBeenCalled();
  });

  it("updates a bundle to the component quantity still to ship when the order changes", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 669 }] }));
    const full = bundleOrder(4);
    const order = bundleOrder(2, await sendcloudSyncHash(full));
    const { req, put } = orderUpdatedRequest(order, {}, { ...SYNC, show_bundle_components: true });

    await handler(req);

    const sent = postedOrder();
    expect(sent.order_id).toBe("order_1");
    expect(sent.order_details.order_items).toEqual([
      expect.objectContaining({ item_id: "pouch", quantity: 2, name: "Bundle → Pouch" }),
    ]);
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: { sendcloud: { sendcloud_sync_hash: await sendcloudSyncHash(order), sendcloud_error: null } },
    });
  });
});

const SYNC = { ...SETTINGS, sync_with_swell: true };
const LABEL_NOTE = "Order changed after the label was created; update the parcel in Sendcloud.";

function finishedOrder(overrides: Record<string, any> = {}) {
  const order = makeOrder({
    $app: { sendcloud: { sendcloud_order_id: 669 } },
    ...overrides,
  });
  const item = order.items?.[0] as { bundle_items?: unknown; quantity_shipment_deliverable?: number } | undefined;
  if (item && !item.bundle_items) {
    item.quantity_shipment_deliverable = 0;
  }
  return order;
}

function lineItem(overrides: Record<string, any> = {}) {
  return { ...makeOrder().items[0], ...overrides };
}

function bundleOrder(pouchLeft: number, hash?: string) {
  return makeOrder({
    $app: { sendcloud: { sendcloud_order_id: 669, ...(hash ? { sendcloud_sync_hash: hash } : {}) } },
    items: [
      {
        id: "pack",
        delivery: "shipment",
        quantity: 1,
        price_total: 20,
        product_id: "bundle_prod",
        product: { name: "Bundle" },
        bundle_items: [
          {
            id: "pouch",
            product_id: "pouch_prod",
            quantity: 4,
            quantity_total: 4,
            quantity_shipment_deliverable: pouchLeft,
            price: 5,
            product: { name: "Pouch", sku: "POUCH" },
          },
          {
            id: "card",
            product_id: "card_prod",
            quantity: 1,
            quantity_total: 1,
            quantity_shipment_deliverable: pouchLeft === 4 ? 1 : 0,
            product: { name: "Card" },
          },
        ],
      },
    ],
  });
}

function orderUpdatedRequest(order: any, event: Record<string, any> = {}, settings: Record<string, any> = SYNC) {
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    data: {
      id: "order_1",
      $event: { type: "order.updated", ...event },
    } as any,
    appId: "sendcloud",
    swell: {
      settings: vi.fn().mockResolvedValue({ sendcloud: settings }),
      get: routeGet({ "/orders/order_1": order, "/settings/shipments": { weight_unit: "kg" } }),
      put,
    },
  });
  return { req, put };
}

function shipmentRequest(
  order: any,
  shipment: Record<string, any> = {},
  settings: Record<string, any> = SYNC,
) {
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    data: {
      id: "ship_1",
      order_id: "order_1",
      notes: null,
      ...shipment,
      $event: { type: "shipment.created" },
    } as any,
    appId: "sendcloud",
    swell: {
      settings: vi.fn().mockResolvedValue({ sendcloud: settings }),
      get: routeGet({ "/orders/order_1": order }),
      put,
    },
  });
  return { req, put };
}

const SEPARATE = {
  billing_schedule: { interval: "monthly", interval_count: 1 },
  order_schedule: { interval: "monthly", interval_count: 3 },
};

function renewalOrder(overrides: Record<string, any> = {}) {
  return makeOrder({
    number: "100996",
    subscription_id: "sub_1",
    date_created: "2026-11-06T10:29:51.443Z",
    ...overrides,
  });
}

function renewalGet(
  order: Record<string, any>,
  {
    invoices = [],
    holders = [],
    siblings = [order],
    subscription = SEPARATE,
  }: {
    invoices?: any[];
    holders?: any[];
    siblings?: any[];
    subscription?: Record<string, any>;
  } = {},
) {
  return vi.fn(async (url: string, query?: any) => {
    if (url === `/orders/${order.id}`) return order;
    if (url === "/subscriptions/sub_1") return subscription;
    if (url === "/settings/shipments") return { weight_unit: "kg" };
    if (url === "/invoices") {
      const statuses = query?.where?.status?.$in;
      const results = Array.isArray(statuses)
        ? invoices.filter((invoice) => statuses.includes(invoice.status))
        : invoices;
      return { results };
    }
    if (query?.where?.["$app.sendcloud.sendcloud_invoice_id"]) return { results: holders };
    if (query?.where?.date_created) return { results: siblings };
    return null;
  });
}
