# Sendcloud for Swell

Send Swell orders to [Sendcloud](https://www.sendcloud.com) and get tracking back. Orders show up in Sendcloud's **Incoming Orders**, where you create labels. When a label is created, the app saves the tracking on the order and fulfills it in Swell.

## Features

- **Orders to Sendcloud:** when an order is paid (or submitted, see settings) and has items to ship, it's sent to Sendcloud through the v3 Orders API (`POST /api/v3/orders`). It includes the shipping and billing address, customer, line items with SKU, prices and weights, order totals, and the checkout shipping service name. Product and variant names use the customer's language (`account.locale`, then `order.display_locale`, then `account.display_locale`). An order created in the dashboard often has no language of its own; the account's locale preference is used instead. With no language, Swell returns the store language. When **Show the subscription plan on the packing slip** is on, a subscription item's name also includes the plan in that language, as `Product name (plan)`. The plan is read from the product in that same language when the plan record itself cannot be loaded. A one-off item is unchanged. When **Show bundle components on the packing slip** is on, a bundle line is replaced by its components, as `Bundle name → Component name`, with the plan still on the bundle name. The order total and the parcel weight stay the same. An order is sent once automatically.
- **Canceled orders:** when a Swell order is canceled, it's removed from Sendcloud's Incoming Orders. A canceled order is not sent, including when its invoice is paid afterwards. Swell sets both `status: "canceled"` and `canceled: true`; either one is enough.
- **Tracking back to Swell:** Sendcloud's `parcel_status_changed` webhook updates the order with the parcel status, tracking number, tracking link and carrier. Requests are verified with the `Sendcloud-Signature` HMAC header, and updates that arrive out of order are ignored.
- **Fulfillment:** once a parcel has a label, the app creates a Swell shipment with the carrier and tracking number for everything still to be shipped. If the parcel is later canceled, that shipment is canceled too.
- **Order tab:** a **Sendcloud** tab on the order page shows the Sendcloud order ID, status, parcel ID, carrier, tracking number, tracking link, the invoice a shipment is waiting on, and the last error. **Send to Sendcloud** on that page, and the same bulk action in the order list (up to 10), sends an order that was skipped or failed, sends a test order or an order waiting for its invoice or for overdue payments, and updates an order that is already in Sendcloud but has no label. Sending while waiting leaves a note on the order. It skips an order that is not paid or is canceled. A paid renewal of €0 still sends. The request uses the Swell order ID, so Sendcloud updates that Incoming Order instead of creating a second one. An order that already has a label is left as it is.
- **Webhook URL pattern in settings:** the settings show the webhook URL pattern as a read-only value: `https://{store-id}:{public-key}@{store-id}.swell.store/functions/sendcloud/sendcloud-webhook`.

## Settings

All credentials and options are app settings (`settings/sendcloud.json`). Nothing is hard-coded.

| Setting | Required | Default | Description |
|---|---|---|---|
| Public Key | yes | | Public key of your Sendcloud API integration. |
| Secret Key | yes | | Secret key of the same integration. Also verifies webhook signatures. |
| Integration ID | yes | | ID of the Sendcloud API integration. Orders are created under it. Shown at the end of the integration's URL in the Sendcloud panel. |
| Webhook URL | read-only | `https://{store-id}:{public-key}@{store-id}.swell.store/functions/sendcloud/sendcloud-webhook` | The URL pattern. Replace `{store-id}` and `{public-key}` before pasting it into Sendcloud. |
| Webhook Signature Key | no | | Only if your Sendcloud integration shows a separate Webhook Signature Key. Otherwise the Secret Key is used. |
| Send orders to Sendcloud when | no | Order is paid | `Order is paid` (`order.paid`) or `Order is submitted` (`order.submitted`). |
| Skip test orders | no | off | Skip orders with boolean `order.test`. A store can also mark an order with boolean `metadata.test`; that flag is optional and is treated the same way. |
| Hold orders from a separate order schedule until their invoice is paid | no | off | For an order of a subscription whose `order_schedule` differs from `billing_schedule`, wait until that shipment's invoice has status `paid` and the subscription has no arrears. Arrears means subscription status `pastdue` or `unpaid`, or an earlier invoice with status `pending` or `unpaid`. A `void` invoice is ignored. The order then stays at "Waiting for overdue payments". Paying any invoice of that subscription, or a subscription update, rechecks every waiting order of the subscription. The order that created the subscription (`subscription.order_id`) is not held. No invoice yet, or status `pending` or `void` on the shipment's own invoice, keeps the order at "Waiting for invoice payment". A plan with no `order_schedule`, including a yearly plan, is not held. A canceled subscription is never sent. |
| Show the subscription plan on the packing slip | no | off | Append the plan to a subscription item's name, in the customer's language. One-off items are unchanged. |
| Show bundle components on the packing slip | no | off | Replace a bundle line with one line per component: `Bundle name → Component name`. The plan stays on the bundle name. The order total and the parcel weight stay the same. |
| Default shipping option code | no | | Preselects a Sendcloud shipping option on each order, e.g. `postnl:standard`. |
| Default parcel weight (kg) | no | 1 | Used when the order's items have no shipment weight. |
| Create Swell shipment when label is created | no | on | Fulfill the Swell order with the Sendcloud tracking number. |
| Enabled | no | on | Turns off sending orders and cancellations without uninstalling the app. |

## Setup

1. In Sendcloud, go to **Settings → Integrations** and add a **Sendcloud API** integration. Copy its public and secret keys.
2. Install the app in Swell and open its settings. Enter the **Public Key**, **Secret Key** and **Integration ID**.
3. Build the webhook URL from the pattern in the app settings, `https://{store-id}:{public-key}@{store-id}.swell.store/functions/sendcloud/sendcloud-webhook`. Replace `{store-id}` with your store ID and `{public-key}` with your Swell public key (Developer → API keys). Use the live key for the live environment and the test key for test.
4. In the Sendcloud integration, paste the URL into **Webhook URL**, turn on **webhook feedback**, and save. **Test API Webhook** should return 200.
5. Place a test order and pay it. It should appear in Sendcloud's Incoming Orders, and its Sendcloud tab in Swell should show a Sendcloud order ID.
6. Create a label in Sendcloud. The Swell order should get the tracking number and a shipment.

## How it works

| Function | Trigger | What it does |
|---|---|---|
| `functions/order-events.ts` | `order.submitted`, `order.paid`, `order.canceled`, `invoice.created`, `invoice.payment_succeeded`, `subscription.invoiced`, `subscription.updated` | Sends the order to Sendcloud on the event chosen in settings. Holds a separate-schedule shipment until its own invoice is paid and the subscription has no overdue invoice. Rechecks every waiting order of that subscription when any of its invoices is paid or the subscription is updated. Deletes the Sendcloud order on cancel. |
| `functions/send-to-sendcloud.ts` | Admin action on one order or a bulk selection | Sends or updates the selected orders. Reports, per order, whether it was sent, updated, skipped or failed. |
| `functions/sendcloud-webhook.ts` | Public route, `POST` | Receives Sendcloud webhooks and updates the order and shipment. |
| `functions/lib/sendcloud.ts` | Shared | Sendcloud API client, Swell order to Sendcloud order mapping, signature check. |

Data stored on each order under `$app.sendcloud` (`models/orders.json`): `sendcloud_order_id`, `sendcloud_parcel_id`, `sendcloud_status_id`, `sendcloud_status`, `sendcloud_status_timestamp`, `sendcloud_tracking_number`, `sendcloud_tracking_url`, `sendcloud_carrier`, `sendcloud_shipment_id`, `sendcloud_invoice_id`, `sendcloud_error`.

**Weights:** Swell item weights are line totals in the store's weight unit (`/settings/shipments` → `weight_unit`, default `lb`). They're converted to kg per unit for each item and summed for the whole order.

**House numbers:** Sendcloud needs the street and house number separately. The first address line is split on a leading number (`417 Montgomery St`) or a trailing one (`Stationsstraat 12A`). If neither matches, the whole line is sent as the street.

## Limits

- **No label creation:** the app doesn't create labels itself. Labels are created in Sendcloud. Sendcloud's v2 Parcels API is blocked for newer accounts, and v3 labels need the Shipments API, which isn't implemented yet.
- **No checkout rates:** customers don't see Sendcloud shipping rates at checkout. That needs a separate shipping extension.
- **One parcel per order:** only one parcel is tracked per order. A second parcel replaces the first only after the first is canceled. Multi-parcel (multicollo) shipments aren't tracked separately.
- **Order matching:** webhook updates are matched to Swell orders by order number.
- **Cancel doesn't cancel labels:** canceling a Swell order removes it from Sendcloud's Incoming Orders but doesn't cancel a label that was already created.
- **Currencies:** Sendcloud's v3 Orders API documents only EUR, GBP and USD prices. Orders in other currencies may be rejected, and the error is shown on the order.
- **Retries:** errors from Sendcloud are saved to the order's `sendcloud_error`. Only Sendcloud 5xx errors are retried by the platform. A 4xx error, a skipped test order, or an order still waiting for its invoice or for overdue payments is not retried on its own. **Send to Sendcloud** sends it again and notes that the wait was skipped. That button updates an order already in Sendcloud when it has no label, and does nothing when a label already exists. Model-event functions that keep failing are turned off by the platform after about 4 days.

## Development

Needs the [Swell CLI](https://developers.swell.is/cli) (`swell login`) and Node 20+.

```bash
npm install
swell app dev          # run functions locally against the test environment
npm test               # vitest: unit tests + read-only integration tests
npm run typecheck
swell app push         # deploy to the store's test environment
swell inspect functions --app=.
swell logs --type function -s sendcloud
```

- **Unit tests** (`test/unit/`) mock Swell and Sendcloud (`fetch`) and cover every function and the shared library.
- **Integration tests** (`test/integration/`) are read-only and use your `swell login` session against the test store.
- **CLI test scaffold:** it pins `vitest` 3.2 but asks for the latest `@cloudflare/vitest-pool-workers`, which now needs vitest 4. The pool is pinned to `~0.12.21`, the last version that works with vitest 3.2.
- **Public route URL:** the webhook only responds after `swell app push`. Under `swell app dev` it isn't reachable publicly.
- **Webhook URL:** Sendcloud reaches the route at `https://{store-id}:{public-key}@{store-id}.swell.store/functions/sendcloud/sendcloud-webhook`. That's the store host, with no `/api`, and the key in the URL. Without a key the request returns 404.
- **Webhook signatures:** the platform doesn't pass the original request bytes to the function. `req.rawBody` arrives re-serialized as `JSON.stringify(body, null, 2)`. So the handler also checks the signature against the parsed body serialized the way Python's `json.dumps()` does it (`toPythonJson`), and against compact JSON. It logs which one matched. Numbers that Sendcloud sends as floats with a trailing `.0` can't be rebuilt exactly and would fail verification.

Listing assets: `assets/screenshots/*.png` are 3200×1800 listing images that show the Swell dashboard (light theme) with the app on a sample store ("Alder & Co."), referenced from `images` in `swell.json`. `assets/icon.png` is Sendcloud's official app icon (from sendcloud.com), made full-bleed at 512×512, and `assets/image.png` is a 1200×630 social card.
