/**
 * Optional demo helper (NOT part of check.sh) — Playwright storefront checkout
 * smoke against the LOCAL demo host (docs/demo-runbook.md T1).
 *
 * Usage:
 *   PW_PATH=/path/to/playwright node scripts/demo/storefront-checkout.cjs
 *
 * Requires: the ingress port-forward on 127.0.0.1:18080 and the /etc/hosts
 * entry (or run Playwright with --host-resolver-rules, which this script sets).
 * Never place real orders on a production store with it. No secrets here.
 */
const fs = require("node:fs");
const { chromium } = require(process.env.PW_PATH);

fs.mkdirSync(".tmp/dod", { recursive: true });

(async () => {
  const browser = await chromium.launch({
    args: ["--host-resolver-rules=MAP shop.urumi.test 127.0.0.1, MAP dashboard.urumi.test 127.0.0.1"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  // 1. Storefront catalog → product page
  await page.goto("http://shop.urumi.test:18080/shop/", { waitUntil: "networkidle", timeout: 45000 });
  const productLink = page.locator('a[href*="/product/"]').first();
  const href = await productLink.getAttribute("href");
  console.log("product link:", href);
  await productLink.click();
  await page.waitForLoadState("networkidle");

  // 2. Add to cart (classic single-product button)
  await page.locator('button[name="add-to-cart"], .single_add_to_cart_button').first().click();
  await page.waitForTimeout(1500);
  console.log("cart after add:", await page.locator(".cart-contents .amount, .wc-block-mini-cart__badge").first().textContent().catch(() => "(badge not found)"));

  // 3. Block checkout: contact + billing + COD
  await page.goto("http://shop.urumi.test:18080/checkout/", { waitUntil: "networkidle", timeout: 45000 });
  await page.fill("#email", "ada@example.test");
  await page.selectOption("#billing-country", "US");
  await page.fill("#billing-first_name", "Ada");
  await page.fill("#billing-last_name", "Lovelace");
  await page.fill("#billing-address_1", "1 Analytical Way");
  await page.fill("#billing-city", "San Francisco");
  await page.fill("#billing-postcode", "94105");
  await page.fill("#billing-phone", "5550100");
  await page.selectOption("#billing-state", "CA").catch(async () => {
    await page.fill("#billing-state", "CA");
  });
  await page.locator("#radio-control-wc-payment-method-options-cod").check();
  console.log("payment method: Cash on delivery selected");
  await page.screenshot({ path: ".tmp/dod/checkout-before-place-order.png", fullPage: true });

  // 4. Place order (block checkout button)
  await page.locator('button:has-text("Place order")').first().click();
  try {
    await page.waitForSelector('text=/thank you|order received|order number/i', { timeout: 60000 });
  } catch {
    console.log("NO CONFIRMATION. page tail:", JSON.stringify((await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "))).slice(-800)));
    throw new Error("order confirmation never appeared");
  }
  await page.waitForLoadState("networkidle");
  const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  console.log("confirmation url:", page.url());
  const m = body.match(/Order #: (\d+)/i) ?? body.match(/order number[:\s]*#?(\d+)/i) ?? url.match(/order-received\/(\d+)/);
  console.log("ORDER_ID:", m ? m[1] : "NOT_FOUND");
  console.log("confirmation text:", body.slice(body.toLowerCase().indexOf("thank"), body.toLowerCase().indexOf("thank") + 260));
  await page.screenshot({ path: ".tmp/dod/order-received.png", fullPage: true });
  console.log("page errors:", errors.length ? errors.join("; ") : "none");
  await browser.close();
})().catch((e) => {
  console.error("CHECKOUT FAIL:", e.message);
  process.exit(1);
});
