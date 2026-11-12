import {
  INVOICE_WINDOW_MS,
  ORDER_EXPAND,
  SendcloudError,
  WAITING_FOR_INVOICE,
  WAITING_FOR_OVERDUE,
  deleteOrder,
  earlierInvoiceInArrears,
  getAppData,
  getSendcloudSettings,
  hasCredentials,
  hasSeparateOrderSchedule,
  isCanceledOrder,
  isSubscriptionCanceled,
  isTestOrder,
  orderClosestToInvoice,
  pushOrder,
  shippableItems,
  subscriptionInArrears,
} from './lib/sendcloud';
import { syncOrder } from './lib/sync-order';

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
      'subscription.updated',
    ],
  },
};

export default async function (req: SwellRequest) {
  const eventType = req.data.$event?.type;
  if (eventType === 'subscription.updated') {
    return handleSubscription(req);
  }
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

  if (eventType === 'order.canceled') {
    const appData = getAppData(order, appId || 'sendcloud');
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

  const outcome = await syncOrder(swell, settings, order, appId || 'sendcloud', (data) => req.appValues(data));
  if (outcome.status === 'failed' && outcome.retry) {
    throw outcome.error;
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
  if (invoice.status === 'paid') {
    const subscription = await swell.get(`/subscriptions/${invoice.subscription_id}`);
    if (hasSeparateOrderSchedule(subscription)) {
      await releaseHeldOrders(req, settings, subscription, invoice.subscription_id);
      return;
    }
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

async function handleSubscription(req: SwellRequest) {
  const { swell, data } = req;
  const settings = await getSendcloudSettings(swell);
  if (settings.hold_separate_order_schedule !== true || settings.enabled === false) {
    return;
  }
  if (!hasCredentials(settings)) {
    console.error('Sendcloud: missing required settings (public_key, secret_key, integration_id)');
    return;
  }
  if (!data?.id) {
    return;
  }
  const subscription = await swell.get(`/subscriptions/${data.id}`);
  await releaseHeldOrders(req, settings, subscription, data.id);
}

async function releaseHeldOrders(req: SwellRequest, settings: Awaited<ReturnType<typeof getSendcloudSettings>>, subscription: any, subscriptionId: string) {
  if (!hasSeparateOrderSchedule(subscription)) {
    return;
  }
  const { swell } = req;
  const [invoiceList, orderList] = await Promise.all([
    swell.get('/invoices', {
      where: { subscription_id: subscriptionId },
      sort: 'date_created asc',
      limit: 100,
    }),
    swell.get('/orders', {
      where: { subscription_id: subscriptionId },
      limit: 100,
      expand: ORDER_EXPAND,
    }),
  ]);
  const invoices = invoiceList?.results || [];
  for (const order of orderList?.results || []) {
    const appData = getAppData(order, req.appId || 'sendcloud');
    if (appData.sendcloud_order_id) {
      continue;
    }
    if (appData.sendcloud_status !== WAITING_FOR_INVOICE && appData.sendcloud_status !== WAITING_FOR_OVERDUE) {
      continue;
    }
    await settleHeldOrder(req, settings, subscription, invoices, order);
  }
}

async function settleHeldOrder(req: SwellRequest, settings: Awaited<ReturnType<typeof getSendcloudSettings>>, subscription: any, invoices: any[], order: any) {
  const { swell } = req;
  const appData = getAppData(order, req.appId || 'sendcloud');
  if (subscription?.order_id && subscription.order_id === order.id) {
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
  if (isSubscriptionCanceled(subscription)) {
    console.log(`Sendcloud: order ${order.number} subscription is canceled, skipping`);
    return;
  }

  const own = invoices.find((invoice) => invoice.id === appData.sendcloud_invoice_id);
  if (!own || own.status !== 'paid') {
    return;
  }
  if (subscriptionInArrears(subscription) || earlierInvoiceInArrears(own, invoices)) {
    if (appData.sendcloud_status !== WAITING_FOR_OVERDUE) {
      await swell.put(
        `/orders/${order.id}`,
        req.appValues({
          sendcloud_status: WAITING_FOR_OVERDUE,
          sendcloud_invoice_id: own.id,
          sendcloud_error: null,
        }),
      );
    }
    console.log(`Sendcloud: order ${order.number} is waiting for overdue payments`);
    return;
  }
  if (!shippableItems(order).length || !order.shipping?.address1 || !order.shipping?.country) {
    return;
  }

  try {
    const created = await pushOrder(swell, settings, order, (values) => req.appValues(values), {
      sendcloud_invoice_id: own.id,
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
