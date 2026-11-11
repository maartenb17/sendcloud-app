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
import {
  ItemsAlreadyShipped,
  SHIPMENT_CREATED,
  SHIPPED_ELSEWHERE,
  ShipmentPending,
  createSwellShipment,
  itemsShippedNote,
} from './lib/shipments';

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

  // turned off: acknowledged without saving anything
  if (settings.enabled === false) {
    return { received: true, processed: false };
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
  let pendingError: ShipmentPending | undefined;
  if (settings.create_fulfillment !== false && hasLabel && !appData.sendcloud_shipment_id && sentByApp) {
    try {
      values.sendcloud_shipment_id = await createSwellShipment(swell, order, parcel, {
        notify: settings.notify_customer !== false,
      });
      values.sendcloud_shipment_status = SHIPMENT_CREATED;
      values.sendcloud_note = null;
    } catch (err) {
      if (err instanceof ItemsAlreadyShipped) {
        values.sendcloud_shipment_status = SHIPPED_ELSEWHERE;
        values.sendcloud_note = itemsShippedNote(err.message);
      } else if (err instanceof ShipmentPending) {
        pendingError = err;
      } else {
        throw err;
      }
    }
  } else if (hasLabel && !sentByApp) {
    console.log(`Sendcloud: order ${order.number} was not sent by this app, not creating a shipment`);
  }

  if (isCanceled) {
    values.sendcloud_shipment_status = null;
    values.sendcloud_note = null;
    if (appData.sendcloud_shipment_id) {
      await swell.put(`/shipments/${appData.sendcloud_shipment_id}`, { canceled: true });
      values.sendcloud_shipment_id = null;
      console.log(`Sendcloud: canceled shipment ${appData.sendcloud_shipment_id} for order ${order.number}`);
    }
  }

  await swell.put(`/orders/${order.id}`, req.appValues(values));

  // tracking is saved; an error response lets the shipment be retried by a resent or the next webhook
  if (pendingError) {
    console.warn(`Sendcloud: ${pendingError.message}`);
    throw new SwellError(pendingError.message, { status: 503 });
  }

  return { received: true, order_found: true, updated: true };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
