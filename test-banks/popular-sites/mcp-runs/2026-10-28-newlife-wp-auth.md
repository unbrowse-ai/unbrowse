# New Life WordPress auth check — 2026-10-28

This site-specific test is outside the 400-site inventory. The node's local
browser reached the WordPress login form as a guest, filled the saved Vault
login, and then showed the Dashboard. The observed Posts link opened
`/wp-admin/edit.php`; its Posts heading was visible without a login form. No
MFA appeared. No content edit was submitted.

`unbrowse_do` did **not** discover a valid read route for “list WordPress admin
posts.” Its first attempt learned a background `POST /wp-admin/admin-ajax.php`
as a `write: true` route with no inputs, then received HTTP 400. The node log
shows a heal retry also received HTTP 400. I backed up and removed that route.
After a local read-goal guard and node restart, the same goal returned
`how: browse`, saved no route, and left the authenticated Posts page readable
in the node browser. This is a safe fallback, not an MCP replay pass.

Logout was not tested, and the authenticated node browser session remains
open. The [metadata](2026-10-28-newlife-wp-auth.json) omits account and
session material.
