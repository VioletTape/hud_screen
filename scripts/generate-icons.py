import asyncio
from pathlib import Path
from playwright.async_api import async_playwright
from PIL import Image

svg_master = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <defs>
    <!-- Screen Backdrop: Deep void slate with radial telemetry glow -->
    <radialGradient id="screenBackdrop" cx="50%" cy="42%" r="68%">
      <stop offset="0%" stop-color="#0f263d"/>
      <stop offset="45%" stop-color="#081322"/>
      <stop offset="85%" stop-color="#040811"/>
      <stop offset="100%" stop-color="#020408"/>
    </radialGradient>

    <!-- Outer Bezel Neon Gradient: Vibrant Cyan to Electric Emerald -->
    <linearGradient id="neonBezel" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="25%" stop-color="#00f0ff"/>
      <stop offset="70%" stop-color="#00f5c4"/>
      <stop offset="100%" stop-color="#10b981"/>
    </linearGradient>

    <!-- Telemetry Pulse Gradient -->
    <linearGradient id="pulseGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#00e5ff"/>
      <stop offset="40%" stop-color="#00f0ff"/>
      <stop offset="75%" stop-color="#00ffcc"/>
      <stop offset="100%" stop-color="#34d399"/>
    </linearGradient>

    <!-- Metallic Edge Inset -->
    <linearGradient id="metalInset" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="30%" stop-color="#ffffff" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.4"/>
    </linearGradient>

    <!-- Wide Bloom Glow Filter -->
    <filter id="bloomGlow" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="9" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <!-- Tight Crisp Glow Filter -->
    <filter id="crispGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- Layer 1: Hardware Bezel Chassis (Deep Obsidian with Vibrant Neon Perimeter) -->
  <rect x="20" y="20" width="472" height="472" rx="104" fill="#060912" stroke="url(#neonBezel)" stroke-width="12"/>

  <!-- Layer 2: Subtle Metallic Top-Light Reflection Bevel -->
  <rect x="30" y="30" width="452" height="452" rx="94" fill="none" stroke="url(#metalInset)" stroke-width="2.5"/>

  <!-- Layer 3: Inner Display Screen Face -->
  <rect x="44" y="44" width="424" height="424" rx="80" fill="url(#screenBackdrop)"/>

  <!-- Layer 4: HUD Sensor Background Matrix / Reticle Coordinates -->
  <circle cx="256" cy="256" r="148" fill="none" stroke="#00f0ff" stroke-opacity="0.09" stroke-width="2"/>
  <circle cx="256" cy="256" r="92" fill="none" stroke="#00f0ff" stroke-opacity="0.07" stroke-width="1.5" stroke-dasharray="6 6"/>
  <line x1="256" y1="96" x2="256" y2="416" stroke="#00f0ff" stroke-opacity="0.07" stroke-width="1.5"/>
  <line x1="96" y1="256" x2="416" y2="256" stroke="#00f0ff" stroke-opacity="0.07" stroke-width="1.5"/>

  <!-- Layer 5: Top Status Bar / Live Indicators -->
  <circle cx="160" cy="98" r="8" fill="#10b981" filter="url(#crispGlow)"/>
  <circle cx="160" cy="98" r="4" fill="#ffffff"/>
  <rect x="184" y="92" width="28" height="12" rx="6" fill="#00f0ff" fill-opacity="0.25"/>
  <rect x="220" y="92" width="56" height="12" rx="6" fill="#00f0ff" fill-opacity="0.5"/>
  <rect x="284" y="92" width="40" height="12" rx="6" fill="#00f0ff" fill-opacity="0.3"/>
  <circle cx="352" cy="98" r="7" fill="#00f0ff" filter="url(#crispGlow)"/>
  <circle cx="352" cy="98" r="3.5" fill="#ffffff"/>

  <!-- Layer 6: HUD Viewfinder Brackets [ ] -->
  <g stroke="#00f0ff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none" filter="url(#crispGlow)">
    <path d="M 96 154 L 96 118 L 132 118"/>
    <path d="M 380 118 L 416 118 L 416 154"/>
    <path d="M 96 358 L 96 394 L 132 394"/>
    <path d="M 380 394 L 416 394 L 416 358"/>
  </g>

  <!-- Layer 7: The Master Telemetry Pulse Wave -->
  <!-- Ambient Glow Underlay -->
  <path d="M 84 266 L 160 266 L 194 196 L 226 336 L 268 152 L 306 312 L 332 266 L 428 266"
        fill="none" stroke="#00f0ff" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"
        opacity="0.3" filter="url(#bloomGlow)"/>

  <!-- Vibrant Cyber Neon Wave -->
  <path d="M 84 266 L 160 266 L 194 196 L 226 336 L 268 152 L 306 312 L 332 266 L 428 266"
        fill="none" stroke="url(#pulseGrad)" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"
        filter="url(#crispGlow)"/>

  <!-- High-Luminance White Core Line for Needle-Sharp Contrast at 16x16 -->
  <path d="M 88 266 L 160 266 L 194 196 L 226 336 L 268 152 L 306 312 L 332 266 L 424 266"
        fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>

  <!-- Layer 8: Focal Telemetry Beacon (At Highest Peak x=268, y=152) -->
  <circle cx="268" cy="152" r="28" fill="#00f0ff" fill-opacity="0.3" filter="url(#bloomGlow)"/>
  <circle cx="268" cy="152" r="15" fill="#00f5c4" filter="url(#crispGlow)"/>
  <circle cx="268" cy="152" r="7.5" fill="#ffffff"/>

  <!-- Layer 9: Live Terminal Dot (End of Wave x=424, y=266) -->
  <circle cx="424" cy="266" r="9" fill="#10b981" filter="url(#crispGlow)"/>
  <circle cx="424" cy="266" r="4.5" fill="#ffffff"/>

  <!-- Layer 10: Bottom Telemetry Ruler / Scale Ticks (Secondary Sensor Display) -->
  <g transform="translate(116, 422)" stroke="#00f0ff" stroke-opacity="0.4" stroke-linecap="round" stroke-width="3">
    <line x1="0" y1="0" x2="0" y2="10"/>
    <line x1="28" y1="2" x2="28" y2="8"/>
    <line x1="56" y1="1" x2="56" y2="9"/>
    <line x1="84" y1="2" x2="84" y2="8"/>
    <line x1="112" y1="0" x2="112" y2="10"/>
    <line x1="140" y1="2" x2="140" y2="8"/>
    <line x1="168" y1="1" x2="168" y2="9"/>
    <line x1="196" y1="2" x2="196" y2="8"/>
    <line x1="224" y1="1" x2="224" y2="9"/>
    <line x1="252" y1="2" x2="252" y2="8"/>
    <line x1="280" y1="0" x2="280" y2="10"/>
  </g>
</svg>'''

async def main():
    project_root = Path(__file__).resolve().parent.parent
    assets_dir = project_root / "assets"
    assets_dir.mkdir(exist_ok=True)
    
    client_dir = project_root / "src/client"
    native_dir = project_root / "src/native/ControlPanel.Hud"
    
    # Save SVG versions
    (assets_dir / "icon.svg").write_text(svg_master)
    (client_dir / "favicon.svg").write_text(svg_master)
    
    # Render raster sizes
    sizes = [512, 256, 128, 64, 48, 32, 24, 16]
    rendered_images = {}
    
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        for size in sizes:
            page = await browser.new_page(viewport={"width": size, "height": size})
            html_content = f'''<!DOCTYPE html>
<html>
<head>
  <style>
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{ background: transparent; overflow: hidden; width: {size}px; height: {size}px; }}
    svg {{ width: {size}px; height: {size}px; display: block; }}
  </style>
</head>
<body>
{svg_master}
</body>
</html>'''
            await page.set_content(html_content)
            await page.wait_for_timeout(50)
            png_bytes = await page.screenshot(omit_background=True)
            rendered_images[size] = Image.open(io_bytes := Path(f"/tmp/icon_{size}.png"))
            io_bytes.write_bytes(png_bytes)
            rendered_images[size] = Image.open(io_bytes).convert("RGBA")
            io_bytes.unlink(missing_ok=True)
            await page.close()
        await browser.close()

    # Save PNGs in assets
    rendered_images[512].save(assets_dir / "icon-512.png")
    rendered_images[256].save(assets_dir / "icon-256.png")
    rendered_images[256].save(client_dir / "icon.png")

    # Build multi-resolution ICO for Windows executable and System Tray
    ico_sizes = [256, 128, 64, 48, 32, 24, 16]
    ico_imgs = [rendered_images[s] for s in ico_sizes]
    
    ico_path_assets = assets_dir / "icon.ico"
    ico_path_native = native_dir / "app.ico"
    ico_path_client = client_dir / "favicon.ico"
    
    ico_imgs[0].save(ico_path_assets, format="ICO", append_images=ico_imgs[1:])
    ico_imgs[0].save(ico_path_native, format="ICO", append_images=ico_imgs[1:])
    ico_imgs[0].save(ico_path_client, format="ICO", append_images=ico_imgs[1:])

    print("Successfully generated all icon assets.")

if __name__ == "__main__":
    asyncio.run(main())
