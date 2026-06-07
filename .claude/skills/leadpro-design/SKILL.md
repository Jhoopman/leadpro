---
name: leadpro-design
description: LeadPro design system — deep forest green dark theme, Plus Jakarta Sans, thin-stroke icons, glass card surfaces. Load this before building any LeadPro UI component.
---

# LeadPro Design System

LeadPro is a premium dark SaaS dashboard for home-service contractors. The visual identity is **deep forest green dark** — not OLED black, not white. Every surface has a green tint. The accent is a bright emerald (`#52D99A`). Icons are always thin-stroke, never filled blobs.

---

## 1. Color Tokens (source of truth)

```css
:root {
  /* Brand */
  --green:      #2D6A4F;   /* brand dark — buttons, avatar bg, active states */
  --green-mid:  #3D7A5F;   /* button hover */
  --green-lite: rgba(45,106,79,0.18);
  --accent:     #52D99A;   /* bright emerald — active borders, icon stroke, labels */

  /* Surfaces — 4-step elevation (darkest → lightest) */
  --bg:     #0B1812;   /* body / page background */
  --bg2:    #122118;   /* modals, auth box, onboarding box */
  --bg3:    #192D20;   /* elevated surface (hover states) */
  --surf-1: #122118;   /* cards, metric tiles */
  --surf-2: #192D20;   /* raised within a card */
  --surf-3: #1E3427;   /* focus ring bg, active inputs */

  /* Sidebar / nav */
  --sidebar-bg: #0D1C14;

  /* Text — 3 tiers */
  --text:  #E8F5EE;   /* primary — headings, values */
  --text2: #9CBFAE;   /* secondary — descriptions, table cells */
  --text3: #618A75;   /* muted — timestamps, labels, sub-text */

  /* Borders */
  --border:     rgba(82,217,154,0.09);   /* default card border */
  --border-mid: rgba(82,217,154,0.14);   /* icon containers, active inputs */
  --border-hi:  rgba(82,217,154,0.22);   /* featured cards, focus rings */

  /* Semantic */
  --success: #52D99A;
  --warn:    #fbbf24;
  --danger:  #f87171;
  --info:    #60a5fa;

  /* Radius */
  --radius:    8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
}
```

### Named palette — all hex values used in the codebase

| Name | Value | Usage |
|------|-------|-------|
| Body | `#0B1812` | Page background |
| Sidebar | `#0D1C14` | Sidebar background |
| Card | `rgba(18,33,24,0.92)` | All surface cards |
| Modal | `#122118` | Modals, auth, onboarding |
| Input bg | `rgba(13,28,20,0.8)` | All text inputs, textareas |
| Accent | `#52D99A` | Icons, active text, progress |
| Brand | `#2D6A4F` | Buttons, badges, avatar bg |
| Brand hover | `#3A7A5F` | Button hover state |
| Text-1 | `#E8F5EE` | Headings, metric values |
| Text-2 | `#9CBFAE` | Body copy, table values |
| Text-3 | `#618A75` | Labels, timestamps, muted |
| Border | `rgba(82,217,154,0.09)` | Card edges |
| Border active | `rgba(82,217,154,0.22)` | Featured cards, focus |
| Pill new | `rgba(74,222,128,0.12)` / `#4ade80` | New lead status |
| Pill sched | `rgba(96,165,250,0.12)` / `#60a5fa` | Scheduled status |
| Pill follow | `rgba(251,191,36,0.12)` / `#fbbf24` | Follow-up status |
| Danger | `#f87171` | Errors, danger buttons |

---

## 2. Typography

**Font family:** `'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif`

```html
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
```

| Role | Size | Weight | Tracking | Notes |
|------|------|--------|----------|-------|
| Page title | 19px | 700 | -0.02em | Screen `<h1>` |
| Modal title | 15–17px | 600–700 | -0.01em | Panel headings |
| Metric value | 36px | 700 | -0.03em | Tabular nums |
| Card title | 13px | 600 | 0 | Panel headers |
| Body | 13–14px | 400–500 | 0 | Table cells, descriptions |
| Uppercase label | 11px | 600 | 0.07em | ALL-CAPS field labels |
| Micro | 10–10.5px | 500–700 | 0.04–0.1em | Timestamps, section labels |

---

## 3. Surface Styles

### Standard card / metric tile
```css
background: rgba(18,33,24,0.92);
border: 1px solid rgba(82,217,154,0.09);
border-radius: 14px;
box-shadow: 0 1px 4px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.03);
```

### Featured / hero card (gradient glass)
```css
background: linear-gradient(135deg, rgba(45,106,79,0.38) 0%, rgba(18,33,24,0.96) 65%);
border: 1px solid rgba(82,217,154,0.24);
box-shadow: 0 0 48px rgba(45,106,79,0.22), inset 0 1px 0 rgba(255,255,255,0.04);
border-radius: 14px;
```

### Settings card (heavier border radius)
```css
background: rgba(18,33,24,0.92);
border: 1px solid rgba(82,217,154,0.09);
border-radius: 16px;
box-shadow: 0 1px 4px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.02);
overflow: hidden;
```

### Modal / overlay box
```css
background: #122118;
border: 1px solid rgba(82,217,154,0.16);
border-radius: 16px;
box-shadow: 0 20px 60px rgba(0,0,0,0.55);
```

### Sidebar
```css
background: #0D1C14;
border-right: 1px solid rgba(82,217,154,0.07);
```

### Onboarding wizard overlay
```css
/* backdrop */
background: rgba(5,14,9,0.72);
backdrop-filter: blur(14px);
-webkit-backdrop-filter: blur(14px);

/* box */
background: #122118;
border: 1px solid rgba(82,217,154,0.16);
box-shadow: 0 24px 72px rgba(0,0,0,0.65);
```

---

## 4. Button Styles

### Primary
```css
background: #2D6A4F;
color: #fff;
border: none;
border-radius: 9px;
padding: 9px 22px;
font-size: 13px;
font-weight: 700;
transition: background .15s, box-shadow .15s, transform .1s;
```
Hover: `background: #3A7A5F; box-shadow: 0 3px 12px rgba(45,106,79,0.3); transform: translateY(-1px)`
Active: `transform: translateY(0)`
Disabled: `opacity: .55`

### Secondary / ghost
```css
background: transparent;
color: #777;
border: 1px solid rgba(255,255,255,0.08);
border-radius: 9px;
padding: 9px 16px;
font-size: 13px;
```
Hover: `background: rgba(18,33,24,0.9); color: #E8F5EE`

### Small action button
```css
font-size: 11px;
padding: 4px 9px;
border-radius: 6px;
border: 1px solid rgba(82,217,154,0.12);
background: rgba(18,33,24,0.92);
color: #9CBFAE;
```

### Full-width auth / CTA
```css
width: 100%;
padding: 10px;
background: #2D6A4F;
color: #fff;
border: none;
border-radius: 8px;
font-size: 14px;
font-weight: 600;
```

---

## 5. Input / Form Field Styles

### Text input
```css
width: 100%;
background: rgba(13,28,20,0.8);
border: 1px solid rgba(82,217,154,0.13);
border-radius: 10px;
padding: 11px 14px;
font-size: 14px;
color: #E8F5EE;
font-family: inherit;
outline: none;
transition: border-color .15s, box-shadow .15s;
```
Focus: `border-color: #52D99A; box-shadow: 0 0 0 3px rgba(82,217,154,0.1)`

### Textarea (same as input, plus)
```css
resize: vertical;
min-height: 110px;
line-height: 1.65;
```

### Field label (uppercase)
```css
font-size: 11px;
color: #618A75;
font-weight: 700;
text-transform: uppercase;
letter-spacing: 0.07em;
margin-bottom: 6px;
display: block;
```

### Toggle (iOS-style)
```css
/* track off */  background: rgba(82,217,154,0.12); width: 44px; height: 26px; border-radius: 13px;
/* track on */   background: #2D6A4F;
/* thumb */      width: 22px; height: 22px; background: #fff; border-radius: 50%; transition: transform .2s;
/* on offset */  transform: translateX(18px);
```

---

## 6. Icon System

**All icons are thin-stroke SVGs. Never use filled Material Design icons.**

```css
/* nav icons */
.nav-item svg {
  width: 15px; height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* metric tile icon container */
.metric-icon {
  width: 36px; height: 36px;
  border-radius: 10px;
  background: rgba(82,217,154,0.08);
  border: 1px solid rgba(82,217,154,0.14);
}
.metric-icon svg {
  fill: none;
  stroke: #52D99A;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
```

**Icon library:** Feather / Phosphor Light style. Use paths like:
- Users: `<path d="M17 21v-2a4 4 0 00-4-4H5..."/><circle cx="9" cy="7" r="4"/>`
- Calendar: `<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>`
- Phone: standard Feather `phone` path
- Settings: standard Feather `settings` (gear with circle cx="12" cy="12" r="3")
- Dashboard: four rounded rectangles grid

---

## 7. Spacing Scale

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Icon gap, tight padding |
| sm | 8px | Inner pill padding, small gap |
| md | 12–14px | Row padding, field gap |
| lg | 16–20px | Card internal padding, grid gap |
| xl | 22–26px | Screen padding |
| 2xl | 32px | Modal padding |
| section | 20px | Margin between sections |

Screen-level padding: `22px 26px`
Card padding: `20px 22px`
Grid gap: `16px`
Section gap: `margin-bottom: 20px`

---

## 8. Animation / Transition Values

```css
/* default interaction */
transition: all .15s;

/* cards on hover */
transition: border-color .2s, transform .2s;
/* hover: */  transform: translateY(-1px);

/* primary button */
transition: background .15s, box-shadow .15s, transform .1s;

/* toast slide-in */
transition: all .35s;
transform: translateY(0); opacity: 1;

/* dot pulse (live indicator) */
@keyframes dot-pulse {
  0%,100% { opacity:1; transform:scale(1); }
  50%      { opacity:0; transform:scale(2); }
}
animation: dot-pulse 2s ease-in-out infinite;

/* typing dots */
@keyframes blink {
  0%,60%,100% { transform:translateY(0); }
  30%          { transform:translateY(-4px); }
}
```

**Rule:** Animate only `transform` and `opacity`. Never animate `top`, `left`, `width`, `height`, or `background-color` on scroll.

---

## 9. Status Pills / Badges

```css
.pill { display: inline-block; font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
.p-new    { background: rgba(74,222,128,0.12);  color: #4ade80; }
.p-sched  { background: rgba(96,165,250,0.12);  color: #60a5fa; }
.p-follow { background: rgba(251,191,36,0.12);  color: #fbbf24; }
.p-done   { background: rgba(18,33,24,0.9);     color: #618A75; }

/* trial / status pill */
.trial-pill { background: rgba(82,217,154,0.12); color: #52D99A; border: 0.5px solid rgba(82,217,154,0.25); border-radius: 20px; padding: 5px 11px; font-size: 12px; font-weight: 500; }
.trial-pill.amber { background: rgba(251,191,36,0.12); color: #fbbf24; }
.trial-pill.red   { background: rgba(248,113,113,0.12); color: #f87171; }
```

---

## 10. How to Apply This System

### Which surface to use
| Context | Surface |
|---------|---------|
| Page / screen background | `#0B1812` |
| Any card, panel, tile | `rgba(18,33,24,0.92)` + `border: 1px solid rgba(82,217,154,0.09)` |
| The one hero/featured stat | Featured gradient + glow |
| Modal, drawer, overlay box | `#122118` + `rgba(82,217,154,0.16)` border |
| Input backgrounds | `rgba(13,28,20,0.8)` |
| Section group label | 10–11px, `#52D99A`, uppercase, 0.1em tracking |

### What new components should look like
1. **Every card uses the standard surface** — semi-transparent forest green, hairline emerald border, subtle inset highlight.
2. **Icons are ALWAYS thin-stroke** — Feather/Phosphor style, `stroke-width: 1.5`, `fill: none`. Never a filled Material blob.
3. **Metric values** — 36px/700, tabular nums, `#E8F5EE`. Label above in uppercase 11px `#618A75`. Subtitle in 12px `#9CBFAE`.
4. **Section grouping** — group label in `#52D99A` uppercase, then a `.set-card` with `border-radius: 16px`.
5. **Hover lift** — cards hover with `translateY(-1px)`. Buttons lift with `translateY(-1px)` + green box-shadow.
6. **Transitions** — `all .15s` for most things. `border-color .2s, transform .2s` for cards.

---

## 11. Sample Component — Notification Card

A new card built entirely in the LeadPro system:

```html
<div class="notification-card">
  <div class="nc-header">
    <div class="metric-icon">
      <svg viewBox="0 0 24 24" width="15" height="15">
        <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 01-3.46 0"/>
      </svg>
    </div>
    <div class="nc-title">Notifications</div>
    <span class="trial-pill">3 new</span>
  </div>
  <div class="nc-row">
    <span class="act-dot a-green"></span>
    <div>
      <div class="act-text">New lead from chatbot — Mike Torres</div>
      <div class="act-time">2 min ago</div>
    </div>
  </div>
</div>

<style>
.notification-card {
  background: rgba(18,33,24,0.92);
  border: 1px solid rgba(82,217,154,0.09);
  border-radius: 14px;
  padding: 20px 22px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.03);
  transition: border-color .2s, transform .2s;
}
.notification-card:hover {
  border-color: rgba(82,217,154,0.18);
  transform: translateY(-1px);
}
.nc-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}
.nc-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: #E8F5EE;
}
.nc-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 0;
  border-top: 1px solid rgba(82,217,154,0.06);
}
</style>
```
