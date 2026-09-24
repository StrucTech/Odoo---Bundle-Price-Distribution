/** @odoo-module **/
/**
 * POS Bundle Pricing Fix vX — Odoo 19 Online
 * Fix 1: equal split when base_price=0
 * Fix 2: XHR intercept — distribute from parent price in payload
 * Fix 3: lock pricelist when cashier selects manually
 *         restore after customer selection via setPartner patch
 */

import { patch } from "@web/core/utils/patch";
import { ProductTemplate } from "@point_of_sale/app/models/product_template";
import { PosStore } from "@point_of_sale/app/services/pos_store";

console.log("[BundlePricing] vX loading...");

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------
const _bpPriceCache = new Map();           // combo_item_id → price (for packaging detection)
const _bpManualPricelist = new WeakMap();  // order → manually selected pricelist id

// ---------------------------------------------------------------------------
// Fix 1: getComboPrice — equal split when base_price = 0
// ---------------------------------------------------------------------------
patch(ProductTemplate.prototype, {
    getComboPrice(childLineConf = [], extraLineConf = [], pricelist = false) {
        const allZero =
            childLineConf.every(c => (c.combo_item_id?.combo_id?.base_price ?? 0) === 0) &&
            extraLineConf.every(c => (c.combo_item_id?.combo_id?.base_price ?? 0) === 0);

        if (!allZero) return super.getComboPrice(childLineConf, extraLineConf, pricelist);

        console.log("[BundlePricing] vX: equal split activated");

        const dp = this.models["decimal.precision"].getAll();
        const attrById = this.models["product.template.attribute.value"].getAllBy("id");
        const currency = this.config.currency_id;
        const PP = currency || dp.find(d => d.name === "Product Price");
        const parent = this.product_variant_ids[0];

        // Get parent price from active order pricelist
        let parentPrice = null;
        let pricelistToUse = pricelist;
        try {
            const activeOrder = posmodel?.selectedOrder;
            if (activeOrder?.pricelist_id) pricelistToUse = activeOrder.pricelist_id;
        } catch(e) {}

        if (pricelistToUse) {
            const computed = parent.getPrice(pricelistToUse, 1, 0, false, parent);
            if (computed && computed !== parent.lst_price) {
                parentPrice = computed;
                console.log(`[BP] parentPrice from pricelist "${pricelistToUse.name}": ${parentPrice}`);
            }
        }
        if (!parentPrice) {
            parentPrice = parent.lst_price || parent.getPrice(pricelistToUse, 1, 0, false, parent);
            console.log(`[BP] parentPrice fallback: ${parentPrice}`);
        }

        const getAttrExtra = (ids) =>
            (ids ?? []).filter(a => a?.attribute_id?.create_variant !== "always")
                .reduce((s, a) => s + (a?.price_extra || 0), 0);

        const conf = [...childLineConf];
        const last = conf[conf.length - 1];
        if (last?.qty > 1 && (last?.parentQty ?? 1) === 1) {
            last.qty -= 1;
            conf.push({ ...last, qty: 1 });
        }

        const isPackaging = (c) =>
            (c.combo_item_id?.combo_id?.name || '').toLowerCase().includes('ackag');

        const packagingConf = conf.filter(c => isPackaging(c));
        const pricedIncluded = conf.filter(c => !isPackaging(c));
        const pricedExtra = extraLineConf.filter(e => !isPackaging(e));
        const packagingExtra = extraLineConf.filter(e => isPackaging(e));
        const allPriced = [...pricedIncluded, ...pricedExtra];

        const totalQty = allPriced.reduce((s, c) => s + (c.qty || 1), 0);
        const share = totalQty > 0 ? parentPrice / totalQty : 0;
        let rem = parentPrice;
        const items = [];

        // Packaging → 0
        for (const c of [...packagingConf, ...packagingExtra]) {
            const item = c.combo_item_id;
            const qty = c.qty || 1;
            const attrIds = c.configuration?.attribute_value_ids?.map(id => attrById[id]);
            console.info(`  [BP] PACKAGING "${item.product_id?.display_name}" → 0`);
            _bpPriceCache.set(item.id, 0);
            items.push({
                combo_item_id: item, price_unit: 0,
                attribute_value_ids: attrIds || item.product_id?.product_template_attribute_value_ids,
                attribute_custom_values: c.configuration?.attribute_custom_values || {},
                qty,
            });
        }

        // Priced → equal split
        for (const c of allPriced) {
            const item = c.combo_item_id;
            const qty = c.qty || 1;
            const coef = c.parentQty || 1;
            let pu = PP.round(share * coef);
            rem -= (pu * qty) / coef;
            if (c === allPriced[allPriced.length - 1]) { pu += rem; rem = 0; }
            const attrIds = c.configuration?.attribute_value_ids?.map(id => attrById[id]);
            const total = pu + getAttrExtra(attrIds) + (item.extra_price || 0);
            console.info(`  [BP] "${item.product_id?.display_name}" ${pu} + ${item.extra_price} = ${total}`);
            _bpPriceCache.set(item.id, total);
            items.push({
                combo_item_id: item, price_unit: total,
                attribute_value_ids: attrIds || item.product_id?.product_template_attribute_value_ids,
                attribute_custom_values: c.configuration?.attribute_custom_values || {},
                qty,
            });
        }

        let seq = 0;
        const seqMap = this.combo_ids.reduce((acc, combo) => {
            combo.combo_item_ids.forEach(i => { acc[i.id] = seq++; });
            return acc;
        }, {});
        items.sort((a, b) => (seqMap[a.combo_item_id.id] ?? Infinity) - (seqMap[b.combo_item_id.id] ?? Infinity));

        console.log(`[BundlePricing] Done ✓ ${items.length} items | parent=${parentPrice}`);
        return items;
    }
});

// ---------------------------------------------------------------------------
// Fix 2 + Fix 3: PosStore patches
// ---------------------------------------------------------------------------
patch(PosStore.prototype, {
    // Fix 3a: lock pricelist when cashier manually selects
    async selectPricelist(pricelist) {
        const order = this.selectedOrder;
        const stack = new Error().stack || '';
        const isSystem = stack.includes('updatePricelistAndFiscalPosition') ||
                         stack.includes('setPartner');
        if (!isSystem && order && pricelist) {
            _bpManualPricelist.set(order, pricelist.id);
            console.log(`[BP] Manual pricelist locked: "${pricelist.name}"`);
        }
        return super.selectPricelist(...arguments);
    },

    // Fix 3b: restore manual pricelist after customer selection
    async setPartner(partner) {
        const order = this.selectedOrder;
        const manualId = _bpManualPricelist.get(order);
        const result = await super.setPartner(...arguments);
        if (manualId && order?.pricelist_id?.id !== manualId) {
            try {
                const manualPl = [...order.models['product.pricelist'].records.values()]
                    .find(p => p.id === manualId);
                if (manualPl) {
                    order.pricelist_id = manualPl;
                    console.log(`[BP] Pricelist restored after partner: "${manualPl.name}"`);
                }
            } catch(e) { console.warn('[BP] restore error:', e); }
        }
        return result;
    }
});

// ---------------------------------------------------------------------------
// Fix 2: XHR intercept — distribute parent price to children in payload
// ---------------------------------------------------------------------------
const _origOpen = XMLHttpRequest.prototype.open;
const _origSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__bpUrl = url;
    return _origOpen.call(this, method, url, ...rest);
};

XMLHttpRequest.prototype.send = function(body) {
    if (this.__bpUrl?.includes('sync_from_ui') && body) {
        try {
            const data = JSON.parse(body);
            const orders = data?.params?.args?.[0] || [];
            let modified = false;

            for (const order of orders) {
                const lines = order.lines || [];
                const parentMap = {};

                lines.forEach(line => {
                    const d = line[2];
                    if (!d) return;
                    if (Array.isArray(d.combo_line_ids) && d.combo_line_ids.length > 0) {
                        parentMap[d.uuid] = { parent: d, children: [] };
                    }
                });

                lines.forEach(line => {
                    const d = line[2];
                    if (!d?.combo_item_id || !d?.uuid) return;
                    for (const [, entry] of Object.entries(parentMap)) {
                        if (entry.parent.combo_line_ids?.includes(d.uuid)) {
                            entry.children.push(d);
                            break;
                        }
                    }
                });

                for (const [, entry] of Object.entries(parentMap)) {
                    const { parent, children } = entry;
                    if (!children.length) continue;

                    const parentPrice = parent.price_unit;
                    const isPackaging = (d) =>
                        _bpPriceCache.get(typeof d.combo_item_id === 'object'
                            ? d.combo_item_id?.id : d.combo_item_id) === 0;

                    const pricedChildren = children.filter(d => !isPackaging(d));
                    const packagingChildren = children.filter(d => isPackaging(d));
                    if (!pricedChildren.length) continue;

                    const getTaxRate = (d) => {
                        try {
                            const taxes = [...posmodel.models['account.tax'].records.values()];
                            const taxId = (d.tax_ids || []).flat(3).find(x => typeof x === 'number' && x > 10);
                            const tax = taxes.find(t => t.id === taxId);
                            return tax?.amount ? tax.amount / 100 : 0.14;
                        } catch(e) { return 0.14; }
                    };

                    const round2 = v => Math.round(v * 100) / 100;
                    const share = parentPrice / pricedChildren.length;
                    let rem = parentPrice;

                    packagingChildren.forEach(d => {
                        d.price_unit = 0; d.price_subtotal = 0; d.price_subtotal_incl = 0;
                        modified = true;
                    });

                    pricedChildren.forEach((d, i) => {
                        let pu = round2(share);
                        rem -= pu;
                        if (i === pricedChildren.length - 1) { pu += rem; rem = 0; }
                        const qty = d.qty || 1;
                        const rate = getTaxRate(d);
                        d.price_unit = pu;
                        d.price_subtotal = round2(pu * qty);
                        d.price_subtotal_incl = round2(d.price_subtotal * (1 + rate));
                        console.info(`[BP] XHR: "${d.full_product_name}" pu=${pu} sub=${d.price_subtotal} incl=${d.price_subtotal_incl}`);
                        modified = true;
                    });
                }
            }

            if (modified) {
                body = JSON.stringify(data);
                console.log("[BundlePricing] XHR payload fixed ✓");
            }
        } catch(e) {
            console.warn("[BundlePricing] XHR error:", e);
        }
    }
    return _origSend.call(this, body);
};

console.log("[BundlePricing] vX loaded OK ✓");
