// webgl-probe.mjs — find launch flags that give headless Chromium a working
// WebGL2 context (needed for the minecraft-web-client 3D renderer).
import puppeteer from 'puppeteer';

const VARIANTS = [
  { name: 'default', args: [] },
  { name: 'unsafe-swiftshader', args: ['--enable-unsafe-swiftshader'] },
  {
    name: 'angle-swiftshader',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  },
];

const BASE_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

for (const variant of VARIANTS) {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [...BASE_ARGS, ...variant.args],
    });
    const page = await browser.newPage();
    const info = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return { ok: false };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = dbg
        ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
      // draw something and read a pixel back to prove rasterization works
      gl.clearColor(0.2, 0.6, 0.9, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const px = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return {
        ok: true,
        webgl2: !!canvas.getContext('webgl2'),
        renderer: String(renderer),
        pixel: Array.from(px),
        sab: typeof SharedArrayBuffer !== 'undefined',
      };
    });
    console.log(variant.name, JSON.stringify(info));
  } catch (err) {
    console.log(variant.name, 'LAUNCH/EVAL FAILED:', err.message.split('\n')[0]);
  } finally {
    await browser?.close().catch(() => {});
  }
}
