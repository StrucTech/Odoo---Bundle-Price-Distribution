# Odoo POS – Bundle Price Distribution (`pos_bpx`)

An Odoo 19 Point of Sale add-on that fixes how the price of a combo (bundle) product is spread across its component lines, and keeps a pricelist chosen by the cashier from being overwritten when a customer is selected.

## Features

### 1. Equal price split for combos with no base price
When every combo in a bundle has `base_price = 0`, standard Odoo can't work out how to split the bundle price. This module overrides `ProductTemplate.getComboPrice` to:

- Take the bundle (parent) price from the order's active pricelist, falling back to the product's sales price.
- Split that price **equally** across the priced component lines, weighted by quantity. Any rounding remainder goes on the last line so the total matches exactly.
- Add attribute `price_extra` and combo item `extra_price` on top of each line's share.
- Price **packaging** lines at `0`. A line counts as packaging when its combo name contains "packaging" (case-insensitive).
- Keep component lines in the order the combo defines.

### 2. Correct line prices in the synced order payload
The module intercepts the POS `sync_from_ui` request and rewrites the payload before it is sent to the server. For each combo parent line it:

- Splits the parent `price_unit` equally across its priced child lines, again putting the rounding remainder on the last line.
- Sets packaging child lines to `0`.
- Recalculates `price_subtotal` and `price_subtotal_incl` from the line's tax rate.

### 3. Manual pricelist lock
- If the cashier picks a pricelist by hand, that choice is saved for the current order.
- Selecting a customer normally resets the pricelist to the customer's default. This module puts the cashier's choice back afterwards.

## Module structure

```
pos_bpx/
├── __init__.py
├── __manifest__.py
├── models/
│   └── __init__.py
├── views/
│   └── pos_order_views.xml
└── static/src/overrides/
    └── bpx.js          # all POS-side patches
```

## Requirements

- Odoo **19.0**
- Depends on: `web`, `point_of_sale`

## Installation

1. Copy the `pos_bpx` folder into your Odoo addons path (or add this repository to `addons_path`).
2. Restart the Odoo server.
3. Go to **Apps → Update Apps List**, search for **POS BPX** and click **Install**.
4. Open or reload the POS session so the new assets are loaded.

## Configuration

No settings are needed. To use the equal-split behavior:

- Set **Base Price = 0** on every combo in the bundle product.
- Put "Packaging" in the name of any combo whose items should be free (price `0`).

## Debugging

The module logs to the browser console with the prefixes `[BundlePricing]` and `[BP]`. On load you should see:

```
[BundlePricing] vX loading...
[BundlePricing] vX loaded OK ✓
```

## Known limitations

- The payload correction splits the parent price by the **number** of priced child lines and does not weight it by quantity.
- When a line's tax can't be found, the payload correction assumes a **14%** tax rate.
- Tax lookup in the payload only considers tax IDs greater than 10.
- Packaging lines are detected by combo name only.

## License

LGPL-3
