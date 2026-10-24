# Sources and modifications

## Remnawave frontend

- Upstream: https://github.com/remnawave/frontend
- Snapshot: dcb1affbfc42793799caecee988fd20ac0a270b7
- Declared package version: 3.4.7
- License: AGPL-3.0-only; upstream LICENCE retained verbatim as LICENSE.
- Copyright: Remnawave and contributors.
- Retained/adapted sources: src/shared/constants/theme/theme.ts → web/theme.ts; src/app/layouts/dashboard/main-layout/layout-variants/sidebar-shell.layout.tsx and layout.module.css → reduced AppShell/sidebar in web/panel.tsx and web/style.css.
- Original retained reference copies: web/upstream/. The complete unrelated frontend is excluded from the deliverable.
- Changes: removed billing/user/quota/squad/bot/terminal/navigation modules and their dependencies; replaced API/auth/config/operations UI for Chen017/Xray; added Chinese operational views. This is a reduced derivative frontend with a new compatible control plane, not an unchanged Remnawave distribution.

## Chen017/Xray

- Upstream: https://github.com/Chen017/Xray
- Local snapshot: 38765c9c0e9e217397b7ee6d096386494d834f4f, script v2.7.9.
- Reused script modules are in vendor/xray-script/ for unattended bootstrap and local integration tests. An already installed VPS uses its own sh/src modules.
- Configuration compiler adapted from src/node.jq, core.sh relay rebuild and runtime.sh outbound strategies; existing runtime.sh transaction and firewall.sh are directly executed by agent/bridge.sh.
- Local change in vendor install.sh: PANEL_UNATTENDED=1 skips interactive export prompts and bootstraps standard or no-inbound landing mode. v2.7.10 additionally introduces the Agent lifecycle submenu, early CLI dispatch and read-only report helper, mirrored from the original script workspace; those changes do not change Xray deployment behavior.
- Script v2.7.11 adds the shared read-only network_probe.sh module and domestic/Cloudflare menu status, mirrored from the original Script workspace. Panel Agent reuses this same module for network notifications; it does not deploy or modify Xray configuration.
- The supplied Xray repository has no standalone LICENSE file; its source is included as user-provided project code with attribution. Review its licensing before separately redistributing it outside your own project.

## Dependencies

React, Mantine, Tabler Icons, Express, Helmet, express-rate-limit, YAML, Zod, age-encryption/typage and their transitive libraries retain their individual licenses in installed package directories. Runtime dependencies are pinned by package-lock.json. age encryption uses the official typage implementation from https://github.com/FiloSottile/typage.
