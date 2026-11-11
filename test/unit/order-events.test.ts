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

  it("still sends a test order when skip test orders is off", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 669 }] }));
    const order = makeOrder({
      test: true,
      metadata: { test: true },
    });
    const { req } = setup({ order });

    await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
});
