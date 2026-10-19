<?php
// This script runs inside WP-CLI after WooCommerce is active.
function urumi_post($type, $slug, $title, $content, $theme = false) {
    $query = ['post_type' => $type, 'name' => $slug, 'post_status' => 'any', 'numberposts' => 1];
    if ($theme) $query['tax_query'] = [['taxonomy' => 'wp_theme', 'field' => 'slug', 'terms' => 'twentytwentyfive']];
    $found = get_posts($query);
    $id = $found ? $found[0]->ID : 0;
    $data = ['post_type' => $type, 'post_name' => $slug, 'post_title' => $title, 'post_content' => $content, 'post_status' => 'publish'];
    if (!$id || array_diff_assoc($data, array_intersect_key((array) get_post($id), $data))) {
        $id = wp_insert_post(wp_slash(['ID' => $id] + $data), true);
        if (is_wp_error($id)) WP_CLI::error($id->get_error_message());
    }
    if ($theme) wp_set_object_terms($id, 'twentytwentyfive', 'wp_theme');
    return $id;
}
function urumi_html($html) { return "<!-- wp:html -->\n$html\n<!-- /wp:html -->"; }
$categories = [];
foreach (['tea-coffee' => 'Tea & coffee', 'textiles' => 'Textiles', 'gifting' => 'Gifting'] as $slug => $name) {
    $term = get_term_by('slug', $slug, 'product_cat');
    $result = $term ? ['term_id' => $term->term_id] : wp_insert_term($name, 'product_cat', ['slug' => $slug]);
    if (is_wp_error($result)) WP_CLI::error($result->get_error_message());
    $categories[$slug] = (int) $result['term_id'];
}
$catalog = [
    ['UR-MUG', 'urumi-mug', 'Urumi Mug', '499', 'tea-coffee', 'A little pause for your everyday ritual.', 'A terracotta-coloured mug illustration with a simple curved motif. Pair this demo item with a chai tin or coffee pack as you explore the collection.'],
    ['UR-TEE', 'urumi-t-shirt', 'Urumi T-shirt', '999', 'textiles', 'An everyday staple in forest green.', 'A forest-green T-shirt illustration carrying the URUMI wordmark. A sample wardrobe item for exploring product discovery and checkout.'],
    ['UR-CHAI', 'masala-chai-tin', 'Masala Chai Tin', '349', 'tea-coffee', 'Make room for a chai break.', 'A warm terracotta tin illustrated with a cream label and a leaf motif. Explore this sample tea item alongside the Urumi Mug.'],
    ['UR-COFFEE', 'filter-coffee-pack', 'Filter Coffee Pack', '499', 'tea-coffee', 'For the slow-start kind of morning.', 'A coffee pack illustration with a forest-green label and coffee-bean detail. A sample pantry item in our Tea & coffee collection.'],
    ['UR-TOTE', 'handloom-tote-bag', 'Handloom Tote Bag', '799', 'textiles', 'A useful companion for everyday things.', 'An olive tote illustration with loop handles and a geometric motif. Explore this sample accessory alongside the other textiles.'],
    ['UR-DIYA', 'brass-diya-set', 'Brass Diya Set', '1299', 'gifting', 'A small spark for an occasion.', 'Four golden diya illustrations with warm terracotta flames. A sample gift idea in the Urumi demo collection.'],
    ['UR-CUSHION', 'block-print-cushion-cover', 'Block-Print Cushion Cover', '649', 'textiles', 'A warm accent for a favourite corner.', 'A cushion illustration in terracotta with a repeating cream leaf pattern. A sample home textile for browsing and test orders.'],
    ['UR-CERAMIC', 'ceramic-mug-set', 'Ceramic Mug Set', '999', 'tea-coffee', 'A shared moment, two cups.', 'Two mug illustrations in olive and clay, each with a cream stripe. A sample pair to explore alongside our tea and coffee.'],
    ['UR-HAMPER', 'festive-gift-hamper', 'Festive Gift Hamper', '2499', 'gifting', 'A thoughtful-looking bundle for an occasion.', 'A gift-box illustration with tea, coffee and a terracotta ribbon. A sample festive bundle for trying the gifting collection.'],
];
require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';
$products = []; $images = [];
foreach ($catalog as [$sku, $slug, $name, $price, $category, $short, $description]) {
    $id = wc_get_product_id_by_sku($sku);
    if (!$id) {
        $existing = get_page_by_path($slug, OBJECT, 'product');
        if (!$existing) {
            global $wpdb;
            $existing_id = $wpdb->get_var($wpdb->prepare("SELECT ID FROM {$wpdb->posts} WHERE post_type='product' AND post_status NOT IN ('trash','auto-draft') AND post_title=%s ORDER BY ID LIMIT 1", $name));
            $existing = $existing_id ? get_post($existing_id) : null;
        }
        $id = $existing ? $existing->ID : 0;
    }
    $product = $id ? wc_get_product($id) : new WC_Product_Simple();
    $product->set_name($name); $product->set_slug($slug); $product->set_sku($sku);
    $product->set_status('publish'); $product->set_catalog_visibility('visible');
    $product->set_regular_price($price); $product->set_reviews_allowed(false);
    $product->set_category_ids([$categories[$category]]);
    $product->set_short_description($short . ' Demo product. No payment or shipment.');
    $product->set_description('<p>' . $description . '</p><p>Original demo illustration, not product photography. This is a sample catalogue item. Choose Cash on delivery to place a test order. No payment is collected and nothing is shipped.</p>');
    $attachments = get_posts(['post_type' => 'attachment', 'post_status' => 'inherit', 'meta_key' => '_urumi_asset_slug', 'meta_value' => $slug, 'numberposts' => 1]);
    $source = '/scripts/store/' . $slug . '.png';
    $hash = hash_file('sha256', $source);
    if ($attachments) {
        $attachment_id = $attachments[0]->ID;
        if (get_post_meta($attachment_id, '_urumi_asset_sha256', true) !== $hash) {
            $target = get_attached_file($attachment_id);
            if (!copy($source, $target)) WP_CLI::error('Cannot update artwork: ' . $slug);
            wp_update_attachment_metadata($attachment_id, wp_generate_attachment_metadata($attachment_id, $target));
        }
    } else {
        $upload = wp_upload_bits($slug . '.png', null, file_get_contents($source));
        if ($upload['error']) WP_CLI::error($upload['error']);
        $attachment_id = wp_insert_attachment(['post_title' => $name . ' illustration', 'post_name' => 'urumi-art-' . $slug, 'post_mime_type' => 'image/png', 'post_status' => 'inherit'], $upload['file']);
        if (is_wp_error($attachment_id)) WP_CLI::error($attachment_id->get_error_message());
        wp_update_attachment_metadata($attachment_id, wp_generate_attachment_metadata($attachment_id, $upload['file']));
    }
    update_post_meta($attachment_id, '_urumi_asset_slug', $slug);
    update_post_meta($attachment_id, '_urumi_asset_sha256', $hash);
    update_post_meta($attachment_id, '_wp_attachment_image_alt', $name . ', original illustrative demo artwork');
    if ((int) $product->get_image_id() !== (int) $attachment_id) $product->set_image_id($attachment_id);
    if (!$id || $product->get_changes()) $product->save();
    $products[$slug] = $product->get_id(); $images[$slug] = $attachment_id;
}
$logo = '<a class="ur-logo" href="' . esc_url(home_url('/')) . '" aria-label="Urumi home">URUMI</a>';
$header = urumi_html('<div class="ur-announcement">DEMO STORE &nbsp;·&nbsp; No payment collected. No products shipped.</div><div class="ur-header"><div class="ur-wrap ur-header-inner">' . $logo . '<nav aria-label="Main navigation"><a href="' . home_url('/shop/') . '">Shop</a><a href="' . home_url('/#collections') . '">Collections</a><a href="' . home_url('/cart/') . '">Cart</a></nav></div></div>');
$footer = urumi_html('<div class="ur-footer"><div class="ur-wrap"><div class="ur-footer-grid"><div>' . $logo . '<p>Everyday &amp; occasion.<br>A demo collection of small joys.</p></div><nav aria-label="Footer navigation"><a href="' . home_url('/shop/') . '">Shop</a><a href="' . home_url('/demo-terms/') . '">Demo terms</a><a href="' . home_url('/demo-privacy/') . '">Privacy</a><a href="' . home_url('/shipping-and-returns/') . '">Shipping &amp; returns</a></nav></div><div class="ur-footer-bottom">URUMI DEMO STORE &nbsp;·&nbsp; Prices in INR &nbsp;·&nbsp; Cash on delivery test checkout &nbsp;·&nbsp; Original illustrative artwork</div></div></div>');
foreach (['header' => $header, 'footer' => $footer] as $slug => $content) {
    $id = urumi_post('wp_template_part', $slug, 'Urumi ' . $slug, $content, true);
    wp_set_object_terms($id, $slug, 'wp_template_part_area');
}
$template_start = '<!-- wp:template-part {"slug":"header","theme":"twentytwentyfive","tagName":"header"} /-->';
$template_end = '<!-- wp:template-part {"slug":"footer","theme":"twentytwentyfive","tagName":"footer"} /-->';
urumi_post('wp_template', 'front-page', 'Urumi front page', $template_start . '<!-- wp:group {"tagName":"main","layout":{"type":"default"}} --><main class="wp-block-group"><!-- wp:post-content /--></main><!-- /wp:group -->' . $template_end, true);
urumi_post('wp_template', 'page', 'Urumi page', $template_start . '<!-- wp:group {"tagName":"main","className":"ur-page","layout":{"type":"default"}} --><main class="wp-block-group ur-page"><!-- wp:post-title {"level":1} /--><!-- wp:post-content /--></main><!-- /wp:group -->' . $template_end, true);
urumi_post('wp_template', 'page-checkout', 'Urumi checkout', $template_start . '<!-- wp:woocommerce/page-content-wrapper {"page":"checkout"} --><!-- wp:group {"tagName":"main","className":"ur-page","layout":{"type":"default"}} --><main class="wp-block-group ur-page"><!-- wp:heading {"level":1} --><h1 class="wp-block-heading">Demo checkout</h1><!-- /wp:heading --><!-- wp:woocommerce/store-notices /--><!-- wp:post-content /--></main><!-- /wp:group --><!-- /wp:woocommerce/page-content-wrapper -->' . $template_end, true);
$confirmation = $template_start . '<!-- wp:group {"tagName":"main","className":"ur-page","layout":{"type":"default"}} --><main class="wp-block-group ur-page">' . urumi_html('<div class="ur-checkout-note"><strong>Your demo order is recorded.</strong> No payment is due and nothing will be shipped. No further action is required.</div>') . '<!-- wp:woocommerce/order-confirmation-status {"fontSize":"large"} /--><!-- wp:woocommerce/order-confirmation-summary /--><!-- wp:woocommerce/order-confirmation-totals-wrapper --><!-- wp:heading --><h2 class="wp-block-heading">Demo order details</h2><!-- /wp:heading --><!-- wp:woocommerce/order-confirmation-totals /--><!-- /wp:woocommerce/order-confirmation-totals-wrapper --><!-- wp:woocommerce/order-confirmation-billing-wrapper --><!-- wp:heading --><h2 class="wp-block-heading">Billing details</h2><!-- /wp:heading --><!-- wp:woocommerce/order-confirmation-billing-address /--><!-- /wp:woocommerce/order-confirmation-billing-wrapper --><!-- wp:woocommerce/order-confirmation-additional-information /-->' . urumi_html('<a class="ur-cta" href="' . home_url('/shop/') . '">Continue exploring ↗</a>') . '</main><!-- /wp:group -->' . $template_end;
urumi_post('wp_template', 'order-confirmation', 'Urumi demo order confirmation', $confirmation, true);
$hero_url = esc_url(wp_get_attachment_image_url($images['urumi-mug'], 'full'));
$home = urumi_html('<div class="ur-wrap ur-home"><section class="ur-hero"><div><p class="ur-eyebrow">Everyday &amp; occasion</p><h1>Small joys.<br>Everyday rituals.</h1><p class="ur-intro">A warm cup, a useful tote, a thoughtful gift. Find a little joy in the Urumi demo collection.</p><a class="ur-cta" href="' . home_url('/shop/') . '">Shop the collection <span aria-hidden="true">↗</span></a><p class="ur-small">Explore freely. Every order is a demo.</p></div><figure class="ur-art"><img src="' . $hero_url . '" alt="Terracotta Urumi Mug with a curved cream motif, original demo illustration" width="720" height="600" fetchpriority="high"><figcaption>THE EVERYDAY EDIT &nbsp; / &nbsp; URUMI</figcaption></figure></section><section aria-labelledby="favourites"><div class="ur-section-head"><h2 id="favourites">A few everyday favourites</h2><a href="' . home_url('/shop/') . '">View all &nbsp;↗</a></div>') . '\n<!-- wp:shortcode -->[products ids="' . implode(',', [$products['urumi-mug'], $products['handloom-tote-bag'], $products['masala-chai-tin']]) . '" columns="3" orderby="post__in"]<!-- /wp:shortcode -->\n' . urumi_html('</section><section class="ur-collections" id="collections" aria-labelledby="collection-title"><p class="ur-eyebrow">Explore the collections</p><h2 id="collection-title">Find your kind of everyday</h2><div class="ur-collection-grid"><a class="ur-collection" href="' . home_url('/product-category/tea-coffee/') . '"><span>01 / A MOMENT TO PAUSE</span><h3>Tea &amp; coffee ↗</h3><p>Chai tins, coffee packs and favourite cups.</p></a><a class="ur-collection" href="' . home_url('/product-category/textiles/') . '"><span>02 / EVERYDAY COMPANIONS</span><h3>Textiles ↗</h3><p>Totes, tees and a little comfort for home.</p></a><a class="ur-collection" href="' . home_url('/product-category/gifting/') . '"><span>03 / SOMETHING THOUGHTFUL</span><h3>Gifting ↗</h3><p>Little lights and bundles for an occasion.</p></a></div></section><aside class="ur-demo-note"><strong>A store made for exploring.</strong><p>This is a demo. All product artwork is illustrative. Cash on delivery places a test order only. No payment is collected and nothing is shipped.</p></aside></div>');
// Use actual newlines between serialized blocks, never literal backslash-n text.
$home = str_replace('\\n', "\n", $home);
$home_id = urumi_post('page', 'home', 'Home', $home);
update_option('show_on_front', 'page'); update_option('page_on_front', $home_id);
$policies = [
 'demo-terms' => ['Demo terms', '<h2>A test storefront</h2><p>URUMI is a demonstration store for exploring browsing, cart and order management. Products, prices and illustrations are sample catalogue content, not an offer for sale.</p><h2>Cash on delivery is a demo</h2><p>Checkout creates a test WooCommerce order. No payment is collected now or later. No goods are dispatched, and no contract to buy or sell goods is formed.</p><h2>Use test details</h2><p>Use fictional contact and address details. Please do not enter sensitive information or real payment details. Orders may be reviewed in the demo dashboard or deleted when the demo is reset.</p>'],
 'demo-privacy' => ['Demo privacy', '<h2>What this demo stores</h2><p>The cart uses cookies to remember your selection. Placing a test order stores the name, email, phone, billing address and items you enter in this demo WordPress and WooCommerce installation.</p><h2>How test details are used</h2><p>Demo administrators can view test orders in WooCommerce and through the connected gateway. Details are used to demonstrate order handling. No payment processing or shipping service is connected.</p><h2>Use fictional information</h2><p>Do not submit sensitive or real personal details. Demo data can remain until an administrator resets the installation. This demonstration does not promise a production retention period or a staffed privacy service.</p>'],
 'shipping-and-returns' => ['Shipping & returns', '<h2>Nothing is shipped</h2><p>This is a demo store. All orders are test records. There are no deliveries, shipping charges, delivery dates or physical goods to receive.</p><h2>No payment or refund</h2><p>The Cash on delivery option simulates an order. No money is collected online, on delivery or later. Because there is no sale or shipment, there are no physical returns, exchanges or refunds.</p><h2>After checkout</h2><p>The confirmation page shows your demo order number. No further action or payment is required. You can return to the collection and continue exploring.</p>'],
];
foreach ($policies as $slug => [$title, $body]) {
    $id = urumi_post('page', $slug, $title, urumi_html('<div class="ur-policy"><p class="ur-eyebrow">URUMI / DEMO STORE</p>' . $body . '<p><a href="' . home_url('/shop/') . '">Back to the collection ↗</a></p></div>'));
    if ($slug === 'demo-terms') update_option('woocommerce_terms_page_id', $id);
    if ($slug === 'demo-privacy') update_option('wp_page_for_privacy_policy', $id);
}
foreach (['cart' => 'woocommerce_cart_page_id', 'checkout' => 'woocommerce_checkout_page_id'] as $slug => $option) {
    $id = get_option($option); $page = get_post($id);
    if (!$page) WP_CLI::error('Missing WooCommerce ' . $slug . ' page');
    $notice = urumi_html('<div class="ur-checkout-note"><strong>Demo ' . $slug . '.</strong> Use fictional billing details. Cash on delivery creates a test order. No payment is collected and nothing is shipped.</div>');
    $content = preg_replace('/<!-- wp:html -->\s*<div class="ur-checkout-note">.*?<!-- \/wp:html -->\s*/s', '', $page->post_content);
    $content = $notice . "\n" . $content;
    if ($page->post_content !== $content) wp_update_post(wp_slash(['ID' => $id, 'post_content' => $content]));
}
update_option('blogname', 'URUMI'); update_option('blogdescription', 'Everyday & occasion. Demo store.');
update_option('woocommerce_currency_pos', 'left'); update_option('woocommerce_price_num_decimals', 0); update_option('woocommerce_price_thousand_sep', ',');
update_option('woocommerce_enable_coupons', 'no'); update_option('woocommerce_enable_guest_checkout', 'yes');
update_option('woocommerce_allowed_countries', 'specific'); update_option('woocommerce_specific_allowed_countries', ['IN']);
update_option('woocommerce_enable_reviews', 'no');
$cod = get_option('woocommerce_cod_settings', []);
update_option('woocommerce_cod_settings', array_merge($cod, ['enabled' => 'yes', 'title' => 'Cash on delivery', 'description' => 'Demo checkout only. No payment is collected and nothing is shipped.', 'instructions' => 'Demo order only. No shipment or payment will occur. No further action is required.', 'enable_for_virtual' => 'yes']));
$styles = ['version' => 3, 'isGlobalStylesUserThemeJSON' => true, 'settings' => ['layout' => ['contentSize' => '720px', 'wideSize' => '1120px'], 'typography' => ['fontFamilies' => [['name' => 'System sans', 'slug' => 'body', 'fontFamily' => 'Arial, Helvetica, sans-serif'], ['name' => 'Georgia', 'slug' => 'heading', 'fontFamily' => 'Georgia, serif']]], 'color' => ['palette' => [['slug' => 'base', 'name' => 'Cream', 'color' => '#faf7ef'], ['slug' => 'contrast', 'name' => 'Forest', 'color' => '#203e32'], ['slug' => 'accent-1', 'name' => 'Terracotta', 'color' => '#a44a32']]]], 'styles' => ['color' => ['background' => '#faf7ef', 'text' => '#252b25'], 'spacing' => ['blockGap' => '24px'], 'typography' => ['fontFamily' => 'Arial, Helvetica, sans-serif', 'fontSize' => '16px', 'lineHeight' => '1.6'], 'elements' => ['heading' => ['typography' => ['fontFamily' => 'Georgia, serif', 'fontWeight' => '400']], 'button' => ['color' => ['background' => '#203e32', 'text' => '#ffffff']], 'link' => ['color' => ['text' => '#203e32']]]]];
$style_id = WP_Theme_JSON_Resolver::get_user_global_styles_post_id();
$content = wp_json_encode($styles);
if (!$style_id || get_post_field('post_content', $style_id) !== $content) {
    $style_id = wp_insert_post(wp_slash(['ID' => $style_id ?: 0, 'post_type' => 'wp_global_styles', 'post_status' => 'publish', 'post_name' => 'wp-global-styles-twentytwentyfive', 'post_title' => 'Urumi styles', 'post_content' => $content]), true);
    if (is_wp_error($style_id)) WP_CLI::error($style_id->get_error_message());
}
wp_set_object_terms($style_id, 'twentytwentyfive', 'wp_theme');
// Remove only known untouched WordPress starter content.
foreach (['sample-page' => 'page', 'hello-world' => 'post'] as $slug => $type) {
    $post = get_page_by_path($slug, OBJECT, $type);
    if ($post && (str_contains($post->post_content, 'This is an example page') || str_contains($post->post_content, 'Welcome to WordPress'))) wp_trash_post($post->ID);
}
WP_CLI::success('Urumi storefront reconciled: 9 products, 9 original illustrations, 3 collections.');
