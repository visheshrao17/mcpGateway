<?php
/** Chart-owned presentation and WooCommerce interactivity compatibility. */
add_action('wp_enqueue_scripts', function () {
    wp_enqueue_style('urumi-store', content_url('/urumi-store/store.css'), [], hash_file('sha256', WP_CONTENT_DIR . '/urumi-store/store.css'));
    // WooCommerce 11's cart module can load without a block initializing its REST root.
    // Register the missing state through WordPress, before script-module data is emitted.
    if (function_exists('wp_interactivity_state')) {
        wp_interactivity_state('woocommerce', ['restUrl' => get_rest_url()]);
    }
});
add_filter('woocommerce_product_tabs', function ($tabs) { unset($tabs['reviews']); return $tabs; });
add_filter('woocommerce_product_related_products_heading', fn() => 'A little more to explore');
add_filter('woocommerce_get_privacy_policy_text', function ($text, $type) {
    if ($type !== 'checkout') return $text;
    return 'Demo only. Your test details are stored with this demo order. No payment is collected and nothing is shipped. Read our [privacy_policy].';
}, 10, 2);
