import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../functions/check-and-send";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, jsonResponse, makeOrder } from "../helpers/fixtures";

const ORDER_ID = "a".repeat(24);

const SEPARATE = {
  billing_schedule: { interval: "monthly", interval_count: 1 },
  order_schedule: { interval: "monthly", interval_count: 3 },
};

function renewal(overrides: Record<string, any> = {}) {
  return makeOrder({
    id: ORDER_ID,
    number: "100996",
    paid: true,
    subscription_id: "sub_1",
    date_created: "2026-11-06T10:29:51.443Z",
    ...overrides,
  });
}

function requestFor(orders: any[], settings: Record<string, any>, get: ReturnType<typeof vi.fn>) {
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    data: {
      $action: { collection: "orders", source: "record", record_id: orders[0]?.id || ORDER_ID },
    } as any,
    appId: "sendcloud",
    swell: {
      settings: vi.fn().mockResolvedValue({ sendcloud: settings }),
      get,
      put,
      post: vi.fn().mockResolvedValue({}),
    },
  });
  return { req, put };
}

function plainGet(orders: any[]) {
  return vi.fn(async (url: string) => {
    if (url === "/orders") return { results: orders };
    if (url === "/settings/shipments") return { weight_unit: "kg" };
    return null;
  });
}

function holdGet(order: any, invoices: any[], subscription: Record<string, any> = SEPARATE) {
  return vi.fn(async (url: string, query?: any) => {
    if (url === "/subscriptions/sub_1") return subscription;
    if (url === "/settings/shipments") return { weight_unit: "kg" };
    if (url === "/invoices") {
      const statuses = query?.where?.status?.$in;
      const results = Array.isArray(statuses)
        ? invoices.filter((invoice) => statuses.includes(invoice.status))
        : invoices;
      return { results };
    }
    if (url === "/orders" && query?.where?.id) return { results: [order] };
    if (query?.where?.["$app.sendcloud.sendcloud_invoice_id"]) return { results: [] };
    if (url === "/orders") return { results: [order] };
    return null;
  });
}

const logs: string[] = [];

describe("check-and-send", () => {
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

  it("sends an order that may go", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 669 }] }));
    const order = makeOrder({ id: ORDER_ID });
    const { req } = requestFor([order], SETTINGS, plainGet([order]));

    const result = await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ message: expect.stringContaining("Sent 1 order to Sendcloud: 100003.") });
  });

  it("skips a test order and a canceled order", async () => {
    const settings = { ...SETTINGS, skip_test_orders: true };
    const testOrder = makeOrder({ id: ORDER_ID, number: "100010", test: true });
    const { req } = requestFor([testOrder], settings, plainGet([testOrder]));

    await expect(handler(req)).rejects.toThrow("Skipped: 100010: order is a test order.");
    expect(fetchMock).not.toHaveBeenCalled();

    const canceled = makeOrder({ id: ORDER_ID, number: "100011", status: "canceled" });
    const second = requestFor([canceled], settings, plainGet([canceled]));
    await expect(handler(second.req)).rejects.toThrow("Skipped: 100011: order is canceled.");
    expect(logs).toContain("Sendcloud: order 100011 is canceled, skipping");
  });

  it("holds a renewal until its invoice is paid and stores the invoice id", async () => {
    const order = renewal({ grand_total: 0 });
    const { req, put } = requestFor(
      [order],
      { ...SETTINGS, hold_separate_order_schedule: true },
      holdGet(order, [{ id: "inv_1", status: "pending", date_created: "2026-11-06T10:29:50.000Z" }]),
    );

    const result = await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, {
      $app: {
        sendcloud: {
          sendcloud_status: "Waiting for invoice payment",
          sendcloud_invoice_id: "inv_1",
          sendcloud_error: null,
        },
      },
    });
    expect(result?.message).toContain("100996: waiting for invoice payment");
    expect(logs).toContain("Sendcloud: order 100996 is waiting for invoice payment");
  });

  it("holds a paid invoice when the subscription is in arrears", async () => {
    const order = renewal();
    const { req, put } = requestFor(
      [order],
      { ...SETTINGS, hold_separate_order_schedule: true },
      holdGet(
        order,
        [{ id: "inv_1", status: "paid", date_created: "2026-11-06T10:29:50.000Z" }],
        { ...SEPARATE, status: "pastdue" },
      ),
    );

    const result = await handler(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, {
      $app: {
        sendcloud: {
          sendcloud_status: "Waiting for overdue payments",
          sendcloud_invoice_id: "inv_1",
          sendcloud_error: null,
        },
      },
    });
    expect(result?.message).toContain("waiting for overdue payments");
  });

  it("sends the renewal when its invoice is paid and nothing is overdue", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 670 }] }));
    const order = renewal();
    const { req, put } = requestFor(
      [order],
      { ...SETTINGS, hold_separate_order_schedule: true },
      holdGet(order, [{ id: "inv_1", status: "paid", date_created: "2026-11-06T10:29:50.000Z" }]),
    );

    const result = await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, {
      $app: {
        sendcloud: expect.objectContaining({
          sendcloud_order_id: 670,
          sendcloud_invoice_id: "inv_1",
        }),
      },
    });
    expect(result?.message).toContain("Sent 1 order to Sendcloud: 100996.");
  });

  it("does not send an order that is already in Sendcloud", async () => {
    const order = makeOrder({ id: ORDER_ID, $app: { sendcloud: { sendcloud_order_id: 669 } } });
    const { req } = requestFor([order], SETTINGS, plainGet([order]));

    await expect(handler(req)).rejects.toThrow("already in Sendcloud");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a bulk selection of more than 10 orders", async () => {
    const orders = Array.from({ length: 11 }, (_item, index) =>
      makeOrder({ id: index.toString(16).padStart(24, "b"), number: String(100000 + index) }),
    );
    const req = createMockRequest({
      data: {
        $action: { collection: "orders", source: "bulk", selection: { query: { where: {} } } },
      } as any,
      appId: "sendcloud",
      swell: {
        settings: vi.fn().mockResolvedValue({ sendcloud: SETTINGS }),
        get: plainGet(orders),
        put: vi.fn(),
        post: vi.fn(),
      },
    });

    await expect(handler(req)).rejects.toThrow("Select up to 10 orders.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
