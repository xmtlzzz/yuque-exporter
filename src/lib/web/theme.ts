// Visual theme for the local web UI.
//
// The page is rendered server-side with no build step of its own, so the whole
// visual language lives in this one string. It is deliberately self-contained:
// no @import, no web fonts, no remote assets - the UI must look the same on a
// machine with no network access.
//
// Language: quiet and light-weight. Hairline borders, small radii, no drop
// shadows on surfaces, one accent colour used only for the primary action and
// the selected rows. Dark is the default; a light palette follows the OS.
//
// Structure: tokens (dark, then light) -> reset -> shell -> panels -> controls
// -> repo list -> progress -> log -> report -> scrollbars -> responsive.

export const THEME = `
:root{
  color-scheme:dark;

  /* surfaces, from the canvas up to the hovered well */
  --canvas:#0b0c0e;
  --surface:#101114;
  --surface-2:#17191d;
  --surface-3:#1e2127;
  --code-bg:#0d0e11;

  /* hairlines: the only thing that separates regions */
  --border:#212429;
  --border-strong:#31353c;

  --fg:#e9eaee;
  --fg-soft:#c3c7cf;
  --muted:#8a8f99;
  --faint:#666b74;

  /* one accent, used for the primary button and selection only */
  --accent:#5f6ff2;
  --accent-hover:#7180f7;
  --accent-soft:rgba(95,111,242,.13);
  --accent-line:rgba(120,134,255,.30);
  --on-accent:#ffffff;
  --ring:0 0 0 3px rgba(95,111,242,.26);

  --danger:#ef6b74;
  --danger-soft:rgba(239,107,116,.09);
  --danger-line:rgba(239,107,116,.26);

  --r-sm:6px;
  --r-md:8px;
  --r-lg:10px;

  --ease:cubic-bezier(.4,0,.2,1);
  --t:140ms;
}

@media (prefers-color-scheme:light){
  :root{
    color-scheme:light;

    --canvas:#fbfbfc;
    --surface:#ffffff;
    --surface-2:#f4f5f7;
    --surface-3:#eceef2;
    --code-bg:#f7f8f9;

    --border:#e6e8ec;
    --border-strong:#d4d8df;

    --fg:#17191e;
    --fg-soft:#3b4049;
    --muted:#6b7280;
    --faint:#9aa0aa;

    --accent:#5145e5;
    --accent-hover:#4335d6;
    --accent-soft:rgba(81,69,229,.07);
    --accent-line:rgba(81,69,229,.24);
    --ring:0 0 0 3px rgba(81,69,229,.16);

    --danger:#c02b36;
    --danger-soft:rgba(192,43,54,.06);
    --danger-line:rgba(192,43,54,.20);
  }
}

*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}

body{
  margin:0;
  min-height:100vh;
  color:var(--fg);
  background:var(--canvas);
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
}

::selection{background:var(--accent-soft);color:var(--fg)}

main{max-width:760px;margin:0 auto;padding:52px 24px 88px}

/* ---------- page shell ---------- */

header{margin-bottom:28px}

h1{
  display:flex;
  align-items:center;
  gap:10px;
  margin:0;
  font-size:20px;
  line-height:1.3;
  font-weight:600;
  letter-spacing:-.012em;
}

/* The single accent mark in the header; no gradient, no glow. */
h1::before{
  content:"";
  flex:0 0 auto;
  width:18px;
  height:18px;
  border-radius:5px;
  background:var(--accent);
}

.sub,.muted{margin:0;font-size:13px;color:var(--muted)}
.sub{margin-top:8px}

/* Account line: one quiet caption, never a second headline. */
#who{
  margin-top:8px;
  font-size:13px;
  line-height:1.5;
  color:var(--muted);
  letter-spacing:.002em;
}

/* ---------- panels ---------- */

.panel{
  margin-top:16px;
  padding:24px;
  border:1px solid var(--border);
  border-radius:var(--r-lg);
  background:var(--surface);
}

.panel + .panel{margin-top:12px}

h2{
  display:flex;
  align-items:center;
  gap:12px;
  margin:0 0 16px;
  font-size:12px;
  font-weight:600;
  letter-spacing:.06em;
  color:var(--muted);
}

/* A hairline that runs out of the label, so sections read without a box. */
h2::after{content:"";flex:1 1 auto;height:1px;background:var(--border)}

.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}

.actions{
  margin-top:20px;
  padding-top:18px;
  border-top:1px solid var(--border);
  gap:12px;
}

/* ---------- buttons ---------- */

button{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:6px;
  padding:8px 16px;
  font:inherit;
  font-size:13px;
  font-weight:500;
  line-height:1.4;
  white-space:nowrap;
  color:var(--on-accent);
  background:var(--accent);
  border:1px solid transparent;
  border-radius:var(--r-md);
  cursor:pointer;
  transition:background-color var(--t) var(--ease),
             border-color var(--t) var(--ease),
             color var(--t) var(--ease),
             opacity var(--t) var(--ease);
}

button:hover:not(:disabled){background:var(--accent-hover)}
button:active:not(:disabled){background:var(--accent-hover)}
button:focus-visible{outline:none;box-shadow:var(--ring)}
button:disabled{opacity:.42;cursor:not-allowed}

/* Secondary action: border only, no fill until hover. */
button.ghost{
  color:var(--fg-soft);
  background:transparent;
  border-color:var(--border-strong);
}

button.ghost:hover:not(:disabled){
  color:var(--fg);
  background:var(--surface-2);
}

button.ghost:active:not(:disabled){background:var(--surface-3)}
button.ghost:disabled{border-color:var(--border)}

/* Refresh sits beside the primary action, so it stays visually smaller. */
#reload{
  padding:7px 14px;
  font-size:12.5px;
  font-weight:450;
  color:var(--muted);
}

#reload:hover:not(:disabled){color:var(--fg)}

#start{min-width:132px}

#hint{
  flex:1 1 100%;
  margin:2px 0 0;
  font-size:12.5px;
  line-height:1.5;
  color:var(--muted);
}

/* The element is always present; an empty one must not leave a gap. */
#hint:empty{display:none}

/* ---------- option toggle ---------- */

.check{
  display:inline-flex;
  align-items:center;
  gap:8px;
  margin-left:-7px;
  padding:5px 7px;
  font-size:13px;
  color:var(--muted);
  border-radius:var(--r-sm);
  cursor:pointer;
  user-select:none;
  transition:color var(--t) var(--ease),background-color var(--t) var(--ease);
}

.check:hover{color:var(--fg-soft);background:var(--surface-2)}

/* The labels are the click target; the box inherits the .check metrics. */
#clean,#selectAll{
  margin:0;
  accent-color:var(--accent);
  vertical-align:middle;
}

/* ---------- checkboxes ---------- */

/* Every checkbox is drawn by hand: without this the native box reads as a
   foreign control on both backgrounds, and the tick is inconsistent. */
.item input[type=checkbox],
.check input[type=checkbox]{
  position:relative;
  flex:0 0 auto;
  width:17px;
  height:17px;
  margin:0;
  border:1.5px solid var(--faint);
  border-radius:5px;
  background:transparent;
  cursor:pointer;
  -webkit-appearance:none;
  appearance:none;
  transition:background-color var(--t) var(--ease),
             border-color var(--t) var(--ease);
}

.item input[type=checkbox]:hover,
.check input[type=checkbox]:hover{border-color:var(--accent)}

.item input[type=checkbox]:focus-visible,
.check input[type=checkbox]:focus-visible{outline:none;box-shadow:var(--ring)}

.item input[type=checkbox]:checked,
.check input[type=checkbox]:checked{
  background:var(--accent);
  border-color:var(--accent);
}

/* Indeterminate (partial selection) shows a dash instead of a tick. */
.item input[type=checkbox]:indeterminate,
.check input[type=checkbox]:indeterminate{
  background:var(--accent);
  border-color:var(--accent);
}

.item input[type=checkbox]:indeterminate::after,
.check input[type=checkbox]:indeterminate::after{
  content:"";
  position:absolute;
  left:4px;
  top:7px;
  width:7px;
  height:2px;
  border-radius:1px;
  background:var(--on-accent);
}

.item input[type=checkbox]:checked::after,
.check input[type=checkbox]:checked::after{
  content:"";
  position:absolute;
  left:5px;
  top:2px;
  width:4px;
  height:8px;
  border:solid var(--on-accent);
  border-width:0 2px 2px 0;
  border-radius:1px;
  transform:rotate(43deg);
}

/* ---------- search + select all ---------- */

/* First-run setup: one focused task, so it gets breathing room and a single
   clear primary action instead of sitting inside the export toolbar. */
.setup h2{font-size:15px;margin:0 0 8px}
.setup-hint{max-width:62ch;margin:0 0 18px;line-height:1.7}
#tokenInput{
  flex:1 1 auto;
  width:100%;
  font:inherit;
  font-size:13px;
  padding:10px 12px;
  border-radius:var(--r-md);
  border:1px solid var(--border);
  background:var(--surface-2);
  color:var(--fg);
  transition:border-color .15s ease,box-shadow .15s ease,background .15s ease;
}
#tokenInput::placeholder{color:var(--faint)}
#tokenInput:hover{border-color:var(--border-strong)}
#tokenInput:focus{outline:none;border-color:var(--accent);background:var(--surface);box-shadow:var(--ring)}
#tokenHint{color:var(--muted)}

.search-row{margin-top:18px}

#search{
  flex:1 1 auto;
  width:100%;
  padding:9px 12px;
  font:inherit;
  font-size:13px;
  color:var(--fg);
  background:var(--surface-2);
  border:1px solid var(--border);
  border-radius:var(--r-md);
  -webkit-appearance:none;
  appearance:none;
  transition:border-color var(--t) var(--ease),
             background-color var(--t) var(--ease),
             box-shadow var(--t) var(--ease);
}

#search::placeholder{color:var(--faint)}
#search:hover{border-color:var(--border-strong)}
#search:focus{outline:none;border-color:var(--accent);background:var(--surface);box-shadow:var(--ring)}

.selectall-row{margin-top:14px;padding-top:12px;border-top:1px solid var(--border)}

#visibleCount{
  margin-left:auto;
  font-size:12px;
  color:var(--muted);
  font-variant-numeric:tabular-nums;
}

/* ---------- repository list ---------- */

#list,.list{
  display:grid;
  gap:2px;
  margin:14px 0 0;
  padding:0;
  /* 16 libraries fit on screen; only a very large account scrolls inside. */
  max-height:min(64vh,620px);
  overflow:auto;
  overscroll-behavior:contain;
  border-radius:var(--r-md);
  scrollbar-width:thin;
  scrollbar-color:var(--border-strong) transparent;
}

#list p{margin:0;padding:10px 12px;font-size:13px;color:var(--muted)}

.item{
  display:flex;
  align-items:center;
  gap:10px;
  padding:9px 12px;
  border:1px solid transparent;
  border-radius:var(--r-sm);
  cursor:pointer;
  scroll-margin:8px;
  transition:background-color var(--t) var(--ease),border-color var(--t) var(--ease);
}

.item:hover{background:var(--surface-2)}
.item:focus-within{background:var(--surface-2);border-color:var(--border-strong)}

/* Selection is a tint, never a slab: the row must not out-shout the button. */
.item.on,
.item:has(input:checked){background:var(--accent-soft);border-color:var(--accent-line)}

.item .name{
  flex:1 1 auto;
  min-width:0;
  font-size:13.5px;
  line-height:1.5;
  color:var(--fg-soft);
  overflow-wrap:anywhere;
  transition:color var(--t) var(--ease);
}

.item.on .name,
.item:has(input:checked) .name{color:var(--fg);font-weight:500}

.item .meta{
  flex:0 0 auto;
  font-size:12px;
  color:var(--muted);
  font-variant-numeric:tabular-nums;
  transition:color var(--t) var(--ease);
}

.item.on .meta,
.item:has(input:checked) .meta{color:var(--accent)}

/* ---------- progress ---------- */

/* Both result sections appear on their own; keep the spacing airy when they do. */
#progressPanel{padding-bottom:20px}
#resultPanel{padding-bottom:22px}
#progressPanel h2,#resultPanel h2{margin-bottom:18px}

.bar{
  position:relative;
  height:6px;
  border-radius:999px;
  overflow:hidden;
  background:var(--surface-2);
}

.bar-fill{
  height:100%;
  width:0;
  border-radius:inherit;
  background:var(--accent);
  transition:width .32s var(--ease);
}

/* The poller writes an inline width; never let a stray value escape the rail. */
#barFill{max-width:100%}

#progressText{
  margin:12px 0 0;
  font-size:12.5px;
  color:var(--muted);
  font-variant-numeric:tabular-nums;
}

/* ---------- log ---------- */

#log,.log{
  margin:14px 0 0;
  padding:14px 16px;
  max-height:260px;
  overflow:auto;
  border:1px solid var(--border);
  border-radius:var(--r-md);
  background:var(--code-bg);
  color:var(--fg-soft);
  font:12px/1.7 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  white-space:pre-wrap;
  overflow-wrap:anywhere;
  scrollbar-width:thin;
  scrollbar-color:var(--border-strong) transparent;
}

/* ---------- report ---------- */

/* Hairline dividers instead of separate cards: one block, many numbers. */
.stats,
#stats{
  /* Flex rather than grid: the last row grows to fill, so a report with an
     odd number of figures never leaves an empty cell showing the divider. */
  display:flex;
  flex-wrap:wrap;
  gap:1px;
  overflow:hidden;
  border:1px solid var(--border);
  border-radius:var(--r-md);
  background:var(--border);
}

.stat{
  display:flex;
  flex:1 1 100px;
  flex-direction:column;
  gap:4px;
  min-width:0;
  padding:14px 16px;
  background:var(--surface);
  transition:background-color var(--t) var(--ease);
}

.stat:hover{background:var(--surface-2)}

.stat b{
  font-size:22px;
  line-height:1.2;
  font-weight:600;
  letter-spacing:-.02em;
  color:var(--fg);
  font-variant-numeric:tabular-nums;
}

.stat span{
  font-size:11px;
  font-weight:500;
  letter-spacing:.06em;
  text-transform:uppercase;
  color:var(--muted);
}

.stat.warn b{color:var(--danger)}

/* An empty failures box must not reserve space under the stats. */
#failures{margin-top:16px}
#failures:empty{display:none}

.bad{
  margin-top:6px;
  padding:8px 12px;
  border:1px solid var(--danger-line);
  border-radius:var(--r-sm);
  background:var(--danger-soft);
  color:var(--fg-soft);
  font-size:12.5px;
  line-height:1.55;
  overflow-wrap:anywhere;
}

#outDir{
  margin:16px 0 0;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:12px;
  color:var(--faint);
  overflow-wrap:anywhere;
}

/* ---------- scrollbars ---------- */

#list::-webkit-scrollbar,#log::-webkit-scrollbar,.log::-webkit-scrollbar{width:10px;height:10px}
#list::-webkit-scrollbar-track,#log::-webkit-scrollbar-track,.log::-webkit-scrollbar-track{background:transparent}

#list::-webkit-scrollbar-thumb,
#log::-webkit-scrollbar-thumb,
.log::-webkit-scrollbar-thumb{
  border:3px solid transparent;
  border-radius:999px;
  background:var(--border-strong);
  background-clip:content-box;
}

/* ---------- narrow screens ---------- */

@media (max-width:620px){
  main{padding:32px 16px 64px}
  header{margin-bottom:22px}
  h1{font-size:18px;gap:8px}
  h1::before{width:16px;height:16px;border-radius:4px}
  .panel{margin-top:12px;padding:18px 16px}
  .panel + .panel{margin-top:10px}
  .check{margin-left:0;padding-left:0}
  .check:hover{background:transparent}
  /* Stacked actions: the primary button owns the full width, counters centre. */
  .actions{flex-direction:column;align-items:stretch;gap:10px}
  #start{width:100%;min-width:0}
  #count,#hint{text-align:center}
  #hint{flex:0 0 auto}
  #list,.list{max-height:300px}
  .stat{flex:1 1 39%;padding:12px}
  .stat b{font-size:20px}
  #log,.log{max-height:220px}
}

@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{
    animation-duration:.01ms!important;
    animation-iteration-count:1!important;
    transition-duration:.01ms!important;
  }
}
`;
