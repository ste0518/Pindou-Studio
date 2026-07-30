import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the local bead studio landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>拼豆工坊｜拼豆图纸生成工具<\/title>/);
  assert.match(html, /LOCAL BEAD STUDIO/);
  assert.match(html, /图片始终留在你的设备上处理/);
  assert.match(html, /灵感画廊/);
  assert.match(html, /模板市场/);
  assert.match(html, /用此模板创作/);
});

test("keeps template selection local to the image-to-pattern workflow", async () => {
  const [page, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /title: "拼豆工坊｜拼豆图纸生成工具"/);
  assert.match(page, /const BEAD_TEMPLATES: BeadTemplate\[\]/);
  assert.match(page, /const startFromTemplate/);
  assert.match(page, /setMaxColors\(template\.colours\)/);
  assert.match(page, /setDetail\(template\.detail\)/);
  assert.match(page, /AI 人像分割/);
  assert.match(page, /sharpenTransparency/);
  assert.doesNotMatch(page, /coverage < 0\.025 \|\| coverage > 0\.98/);
  assert.doesNotMatch(page, /动漫风|图生图|style-transfer/i);
  assert.doesNotMatch(page, /https?:\/\/api\./i);
});
