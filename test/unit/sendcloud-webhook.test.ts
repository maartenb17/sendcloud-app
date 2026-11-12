import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { post } from "../../functions/sendcloud-webhook";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, hmacHex, makeOrder, routeGet } from "../helpers/fixtures";
import { toPythonJson } from "../../functions/lib/sendcloud";

const PARCEL = {
  id: 5001,
  order_number: "100003",
  tracking_number: "3SABCD123",
  tracking_url: "https://tracking.example/3SABCD123",
  status: { id: 1000, message: "Ready to send" },
  carrier: { code: "postnl" },
  shipment: { id: 8, name: "PostNL Standard" },
};

async function setup({
  payload = { action: "parcel_status_changed", timestamp: 1000, parcel: PARCEL } as Record<string, any>,
  settings = SETTINGS as Record<string, any>,
  order = makeOrder() as Record<string, any>,
  signatureKey = "sk",
  signature,
}: {
  payload?: Record<string, any>;
  settings?: Record<string, any>;
  order?: Record<string, any>;
  signatureKey?: string;
  signature?: string;
} = {}) {
  const rawBody = JSON.stringify(payload);
  const put = vi.fn().mockResolvedValue({});
  const postFn = vi.fn().mockResolvedValue({ id: "shipment_1" });
  const req = createMockRequest({
    data: payload as any,
    appId: "sendcloud",
    headers: { "sendcloud-signature": signature ?? (await hmacHex(rawBody, signatureKey)) },
    swell: {
      settings: vi.fn().mockResolvedValue({ sendcloud: settings }),
      get: routeGet({ "/orders": { results: [order] } }),
      put,
      post: postFn,
    },
  });
  (req as any).rawBody = rawBody;
  return { req, put, post: postFn };
}

describe("sendcloud-webhook", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects requests with an invalid signature", async () => {
    const { req, put } = await setup({ signature: "bad" });
    await expect(post(req)).rejects.toMatchObject({ status: 401 });
    expect(put).not.toHaveBeenCalled();
  });

  it("verifies against the JSON body when the raw body is not passed through", async () => {
    const { req } = await setup();
    (req as any).rawBody = "";
    await expect(post(req)).resolves.toMatchObject({ updated: true });
  });

  it("verifies a Python-serialized signature when the platform pretty-prints rawBody", async () => {
    const payload = { action: "parcel_status_changed", timestamp: 1000, parcel: PARCEL };
    const { req } = await setup({ payload, signature: await hmacHex(toPythonJson(payload), "sk") });
    // what the platform actually passes as req.rawBody
    (req as any).rawBody = JSON.stringify(payload, null, 2);
    await expect(post(req)).resolves.toMatchObject({ updated: true });
  });

  it("verifies with the webhook signature key when set", async () => {
    const { req } = await setup({
      settings: { ...SETTINGS, webhook_signature_key: "wsk" },
      signatureKey: "wsk",
    });
    await expect(post(req)).resolves.toMatchObject({ updated: true });
  });

  it("acknowledges other webhook actions", async () => {
    const { req, put } = await setup({ payload: { action: "integration_updated" } });
    await expect(post(req)).resolves.toEqual({ received: true });
    expect(put).not.toHaveBeenCalled();
  });

  it("acknowledges parcels for unknown orders", async () => {
    const { req, put } = await setup();
    (req.swell.get as any).mockImplementation(async () => ({ results: [] }));
    await expect(post(req)).resolves.toEqual({ received: true, order_found: false });
    expect(put).not.toHaveBeenCalled();
  });

  it("stores tracking and creates the Swell shipment once the label exists", async () => {
    const { req, put, post: postFn } = await setup({
      order: makeOrder({ $app: { sendcloud: { sendcloud_order_id: "sc_1" } } }),
    });

    await expect(post(req)).resolves.toEqual({ received: true, order_found: true, updated: true });

    expect(postFn).toHaveBeenCalledWith(
      "/shipments",
      expect.objectContaining({
        order_id: "order_1",
        items: [{ order_item_id: "item_1", product_id: "prod_1", variant_id: undefined, quantity: 2 }],
        carrier: "postnl",
        tracking_code: "3SABCD123",
        service: "PostNL Standard",
        service_name: "PostNL Standard",
      }),
    );
    expect(postFn.mock.calls[0][1].$notify).toBeUndefined();
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: {
        sendcloud: {
          sendcloud_parcel_id: 5001,
          sendcloud_status_id: 1000,
          sendcloud_status: "Ready to send",
          sendcloud_tracking_number: "3SABCD123",
          sendcloud_tracking_url: "https://tracking.example/3SABCD123",
          sendcloud_carrier: "postnl",
          sendcloud_status_timestamp: 1000,
          sendcloud_shipment_id: "shipment_1",
        },
      },
    });
  });

  it("notifies the customer only when that setting is on", async () => {
    const { req, post: postFn } = await setup({
      settings: { ...SETTINGS, notify_customer: true },
      order: makeOrder({ $app: { sendcloud: { sendcloud_order_id: "sc_1" } } }),
    });

    await post(req);

    expect(postFn.mock.calls[0][1].$notify).toBe("orders.shipped");
  });

  it("ships each bundle component with its bundle_item_id", async () => {
    const order: any = makeOrder({ $app: { sendcloud: { sendcloud_order_id: "sc_1" } } });
    order.items = [
      {
        id: "pack",
        delivery: "shipment",
        quantity: 1,
        quantity_shipment_deliverable: 1,
        product_id: "bundle",
        bundle_items: [
          {
            id: "component",
            product_id: "pouch",
            quantity: 4,
            quantity_total: 4,
            quantity_shipment_deliverable: 4,
          },
        ],
      },
    ];
    const { req, post: postFn } = await setup({ order });

    await post(req);

    expect(postFn).toHaveBeenCalledWith(
      "/shipments",
      expect.objectContaining({
        items: [
          {
            order_item_id: "pack",
            bundle_item_id: "component",
            product_id: "pouch",
            quantity: 4,
          },
        ],
      }),
    );
  });

  it("does not notify the customer when that setting is off", async () => {
    const { req, post: postFn } = await setup({
      settings: { ...SETTINGS, notify_customer: false },
      order: makeOrder({ $app: { sendcloud: { sendcloud_order_id: "sc_1" } } }),
    });

    await post(req);

    const body = postFn.mock.calls[0][1];
    expect(body.$notify).toBeUndefined();
    expect(body.tracking_code).toBe("3SABCD123");
  });

  it("stores tracking without a shipment when the order was not sent by this app", async () => {
    const { req, put, post: postFn } = await setup();

    await expect(post(req)).resolves.toEqual({ received: true, order_found: true, updated: true });

    expect(postFn).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith("/orders/order_1", {
      $app: {
        sendcloud: {
          sendcloud_parcel_id: 5001,
          sendcloud_status_id: 1000,
          sendcloud_status: "Ready to send",
          sendcloud_tracking_number: "3SABCD123",
          sendcloud_tracking_url: "https://tracking.example/3SABCD123",
          sendcloud_carrier: "postnl",
          sendcloud_status_timestamp: 1000,
        },
      },
    });
  });

  it("stores tracking without a shipment when nothing is left to ship", async () => {
    const order = makeOrder({ $app: { sendcloud: { sendcloud_order_id: "sc_1" } } });
    order.items[0].quantity_shipment_deliverable = 0;
    const { req, put, post: postFn } = await setup({ order });

    await expect(post(req)).resolves.toEqual({ received: true, order_found: true, updated: true });

    expect(postFn).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith(
      "/orders/order_1",
      expect.objectContaining({
        $app: {
          sendcloud: expect.objectContaining({
            sendcloud_tracking_number: "3SABCD123",
            sendcloud_carrier: "postnl",
          }),
        },
      }),
    );
    expect(put.mock.calls[0][1].$app.sendcloud.sendcloud_shipment_id).toBeUndefined();
  });

  it("does not create a shipment when fulfillment is off or there is no label yet", async () => {
    const off = await setup({
      settings: { ...SETTINGS, create_fulfillment: false },
      order: makeOrder({ $app: { sendcloud: { sendcloud_order_id: "sc_1" } } }),
    });
    await post(off.req);
    expect(off.post).not.toHaveBeenCalled();

    const noLabel = await setup({
      order: makeOrder({ $app: { sendcloud: { sendcloud_order_id: "sc_1" } } }),
      payload: {
        action: "parcel_status_changed",
        parcel: { ...PARCEL, tracking_number: null, status: { id: 999, message: "No label" } },
      },
    });
    await post(noLabel.req);
    expect(noLabel.post).not.toHaveBeenCalled();
  });

  it("skips out-of-order updates", async () => {
    const { req, put } = await setup({
      order: makeOrder({ $app: { sendcloud: { sendcloud_parcel_id: 5001, sendcloud_status_timestamp: 2000 } } }),
    });
    await expect(post(req)).resolves.toMatchObject({ updated: false });
    expect(put).not.toHaveBeenCalled();
  });

  it("ignores a different parcel unless the stored one was canceled", async () => {
    const other = await setup({
      order: makeOrder({ $app: { sendcloud: { sendcloud_parcel_id: 4000, sendcloud_status_id: 1000 } } }),
    });
    await expect(post(other.req)).resolves.toMatchObject({ updated: false });

    const replaced = await setup({
      order: makeOrder({ $app: { sendcloud: { sendcloud_parcel_id: 4000, sendcloud_status_id: 2000 } } }),
    });
    await expect(post(replaced.req)).resolves.toMatchObject({ updated: true });
  });

  it("cancels the Swell shipment when the parcel is canceled", async () => {
    const { req, put, post: postFn } = await setup({
      payload: {
        action: "parcel_status_changed",
        parcel: { ...PARCEL, status: { id: 2000, message: "Cancelled" } },
      },
      order: makeOrder({ $app: { sendcloud: { sendcloud_parcel_id: 5001, sendcloud_shipment_id: "shipment_1" } } }),
    });

    await post(req);

    expect(postFn).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith("/shipments/shipment_1", { canceled: true });
    expect(put).toHaveBeenCalledWith(
      "/orders/order_1",
      expect.objectContaining({
        $app: { sendcloud: expect.objectContaining({ sendcloud_shipment_id: null, sendcloud_status_id: 2000 }) },
      }),
    );
  });
});
