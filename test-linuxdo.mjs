// 本地测试 linux.do 抓取
const testUrl = "https://linux.do/t/topic/847468/1.json";

async function testDirect() {
  console.log("=== 测试1: 直连 (无cookie) ===");
  try {
    const resp = await fetch(testUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    console.log(`status=${resp.status}`);
    if (resp.ok) {
      const data = await resp.json();
      console.log(`title=${data.title}`);
      console.log(`posts=${data.post_stream?.posts?.length}`);
      const first = data.post_stream?.posts?.[0];
      if (first) {
        console.log(`author=${first.name || first.username}`);
        console.log(`content_preview=${first.cooked?.slice(0, 200)}`);
      }
    } else {
      const body = await resp.text();
      const isCloudflare = body.includes("Just a moment");
      console.log(`failed: ${isCloudflare ? "Cloudflare JS Challenge" : body.slice(0, 300)}`);
    }
  } catch (e) {
    console.error("error:", e.message);
  }
}

async function testScrape(token) {
  if (!token) {
    console.log("\n=== 测试2: scrape.do (跳过, 无token) ===");
    console.log("用法: node test-linuxdo.mjs <SCRAPE_DO_TOKEN>");
    return;
  }

  // 测试不同参数组合
  const configs = [
    { name: "默认(无geoCode)", params: `pureCookies=true` },
    { name: "geoCode=us", params: `geoCode=us&pureCookies=true` },
    { name: "geoCode=jp", params: `geoCode=jp&pureCookies=true` },
    { name: "super=true", params: `super=true&pureCookies=true` },
    { name: "geoCode=sg(原始)", params: `geoCode=sg&pureCookies=true` },
  ];

  for (const cfg of configs) {
    console.log(`\n=== 测试 scrape.do: ${cfg.name} ===`);
    const proxyUrl = `https://api.scrape.do/?token=${token}&url=${encodeURIComponent(testUrl)}&${cfg.params}`;
    try {
      const resp = await fetch(proxyUrl);
      console.log(`status=${resp.status}`);
      if (resp.ok) {
        const text = await resp.text();
        try {
          const data = JSON.parse(text);
          console.log(`✅ 成功! title=${data.title}`);
        } catch {
          const isCloudflare = text.includes("Just a moment");
          console.log(`返回非JSON: ${isCloudflare ? "Cloudflare Challenge页面" : text.slice(0, 200)}`);
        }
      } else {
        const body = await resp.text();
        console.log(`❌ 失败: ${body.slice(0, 300)}`);
      }
    } catch (e) {
      console.error(`error: ${e.message}`);
    }
  }
}

await testDirect();
await testScrape(process.argv[2]);
