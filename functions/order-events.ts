import {
  INVOICE_WINDOW_MS,
  ORDER_EXPAND,
  SendcloudError,
  WAITING_FOR_INVOICE,
  deleteOrder,
  getAppData,
  getSendcloudSettings,
  hasCredentials,
  hasSeparateOrderSchedule,
  isCanceledOrder,
  isTestOrder,
  orderClosestToInvoice,
  pushOrder,
  renewalInvoice,
  shippableItems,
} from './lib/sendcloud';

export const config: SwellConfig = {
  description: 'Send orders to Sendcloud and remove them when canceled',
  model: {
    events: [
      'order.submitted',
      'order.paid',
      'order.canceled',
      'invoice.created',
      'invoice.payment_succeeded',
      'subscription.invoiced',
    ],
  },
};

export default async function (req: SwellRequest) {
  const eventType = req.data.$event?.type;
  if (
    eventType === 'invoice.created' ||
    eventType === 'invoice.payment_succeeded' ||
    eventType === 'subscription.invoiced'
  ) {
    return handleInvoice(req);
  }
  return handleOrder(req);
}

async function handleOrder(req: SwellRequest) {
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

  const order = await swell.get(`/orders/${orderId}`, { expand: ORDER_EXPAND });
  if (!order) {
    console.error(`Sendcloud: order ${orderId} not found`);
    return;
  }

  const appData = getAppData(order, appId || 'sendcloud');

  if (eventType === 'order.canceled') {
    if (appData.sendcloud_order_id) {
      try {
        await deleteOrder(settings, appData.sendcloud_order_id);
        console.log(`Sendcloud: removed order ${order.number} from Sendcloud incoming orders`);
      } catch (err) {
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
  if (isCanceledOrder(order)) {
    console.log(`Sendcloud: order ${order.number} is canceled, skipping`);
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

  let invoiceId: string | undefined;
  if (settings.hold_separate_order_schedule === true) {
    const decision = await renewalInvoice(swell, appId || 'sendcloud', order);
    if (decision.applies && decision.invoice?.status !== 'paid') {
      await swell.put(
        `/orders/${orderId}`,
        req.appValues({
          sendcloud_status: WAITING_FOR_INVOICE,
          ...(decision.invoice?.id && { sendcloud_invoice_id: decision.invoice.id }),
          sendcloud_error: null,
        }),
      );
      console.log(`Sendcloud: order ${order.number} is waiting for invoice payment`);
      return;
    }
    invoiceId = decision.invoice?.id;
  }

  try {
    const created = await pushOrder(swell, settings, order, (data) => req.appValues(data), 
      invoiceId ? { sendcloud_invoice_id: invoiceId } : {},
    );
    console.log(`Sendcloud: sent order ${order.number} as Sendcloud order ${created?.id}`);
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error(`Sendcloud: failed to send order ${order.number} - ${message}`);
    await swell.put(`/orders/${orderId}`, req.appValues({ sendcloud_error: message }));
    if (err instanceof SendcloudError && err.status < 500) {
      return;
    }
    throw err;
  }
}

async function handleInvoice(req: SwellRequest) {
  const { swell, data, appId } = req;
  const settings = await getSendcloudSettings(swell);
  if (settings.hold_separate_order_schedule !== true || settings.enabled === false) {
    return;
  }
  if (!hasCredentials(settings)) {
    console.error('Sendcloud: missing required settings (public_key, secret_key, integration_id)');
    return;
  }

  const invoice = await loadInvoice(swell, data);
  if (!invoice?.id || !invoice.subscription_id) {
    return;
  }

  const resolvedAppId = appId || 'sendcloud';
  const holders = await swell.get('/orders', {
    where: { [`$app.${resolvedAppId}.sendcloud_invoice_id`]: invoice.id },
    sort: 'date_created asc',
    limit: 5,
    expand: ORDER_EXPAND,
  });
  const linked = holders?.results || [];
  if (linked.length > 1) {
    console.log(`Sendcloud: invoice ${invoice.id} is linked to more than one order; using the earliest`);
  }
  const order = linked[0] || (await orderToLink(swell, invoice));
  if (!order) {
    return;
  }
  const appData = getAppData(order, resolvedAppId);
  if (appData.sendcloud_order_id) {
    return;
  }
  if (settings.skip_test_orders === true && isTestOrder(order)) {
    console.log(`Sendcloud: order ${order.number} is a test order, skipping`);
    return;
  }
  if (isCanceledOrder(order)) {
    console.log(`Sendcloud: order ${order.number} is canceled, skipping`);
    return;
  }
  if (invoice.status !== 'paid') {
    await swell.put(
      `/orders/${order.id}`,
      req.appValues({
        sendcloud_status: WAITING_FOR_INVOICE,
        sendcloud_invoice_id: invoice.id,
        sendcloud_error: null,
      }),
    );
    console.log(`Sendcloud: order ${order.number} is waiting for invoice payment`);
    return;
  }
  if (!shippableItems(order).length || !order.shipping?.address1 || !order.shipping?.country) {
    return;
  }

  try {
    const created = await pushOrder(swell, settings, order, (values) => req.appValues(values), {
      sendcloud_invoice_id: invoice.id,
    });
    console.log(`Sendcloud: sent order ${order.number} as Sendcloud order ${created?.id}`);
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error(`Sendcloud: failed to send order ${order.number} - ${message}`);
    await swell.put(`/orders/${order.id}`, req.appValues({ sendcloud_error: message }));
    if (err instanceof SendcloudError && err.status < 500) {
      return;
    }
    throw err;
  }
}

async function loadInvoice(swell: SwellAPI, data: any): Promise<any | null> {
  if (data.$event?.type === 'subscription.invoiced') {
    const found = await swell.get('/invoices', {
      where: { subscription_id: data.id },
      sort: 'date_created desc',
      limit: 1,
    });
    return found?.results?.[0] || null;
  }
  return (await swell.get(`/invoices/${data.id}`)) || null;
}

async function orderToLink(swell: SwellAPI, invoice: any): Promise<any | null> {
  const subscription = await swell.get(`/subscriptions/${invoice.subscription_id}`);
  if (!hasSeparateOrderSchedule(subscription)) {
    return null;
  }
  const center = new Date(invoice.date_created).getTime();
  if (!Number.isFinite(center)) {
    return null;
  }
  const around = await swell.get('/orders', {
    where: {
      subscription_id: invoice.subscription_id,
      date_created: {
        $gte: new Date(center - INVOICE_WINDOW_MS).toISOString(),
        $lte: new Date(center + INVOICE_WINDOW_MS).toISOString(),
      },
    },
    limit: 50,
    expand: ORDER_EXPAND,
  });
  const candidates = (around?.results || []).filter((entry: any) => entry.id !== subscription.order_id);
  return orderClosestToInvoice(invoice, candidates);
}
