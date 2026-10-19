#!/bin/sh
set -eu
cd /var/www/html

echo "waiting for wp-config.php from the wordpress container"
until [ -f wp-config.php ]; do sleep 3; done
echo "waiting for the database"
until wp db check --quiet >/dev/null 2>&1; do sleep 3; done

if ! wp core is-installed 2>/dev/null; then
  wp core install --url="$STORE_URL" --title="$STORE_TITLE" --admin_user=admin \
    --admin_password="$WP_ADMIN_PASSWORD" --admin_email="$STORE_ADMIN_EMAIL" --skip-email
fi
wp core update-db --quiet
wp eval '
  $user = get_user_by("login", "admin");
  if (!wp_check_password(getenv("WP_ADMIN_PASSWORD"), $user->user_pass, $user->ID)) {
    wp_set_password(getenv("WP_ADMIN_PASSWORD"), $user->ID);
  }
' 
wp option update timezone_string "$STORE_TIMEZONE"
wp rewrite structure '/%postname%/'

if ! wp plugin is-installed woocommerce; then
  if [ -n "$WOOCOMMERCE_VERSION" ]; then
    wp plugin install woocommerce --version="$WOOCOMMERCE_VERSION"
  else
    wp plugin install woocommerce
  fi
fi
wp plugin is-active woocommerce || wp plugin activate woocommerce

wp option update woocommerce_currency "$STORE_CURRENCY"
wp option update woocommerce_default_country "$STORE_COUNTRY"
wp option update woocommerce_default_customer_address base
wp option update woocommerce_coming_soon no
wp option update woocommerce_ship_to_countries disabled
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
wp wc tool run install_pages --user=admin >/dev/null
wp wc payment_gateway update cod --enabled=true --user=admin >/dev/null

wp theme is-installed twentytwentyfive || wp theme install twentytwentyfive
wp theme is-active twentytwentyfive || wp theme activate twentytwentyfive
mkdir -p wp-content/mu-plugins wp-content/urumi-store
cmp -s /scripts/store/storefront.php wp-content/mu-plugins/urumi-storefront.php || cp /scripts/store/storefront.php wp-content/mu-plugins/urumi-storefront.php
cmp -s /scripts/store/store.css wp-content/urumi-store/store.css || cp /scripts/store/store.css wp-content/urumi-store/store.css
wp eval-file /scripts/store/bootstrap.php

wp eval '
  global $wpdb;
  $table = $wpdb->prefix . "woocommerce_api_keys";
  $ck = getenv("WOO_CONSUMER_KEY");
  $hash = wc_api_hash($ck);
  if ($wpdb->get_var($wpdb->prepare("SELECT key_id FROM $table WHERE consumer_key = %s", $hash))) { echo "api key present\n"; return; }
  $wpdb->delete($table, ["description" => "urumi woo-mcp"]);
  $wpdb->insert($table, [
    "user_id" => get_user_by("login", "admin")->ID,
    "description" => "urumi woo-mcp",
    "permissions" => "read_write",
    "consumer_key" => $hash,
    "consumer_secret" => getenv("WOO_CONSUMER_SECRET"),
    "truncated_key" => substr($ck, -7),
  ]);
  echo "api key installed\n";
'
echo "store ready"
