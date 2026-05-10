// manifest-loader.js — loads industry manifest JSON, applies branding tokens.
// Pure config-driven: no industry-specific code lives here.

const BUILTIN_INDUSTRIES = [
  "residential", "commercial", "factory", "museum", "tourism", "medical"
];

export async function loadManifest({ industry, customManifestUrl }) {
  const url = customManifestUrl || `./manifests/${industry}.json`;
  // Allow built-ins + any `demo-*` industry (escape hatch for experiments).
  const isBuiltin = BUILTIN_INDUSTRIES.includes(industry);
  const isDemo = /^demo-[a-z0-9-]+$/i.test(industry || "");
  if (!customManifestUrl && !isBuiltin && !isDemo) {
    throw new Error(`unknown industry: ${industry}. valid: ${BUILTIN_INDUSTRIES.join(",")} or demo-*`);
  }
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`manifest http ${res.status}: ${url}`);
  const m = await res.json();
  return validate(m);
}

function validate(m) {
  if (!m.industry) throw new Error("manifest.industry missing");
  if (!Array.isArray(m.scenes) || m.scenes.length === 0) throw new Error("manifest.scenes empty");
  for (const s of m.scenes) {
    if (!s.id) throw new Error("scene.id missing");
    // Scene must declare exactly ONE source: splat_url, equirect_url, or video_url
    const sources = [s.splat_url, s.equirect_url, s.video_url].filter(Boolean);
    if (sources.length === 0) throw new Error(`scene[${s.id}] needs splat_url | equirect_url | video_url`);
    s.scene_type = s.splat_url ? "splat" : s.equirect_url ? "equirect" : "video";
    s.label = s.label || s.id;
    s.start = s.start || [0, 1.6, 0];
    s.offset = s.offset || [0, 0, 0];
    s.size_mb = s.size_mb || 30;
    s.hotspots = s.hotspots || [];
    s.scale_to_meters = s.scale_to_meters ?? 1.0;
  }
  m.brand_color = m.brand_color || "#ff8a3d";
  m.brand_color_2 = m.brand_color_2 || lighten(m.brand_color, 0.18);
  m.cta = m.cta || {};
  m.features = m.features || ["hotspot_nav", "measure", "dollhouse", "annotation"];
  return m;
}

export function applyBranding(m) {
  const root = document.documentElement;
  root.style.setProperty("--brand", m.brand_color);
  root.style.setProperty("--brand-2", m.brand_color_2);
  root.style.setProperty("--brand-grad", `linear-gradient(135deg,${m.brand_color},${m.brand_color_2})`);
  root.style.setProperty("--brand-knob", hexToRgba(m.brand_color, 0.55));
  root.style.setProperty("--brand-knob-active", hexToRgba(m.brand_color_2, 0.85));
  root.style.setProperty("--brand-border", hexToRgba(m.brand_color, 0.42));

  // Bind data-bind attributes
  const bindings = {
    brand_short: m.brand_short || m.name?.[0] || "V",
    brand_name: m.name,
    brand_sub: m.brand_sub || `industry: ${m.industry}`,
    cta_title: m.cta?.title || "",
    cta_price: m.cta?.price || "",
    cta_desc: m.cta?.desc || "",
    cta_button: m.cta?.button || "Learn more"
  };
  for (const [k, v] of Object.entries(bindings)) {
    document.querySelectorAll(`[data-bind="${k}"]`).forEach(el => { el.textContent = v; });
  }
  document.title = `${m.name} - VR Tour v3`;
}

function lighten(hex, amt) {
  const h = hex.replace("#", "");
  const r = Math.min(255, parseInt(h.slice(0, 2), 16) + Math.round(255 * amt));
  const g = Math.min(255, parseInt(h.slice(2, 4), 16) + Math.round(255 * amt));
  const b = Math.min(255, parseInt(h.slice(4, 6), 16) + Math.round(255 * amt));
  return "#" + [r, g, b].map(n => n.toString(16).padStart(2, "0")).join("");
}

function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
