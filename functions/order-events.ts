import {
  SendcloudError,
  buildOrder,
  deleteOrder,
  getAppData,
  getSendcloudSettings,
  getWeightUnit,
  hasCredentials,
  isTestOrder,
  shippableItems,
  upsertOrder,
} from './lib/sendcloud';

export const config: SwellConfig = {
  description: 'Send orders to Sendcloud and remove them when canceled',
  model: {
    events: ['order.submitted', 'order.paid', 'order.canceled'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data, appId } = req;
  const eventType = data.$event?.type;
  const orderId: string = data.id;

  const settings = await getSendcloudSettings(swell);

  if (settings.enabled === false) {
    return;
  }

  if (!hasCredentials(settings)) {
    console.error('Sendcloud: missing required settings (public_key, secret_key, integration_id)');
    return;
  }

  const order = await swell.get(`/orders/${orderId}`, {
    expand: ['account', 'items.product', 'items.variant'],
  });

  if (!order) {
    console.error(`Sendcloud: order ${orderId} not found`);
    return;
  }

  const appData = getAppData(order, appId);

  if (eventType === 'order.canceled') {
    if (appData.sendcloud_order_id) {
      try {
        await deleteOrder(settings, appData.sendcloud_order_id);
        console.log(`Sendcloud: removed order ${order.number} from Sendcloud incoming orders`);
      } catch (err) {
        // 404/410: order already gone
        if (err instanceof SendcloudError && [404, 410].includes(err.status)) {
          return;
        }
        throw err;
      }
    }
    return;
  }

  const syncEvent = settings.sync_on === 'submitted' ? 'order.submitted' : 'order.paid';
  if (eventType !== syncEvent) {
    return;
  }

  if (settings.skip_test_orders === true && isTestOrder(order)) {
    console.log(`Sendcloud: order ${order.number} is a test order, skipping`);
    return;
  }

  if (appData.sendcloud_order_id) {
    console.log(`Sendcloud: order ${order.number} already sent as Sendcloud order ${appData.sendcloud_order_id}`);
    return;
  }

  if (!shippableItems(order).length) {
    console.log(`Sendcloud: order ${order.number} has no shippable items, skipping`);
    return;
  }

  if (!order.shipping?.address1 || !order.shipping?.country) {
    await swell.put(`/orders/${orderId}`, req.appValues({ sendcloud_error: 'Missing shipping address' }));
    return;
  }

  try {
    const weightUnit = await getWeightUnit(swell);
    const created = await upsertOrder(settings, buildOrder(order, settings, weightUnit));

    await swell.put(
      `/orders/${orderId}`,
      req.appValues({
        sendcloud_order_id: created?.id,
        sendcloud_status: 'Sent to Sendcloud',
        sendcloud_error: null,
      }),
    );

    console.log(`Sendcloud: sent order ${order.number} as Sendcloud order ${created?.id}`);
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error(`Sendcloud: failed to send order ${order.number} - ${message}`);
    await swell.put(`/orders/${orderId}`, req.appValues({ sendcloud_error: message }));

    // 4xx means the order data or credentials are wrong; retrying won't help
    if (err instanceof SendcloudError && err.status < 500) {
      return;
    }
    throw err;
  }
}
