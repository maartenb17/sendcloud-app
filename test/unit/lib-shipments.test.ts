import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemsAlreadyShipped, ShipmentPending, createSwellShipment, itemsShippedNote } from "../../functions/lib/shipments";
import { makeOrder } from "../helpers/fixtures";

const PARCEL = { id: 5001, tracking_number: "3SABCD123", carrier: { code: "postnl" }, shipment: { id: 8, name: "PostNL Standard" } };
const CANNOT_SHIP = { items: { message: "Cannot ship 2 of item item_1, only 0 left to deliver", code: "INVALID" } };

function refusal(body: unknown, status = 400) {
  return Object.assign(new Error("POST /shipments\nrefused"), { name: "SwellError", status, body });
}

// swell mock: `shipments` answers each GET /shipments in turn, `left` is the reread order's deliverable quantity
function client({ shipments = [[], []] as any[][], left = 2, post = vi.fn().mockResolvedValue({ id: "ship_new" }) } = {}) {
  const lookups = [...shipments];
  return {
    get: vi.fn(async (url: string) => {
      if (url === "/shipments") return { results: lookups.shift() || [] };
      if (url === "/orders/order_1") return makeOrder({ items: [{ ...makeOrder().items[0], quantity_shipment_deliverable: left }] });
      return null;
    }),
    post,
    put: vi.fn().mockResolvedValue({}),
  } as any;
}

describe("createSwellShipment", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("creates the shipment with $validate_items for the items left to ship", async () => {
    const swell = client();
    await expect(createSwellShipment(swell, makeOrder(), PARCEL)).resolves.toBe("ship_new");
    expect(swell.post).toHaveBeenCalledWith(
      "/shipments",
      expect.objectContaining({
        $validate_items: true,
        tracking_code: "3SABCD123",
        items: [{ order_item_id: "item_1", product_id: "prod_1", variant_id: undefined, quantity: 2 }],
      }),
    );
  });

  it("reuses the order's shipment with the parcel's tracking number", async () => {
    const swell = client({ shipments: [[{ id: "ship_old" }]] });
    await expect(createSwellShipment(swell, makeOrder(), PARCEL)).resolves.toBe("ship_old");
    expect(swell.post).not.toHaveBeenCalled();
  });

  it("treats nothing left to ship as shipped elsewhere", async () => {
    const swell = client();
    const order = makeOrder();
    order.items[0].quantity_shipment_deliverable = 0;
    await expect(createSwellShipment(swell, order, PARCEL)).rejects.toBeInstanceOf(ItemsAlreadyShipped);
    expect(swell.post).not.toHaveBeenCalled();
  });

  it("reuses a parallel webhook's shipment after a refusal", async () => {
    const swell = client({ shipments: [[], [{ id: "ship_parallel" }]], post: vi.fn().mockRejectedValue(refusal(CANNOT_SHIP)) });
    await expect(createSwellShipment(swell, makeOrder(), PARCEL)).resolves.toBe("ship_parallel");
  });

  it("retries when the refused items are still deliverable (a reservation)", async () => {
    const swell = client({ left: 2, post: vi.fn().mockRejectedValue(refusal({ errors: CANNOT_SHIP }, 422)) });
    await expect(createSwellShipment(swell, makeOrder(), PARCEL)).rejects.toBeInstanceOf(ShipmentPending);
  });

  it("reports shipped elsewhere when fewer items are left, fully or partly", async () => {
    for (const left of [0, 1]) {
      const swell = client({ left, post: vi.fn().mockRejectedValue(refusal(CANNOT_SHIP)) });
      const error = await createSwellShipment(swell, makeOrder(), PARCEL).catch((e) => e);
      expect(error).toBeInstanceOf(ItemsAlreadyShipped);
      expect(error.message).toBe(CANNOT_SHIP.items.message);
    }
  });

  it("retries when the order's shipments are locked", async () => {
    const locked = { order_id: { message: "Order shipments are being updated, please try again" } };
    const swell = client({ post: vi.fn().mockRejectedValue(refusal(locked)) });
    await expect(createSwellShipment(swell, makeOrder(), PARCEL)).rejects.toBeInstanceOf(ShipmentPending);
  });

  it("rethrows other errors", async () => {
    const other = refusal({ destination: { message: "Invalid" } });
    const swell = client({ post: vi.fn().mockRejectedValue(other) });
    await expect(createSwellShipment(swell, makeOrder(), PARCEL)).rejects.toBe(other);

    const server = refusal({ error: "boom" }, 500);
    await expect(createSwellShipment(client({ post: vi.fn().mockRejectedValue(server) }), makeOrder(), PARCEL)).rejects.toBe(server);
  });

  it("cancels its copy when a parallel webhook created one first", async () => {
    const swell = client({ shipments: [[], [{ id: "ship_first" }, { id: "ship_new" }]] });
    await expect(createSwellShipment(swell, makeOrder(), PARCEL)).resolves.toBe("ship_first");
    expect(swell.put).toHaveBeenCalledWith("/shipments/ship_new", { canceled: true });
  });

  it("explains the note", () => {
    expect(itemsShippedNote("nothing left to ship")).toContain("(nothing left to ship). Cancel the label in Sendcloud");
  });
});
