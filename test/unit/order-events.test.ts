import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../functions/order-events";
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
    const { req } = setup({
      eventType: "order.canceled",
      order: makeOrder({ $app: { sendcloud: { sendcloud_order_id: 669 } } }),
    });

    await handler(req);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://panel.sendcloud.sc/api/v3/orders/669");
    expect(init.method).toBe("DELETE");
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

  it("does not treat a string test flag as a test order", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 1 }] }));
    const { req } = setup({
      settings: { ...SETTINGS, skip_test_orders: true },
      order: makeOrder({ test: "true", metadata: { test: "true" } }),
    });
    await handler(req);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("sends the first order of a separate schedule, and a yearly renewal, without waiting", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ data: [{ id: 1 }] }));
    const first = renewalOrder();
    const { req } = setup({
      settings: { ...SETTINGS, hold_separate_order_schedule: true },
      order: first,
    });
    req.swell.get = renewalGet(first, { earliestId: "order_1" });
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
      if (url === "/subscriptions/sub_1") return { billing_schedule: { interval: "yearly", interval_count: 1 } };
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
});

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
    earliestId = "order_0",
    siblings = [order],
  }: {
    invoices?: any[];
    holders?: any[];
    earliestId?: string;
    siblings?: any[];
  } = {},
) {
  return vi.fn(async (url: string, query?: any) => {
    if (url === `/orders/${order.id}`) return order;
    if (url === "/subscriptions/sub_1") return SEPARATE;
    if (url === "/settings/shipments") return { weight_unit: "kg" };
    if (url === "/invoices") return { results: invoices };
    if (query?.where?.["$app.sendcloud.sendcloud_invoice_id"]) return { results: holders };
    if (query?.where?.date_created) return { results: siblings };
    if (query?.sort) return { results: [{ id: earliestId, date_created: "2026-01-01T00:00:00.000Z" }] };
    return null;
  });
}
