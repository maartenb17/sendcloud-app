import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../functions/send-to-sendcloud";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, jsonResponse, makeOrder } from "../helpers/fixtures";

const ORDER_ID = "a".repeat(24);

function order(overrides: Record<string, any> = {}) {
  return makeOrder({ id: ORDER_ID, ...overrides });
}

function actionRequest(orders: any[], source: "record" | "bulk" = "record") {
  const post = vi.fn().mockResolvedValue({});
  const put = vi.fn().mockResolvedValue({});
  const get = vi.fn(async (url: string) => {
    if (url === "/orders") return { results: orders };
    if (url === "/settings/shipments") return { weight_unit: "kg" };
    return null;
  });
  const req = createMockRequest({
    data: {
      $action:
        source === "record"
          ? { collection: "orders", source: "record", record_id: ORDER_ID }
          : { collection: "orders", source: "bulk", selection: { query: { where: {} } } },
    } as any,
    appId: "sendcloud",
    swell: {
      settings: vi.fn().mockResolvedValue({ sendcloud: SETTINGS }),
      get,
      put,
      post,
    },
  });
  return { req, put, post };
}

const logs: string[] = [];

describe("send-to-sendcloud", () => {
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

  it.each([
    ["was not sent", {}],
    ["has a sendcloud error", { $app: { sendcloud: { sendcloud_error: "Sendcloud 400: no" } } }],
  ])("sends an order that %s", async (_label, extra) => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 669, order_id: ORDER_ID }] }));
    const { req, put } = actionRequest([order(extra)]);

    const result = await handler(req);

    expect(result).toEqual({ message: expect.stringContaining("Sent 1 order to Sendcloud") });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body[0].order_id).toBe(ORDER_ID);
    expect(put).toHaveBeenCalledWith(
      `/orders/${ORDER_ID}`,
      expect.objectContaining({
        $app: { sendcloud: expect.objectContaining({ sendcloud_order_id: 669, sendcloud_status: "Sent to Sendcloud" }) },
      }),
    );
  });

  it("sends an order that is waiting for invoice payment, and notes that it was manual", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 700 }] }));
    const waiting = order({
      $app: { sendcloud: { sendcloud_status: "Waiting for invoice payment", sendcloud_invoice_id: "inv_1" } },
    });
    const { req, post } = actionRequest([waiting]);

    const result = await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logs).toContain("Sendcloud: order 100003 sent manually while waiting for invoice payment");
    expect(post).toHaveBeenCalledWith("/notes", {
      body: "Sent to Sendcloud manually while waiting for invoice payment.",
      collection: "orders",
      record_id: ORDER_ID,
    });
    expect(result?.message).toContain("sent manually while waiting for invoice payment");
  });

  it("sends an order that is waiting for overdue payments, and notes that it was manual", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 703 }] }));
    const waiting = order({
      $app: { sendcloud: { sendcloud_status: "Waiting for overdue payments", sendcloud_invoice_id: "inv_1" } },
    });
    const { req, post } = actionRequest([waiting]);

    const result = await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logs).toContain("Sendcloud: order 100003 sent manually while waiting for overdue payments");
    expect(post).toHaveBeenCalledWith("/notes", {
      body: "Sent to Sendcloud manually while waiting for overdue payments.",
      collection: "orders",
      record_id: ORDER_ID,
    });
    expect(result?.message).toContain("sent manually while waiting for overdue payments");
  });

  it("sends a test order and logs that the send was manual", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 701 }] }));
    const { req } = actionRequest([order({ test: true })]);

    const result = await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logs).toContain("Sendcloud: order 100003 is a test order, sending manually");
    expect(result?.message).toContain("test order, sent manually");
  });

  it("updates an order already in Sendcloud by posting the same Swell order id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 669, order_id: ORDER_ID }] }));
    const existing = order({ $app: { sendcloud: { sendcloud_order_id: 669 } } });
    const { req } = actionRequest([existing]);

    const result = await handler(req);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body).toEqual([expect.objectContaining({ order_id: ORDER_ID, order_number: "100003" })]);
    expect(result?.message).toContain("Updated 1 order in Sendcloud");
  });

  it("skips an unpaid order and a canceled order", async () => {
    const unpaid = order({ id: "b".repeat(24), number: "100010", paid: false });
    const canceled = order({ id: "c".repeat(24), number: "100011", status: "canceled", paid: true });
    const { req } = actionRequest([unpaid, canceled], "bulk");

    await expect(handler(req)).rejects.toThrow(
      "Skipped: 100010: order is not paid · 100011: order is canceled.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs).toContain("Sendcloud: order 100011 is canceled, skipping");
  });

  it("still sends a paid renewal whose total is zero", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 702 }] }));
    const renewal = order({
      grand_total: 0,
      paid: true,
      $app: { sendcloud: { sendcloud_status: "Waiting for invoice payment" } },
    });
    const { req } = actionRequest([renewal]);

    const result = await handler(req);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result?.message).toContain("Sent 1 order to Sendcloud");
  });

  it("skips an order that already has a label", async () => {
    const labeled = order({
      $app: { sendcloud: { sendcloud_order_id: 669, sendcloud_parcel_id: 5001, sendcloud_status_id: 1000 } },
    });
    const { req } = actionRequest([labeled]);

    await expect(handler(req)).rejects.toThrow("Order 100003 already has a label in Sendcloud");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a new Sendcloud order after the label was canceled and clears the parcel fields", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 880 }] }));
    const canceled = order({
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
    const { req, put } = actionRequest([canceled]);

    const result = await handler(req);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body).toEqual([expect.objectContaining({ order_id: `${ORDER_ID}-2`, order_number: "100003" })]);
    expect(result?.message).toContain("Sent 1 order to Sendcloud");
    expect(logs.join("\n")).toContain("previous order 669 left in Sendcloud");
    expect(logs.join("\n")).toContain("Sendcloud order 880");
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
    const canceled = order({
      $app: {
        sendcloud: {
          sendcloud_order_id: 880,
          sendcloud_order_suffix: 2,
          sendcloud_parcel_id: 5002,
          sendcloud_status_id: 2000,
        },
      },
    });
    const { req, put } = actionRequest([canceled]);

    await handler(req);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body[0].order_id).toBe(`${ORDER_ID}-3`);
    expect(body[0].order_number).toBe("100003");
    expect(put.mock.calls.at(-1)?.[1].$app.sendcloud.sendcloud_order_suffix).toBe(3);
    expect(put.mock.calls.at(-1)?.[1].$app.sendcloud.sendcloud_order_id).toBe(881);
  });

  it("refuses a bulk selection of more than 10 orders", async () => {
    const orders = Array.from({ length: 11 }, (_item, index) => order({ id: `id_${index}`, number: String(100000 + index) }));
    const { req } = actionRequest(orders, "bulk");

    await expect(handler(req)).rejects.toThrow("Select up to 10 orders.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
