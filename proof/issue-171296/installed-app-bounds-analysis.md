# Installed-app measured bounds — final run 38558044952 (all 8 captures)

Real installed playDebug APKs on API 36 emulator (KVM, GitHub-hosted runner),
driven via uiautomator; screenshot-fixture mode provides deterministic
connected-gateway state. BEFORE apk = PR-head tree with ClawComponents.kt
reverted to upstream main; AFTER apk = PR head 0bd8b922630. Sole UI difference:
the ClawStatusRow horizontal padding line.

## Health, normal scale (1080x1920 @420dpi => 2.625 px/dp)
| element | BEFORE | AFTER | delta |
|---|---|---|---|
| 'Phone Node' label left | x=42 | x=68 | +26px = 9.9dp |
| 'Voice' label left | x=42 | x=68 | +26px |
| 'Online' badge right | x=1017 | x=991 | -26px |
| 'Ready' badge right | x=1017 | x=991 | -26px |
| summary panel 'Online' (untouched) | x=74 | x=74 | 0 |

## Dreaming, normal scale (same density)
| element | BEFORE | AFTER | delta |
|---|---|---|---|
| 'Memory Store' label left | x=42 | x=68 | +26px |
| 'Signal Index' label left | x=42 | x=68 | +26px |
| 'Promoted' label left | x=42 | x=68 | +26px |
| 'Healthy' badge right | x=1017 | x=991 | -26px |
| metric panel 'Signals' (untouched) | x=74 | x=74 | 0 |

## Health, narrow localized large font (fr-FR, 2x font scale, 640x1360 @320dpi => 2.0 px/dp)
| element | BEFORE | AFTER | delta |
|---|---|---|---|
| status-row 'Gateway' label left | x=32 | x=52 | +20px = exactly 10dp |
| summary 'Gateway' (untouched) | x=56 | x=56 | 0 |

## Dreaming, narrow localized large font (same config)
| element | BEFORE | AFTER | delta |
|---|---|---|---|
| 'Stockage de la mémoire' label left | x=32 | x=52 | +20px = exactly 10dp |

All deltas match the restored `padding(horizontal = 10.dp)` at both densities;
summary/metric panels (which always kept their inset) are pixel-identical.
