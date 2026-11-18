import type { SendcloudParcel } from './sendcloud';

// sendcloud_shipment_status values
export const SHIPMENT_CREATED = 'created';
export const SHIPPED_ELSEWHERE = 'shipped_elsewhere';

// the order's items were shipped elsewhere, refunded or canceled; the message is the reason
export class ItemsAlreadyShipped extends Error {}

// shipments locked or items reserved by another write; the next webhook for the parcel retries
export class ShipmentPending extends Error {}

export function itemsShippedNote(reason: string): string {
  return `No Swell shipment was created for this parcel: the order's items were already shipped by another shipment, or refunded or canceled (${reason}). Cancel the label in Sendcloud if it isn't needed.`;
}

function nonNegativeInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

// already shipped units, when the deliverable fields are missing and the reserve total is all that remains
function alreadyShipped(item: any): number {
  const fromShipment = nonNegativeInt(item?.quantity_shipment_delivered);
  if (fromShipment !== null) return fromShipment;
  return nonNegativeInt(item?.quantity_delivered) ?? 0;
}

// bundle components use quantity_total when Swell has not stored a deliverable quantity yet
function shippableQuantity(item: any, useQuantityTotal: boolean): number {
  const fromShipment = nonNegativeInt(item?.quantity_shipment_deliverable);
  if (fromShipment !== null) return fromShipment;
  const fromDeliverable = nonNegativeInt(item?.quantity_deliverable);
  if (fromDeliverable !== null) return fromDeliverable;

  const canceled = Math.max(0, Number(item?.quantity_canceled) || 0);
  let base = Math.max(0, Number(item?.quantity) || 0);
  if (useQuantityTotal) {
    const total = nonNegativeInt(item?.quantity_total);
    if (total !== null && total > 0) base = total;
  }
  return Math.max(0, Math.floor(base - canceled - alreadyShipped(item)));
}

function bundleChildren(item: any): any[] {
  const children = Array.isArray(item?.bundle_items) ? item.bundle_items : [];
  return children.filter((child: any) => child?.id && child?.product_id);
}

function lineKey(item: { order_item_id: string; bundle_item_id?: string }): string {
  return item.bundle_item_id ? `${item.order_item_id}:${item.bundle_item_id}` : String(item.order_item_id);
}

// the order's items left to ship; a bundle is one line per component, not one line for the bundle
export function deliverableItems(order: any) {
  const lines = [];
  for (const item of order.items || []) {
    if (item?.delivery !== 'shipment') continue;
    const children = bundleChildren(item);
    if (children.length) {
      for (const child of children) {
        const quantity = shippableQuantity(child, true);
        if (quantity <= 0) continue;
        lines.push({
          order_item_id: item.id,
          bundle_item_id: child.id,
          product_id: child.product_id,
          quantity,
          ...(child.variant_id ? { variant_id: child.variant_id } : {}),
        });
      }
      continue;
    }
    if (!(item.quantity_shipment_deliverable > 0)) continue;
    lines.push({
      order_item_id: item.id,
      product_id: item.product_id,
      variant_id: item.variant_id,
      quantity: item.quantity_shipment_deliverable,
    });
  }
  return lines;
}

// active Swell shipments of the order with this tracking number, oldest first
async function findShipmentsByTracking(swell: SwellAPI, orderId: string, trackingNumber?: string): Promise<any[]> {
  if (!trackingNumber) return [];
  const result: any = await swell.get('/shipments', {
    where: { order_id: orderId, tracking_code: trackingNumber, canceled: { $ne: true } },
    limit: 25,
  });
  return (result?.results || []).sort(
    (a: any, b: any) => String(a.date_created).localeCompare(String(b.date_created)) || String(a.id).localeCompare(String(b.id)),
  );
}

// errors of a write Swell refused, from the SwellError's body
function validationErrors(err: any): Record<string, any> | undefined {
  if (!(err?.status >= 400 && err.status < 500)) return undefined;
  const errors = err.body?.errors ?? err.body;
  return errors && typeof errors === 'object' ? errors : undefined;
}

// Swell's "Cannot ship …" reason when $validate_items refused the items
function itemsRefusal(errors: Record<string, any>): string | undefined {
  const message = errors.items?.message;
  return typeof message === 'string' && /^Cannot ship /.test(message) ? message : undefined;
}

function errorText(errors: Record<string, any>): string {
  return Object.entries(errors)
    .map(([field, error]) => `${field}: ${error?.message || error}`)
    .join('; ');
}

// remaining quantity per shipment line; bundle components are keyed apart from their parent order item
function deliverableLeft(order: any): Map<string, number> {
  const left = new Map<string, number>();
  for (const item of order?.items || []) {
    const children = bundleChildren(item);
    if (children.length) {
      for (const child of children) {
        left.set(lineKey({ order_item_id: item.id, bundle_item_id: child.id }), shippableQuantity(child, true));
      }
      continue;
    }
    left.set(String(item.id), Number(item.quantity_shipment_deliverable) || 0);
  }
  return left;
}

// whether the order's saved shipments (not reservations) still leave every requested item to ship
async function stillDeliverable(
  swell: SwellAPI,
  orderId: string,
  requested: { order_item_id: string; bundle_item_id?: string; quantity: number }[],
) {
  const order: any = await swell.get(`/orders/${orderId}`);
  const left = deliverableLeft(order);
  return requested.every((item) => (left.get(lineKey(item)) || 0) >= item.quantity);
}

const pending = (order: any, reason: string) =>
  new ShipmentPending(`Swell couldn't create the shipment for order ${order.number} yet (${reason})`);

// Swell shipment for everything left to ship; reuses one with the parcel's tracking number
export async function createSwellShipment(
  swell: SwellAPI,
  order: any,
  parcel: SendcloudParcel,
  options?: { notify?: boolean },
): Promise<string> {
  const [existing] = await findShipmentsByTracking(swell, order.id, parcel.tracking_number);
  if (existing) {
    console.log(`Sendcloud: order ${order.number} already has shipment ${existing.id} for ${parcel.tracking_number}`);
    return existing.id;
  }

  const items = deliverableItems(order);
  // same as Swell refusing the items below
  if (!items.length) {
    console.log(`Sendcloud: order ${order.number} has nothing left to ship`);
    throw new ItemsAlreadyShipped('nothing left to ship');
  }

  const shipping = order.shipping || {};
  let shipment: any;
  try {
    shipment = await swell.post('/shipments', {
      order_id: order.id,
      items,
      destination: {
        name: shipping.name,
        first_name: shipping.first_name,
        last_name: shipping.last_name,
        address1: shipping.address1,
        address2: shipping.address2,
        city: shipping.city,
        state: shipping.state,
        zip: shipping.zip,
        country: shipping.country,
        phone: shipping.phone,
      },
      carrier: parcel.carrier?.code,
      carrier_name: parcel.carrier?.code,
      // the dashboard shows `service` in the shipment dialog, so use the readable method name, not the numeric id
      service: parcel.shipment?.name || (parcel.shipment?.id ? String(parcel.shipment.id) : undefined),
      service_name: parcel.shipment?.name,
      tracking_code: parcel.tracking_number,
      notes: `Sendcloud parcel ${parcel.id}${parcel.tracking_url ? `: ${parcel.tracking_url}` : ''}`,
      // Swell refuses items the order has no longer left to ship, so they can't be shipped twice
      $validate_items: true,
      // same notification Swell sends when a shipment is created in the dashboard; reuse returns earlier
      ...(options?.notify && { $notify: 'orders.shipped' }),
    });
  } catch (err) {
    // a refused write throws a SwellError with the errors in `body`
    const errors = validationErrors(err);
    // shipments locked by another write
    if (errors?.order_id) throw pending(order, errorText(errors));
    const refused = errors && itemsRefusal(errors);
    if (!refused) throw err;
    // a parallel webhook for this parcel shipped the items: use its shipment
    const [copy] = await findShipmentsByTracking(swell, order.id, parcel.tracking_number);
    if (copy) {
      console.log(`Sendcloud: order ${order.number} was shipped meanwhile; keeps shipment ${copy.id}`);
      return copy.id;
    }
    // saved shipments still leave every item: Swell counted a reservation of a write in progress
    if (await stillDeliverable(swell, order.id, items)) throw pending(order, refused);
    console.warn(`Sendcloud: Swell refused the shipment for order ${order.number}: ${refused}`);
    throw new ItemsAlreadyShipped(refused);
  }

  console.log(`Sendcloud: created shipment ${shipment.id} for order ${order.number}`);

  const copies = await findShipmentsByTracking(swell, order.id, parcel.tracking_number);
  const oldest = copies[0];
  if (oldest && oldest.id !== shipment.id) {
    await swell.put(`/shipments/${shipment.id}`, { canceled: true });
    console.log(`Sendcloud: canceled duplicate shipment ${shipment.id}; order ${order.number} keeps ${oldest.id}`);
    return oldest.id;
  }
  return shipment.id;
}
