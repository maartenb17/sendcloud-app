import {
  CANCELED_STATUSES,
  NO_LABEL_STATUSES,
  SendcloudParcel,
  getAppData,
  getSendcloudSettings,
  getSignatureKey,
  toPythonJson,
  verifySignature,
} from './lib/sendcloud';

export const config: SwellConfig = {
  description: 'Receive Sendcloud parcel status updates',
  route: {
    methods: ['post'],
    public: true,
  },
};

export async function post(req: SwellRequest) {
  const { swell, appId } = req;
  const settings = await getSendcloudSettings(swell);

  const signature = req.headers.get('sendcloud-signature');
  const signatureKey = getSignatureKey(settings);

  // req.rawBody arrives re-serialized by the platform (pretty-printed JSON), not as the bytes
  // Sendcloud signed, so also try the serializations Sendcloud may have used.
  const parsedBody = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  const candidates: [string, unknown][] = [
    ['raw', req.rawBody],
    ['python', parsedBody !== undefined ? toPythonJson(parsedBody) : undefined],
    ['compact', parsedBody !== undefined ? JSON.stringify(parsedBody) : undefined],
  ];

  let verifiedWith: string | null = null;
  for (const [name, candidate] of candidates) {
    if (typeof candidate === 'string' && (await verifySignature(candidate, signature, signatureKey))) {
      verifiedWith = name;
      break;
    }
  }

  if (verifiedWith && verifiedWith !== 'raw') {
    console.log(`Sendcloud: signature verified against ${verifiedWith} JSON body`);
  }

  if (!verifiedWith) {
    const headerNames: string[] = [];
    req.headers.forEach((_value, name) => headerNames.push(name));

    // diagnostics only - no keys or payload contents
    console.warn('Sendcloud: invalid signature', {
      has_signature_header: Boolean(signature),
      signature_length: signature?.length ?? 0,
      has_signature_key: Boolean(signatureKey),
      raw_body_type: typeof req.rawBody,
      raw_body_length: typeof req.rawBody === 'string' ? req.rawBody.length : null,
      body_type: typeof req.body,
      body_json_length: typeof req.body === 'string' ? req.body.length : JSON.stringify(req.body ?? null).length,
      header_names: headerNames,
    });
    throw new SwellError('Invalid Sendcloud signature', { status: 401 });
  }

  const payload = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
    action?: string;
    timestamp?: number;
    parcel?: SendcloudParcel;
  };

  // integration_connected / integration_updated / ... are not needed
  if (payload.action !== 'parcel_status_changed' || !payload.parcel) {
    return { received: true };
  }

  const parcel = payload.parcel;

  if (!parcel.order_number) {
    return { received: true, order_found: false };
  }

  const orders = await swell.get('/orders', {
    where: { number: parcel.order_number },
    limit: 1,
  });
  const orderId = orders?.results?.[0]?.id;

  if (!orderId) {
    console.log(`Sendcloud: no order found for parcel ${parcel.id} (${parcel.order_number})`);
    return { received: true, order_found: false };
  }

  const order = orders.results[0];
  const appData = getAppData(order, appId);

  // track the first parcel created for the order; a new parcel replaces it only after it was canceled
  if (
    appData.sendcloud_parcel_id &&
    appData.sendcloud_parcel_id !== parcel.id &&
    !CANCELED_STATUSES.includes(appData.sendcloud_status_id)
  ) {
    console.log(`Sendcloud: parcel ${parcel.id} does not match order ${order.number} parcel ${appData.sendcloud_parcel_id}`);
    return { received: true, order_found: true, updated: false };
  }

  // webhooks can arrive out of order; skip anything older than the last applied update
  if (
    payload.timestamp &&
    appData.sendcloud_status_timestamp &&
    payload.timestamp < appData.sendcloud_status_timestamp
  ) {
    console.log(`Sendcloud: skipped out-of-order update for parcel ${parcel.id}`);
    return { received: true, order_found: true, updated: false };
  }

  const statusId = parcel.status?.id;
  const values: Record<string, any> = {
    sendcloud_parcel_id: parcel.id,
    sendcloud_status_id: statusId,
    sendcloud_status: parcel.status?.message,
    sendcloud_tracking_number: parcel.tracking_number || null,
    sendcloud_tracking_url: parcel.tracking_url || null,
    sendcloud_carrier: parcel.carrier?.code || null,
    ...(payload.timestamp && { sendcloud_status_timestamp: payload.timestamp }),
  };

  const isCanceled = statusId !== undefined && CANCELED_STATUSES.includes(statusId);
  const hasLabel =
    Boolean(parcel.tracking_number) &&
    statusId !== undefined &&
    !NO_LABEL_STATUSES.includes(statusId) &&
    !isCanceled;

  // a parcel for an order this app did not send still stores tracking, but must not create a second shipment
  const sentByApp = Boolean(appData.sendcloud_order_id);
  if (settings.create_fulfillment !== false && hasLabel && !appData.sendcloud_shipment_id && sentByApp) {
    const shipmentId = await createSwellShipment(swell, order, parcel);
    if (shipmentId) {
      values.sendcloud_shipment_id = shipmentId;
    }
  } else if (hasLabel && !sentByApp) {
    console.log(`Sendcloud: order ${order.number} was not sent by this app, not creating a shipment`);
  }

  if (isCanceled && appData.sendcloud_shipment_id) {
    await swell.put(`/shipments/${appData.sendcloud_shipment_id}`, { canceled: true });
    values.sendcloud_shipment_id = null;
    console.log(`Sendcloud: canceled shipment ${appData.sendcloud_shipment_id} for order ${order.number}`);
  }

  await swell.put(`/orders/${order.id}`, req.appValues(values));

  return { received: true, order_found: true, updated: true };
}

async function createSwellShipment(
  swell: SwellAPI,
  order: any,
  parcel: SendcloudParcel,
): Promise<string | null> {
  const items = (order.items || [])
    .filter((item: any) => item.delivery === 'shipment' && item.quantity_shipment_deliverable > 0)
    .map((item: any) => ({
      order_item_id: item.id,
      product_id: item.product_id,
      variant_id: item.variant_id,
      quantity: item.quantity_shipment_deliverable,
    }));

  if (!items.length) {
    console.log(`Sendcloud: order ${order.number} has nothing left to ship`);
    return null;
  }

  const shipping = order.shipping || {};
  const shipment = await swell.post('/shipments', {
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
  });

  console.log(`Sendcloud: created shipment ${shipment.id} for order ${order.number}`);
  return shipment.id;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
