/**
 * Optional demo helper (NOT part of check.sh) — Playwright check that the
 * browser-placed order is visible in WooCommerce admin (docs/demo-runbook.md T2).
 *
 * Usage:
 *   WP_ADMIN_PW=$(kubectl -n urumi get secret urumi-secrets \
 *     -o jsonpath='{.data.WORDPRESS_ADMIN_PASSWORD}' | base64 -d) \
 *   PW_PATH=/path/to/playwright node scripts/demo/wp-admin-orders-check.cjs
 *
 * The WordPress admin password arrives via the WP_ADMIN_PW environment
 * variable and is never printed, logged or asserted on.
 */
const fs = require("node:fs");
const { chromium } = require(process.env.PW_PATH);

fs.mkdirSync(".tmp/dod", { recursive: true });

(async () => {
  const password = process.env.WP_ADMIN_PW;
  if (!password) throw new Error("WP_ADMIN_PW not set");
  const browser = await chromium.launch({
    args: ["--host-resolver-rules=MAP shop.urumi.test 127.0.0.1"],
  });
  const page = await browser.newPage();
  await page.goto("http://shop.urumi.test:18080/wp-login.php", { waitUntil: "networkidle", timeout: 45000 });
  await page.fill("#user_login", "admin");
  await page.fill("#user_pass", password);
  await page.locator("#wp-submit").click();
  await page.waitForLoadState("networkidle");
  console.log("after login url:", page.url());

  // WooCommerce orders screen (HPOS-first, legacy fallback)
  for (const url of [
    "http://shop.urumi.test:18080/wp-admin/admin.php?page=wc-orders",
    "http://shop.urumi.test:18080/wp-admin/edit.php?post_type=shop_order",
  ]) {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
    const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
    const hasOrder = /#?17\b/.test(text) && /Ada|Lovelace|ada@example\.test/i.test(text);
    console.log("orders screen:", url.split("?")[1], "| mentions #17 + customer:", hasOrder);
    if (hasOrder) {
      const idx = text.search(/#?17\b/);
      console.log("evidence:", text.slice(Math.max(0, idx - 80), idx + 160));
      await page.screenshot({ path: ".tmp/dod/wp-admin-orders.png", fullPage: true });
      break;
    }
  }
  await browser.close();
})().catch((e) => { console.error("WP-ADMIN FAIL:", e.message); process.exit(1); });
