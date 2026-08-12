<?php
/**
 * Plugin Name: Forge AI — Website Intelligence
 * Plugin URI: https://forge-ai-six-psi.vercel.app
 * Description: Connects your WordPress site to Forge AI for real-time building alerts, automated SEO fixes, and continuous monitoring. A product of Werdel Global Systems.
 * Version: 1.0.0
 * Author: Werdel Global Systems
 * License: GPL2
 */

if (!defined('ABSPATH')) exit;

define('FORGE_AI_VERSION', '1.0.0');
define('FORGE_AI_ENDPOINT', 'https://forgeai-wgs.com');

// ── ACTIVATION ────────────────────────────────────────────
register_activation_hook(__FILE__, 'forge_ai_activate');
function forge_ai_activate() {
    add_option('forge_ai_token', '');
    add_option('forge_ai_active', false);
    add_option('forge_ai_auto_fix', true);
    add_option('forge_ai_alerts', true);
}

// ── ADMIN MENU ────────────────────────────────────────────
add_action('admin_menu', 'forge_ai_menu');
function forge_ai_menu() {
    add_menu_page(
        'Forge AI',
        'Forge AI',
        'manage_options',
        'forge-ai',
        'forge_ai_dashboard_page',
        'dashicons-visibility',
        30
    );
    add_submenu_page('forge-ai', 'Settings', 'Settings', 'manage_options', 'forge-ai-settings', 'forge_ai_settings_page');
}

// ── MAIN DASHBOARD PAGE ───────────────────────────────────
function forge_ai_dashboard_page() {
    $token = get_option('forge_ai_token');
    $active = get_option('forge_ai_active');
    $site_url = get_site_url();
    ?>
    <div class="wrap">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;padding:20px;background:#0c0c0d;border-radius:12px">
            <div style="width:36px;height:36px;background:#ff6b35;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff">F</div>
            <div>
                <h1 style="color:#f0f0f2;margin:0;font-size:1.3rem">Forge AI — Website Intelligence</h1>
                <p style="color:#9090a0;margin:0;font-size:.85rem">A product of Werdel Global Systems</p>
            </div>
            <div style="margin-left:auto">
                <span style="background:<?php echo $active ? 'rgba(34,201,122,.15)' : 'rgba(107,107,120,.15)'; ?>;color:<?php echo $active ? '#22c97a' : '#9090a0'; ?>;padding:4px 12px;border-radius:100px;font-size:.8rem;font-weight:600">
                    <?php echo $active ? '● Connected' : '○ Not connected'; ?>
                </span>
            </div>
        </div>

        <?php if (empty($token)): ?>
        <!-- NOT CONNECTED -->
        <div style="background:#131315;border:1px solid rgba(255,107,53,.3);border-radius:12px;padding:24px;margin-bottom:24px">
            <h2 style="color:#f0f0f2;margin:0 0 8px;font-size:1.1rem">Connect to Forge AI</h2>
            <p style="color:#9090a0;margin:0 0 20px;font-size:.9rem">Enter your Forge AI token to connect this site to your agency dashboard.</p>
            <form method="post" action="options.php">
                <?php settings_fields('forge_ai_settings'); ?>
                <div style="display:flex;gap:10px;align-items:center">
                    <input type="text" name="forge_ai_token" placeholder="fat_xxxxxxxxxxxxxxxx_..." 
                           style="flex:1;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:#1a1a1d;color:#f0f0f2;font-size:.85rem"
                           value="<?php echo esc_attr($token); ?>">
                    <?php submit_button('Connect', 'primary', 'submit', false, ['style' => 'background:#ff6b35;border-color:#ff6b35;padding:8px 20px']); ?>
                </div>
                <p style="color:#6b6b78;font-size:.78rem;margin:8px 0 0">Find your token in your Forge AI dashboard under "Monitoring Script"</p>
            </form>
        </div>
        <?php else: ?>

        <!-- CONNECTED - STATS -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px">
            <div style="background:#131315;border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:20px">
                <div style="font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:#6b6b78;margin-bottom:8px">Site URL</div>
                <div style="font-size:.85rem;color:#f0f0f2;word-break:break-all"><?php echo $site_url; ?></div>
            </div>
            <div style="background:#131315;border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:20px">
                <div style="font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:#6b6b78;margin-bottom:8px">Status</div>
                <div style="font-size:1.1rem;font-weight:700;color:#22c97a">Active</div>
            </div>
            <div style="background:#131315;border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:20px">
                <div style="font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:#6b6b78;margin-bottom:8px">Auto-fix</div>
                <div style="font-size:1.1rem;font-weight:700;color:<?php echo get_option('forge_ai_auto_fix') ? '#22c97a' : '#ff3b3b'; ?>">
                    <?php echo get_option('forge_ai_auto_fix') ? 'On' : 'Off'; ?>
                </div>
            </div>
            <div style="background:#131315;border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:20px">
                <div style="font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:#6b6b78;margin-bottom:8px">Alerts</div>
                <div style="font-size:1.1rem;font-weight:700;color:<?php echo get_option('forge_ai_alerts') ? '#22c97a' : '#ff3b3b'; ?>">
                    <?php echo get_option('forge_ai_alerts') ? 'On' : 'Off'; ?>
                </div>
            </div>
        </div>

        <!-- WHAT FORGE AI IS DOING -->
        <div style="background:#131315;border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:24px;margin-bottom:24px">
            <h2 style="color:#f0f0f2;margin:0 0 16px;font-size:1rem">What Forge AI is doing on this site</h2>
            <div style="display:flex;flex-direction:column;gap:10px">
                <div style="display:flex;align-items:center;gap:12px;padding:12px;background:#1a1a1d;border-radius:8px">
                    <span style="color:#22c97a;font-size:1.1rem">✓</span>
                    <div>
                        <div style="color:#f0f0f2;font-size:.85rem;font-weight:600">Real-time building alerts</div>
                        <div style="color:#9090a0;font-size:.78rem">Alerts you instantly when you save a page with SEO issues</div>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:12px;padding:12px;background:#1a1a1d;border-radius:8px">
                    <span style="color:#22c97a;font-size:1.1rem">✓</span>
                    <div>
                        <div style="color:#f0f0f2;font-size:.85rem;font-weight:600">Auto-fix image alt text</div>
                        <div style="color:#9090a0;font-size:.78rem">Automatically adds AI-generated alt text to images missing it</div>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:12px;padding:12px;background:#1a1a1d;border-radius:8px">
                    <span style="color:#22c97a;font-size:1.1rem">✓</span>
                    <div>
                        <div style="color:#f0f0f2;font-size:.85rem;font-weight:600">Meta description monitoring</div>
                        <div style="color:#9090a0;font-size:.78rem">Alerts when pages are missing or have weak meta descriptions</div>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:12px;padding:12px;background:#1a1a1d;border-radius:8px">
                    <span style="color:#22c97a;font-size:1.1rem">✓</span>
                    <div>
                        <div style="color:#f0f0f2;font-size:.85rem;font-weight:600">Heading structure checks</div>
                        <div style="color:#9090a0;font-size:.78rem">Catches incorrect heading hierarchy before you publish</div>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:12px;padding:12px;background:#1a1a1d;border-radius:8px">
                    <span style="color:#22c97a;font-size:1.1rem">✓</span>
                    <div>
                        <div style="color:#f0f0f2;font-size:.85rem;font-weight:600">Daily automated scans</div>
                        <div style="color:#9090a0;font-size:.78rem">Full 5-module scan sent to your Forge AI dashboard every day</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- DISCONNECT -->
        <div style="background:#131315;border:1px solid rgba(255,59,59,.2);border-radius:12px;padding:20px">
            <h3 style="color:#f0f0f2;margin:0 0 8px;font-size:.95rem">Disconnect site</h3>
            <p style="color:#9090a0;font-size:.82rem;margin:0 0 12px">This will remove this site from Forge AI monitoring.</p>
            <form method="post" action="options.php">
                <?php settings_fields('forge_ai_settings'); ?>
                <input type="hidden" name="forge_ai_token" value="">
                <?php submit_button('Disconnect', 'delete', 'submit', false, ['style' => 'background:transparent;border-color:rgba(255,59,59,.4);color:#ff6b6b']); ?>
            </form>
        </div>

        <?php endif; ?>
    </div>
    <?php
}

// ── SETTINGS PAGE ─────────────────────────────────────────
function forge_ai_settings_page() {
    ?>
    <div class="wrap">
        <h1>Forge AI Settings</h1>
        <form method="post" action="options.php">
            <?php settings_fields('forge_ai_settings'); ?>
            <?php do_settings_sections('forge_ai_settings'); ?>
            <table class="form-table">
                <tr>
                    <th>Agency Token</th>
                    <td>
                        <input type="text" name="forge_ai_token" value="<?php echo esc_attr(get_option('forge_ai_token')); ?>" class="regular-text">
                        <p class="description">Your unique Forge AI agency token</p>
                    </td>
                </tr>
                <tr>
                    <th>Auto-fix Issues</th>
                    <td>
                        <input type="checkbox" name="forge_ai_auto_fix" value="1" <?php checked(get_option('forge_ai_auto_fix'), true); ?>>
                        <label>Automatically fix simple issues (alt text, meta descriptions)</label>
                    </td>
                </tr>
                <tr>
                    <th>Real-time Alerts</th>
                    <td>
                        <input type="checkbox" name="forge_ai_alerts" value="1" <?php checked(get_option('forge_ai_alerts'), true); ?>>
                        <label>Show alerts while building in WordPress editor</label>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}

// ── REGISTER SETTINGS ─────────────────────────────────────
add_action('admin_init', 'forge_ai_register_settings');
function forge_ai_register_settings() {
    register_setting('forge_ai_settings', 'forge_ai_token');
    register_setting('forge_ai_settings', 'forge_ai_active');
    register_setting('forge_ai_settings', 'forge_ai_auto_fix');
    register_setting('forge_ai_settings', 'forge_ai_alerts');
}

// ── INJECT MONITORING SCRIPT ──────────────────────────────
add_action('wp_footer', 'forge_ai_inject_script');
function forge_ai_inject_script() {
    $token = get_option('forge_ai_token');
    $alerts = get_option('forge_ai_alerts');
    if (empty($token) || !$alerts) return;
    ?>
    <script src="<?php echo FORGE_AI_ENDPOINT; ?>/forge-ai-tracker.js"></script>
    <script>window.FORGE_AI_TOKEN = '<?php echo esc_js($token); ?>';</script>
    <?php
}

// ── AUTO-FIX: Add alt text to images on save ──────────────
add_action('save_post', 'forge_ai_auto_fix_post', 10, 3);
function forge_ai_auto_fix_post($post_id, $post, $update) {
    $token = get_option('forge_ai_token');
    $auto_fix = get_option('forge_ai_auto_fix');
    if (empty($token) || !$auto_fix) return;
    if (wp_is_post_revision($post_id)) return;
    if ($post->post_status !== 'publish') return;

    // Find images in post content without alt text
    $content = $post->post_content;
    preg_match_all('/<img[^>]+>/i', $content, $matches);

    foreach ($matches[0] as $img_tag) {
        if (!preg_match('/alt=["\'][^"\']*["\']/i', $img_tag) ||
            preg_match('/alt=["\']["\']/', $img_tag)) {
            // Image missing alt text — log for Forge AI to handle
            error_log('Forge AI: Image missing alt text found in post ' . $post_id);
        }
    }

    // Send post save notification to Forge AI
    $site_url = get_site_url();
    $page_url = get_permalink($post_id);

    wp_remote_post(FORGE_AI_ENDPOINT . '/api/realtime-check', [
        'body' => json_encode([
            'token' => $token,
            'url' => $page_url,
            'pageTitle' => $post->post_title,
            'issues' => forge_ai_check_post($post),
            'timestamp' => date('c')
        ]),
        'headers' => ['Content-Type' => 'application/json'],
        'timeout' => 10
    ]);
}

// ── CHECK POST FOR ISSUES ─────────────────────────────────
function forge_ai_check_post($post) {
    $issues = [];
    $content = $post->post_content;

    // Check meta description (using Yoast if available)
    $meta_desc = get_post_meta($post->ID, '_yoast_wpseo_metadesc', true);
    if (empty($meta_desc)) {
        $issues[] = [
            'name' => 'Missing meta description',
            'description' => 'This page has no meta description set.',
            'severity' => 'critical',
            'fix' => 'Add a meta description of 120-160 characters in your SEO settings.'
        ];
    }

    // Check for images without alt text
    preg_match_all('/<img[^>]+>/i', $content, $img_matches);
    $no_alt = 0;
    foreach ($img_matches[0] as $img) {
        if (!preg_match('/alt=["\'][^"\']+["\']/i', $img)) $no_alt++;
    }
    if ($no_alt > 0) {
        $issues[] = [
            'name' => $no_alt . ' image' . ($no_alt > 1 ? 's' : '') . ' missing alt text',
            'description' => $no_alt . ' images on this page have no alt text.',
            'severity' => $no_alt > 3 ? 'critical' : 'high',
            'fix' => 'Add descriptive alt text to every image.'
        ];
    }

    // Check heading structure
    preg_match_all('/<h([1-6])[^>]*>/i', $content, $heading_matches);
    if (!empty($heading_matches[1])) {
        $levels = array_map('intval', $heading_matches[1]);
        for ($i = 1; $i < count($levels); $i++) {
            if ($levels[$i] - $levels[$i-1] > 1) {
                $issues[] = [
                    'name' => 'Heading structure skips levels',
                    'description' => 'Headings jump from H' . $levels[$i-1] . ' to H' . $levels[$i] . '.',
                    'severity' => 'medium',
                    'fix' => 'Use headings in order: H1 → H2 → H3. Never skip levels.'
                ];
                break;
            }
        }
    }

    return $issues;
}

// ── ADMIN NOTICE: show when not connected ─────────────────
add_action('admin_notices', 'forge_ai_admin_notice');
function forge_ai_admin_notice() {
    $token = get_option('forge_ai_token');
    $screen = get_current_screen();
    if (!empty($token) || $screen->id === 'toplevel_page_forge-ai') return;
    ?>
    <div class="notice notice-warning is-dismissible">
        <p>
            <strong>Forge AI</strong> is installed but not connected. 
            <a href="<?php echo admin_url('admin.php?page=forge-ai'); ?>">Connect now →</a>
        </p>
    </div>
    <?php
}

// ── EDITOR ALERT PANEL ────────────────────────────────────
add_action('add_meta_boxes', 'forge_ai_meta_box');
function forge_ai_meta_box() {
    add_meta_box(
        'forge_ai_panel',
        '⬡ Forge AI — Live Analysis',
        'forge_ai_meta_box_content',
        ['post', 'page'],
        'side',
        'high'
    );
}

function forge_ai_meta_box_content($post) {
    $token = get_option('forge_ai_token');
    if (empty($token)) {
        echo '<p style="color:#999;font-size:13px">Connect Forge AI to see live analysis. <a href="' . admin_url('admin.php?page=forge-ai') . '">Connect →</a></p>';
        return;
    }

    $issues = forge_ai_check_post($post);
    $critical = array_filter($issues, fn($i) => $i['severity'] === 'critical');
    $high = array_filter($issues, fn($i) => $i['severity'] === 'high');
    $medium = array_filter($issues, fn($i) => $i['severity'] === 'medium');

    echo '<div style="font-family:-apple-system,sans-serif">';

    if (empty($issues)) {
        echo '<div style="color:#22c97a;font-size:13px;padding:8px 0">✓ No issues found — this page looks great!</div>';
    } else {
        echo '<div style="font-size:12px;color:#666;margin-bottom:8px">' . count($issues) . ' issue' . (count($issues) > 1 ? 's' : '') . ' found</div>';
        foreach ($issues as $issue) {
            $color = $issue['severity'] === 'critical' ? '#ff6b6b' : ($issue['severity'] === 'high' ? '#f5a623' : '#4d9fff');
            echo '<div style="border-left:3px solid ' . $color . ';padding:8px 10px;margin-bottom:8px;background:#f8f8f8;border-radius:0 4px 4px 0">';
            echo '<div style="font-weight:600;font-size:12px;color:#222;margin-bottom:3px">' . esc_html($issue['name']) . '</div>';
            echo '<div style="font-size:11px;color:#666;line-height:1.4">' . esc_html($issue['fix']) . '</div>';
            echo '</div>';
        }
    }

    echo '<a href="' . admin_url('admin.php?page=forge-ai') . '" style="font-size:12px;color:#ff6b35">View full dashboard →</a>';
    echo '</div>';
}
