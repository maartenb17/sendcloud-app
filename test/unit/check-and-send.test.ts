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

  it("skips an unpaid order on the same order and billing cycle", async () => {
    const order = renewal({ paid: false, grand_total: 15, number: "100641" });
    const equal = {
      billing_schedule: { interval: "daily", interval_count: 3 },
      order_schedule: null,
    };
    const { req, put } = requestFor(
      [order],
      { ...SETTINGS, hold_separate_order_schedule: true },
      holdGet(order, [], equal),
    );

    await expect(handler(req)).rejects.toThrow("Skipped: 100641: not paid.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(logs).toContain("Sendcloud: order 100641 is not paid, skipping");
  });

  it("sends a paid order on the same order and billing cycle", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 881 }] }));
    const order = renewal({ paid: true, grand_total: 15, number: "100642" });
    const equal = {
      billing_schedule: { interval: "daily", interval_count: 3 },
      order_schedule: null,
    };
    const { req } = requestFor(
      [order],
      { ...SETTINGS, hold_separate_order_schedule: true },
      holdGet(order, [], equal),
    );

    const result = await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ message: expect.stringContaining("Sent 1 order to Sendcloud: 100642.") });
  });

  it("sends a zero-total order that Swell marks paid", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 882 }] }));
    const order = makeOrder({ id: ORDER_ID, number: "100643", paid: true, grand_total: 0 });
    const { req } = requestFor([order], SETTINGS, plainGet([order]));

    const result = await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ message: expect.stringContaining("Sent 1 order to Sendcloud: 100643.") });
  });

  it("sends an unpaid order when the setting is order submitted", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 883 }] }));
    const order = renewal({ paid: false, grand_total: 15, number: "100644" });
    const { req } = requestFor([order], { ...SETTINGS, sync_on: "submitted" }, plainGet([order]));

    const result = await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ message: expect.stringContaining("Sent 1 order to Sendcloud: 100644.") });
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

  it("marks a waiting order when the subscription is canceled", async () => {
    const order = renewal({
      $app: { sendcloud: { sendcloud_status: "Waiting for invoice payment", sendcloud_invoice_id: "inv_1" } },
    });
    const { req, put } = requestFor(
      [order],
      { ...SETTINGS, hold_separate_order_schedule: true },
      holdGet(order, [], { ...SEPARATE, status: "canceled", canceled: true }),
    );

    await expect(handler(req)).rejects.toThrow("Skipped: 100996: subscription is canceled.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, {
      $app: {
        sendcloud: {
          sendcloud_status: "Not sent: subscription canceled",
          sendcloud_error: null,
        },
      },
    });
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

  it("skips an order that still has an active label", async () => {
    const order = makeOrder({
      id: ORDER_ID,
      $app: { sendcloud: { sendcloud_order_id: 669, sendcloud_parcel_id: 5001, sendcloud_status_id: 1000 } },
    });
    const { req } = requestFor([order], SETTINGS, plainGet([order]));

    await expect(handler(req)).rejects.toThrow("already in Sendcloud");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a new Sendcloud order after the label was canceled and clears the parcel fields", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 880 }] }));
    const order = makeOrder({
      id: ORDER_ID,
      $app: {
        sendcloud: {
          sendcloud_order_id: 669,
          sendcloud_parcel_id: 5001,
          sendcloud_status_id: 2000,
          sendcloud_tracking_number: "3SOLD",
          sendcloud_carrier: "postnl",
          sendcloud_shipment_id: "ship_1",
          sendcloud_note: "old",
        },
      },
    });
    const { req, put } = requestFor([order], SETTINGS, plainGet([order]));

    const result = await handler(req);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body).toEqual([expect.objectContaining({ order_id: `${ORDER_ID}-2`, order_number: "100003" })]);
    expect(result?.message).toContain("Sent 1 order to Sendcloud: 100003.");
    const values = put.mock.calls.at(-1)?.[1].$app.sendcloud;
    expect(values.sendcloud_order_id).toBe(880);
    expect(values.sendcloud_order_suffix).toBe(2);
    expect(values.sendcloud_status).toBe("Sent to Sendcloud");
    expect(values.sendcloud_parcel_id).toBeNull();
    expect(values.sendcloud_status_id).toBeNull();
    expect(values.sendcloud_tracking_number).toBeNull();
    expect(values.sendcloud_carrier).toBeNull();
    expect(values.sendcloud_shipment_id).toBeNull();
    expect(values.sendcloud_note).toBeNull();
  });

  it("uses suffix 3 when the previous resend was also canceled", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 881 }] }));
    const order = makeOrder({
      id: ORDER_ID,
      $app: {
        sendcloud: {
          sendcloud_order_id: 880,
          sendcloud_order_suffix: 2,
          sendcloud_parcel_id: 5002,
          sendcloud_status_id: 1999,
        },
      },
    });
    const { req, put } = requestFor([order], SETTINGS, plainGet([order]));

    await handler(req);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body[0].order_id).toBe(`${ORDER_ID}-3`);
    expect(put.mock.calls.at(-1)?.[1].$app.sendcloud.sendcloud_order_suffix).toBe(3);
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
